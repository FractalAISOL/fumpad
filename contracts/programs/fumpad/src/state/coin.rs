use anchor_lang::prelude::*;

use crate::constants::{
    ATTEST_CAP_WINDOW_SECS, BPS_DENOM, PREGRAD_MIN_SAMPLES, PREGRAD_MIN_SPAN_SECS, PREGRAD_RING_LEN, PREGRAD_WINDOW_SECS,
};
use crate::state::{FeeSplitBps, Params, RewardTerms};

/// One per registered coin. PDA ["coin", mint]. v0.7 fresh layout (D39).
///
/// Lamport accounting: this account's lamports always equal
///   rent_exempt_minimum + creator_fees_unclaimed + platform_fees_unclaimed + buyback_lamports
/// (tested as an invariant). Claimed partner fees are unwrapped into it and leave only through those counters.
#[account]
#[derive(InitSpace)]
pub struct Coin {
    pub bump: u8,
    pub status: CoinStatus,
    /// D33: false until the first `claim_fees` (which sends 100% of what it claims to the buyback balance).
    pub launch_fees_settled: bool,
    pub mint: Pubkey,
    pub creator: Pubkey,
    /// Meteora DBC virtual pool (curve).
    pub dbc_pool: Pubkey,
    /// The pool's DBC config (on `Global.configs` at registration).
    pub dbc_config: Pubkey,
    /// DAMM v2 pool, recorded by `graduate`.
    pub damm_pool: Pubkey,
    /// DAMM v2 position (NFT owned by the `fee_claimer` PDA, 100% permanently locked), recorded by `graduate`.
    pub damm_position: Pubkey,
    /// DBC pool activation slot (= the launch slot).
    pub launch_slot: u64,
    /// DBC fee-scheduler length in slots (anti-snipe window, D33).
    pub launch_window_slots: u64,
    pub created_at: i64,
    pub completed_at: i64,
    pub graduated_at: i64,
    /// DBC fixed supply (pre-migration token supply).
    pub total_supply: u64,

    // Fee accounting (lamports held by this account)
    pub creator_fees_unclaimed: u64,
    pub platform_fees_unclaimed: u64,
    /// Waiting for `execute_buyback`.
    pub buyback_lamports: u64,

    // Stats (informational)
    pub fees_claimed_lamports: u64,
    pub buyback_spent_lamports: u64,
    pub buyback_tokens: u64,
    pub router_volume_lamports: u64,
    pub router_trade_count: u64,
    pub tickets_created: u64,
    pub tokens_paid_out: u64,

    /// M-1: reward terms snapshotted at `register_coin`.
    pub rewards: RewardTerms,
    /// D32: fee split snapshotted at `register_coin`.
    pub fee_split: FeeSplitBps,

    /// D31 rate cap (REVIEW-v0.7 M-1): a leaky bucket that DEFERS, never rejects. `attest_cursor` = when the
    /// attested-token backlog has drained at `max_attest_tokens_per_hour_bps` of supply per hour. Each ticket adds
    /// `tokens × 1 h / cap` seconds; it becomes effective (its challenge window starts) at
    /// `max(now, cursor_after − 1 h)`, so up to one hour's cap is effective at once and the rest is spread out.
    pub attest_cursor: i64,
    /// Cumulative ticket tokens attested (stats).
    pub attest_tokens_total: u64,
    /// Cumulative ticket tokens released from the backlog by rebuy debits / guardian voids (stats).
    pub attest_released_tokens: u64,

    /// SPEC v0.7 §3.4/§6: last keeper pre-graduation sample (DBC spot) — pre-grad buyback guard only.
    pub pregrad_sample_price_q64: u128,
    pub pregrad_sample_ts: i64,

    /// D34: who paid DBC's migration flash rent through `migrate_pool`, and how much (refunded by `graduate`).
    pub migrator: Pubkey,
    pub migrator_cost: u64,
    /// Partner migration fee + partner surplus claimed by `graduate` (lamports).
    pub migration_fee_lamports: u64,
    /// D35: tokens `withdraw_leftover` moved into the reward vault (measured).
    pub leftover_tokens: u64,

    /// L5: the last `PREGRAD_RING_LEN` keeper pre-graduation samples (incl. the one above). The pre-grad buyback
    /// guard is their median (≥ `PREGRAD_MIN_SAMPLES` within `PREGRAD_WINDOW_SECS`, spanning ≥
    /// `PREGRAD_MIN_SPAN_SECS`). Carved out of the former 64 reserved bytes (Coin size unchanged; zeroed = empty).
    pub pregrad_ring: PregradRing,
    /// 2026-10-14: the config's fee policy kind at `register_coin` (`FEE_POLICY_*`; 0 = standard = `fee_split`).
    /// Non-zero: the whole policy is snapshotted in the account's tail (`state::fee_policy`, the account is
    /// `COIN_POLICY_TAIL_LEN` bytes longer) and `fee_split` is unused (zero). Carved out of `reserved` (the borsh
    /// Coin is unchanged; zeroed = standard, so existing coins read standard).
    pub fee_policy_kind: u8,
    pub reserved: [u8; 1],
}

/// L5: ring of recent keeper pre-graduation DBC spot samples (62 bytes).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace)]
pub struct PregradRing {
    /// DBC spot, Q64.64, saturated to `u64::MAX`. A curve coin trades far below 1 lamport per base unit
    /// (q64 < 2^64), so saturation never happens in practice; if it did, the median would be too low and the guard
    /// fails closed (spot out of band → no buyback).
    pub prices_q64: [u64; PREGRAD_RING_LEN],
    /// Unix seconds of each sample (u32: valid until 2106).
    pub ts: [u32; PREGRAD_RING_LEN],
    /// Next slot to write.
    pub head: u8,
    /// Filled slots (≤ `PREGRAD_RING_LEN`).
    pub len: u8,
}

impl PregradRing {
    pub fn push(&mut self, now: i64, price_q64: u128) {
        let i = (self.head as usize) % PREGRAD_RING_LEN;
        self.prices_q64[i] = u64::try_from(price_q64).unwrap_or(u64::MAX);
        self.ts[i] = now.clamp(0, u32::MAX as i64) as u32;
        self.head = ((i + 1) % PREGRAD_RING_LEN) as u8;
        self.len = (self.len as usize + 1).min(PREGRAD_RING_LEN) as u8;
    }

    /// Median of the samples taken in `[now − PREGRAD_WINDOW_SECS, now]`, if there are ≥ `PREGRAD_MIN_SAMPLES`
    /// of them spanning ≥ `PREGRAD_MIN_SPAN_SECS` (even count: mean of the two middle values).
    #[inline(never)]
    pub fn median_q64(&self, now: i64) -> Option<u128> {
        let mut v = [0u64; PREGRAD_RING_LEN];
        let (mut n, mut lo, mut hi) = (0usize, i64::MAX, i64::MIN);
        for i in 0..(self.len as usize).min(PREGRAD_RING_LEN) {
            let ts = self.ts[i] as i64;
            if ts > now || now - ts > PREGRAD_WINDOW_SECS {
                continue;
            }
            v[n] = self.prices_q64[i];
            n += 1;
            lo = lo.min(ts);
            hi = hi.max(ts);
        }
        if n < PREGRAD_MIN_SAMPLES || hi - lo < PREGRAD_MIN_SPAN_SECS {
            return None;
        }
        let v = &mut v[..n];
        v.sort_unstable();
        Some(if n % 2 == 1 { v[n / 2] as u128 } else { (v[n / 2 - 1] as u128 + v[n / 2] as u128) / 2 })
    }
}

impl Coin {
    /// Reward params of this coin: `global` with the coin's snapshotted reward terms applied (M-1).
    pub fn reward_params(&self, global: &Params) -> Params {
        let r = &self.rewards;
        Params {
            trigger_multiple_bps: r.trigger_multiple_bps,
            claim_bps: r.claim_bps,
            max_claim_pool_bps: r.max_claim_pool_bps,
            min_sell_usd_cents: r.min_sell_usd_cents,
            min_hold_secs: r.min_hold_secs,
            rebuy_window_secs: r.rebuy_window_secs,
            claim_window_secs: r.claim_window_secs,
            max_open_tickets: r.max_open_tickets,
            ..*global
        }
    }

    /// Seconds of rate-cap capacity `tokens` take (`cap_bps` of supply per hour). Rounded up when charging,
    /// down when releasing.
    fn attest_secs(&self, tokens: u64, cap_bps: u16, round_up: bool) -> i64 {
        let cap = ((self.total_supply as u128) * cap_bps as u128 / BPS_DENOM as u128).max(1);
        let num = (tokens as u128) * ATTEST_CAP_WINDOW_SECS as u128;
        let secs = if round_up { num.div_ceil(cap) } else { num / cap };
        secs.min(i64::MAX as u128 / 4) as i64
    }

    /// M-1: schedule `tokens` attested at `now`; returns the ticket's effective time (≥ now). Never rejects.
    pub fn schedule_attest(&mut self, now: i64, tokens: u64, cap_bps: u16) -> i64 {
        let start = self.attest_cursor.max(now);
        self.attest_cursor = start.saturating_add(self.attest_secs(tokens, cap_bps, true));
        self.attest_tokens_total = self.attest_tokens_total.saturating_add(tokens);
        now.max(self.attest_cursor.saturating_sub(ATTEST_CAP_WINDOW_SECS))
    }

    /// M-1: give back the capacity of `tokens` of a ticket (effective at `effective_at`) that a rebuy debit or a
    /// guardian void just cancelled, while its tokens still count (effective less than an hour ago, or later)
    /// and there is a backlog to shrink. Released capacity is re-used at the end of the backlog.
    pub fn release_attest(&mut self, now: i64, tokens: u64, cap_bps: u16, effective_at: i64) {
        if tokens == 0 || self.attest_cursor <= now || effective_at.saturating_add(ATTEST_CAP_WINDOW_SECS) <= now {
            return;
        }
        self.attest_cursor = self.attest_cursor.saturating_sub(self.attest_secs(tokens, cap_bps, false)).max(now);
        self.attest_released_tokens = self.attest_released_tokens.saturating_add(tokens);
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum CoinStatus {
    /// DBC curve trading.
    Curve,
    /// The router saw the curve complete; waiting for migration + `graduate`.
    Complete,
    /// DAMM v2 pool recorded; claims enabled.
    Graduated,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coin() -> Coin {
        let mut c: Coin = unsafe { core::mem::zeroed() };
        c.status = CoinStatus::Curve;
        c.total_supply = 1_000_000;
        c
    }

    #[test]
    fn pregrad_ring_median_needs_count_and_span() {
        let mut r = PregradRing::default();
        let t = 1_000_000;
        let q = 1u128 << 50;
        // Warm-up: 3 samples are not enough; 4 spanning < 60 s neither.
        for (k, dt) in [0, 15, 30].iter().enumerate() {
            r.push(t + dt, q + k as u128);
            assert_eq!(r.median_q64(t + dt), None);
        }
        r.push(t + 45, q);
        assert_eq!(r.median_q64(t + 45), None, "span 45 s < 60 s");
        r.push(t + 60, q);
        // samples q, q+1, q+2, q, q → sorted median = q
        assert_eq!(r.median_q64(t + 60), Some(q));
        // One manipulated sample (×10) can't move the median outside the honest values.
        r.push(t + 75, q * 10);
        assert_eq!(r.len as usize, PREGRAD_RING_LEN);
        let m = r.median_q64(t + 75).unwrap();
        assert!(m >= q && m <= q + 2, "{m}");
        // Two outliers out of five still can't (median = third value).
        r.push(t + 90, q * 10);
        let m = r.median_q64(t + 90).unwrap();
        assert!(m >= q && m <= q + 2, "{m}");
        // Samples older than the window drop out: only the 2 newest remain → None.
        assert_eq!(r.median_q64(t + 60 + PREGRAD_WINDOW_SECS + 1), None);
        // Even count: mean of the two middle values.
        let mut r = PregradRing::default();
        for (i, p) in [4u128, 1, 3, 2].iter().enumerate() {
            r.push(t + 20 * i as i64, *p * q);
        }
        assert_eq!(r.median_q64(t + 60), Some(q * 5 / 2));
        // Saturation fails closed (too low).
        let mut r = PregradRing::default();
        r.push(t, u128::MAX);
        assert_eq!(r.prices_q64[0], u64::MAX);
    }

    #[test]
    fn rate_cap_defers_and_releases() {
        let mut c = coin();
        let cap = 2_000; // 20% of 1,000,000 = 200,000 per hour
        let t0 = 7_200;
        // A full hour's cap is effective at once.
        assert_eq!(c.schedule_attest(t0, 200_000, cap), t0);
        assert_eq!(c.attest_cursor, t0 + 3_600);
        // The next 100,000 (half an hour of cap) is deferred by 30 min — accepted, not rejected.
        assert_eq!(c.schedule_attest(t0, 100_000, cap), t0 + 1_800);
        // Releasing it (voided right away) gives the capacity back.
        c.release_attest(t0 + 10, 100_000, cap, t0 + 1_800);
        assert_eq!(c.attest_cursor, t0 + 3_600);
        assert_eq!(c.schedule_attest(t0 + 10, 50_000, cap), t0 + 900);
        // Drained after the backlog: effective immediately again.
        let t1 = t0 + 3 * 3_600;
        assert_eq!(c.schedule_attest(t1, 200_000, cap), t1);
        // A ticket that became effective more than an hour ago releases nothing.
        let before = c.attest_cursor;
        c.release_attest(t1 + 10, 200_000, cap, t1 - 3_600);
        assert_eq!(c.attest_cursor, before);
        // No backlog → nothing to release; the cursor never goes below now.
        c.release_attest(t1 + 10, 1_000_000, cap, t1);
        assert_eq!(c.attest_cursor, t1 + 10);
        assert_eq!((c.attest_tokens_total, c.attest_released_tokens), (550_000, 1_100_000));
    }
}
