// Bonding curve math. OWNER: curve module.
//
// Constant product on virtual reserves (pump.fun style), u128 intermediates,
// every rounding in the protocol's favor. Pure functions only — no account access —
// so they can be property-tested in isolation.
//
// Model. `virtual_sol` (x) and `virtual_token` (y) define the price; `k = x·y`.
// `real_sol` / `real_token` are what the curve actually holds. Every trade moves the
// virtual and real reserves by the SAME amounts, so `virtual_sol − real_sol` (= the
// initial virtual SOL) and `virtual_token − real_token` (= initial virtual tokens −
// curve supply) stay constant for the life of the curve.
//
// Rounding (all in the protocol's favor; each makes `k` non-decreasing):
//   buy  : tokens_out = ⌊y·s / (x + s)⌋
//   last buy (tokens capped at real_token = t): sol_used = ⌈x·t / (y − t)⌉ ≤ s
//   sell : sol_out    = ⌊x·t / (y + t)⌋, additionally capped by real_sol
//
// Fees are NOT handled here — see `math::fees` and the instruction handlers.
use crate::math::fees::ceil_div;

/// Curve reserves of one coin (a copy of the four `Coin` fields).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CurveReserves {
    pub virtual_sol: u64,
    pub virtual_token: u64,
    pub real_sol: u64,
    pub real_token: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BuyQuote {
    /// Lamports actually taken by the curve (≤ the requested amount; < only for the
    /// buy that empties the curve).
    pub sol_used: u64,
    pub tokens_out: u64,
    /// This buy took the last real token: the curve is complete.
    pub completes: bool,
}

/// Quote a buy of up to `sol_in` lamports. Returns None on overflow or on an
/// inconsistent curve (`virtual_token ≤ real_token`). A zero `sol_in` or an empty
/// curve quotes zero.
pub fn quote_buy(r: &CurveReserves, sol_in: u64) -> Option<BuyQuote> {
    if r.virtual_token <= r.real_token || r.virtual_sol == 0 {
        return None;
    }
    if sol_in == 0 || r.real_token == 0 {
        return Some(BuyQuote::default());
    }
    let x = r.virtual_sol as u128;
    let y = r.virtual_token as u128;
    let s = sol_in as u128;
    let raw = y.checked_mul(s)?.checked_div(x.checked_add(s)?)?;
    if raw < r.real_token as u128 {
        return Some(BuyQuote { sol_used: sol_in, tokens_out: u64::try_from(raw).ok()?, completes: false });
    }
    // Partial fill: take exactly the remaining real tokens; charge the (rounded-up)
    // cost of those tokens. Since raw ≥ t ⇒ t·(x+s) ≤ y·s ⇒ x·t ≤ s·(y−t) ⇒ cost ≤ s.
    let t = r.real_token as u128;
    let cost = ceil_div(x.checked_mul(t)?, y.checked_sub(t)?)?;
    debug_assert!(cost <= s);
    Some(BuyQuote { sol_used: u64::try_from(cost).ok()?, tokens_out: r.real_token, completes: true })
}

/// Quote a sell of `tokens_in`: lamports out of the curve (before FUMPAD's fee).
/// None on overflow or if the curve cannot pay (output above `real_sol`).
pub fn quote_sell(r: &CurveReserves, tokens_in: u64) -> Option<u64> {
    if tokens_in == 0 {
        return Some(0);
    }
    let x = r.virtual_sol as u128;
    let y = r.virtual_token as u128;
    let t = tokens_in as u128;
    let out = x.checked_mul(t)?.checked_div(y.checked_add(t)?)?;
    let out = u64::try_from(out).ok()?;
    if out > r.real_sol {
        return None;
    }
    Some(out)
}

/// Exact lamports needed to buy `tokens_out` tokens (inverse quote, for clients
/// and tests). None if `tokens_out ≥ real_token` would exceed the curve or overflow.
pub fn sol_for_tokens(r: &CurveReserves, tokens_out: u64) -> Option<u64> {
    if tokens_out > r.real_token {
        return None;
    }
    let x = r.virtual_sol as u128;
    let y = r.virtual_token as u128;
    let t = tokens_out as u128;
    u64::try_from(ceil_div(x.checked_mul(t)?, y.checked_sub(t)?)?).ok()
}

impl CurveReserves {
    /// Apply a buy quote. Checked; None means the quote didn't come from these reserves.
    pub fn apply_buy(&mut self, q: &BuyQuote) -> Option<()> {
        self.virtual_sol = self.virtual_sol.checked_add(q.sol_used)?;
        self.real_sol = self.real_sol.checked_add(q.sol_used)?;
        self.virtual_token = self.virtual_token.checked_sub(q.tokens_out)?;
        self.real_token = self.real_token.checked_sub(q.tokens_out)?;
        Some(())
    }

    /// Apply a sell of `tokens_in` for `sol_out`.
    pub fn apply_sell(&mut self, tokens_in: u64, sol_out: u64) -> Option<()> {
        self.virtual_sol = self.virtual_sol.checked_sub(sol_out)?;
        self.real_sol = self.real_sol.checked_sub(sol_out)?;
        self.virtual_token = self.virtual_token.checked_add(tokens_in)?;
        self.real_token = self.real_token.checked_add(tokens_in)?;
        Some(())
    }

    /// Spot price, lamports per base unit, Q64.64.
    pub fn spot_price_q64(&self) -> Option<u128> {
        crate::math::price::price_q64(self.virtual_sol, self.virtual_token)
    }

    pub fn k(&self) -> u128 {
        self.virtual_sol as u128 * self.virtual_token as u128
    }
}

/// Fresh curve for a new coin.
pub fn initial_reserves(initial_virtual_sol: u64, initial_virtual_token: u64, curve_supply: u64) -> CurveReserves {
    CurveReserves {
        virtual_sol: initial_virtual_sol,
        virtual_token: initial_virtual_token,
        real_sol: 0,
        real_token: curve_supply,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Params;

    /// xorshift64* — deterministic, dependency-free randomness for property tests.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            self.0 = x;
            x.wrapping_mul(0x2545_f491_4f6c_dd1d)
        }
        /// Log-uniform in [1, max] so tiny and huge amounts both get exercised.
        fn amount(&mut self, max: u64) -> u64 {
            let bits = (self.next() % 64) as u32;
            let cap = if bits >= 63 { max } else { max.min((1u64 << (bits + 1)) - 1) };
            1 + self.next() % cap.max(1)
        }
    }

    fn fresh() -> CurveReserves {
        let p = Params::default();
        initial_reserves(p.initial_virtual_sol, p.initial_virtual_token, p.curve_supply)
    }

    /// Structural invariants that must hold after every trade.
    fn check_invariants(r: &CurveReserves, k0: u128) {
        let p = Params::default();
        assert!(r.k() >= k0, "k decreased");
        assert_eq!(r.virtual_sol - r.real_sol, p.initial_virtual_sol, "sol offset drifted");
        assert_eq!(
            r.virtual_token - r.real_token,
            p.initial_virtual_token - p.curve_supply,
            "token offset drifted"
        );
        assert!(r.real_token <= p.curve_supply);
    }

    #[test]
    fn basic_buy_sell() {
        let r = fresh();
        let q = quote_buy(&r, 1_000_000_000).unwrap();
        // ~1 SOL at 30 SOL virtual ≈ 1/31 of 1,019M tokens ≈ 32.9M tokens.
        assert_eq!(q.tokens_out, (r.virtual_token as u128 * 1_000_000_000 / 31_000_000_000) as u64);
        assert!(!q.completes);
        assert_eq!(q.sol_used, 1_000_000_000);
        let mut r2 = r;
        r2.apply_buy(&q).unwrap();
        let back = quote_sell(&r2, q.tokens_out).unwrap();
        assert!(back <= q.sol_used);
        assert!(q.sol_used - back <= 1);
    }

    #[test]
    fn zero_and_degenerate_inputs() {
        let r = fresh();
        assert_eq!(quote_buy(&r, 0).unwrap(), BuyQuote::default());
        assert_eq!(quote_sell(&r, 0).unwrap(), 0);
        // Selling into a curve that holds no real SOL cannot pay out.
        assert_eq!(quote_sell(&r, 1_000_000), None);
        let empty = CurveReserves { real_token: 0, ..r };
        assert_eq!(quote_buy(&empty, 1_000).unwrap(), BuyQuote::default());
        let broken = CurveReserves { virtual_token: r.real_token, ..r };
        assert_eq!(quote_buy(&broken, 1_000), None);
        // Dust buy rounds to zero tokens (handler rejects it).
        let mut big = r;
        big.virtual_sol = u64::MAX / 2;
        assert_eq!(quote_buy(&big, 1).unwrap().tokens_out, 0);
        // Max inputs don't panic.
        assert!(quote_buy(&r, u64::MAX).unwrap().completes);
    }

    #[test]
    fn exhaustion_is_exact_and_partial() {
        let r = fresh();
        // Way more SOL than needed: the buy is capped to the curve.
        let q = quote_buy(&r, 1_000 * 1_000_000_000).unwrap();
        assert!(q.completes);
        assert_eq!(q.tokens_out, r.real_token);
        assert_eq!(q.sol_used, sol_for_tokens(&r, r.real_token).unwrap());
        let mut done = r;
        done.apply_buy(&q).unwrap();
        assert_eq!(done.real_token, 0);
        assert!(done.k() >= r.k());
        // ≈ 85 SOL raised (graduation_lamports), within rounding.
        let target = Params::default().graduation_lamports;
        assert!(done.real_sol.abs_diff(target) <= 2, "raised {} vs {target}", done.real_sol);
        // Paying exactly the quoted cost also completes; one lamport less does not.
        let exact = quote_buy(&r, q.sol_used).unwrap();
        assert!(exact.completes && exact.sol_used == q.sol_used);
        let short = quote_buy(&r, q.sol_used - 1).unwrap();
        assert!(!short.completes && short.tokens_out < r.real_token);
    }

    #[test]
    fn prop_random_trades_preserve_invariants() {
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
        for _run in 0..200 {
            let mut r = fresh();
            let k0 = r.k();
            // Tokens held by "the market" (sold out of the curve).
            let mut held: u64 = 0;
            let mut sol_in_total: u128 = 0;
            let mut sol_out_total: u128 = 0;
            for _ in 0..60 {
                if r.real_token == 0 {
                    break;
                }
                if rng.next() % 2 == 0 || held == 0 {
                    let s = rng.amount(40_000_000_000);
                    let q = quote_buy(&r, s).unwrap();
                    assert!(q.sol_used <= s);
                    if q.tokens_out == 0 {
                        continue;
                    }
                    let before = r;
                    r.apply_buy(&q).unwrap();
                    assert!(r.k() >= before.k());
                    held += q.tokens_out;
                    sol_in_total += q.sol_used as u128;
                } else {
                    let t = 1 + rng.next() % held;
                    let out = quote_sell(&r, t).expect("curve must always be able to buy back circulating tokens");
                    let before = r;
                    r.apply_sell(t, out).unwrap();
                    assert!(r.k() >= before.k());
                    held -= t;
                    sol_out_total += out as u128;
                }
                check_invariants(&r, k0);
                // Conservation: real SOL == in − out; tokens held + real tokens == curve supply.
                assert_eq!(r.real_sol as u128, sol_in_total - sol_out_total);
                assert_eq!(held + r.real_token, Params::default().curve_supply);
            }
            // No free value: dumping everything never returns more than was paid in.
            if held > 0 {
                let out = quote_sell(&r, held).unwrap();
                assert!(sol_out_total + out as u128 <= sol_in_total);
            }
        }
    }

    #[test]
    fn prop_round_trip_never_profits() {
        let mut rng = Rng(42);
        for _ in 0..2_000 {
            // Random starting point on the curve.
            let mut r = fresh();
            let pre = rng.amount(80_000_000_000);
            let q0 = quote_buy(&r, pre).unwrap();
            r.apply_buy(&q0).unwrap();
            if r.real_token == 0 {
                continue;
            }
            let s = rng.amount(100_000_000_000);
            let q = quote_buy(&r, s).unwrap();
            if q.tokens_out == 0 {
                continue;
            }
            let mut r2 = r;
            r2.apply_buy(&q).unwrap();
            let back = quote_sell(&r2, q.tokens_out).unwrap();
            assert!(back <= q.sol_used, "round trip profit: in {} out {back}", q.sol_used);
            // Splitting a buy in two never yields more tokens than one buy.
            let half = s / 2;
            let a = quote_buy(&r, half).unwrap();
            let mut r3 = r;
            r3.apply_buy(&a).unwrap();
            let b = quote_buy(&r3, s - half).unwrap();
            if !q.completes {
                assert!(a.tokens_out + b.tokens_out <= q.tokens_out);
            }
        }
    }

    #[test]
    fn prop_sell_then_buy_back_never_profits() {
        let mut rng = Rng(7);
        for _ in 0..2_000 {
            let mut r = fresh();
            let q0 = quote_buy(&r, rng.amount(84_000_000_000)).unwrap();
            r.apply_buy(&q0).unwrap();
            if q0.tokens_out == 0 {
                continue;
            }
            let t = 1 + rng.next() % q0.tokens_out;
            let out = quote_sell(&r, t).unwrap();
            let mut r2 = r;
            r2.apply_sell(t, out).unwrap();
            // Spending the proceeds buys back at most what was sold.
            let q = quote_buy(&r2, out).unwrap();
            assert!(q.tokens_out <= t);
        }
    }

    #[test]
    fn prop_exhaustion_from_any_state() {
        let mut rng = Rng(1234);
        for _ in 0..2_000 {
            let mut r = fresh();
            let q0 = quote_buy(&r, rng.amount(84_000_000_000)).unwrap();
            r.apply_buy(&q0).unwrap();
            if r.real_token == 0 {
                continue;
            }
            let need = sol_for_tokens(&r, r.real_token).unwrap();
            let extra = rng.amount(10_000_000_000);
            let q = quote_buy(&r, need.saturating_add(extra)).unwrap();
            assert!(q.completes);
            assert_eq!(q.sol_used, need);
            assert_eq!(q.tokens_out, r.real_token);
            let before = r;
            r.apply_buy(&q).unwrap();
            assert!(r.k() >= before.k());
            assert_eq!(r.real_token, 0);
        }
    }

    /// The curve's final spot price must equal the PumpSwap opening price
    /// (raised SOL / LP tokens) with default params: no price jump at graduation.
    #[test]
    fn graduation_price_continuity_default_params() {
        let p = Params::default();
        let mut r = fresh();
        // Fill the curve in many uneven steps (rounding accumulates like real trading).
        let mut rng = Rng(99);
        loop {
            let q = quote_buy(&r, rng.amount(3_000_000_000)).unwrap();
            r.apply_buy(&q).unwrap();
            if q.completes {
                break;
            }
        }
        assert_eq!(r.real_token, 0);
        let curve_price = r.spot_price_q64().unwrap();
        let lp_sol = r.real_sol - p.graduation_fee_lamports;
        let lp_price = crate::math::price::price_q64(lp_sol, p.lp_supply).unwrap();
        let diff = curve_price.abs_diff(lp_price);
        // Within 1 ppm.
        assert!(diff * 1_000_000 <= curve_price, "curve {curve_price} vs lp {lp_price}");
        // And the raised SOL is ~85 SOL.
        assert!(r.real_sol.abs_diff(p.graduation_lamports) < 1_000, "raised {}", r.real_sol);
        // Start → graduation price ratio ≈ 14.7x (SPEC §3).
        let start = fresh().spot_price_q64().unwrap();
        let ratio_x100 = curve_price * 100 / start;
        assert!((1460..=1480).contains(&ratio_x100), "ratio {ratio_x100}");
    }
}
