use anchor_lang::prelude::*;

use crate::constants::{ATTEST_CAP_WINDOW_SECS, BPS_DENOM};
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

    pub reserved: [u8; 64],
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
