use anchor_lang::prelude::*;

use crate::constants::{ATTEST_BUCKET_SECS, BPS_DENOM};
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

    /// D31 rate cap: sliding hour = current bucket + weighted previous bucket.
    pub attest_bucket_start: i64,
    pub attest_bucket_tokens: u64,
    pub attest_prev_bucket_tokens: u64,

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

    /// D31 rate cap: tokens attested in the sliding hour ending at `now` (current bucket + the previous bucket
    /// weighted by the part of it still inside the hour), after rolling the buckets forward to `now`.
    pub fn roll_attest_buckets(&mut self, now: i64) {
        let bucket = now.div_euclid(ATTEST_BUCKET_SECS) * ATTEST_BUCKET_SECS;
        if bucket != self.attest_bucket_start {
            self.attest_prev_bucket_tokens = if bucket == self.attest_bucket_start + ATTEST_BUCKET_SECS {
                self.attest_bucket_tokens
            } else {
                0
            };
            self.attest_bucket_tokens = 0;
            self.attest_bucket_start = bucket;
        }
    }

    /// Whether `tokens` more fit the hourly cap (`cap_bps` of supply). Call `roll_attest_buckets` first.
    pub fn attest_fits(&self, now: i64, tokens: u64, cap_bps: u16) -> bool {
        let into = (now - self.attest_bucket_start).clamp(0, ATTEST_BUCKET_SECS) as u128;
        let prev = (self.attest_prev_bucket_tokens as u128) * (ATTEST_BUCKET_SECS as u128 - into)
            / ATTEST_BUCKET_SECS as u128;
        let cap = (self.total_supply as u128) * cap_bps as u128 / BPS_DENOM as u128;
        prev + self.attest_bucket_tokens as u128 + tokens as u128 <= cap
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
    fn rate_cap_sliding_hour() {
        let mut c = coin();
        let cap = 2_000; // 20% of 1,000,000 = 200,000
        let t0 = 7_200; // bucket start
        c.roll_attest_buckets(t0);
        assert!(c.attest_fits(t0, 200_000, cap));
        assert!(!c.attest_fits(t0, 200_001, cap));
        c.attest_bucket_tokens = 150_000;
        assert!(!c.attest_fits(t0 + 10, 50_001, cap));
        // Next bucket, 30 min in: previous counts half (75,000).
        let t1 = t0 + 3_600 + 1_800;
        c.roll_attest_buckets(t1);
        assert_eq!((c.attest_prev_bucket_tokens, c.attest_bucket_tokens), (150_000, 0));
        assert!(c.attest_fits(t1, 125_000, cap));
        assert!(!c.attest_fits(t1, 125_001, cap));
        // Two buckets later: the old one is gone.
        let t2 = t0 + 3 * 3_600;
        c.roll_attest_buckets(t2);
        assert_eq!((c.attest_prev_bucket_tokens, c.attest_bucket_tokens), (0, 0));
    }
}
