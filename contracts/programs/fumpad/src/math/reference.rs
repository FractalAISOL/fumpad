//! D10 — per-coin reference price (ticket sell-price floor). Pure; see SPEC §5.3.
//!
//! Threat. In one Jito bundle an attacker crashes the price outside FUMPAD's view
//! (direct PumpSwap dump, or a second wallet dumping on the curve), sells a little
//! through FUMPAD (the ticket records the crashed price), then restores the price.
//! The ticket is then trivially "10x". So a ticket's price is (D12, refining D10)
//!     max(execution price, reference average × execution ÷ pre-trade spot)
//! where the reference is a time-weighted average of spot over ~10 minutes that a
//! price which exists only for an instant cannot move, and the ratio is the sell's own
//! slippage (≈ 1 after a staged crash; = 1 − impact for an honest sell in a flat market).
//!
//! State: `avg` (the reference), `last` (the last spot FUMPAD observed) and
//! `updated_at`. FUMPAD observes spot only at its own touch points: curve buys/sells,
//! router swaps and keeper samples. At each touch point at time `t`:
//!
//!   1. fold   avg ← avg + (v − avg) · w / WINDOW         (v, w below)
//!   2. record last ← spot right AFTER the touch point (post-trade / sampled spot)
//!
//! A spot observed at `t` therefore gets no weight at `t`; it is weighted only by the
//! time that elapses before the NEXT touch point. A crash staged and undone inside one
//! bundle has dt = 0 between its touch points → zero weight.
//!
//! What `v` and `w` are depends on whether the observation is exact:
//!
//! * Curve (`exact = true`). The curve price moves ONLY through FUMPAD buy/sell, so
//!   `last` (post-trade spot of the previous trade) is exactly the price that stood
//!   during [updated_at, t]. v = last, w = min(dt, WINDOW): an exact TWAP. To put
//!   weight on a crashed curve price the attacker must leave it standing, where anyone
//!   can buy the dumped tokens at the discount — i.e. it is a real price.
//!
//! * PumpSwap (`exact = false`: router swaps, keeper samples). Trades on PumpSwap
//!   itself are invisible, so `last` may be a momentary price an attacker staged
//!   ("dump → any FUMPAD touch → rebuy", leaving `last` crashed) right before the coin
//!   goes quiet. With a plain α = min(1, dt/600) the next touch after ≥10 idle minutes
//!   would set avg := last — a one-bundle setup, one-bundle exploit. Two rules close it:
//!
//!   - v = max(last, pre_spot). The interval [updated_at, t] is bracketed by two
//!     observations; folding the HIGHER one means a crashed `last` only gets weight if
//!     the observation that closes its interval is crashed too. Any honest touch point
//!     (a trade, a keeper heartbeat sample) closes the interval at the genuine price and
//!     zeroes the weight of the attacker's staged spot. Since the reference is only ever
//!     used as a FLOOR, biasing it upward is the safe direction.
//!   - w = min(dt, MAX_UNCONFIRMED_SECS) (150 s → α ≤ 1/4). However long a coin was idle,
//!     one interval moves the average at most 1/4 of the way. With a 20x staged crash,
//!     dragging the reference to 1/10 of the genuine price needs ≥ 11 consecutive
//!     intervals that BOTH start and end at attacker-staged crashed spots, each ≥ 150 s
//!     long: ~28 minutes in which no one else (no trader, no keeper heartbeat) touches the
//!     coin through FUMPAD, and ≥ 12 crash bundles, each paying PumpSwap fees on a dump of
//!     ~3.5x the pool's base reserve. The keeper heartbeat (SPEC §5.4) bounds such
//!     windows for every coin it samples.
//!
//!   Honest cost: after a long idle period on PumpSwap the reference lags a genuine move
//!   that happened while idle; it catches up over ~10–30 min of activity or keeper
//!   samples. Tickets in that period are priced conservatively (higher), never lower.
//!
//! Pumping instead of crashing raises the reference (by at most the same bounds), which
//! can only make tickets harder to claim. The reference is used for nothing else and
//! must not be: it is deliberately biased upward and is not a fair price.
//!
//! Rounding: the fold rounds the move toward `v` down — a decrease is never larger than
//! exact, an increase is short by < 1 Q64 unit. No intermediate can overflow.

use anchor_lang::prelude::*;

use super::price::mul_div_ceil;

/// Time constant / window of the reference average.
pub const REFERENCE_WINDOW_SECS: u64 = 600;
/// Max seconds of weight one non-exact (PumpSwap) interval can contribute (α ≤ 1/4).
pub const REFERENCE_MAX_UNCONFIRMED_SECS: u64 = 150;

/// Stored in `Coin.reference` (40 bytes carved out of the old `Coin.reserved`).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace)]
pub struct ReferencePrice {
    /// The reference average: lamports per base unit, Q64.64.
    pub avg_q64: u128,
    /// Spot recorded at the last touch point (post-trade / sampled), Q64.64.
    pub last_spot_q64: u128,
    /// Time of the last touch point; 0 = never initialized.
    pub updated_at: i64,
}

impl ReferencePrice {
    /// State at coin creation: the initial curve price.
    pub fn new(spot_q64: u128, now: i64) -> Self {
        Self { avg_q64: spot_q64, last_spot_q64: spot_q64, updated_at: now }
    }

    pub fn is_initialized(&self) -> bool {
        self.updated_at != 0
    }

    /// Apply one touch point at `now`: `pre_spot` = spot just before it (equals
    /// `post_spot` for a sample), `post_spot` = spot just after it. `exact` = curve.
    pub fn update(&mut self, now: i64, pre_spot_q64: u128, post_spot_q64: u128, exact: bool) {
        if !self.is_initialized() {
            // Unreachable for real coins (initialized in create_coin and carried through
            // graduation). Defensive: start from the higher observation (floor-safe).
            let s = pre_spot_q64.max(post_spot_q64);
            *self = Self::new(s, now);
            return;
        }
        // Solana's clock is monotonic in practice; never trust a negative dt anyway.
        let dt = now.saturating_sub(self.updated_at).max(0) as u64;
        let (v, w) = if exact {
            (self.last_spot_q64, dt.min(REFERENCE_WINDOW_SECS))
        } else {
            (self.last_spot_q64.max(pre_spot_q64), dt.min(REFERENCE_MAX_UNCONFIRMED_SECS))
        };
        self.avg_q64 = blend(self.avg_q64, v, w, REFERENCE_WINDOW_SECS);
        self.last_spot_q64 = post_spot_q64;
        self.updated_at = self.updated_at.max(now);
    }
}

/// avg + (v − avg) · w / window, moving toward `v` by a floored amount. `w ≤ window`.
fn blend(avg: u128, v: u128, w: u64, window: u64) -> u128 {
    let (w, d) = (w.min(window) as u128, window as u128);
    // diff·w/d without overflow: (diff/d)·w + (diff%d)·w/d, each term ≤ diff.
    let part = |diff: u128| (diff / d) * w + (diff % d) * w / d;
    if v >= avg {
        avg + part(v - avg)
    } else {
        avg - part(avg - v)
    }
}

/// D12 ticket price (refines D10): max(execution, reference × execution ÷ pre_trade_spot),
/// the second term rounded UP (protocol-favoring). See SPEC §5.3 / D12.
///
/// `execution ÷ pre_trade_spot` is the sell's own slippage (incl. venue fees) measured
/// from the spot that stood right before it; the floor is the reference scaled by that
/// ratio, i.e. the fill an honest seller of the same size would get at the reference.
/// * Flat market (reference = pre-trade spot): ticket = execution price, exactly.
/// * Crash staged before the sell (another wallet / a direct PumpSwap dump): the sell
///   executes near the crashed pre-trade spot, so the ratio ≈ 1 and the floor stays at
///   the reference — the D10 protection is intact.
/// * Pumping pre-trade spot only raises the execution price (the floor then never binds).
/// * A ratio > 1 (not reachable by a sell) can only raise the floor.
///
/// `pre_trade_spot_q64 == 0` (unknown) falls back to the D10 floor (the reference itself,
/// the higher of the two since a sell never executes above spot). An overflowing
/// quotient (impossible for real prices) saturates — again the higher price.
pub fn ticket_price_q64(execution_q64: u128, reference_q64: u128, pre_trade_spot_q64: u128) -> u128 {
    let floor = if pre_trade_spot_q64 == 0 {
        reference_q64
    } else {
        mul_div_ceil(reference_q64, execution_q64, pre_trade_spot_q64).unwrap_or(u128::MAX)
    };
    execution_q64.max(floor)
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: u128 = 1 << 64; // genuine price
    const CRASH: u128 = P / 20;

    fn at(avg: u128, t: i64) -> ReferencePrice {
        ReferencePrice::new(avg, t)
    }

    #[test]
    fn blend_math_and_rounding() {
        assert_eq!(blend(100, 200, 0, 600), 100);
        assert_eq!(blend(100, 200, 600, 600), 200);
        assert_eq!(blend(100, 200, 300, 600), 150);
        assert_eq!(blend(200, 100, 300, 600), 150);
        // Decrease rounds down in magnitude (avg stays higher).
        assert_eq!(blend(100, 0, 1, 600), 100);
        assert_eq!(blend(0, 100, 1, 600), 0);
        // Extremes don't overflow.
        assert_eq!(blend(0, u128::MAX, 600, 600), u128::MAX);
        assert_eq!(blend(u128::MAX, 0, 600, 600), 0);
        let h = blend(0, u128::MAX, 300, 600);
        assert!(h.abs_diff(u128::MAX / 2) <= 1);
        assert_eq!(blend(5, 7, 10_000, 600), 7); // w clamped
    }

    #[test]
    fn same_timestamp_observation_has_zero_weight() {
        // Bundle: crash → FUMPAD touch → (restore). All at the same t: avg untouched.
        for exact in [true, false] {
            let mut r = at(P, 1_000);
            r.update(1_300, P, P, exact); // honest touch, 5 min later
            let before = r.avg_q64;
            r.update(1_300, CRASH, CRASH, exact); // staged crash, same second
            assert_eq!(r.avg_q64, before);
            r.update(1_300, CRASH, CRASH, exact);
            assert_eq!(r.avg_q64, before);
            assert_eq!(r.avg_q64, P);
        }
    }

    #[test]
    fn idle_coin_staged_last_spot_is_neutralized() {
        // Attacker leaves a crashed `last` (post-touch) and the coin goes idle 1 day.
        let mut r = at(P, 1_000);
        r.update(2_000, CRASH, CRASH, false);
        // An honest touch (trade or keeper sample) at the genuine price closes the interval:
        // v = max(last, pre) = genuine → the staged spot got zero weight.
        r.update(2_000 + 86_400, P, P, false);
        assert_eq!(r.avg_q64, P);
        // Attacker-only touches at both ends: α ≤ 1/4 per interval regardless of idleness.
        let mut r = at(P, 1_000);
        r.update(2_000, CRASH, CRASH, false);
        r.update(2_000 + 86_400, CRASH, CRASH, false);
        let expect = P - (P - CRASH) / 4;
        assert!(r.avg_q64.abs_diff(expect) <= 1, "{} vs {expect}", r.avg_q64);
    }

    #[test]
    fn dragging_to_a_tenth_needs_eleven_staged_intervals() {
        let mut t = 1_000;
        let mut r = at(P, t);
        r.update(t, CRASH, CRASH, false);
        let mut n = 0;
        while r.avg_q64 * 10 > P {
            t += REFERENCE_MAX_UNCONFIRMED_SECS as i64;
            r.update(t, CRASH, CRASH, false);
            n += 1;
        }
        assert!(n >= 11, "only {n} intervals");
        assert!(t - 1_000 >= 11 * 150);
        // Shorter spacing doesn't help: weight is proportional to elapsed time.
        let mut t = 1_000;
        let mut r = at(P, t);
        r.update(t, CRASH, CRASH, false);
        while r.avg_q64 * 10 > P {
            t += 10;
            r.update(t, CRASH, CRASH, false);
        }
        assert!(t - 1_000 >= 1_500, "dragged in {}s", t - 1_000);
    }

    #[test]
    fn curve_is_an_exact_twap() {
        // Price P for 10 min, then a real (standing) drop to P/2: after a full window the
        // reference reaches it; halfway it's halfway.
        let mut r = at(P, 1_000);
        r.update(1_600, P, P / 2, true); // trade at t=1600 moves the curve to P/2
        assert_eq!(r.avg_q64, P);
        r.update(1_900, P / 2, P / 2, true);
        assert_eq!(r.avg_q64, P - P / 4);
        // A long idle period on the curve: `last` stood the whole time → avg := last.
        r.update(1_900 + 3_600, P / 2, P / 2, true);
        assert_eq!(r.avg_q64, P / 2);
    }

    #[test]
    fn genuine_slow_decline_is_tracked() {
        // Spot halves linearly over an hour, touched every 30 s (trades/samples).
        for exact in [true, false] {
            let mut r = at(P, 1_000);
            let mut prev = P;
            for i in 1..=120i64 {
                let spot = P - (P / 2) * i as u128 / 120;
                r.update(1_000 + i * 30, prev, spot, exact);
                prev = spot;
            }
            // A 10-min average lags a steady decline by ~rate × 600 s: here P/12 on top of
            // P/2 (≈ +17%), i.e. ≈ the spot of ~10 minutes ago, far below the start.
            assert!(r.avg_q64 >= prev, "floor never below spot in a decline");
            assert!(r.avg_q64 * 100 <= prev * 120, "lags too much: {} vs {prev}", r.avg_q64);
            assert!(r.avg_q64 * 100 <= P * 60);
        }
    }

    #[test]
    fn uninitialized_and_clock_skew() {
        let mut r = ReferencePrice::default();
        r.update(50, CRASH, P, false);
        assert_eq!(r, at(P, 50));
        // A timestamp before updated_at is treated as dt = 0 and never rewinds.
        r.update(40, CRASH, CRASH, false);
        assert_eq!((r.avg_q64, r.updated_at), (P, 50));
    }

    #[test]
    fn d12_ticket_price() {
        // Unknown pre-trade spot → D10 rule.
        assert_eq!(ticket_price_q64(5, 7, 0), 7);
        assert_eq!(ticket_price_q64(9, 7, 0), 9);
        // Flat market (reference == pre-trade spot): exactly the execution price, any size.
        for exec in [P / 2, P * 9 / 10, P - 1, P] {
            assert_eq!(ticket_price_q64(exec, P, P), exec);
        }
        // Rising market (reference below spot): execution price.
        assert_eq!(ticket_price_q64(P * 99 / 100, P / 2, P), P * 99 / 100);
        // Staged crash: pre-trade spot 20x below the reference, the sell fills 1% under it
        // → the floor is 99% of the reference, ~19.8x the execution price.
        let pre = CRASH;
        let exec = pre * 99 / 100;
        let t = ticket_price_q64(exec, P, pre);
        assert!(t + P / 1_000_000 >= P * 99 / 100 && t <= P, "{t}");
        assert!(t > exec * 19);
        // Rounds up: 3 × 2 / 4 = 1.5 → 2.
        assert_eq!(ticket_price_q64(2, 3, 4), 2);
        assert_eq!(ticket_price_q64(1, 3, 2), 2);
        // A ratio > 1 only raises the floor; extremes saturate instead of overflowing.
        assert_eq!(ticket_price_q64(4, 10, 2), 20);
        assert_eq!(ticket_price_q64(u128::MAX, u128::MAX, 1), u128::MAX);
        // Wide intermediate (Q64 × Q64 overflows u128).
        let big = u128::MAX / 3;
        assert_eq!(ticket_price_q64(big / 2, big, big), big / 2);
    }

    /// Crash-staging can't beat the floor: whatever the pre-trade spot, the ticket is ≥
    /// reference × (the sell's own slippage ratio); a smaller crashed pool only makes that
    /// ratio closer to 1. Constant-product model, fee-less, sale of `s` into base `x`.
    #[test]
    fn d12_crash_raises_ratio() {
        let reference = P;
        let x = 1_000_000u128;
        let s = 50_000u128;
        // exec/pre = x / (x + s) for a fee-less constant-product sell.
        let ratio = |base: u128| (base, base + s);
        let mut last = 0u128;
        for crash in [1u128, 4, 9, 16, 25] {
            // A k-preserving crash by `crash`x multiplies base by √crash.
            let base = x * (crash as f64).sqrt() as u128;
            let (num, den) = ratio(base);
            let pre = P / crash;
            let exec = pre * num / den;
            let t = ticket_price_q64(exec, reference, pre);
            assert!(t * den * 1_000_001 >= reference * num * 1_000_000, "floor = reference × own slippage");
            assert!(t >= last, "a deeper crash never lowers the ticket");
            last = t;
        }
    }
}
