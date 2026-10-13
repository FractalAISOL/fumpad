use anchor_lang::prelude::*;

use crate::constants::*;

/// Singleton config. PDA ["global"]. v0.7 fresh layout (D39).
#[account]
#[derive(InitSpace)]
pub struct Global {
    pub bump: u8,
    /// Squads multisig in production: queues params/configs (48h), proposes authority changes (48h), sets keepers,
    /// pauses, migrates the layout.
    pub admin: Pubkey,
    /// Receives platform fees (`withdraw_platform_fees`).
    pub platform_treasury: Pubkey,
    /// M-2: may only stop things (`set_pause`, `cancel_*`, `void_ticket`).
    pub guardian: Pubkey,
    /// Keeper keys (samples, auto-claim, attestations). Pubkey::default() = empty slot.
    pub keepers: [Pubkey; MAX_KEEPERS],
    /// When each keeper slot got its current key (`set_keepers`); its attestation signatures count only after
    /// `KEEPER_ATTEST_FREEZE_SECS`.
    pub keeper_added_at: [i64; MAX_KEEPERS],
    /// Part of every attestation message (0 mainnet-beta, 1 devnet, 2 localnet/test). Set once at init.
    pub cluster_tag: u8,
    /// Bitmask of `PAUSE_*` flags; in force only until `pause_expires_at` (M-3).
    pub paused: u8,
    pub pause_expires_at: i64,
    pub params: Params,
    /// D15: params queued by `queue_params`; `pending_eta == 0` = nothing queued.
    pub pending_params: Params,
    pub pending_eta: i64,
    /// M-2: authority set proposed by `propose_admin`.
    pub pending_admin: Pubkey,
    pub pending_treasury: Pubkey,
    pub pending_guardian: Pubkey,
    pub pending_admin_eta: i64,
    /// SPEC v0.7 §2: allow-list of FUMPAD DBC configs (Pubkey::default() = empty slot).
    pub configs: [Pubkey; MAX_CONFIGS],
    /// Pending allow-list change (`queue_config`); `pending_config_eta == 0` = none.
    pub pending_config: Pubkey,
    pub pending_config_add: u8,
    pub pending_config_eta: i64,
    pub reserved: [u8; 64],
}

pub const PAUSE_LAUNCH: u8 = 1 << 0;
/// Router buys and buybacks. Never router sells (users can always exit, and can sell on Meteora directly anyway).
pub const PAUSE_TRADE: u8 = 1 << 1;
pub const PAUSE_CLAIMS: u8 = 1 << 2;
/// `migrate_pool` + `graduate` bookkeeping (never Meteora's own migration).
pub const PAUSE_GRADUATE: u8 = 1 << 3;
/// v0.7: `attest_sell`, `attest_rebuy`.
pub const PAUSE_ATTEST: u8 = 1 << 4;
pub const PAUSE_ALL: u8 = PAUSE_LAUNCH | PAUSE_TRADE | PAUSE_CLAIMS | PAUSE_GRADUATE | PAUSE_ATTEST;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct Params {
    // D32 fee split of our share (snapshotted per coin)
    pub fee_buyback_share_bps: u16,
    pub fee_platform_share_bps: u16,
    pub fee_creator_share_bps: u16,

    // Rewards (snapshotted per coin, M-1). min_hold / rebuy are inputs of the off-chain engine (and rebuy is
    // re-checked by `attest_rebuy`).
    pub trigger_multiple_bps: u32,
    pub claim_bps: u16,
    pub max_claim_pool_bps: u16,
    pub min_sell_usd_cents: u64,
    pub min_hold_secs: i64,
    pub rebuy_window_secs: i64,
    pub claim_window_secs: i64,
    pub max_open_tickets: u8,

    // Oracle / buyback (global)
    pub oracle_window_secs: i64,
    pub oracle_min_spacing_secs: i64,
    pub oracle_min_samples: u16,
    pub keeper_stale_secs: i64,
    pub buyback_max_deviation_bps: u16,
    pub buyback_max_pool_bps: u16,

    // Pyth (engine inputs; the program checks |block_time − publish_time| of each attestation)
    pub sol_usd_feed_id: [u8; 32],
    pub max_price_age_secs: u64,

    // D31 attestations
    pub max_attest_age_secs: i64,
    pub max_attest_tokens_per_hour_bps: u16,
    pub ticket_challenge_secs: i64,
    pub attest_threshold: u8,

    /// Off-chain review L1 (launch binding): when not `Pubkey::default()`, `register_coin` must also be signed by
    /// this key (the API's launch co-signer). Changed like every param: `queue_params` → 48 h → `execute_params`.
    pub launch_signer: Pubkey,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            fee_buyback_share_bps: DEFAULT_FEE_BUYBACK_SHARE_BPS,
            fee_platform_share_bps: DEFAULT_FEE_PLATFORM_SHARE_BPS,
            fee_creator_share_bps: DEFAULT_FEE_CREATOR_SHARE_BPS,
            trigger_multiple_bps: DEFAULT_TRIGGER_MULTIPLE_BPS,
            claim_bps: DEFAULT_CLAIM_BPS,
            max_claim_pool_bps: DEFAULT_MAX_CLAIM_POOL_BPS,
            min_sell_usd_cents: DEFAULT_MIN_SELL_USD_CENTS,
            min_hold_secs: DEFAULT_MIN_HOLD_SECS,
            rebuy_window_secs: DEFAULT_REBUY_WINDOW_SECS,
            claim_window_secs: DEFAULT_CLAIM_WINDOW_SECS,
            max_open_tickets: MAX_OPEN_TICKETS as u8,
            oracle_window_secs: DEFAULT_ORACLE_WINDOW_SECS,
            oracle_min_spacing_secs: DEFAULT_ORACLE_MIN_SPACING_SECS,
            oracle_min_samples: DEFAULT_ORACLE_MIN_SAMPLES,
            keeper_stale_secs: DEFAULT_KEEPER_STALE_SECS,
            buyback_max_deviation_bps: DEFAULT_BUYBACK_MAX_DEVIATION_BPS,
            buyback_max_pool_bps: DEFAULT_BUYBACK_MAX_POOL_BPS,
            sol_usd_feed_id: PYTH_SOL_USD_FEED_ID,
            max_price_age_secs: DEFAULT_MAX_PRICE_AGE_SECS,
            max_attest_age_secs: DEFAULT_MAX_ATTEST_AGE_SECS,
            max_attest_tokens_per_hour_bps: DEFAULT_MAX_ATTEST_TOKENS_PER_HOUR_BPS,
            ticket_challenge_secs: DEFAULT_TICKET_CHALLENGE_SECS,
            attest_threshold: ATTEST_THRESHOLD,
            launch_signer: Pubkey::default(),
        }
    }
}

impl Params {
    /// M-1: the reward terms a new coin snapshots at `register_coin` (live tickets keep them).
    pub fn reward_terms(&self) -> RewardTerms {
        RewardTerms {
            trigger_multiple_bps: self.trigger_multiple_bps,
            claim_bps: self.claim_bps,
            max_claim_pool_bps: self.max_claim_pool_bps,
            min_sell_usd_cents: self.min_sell_usd_cents,
            min_hold_secs: self.min_hold_secs,
            rebuy_window_secs: self.rebuy_window_secs,
            claim_window_secs: self.claim_window_secs,
            max_open_tickets: self.max_open_tickets,
        }
    }

    pub fn fee_split(&self) -> FeeSplitBps {
        FeeSplitBps {
            buyback_bps: self.fee_buyback_share_bps,
            platform_bps: self.fee_platform_share_bps,
            creator_bps: self.fee_creator_share_bps,
        }
    }

    /// Bounds for every param (v0.6 M-1/L-2 plus the v0.7 attestation params). Inclusive ranges.
    pub fn is_valid(&self) -> bool {
        let fees = self.fee_buyback_share_bps as u32 + self.fee_platform_share_bps as u32 + self.fee_creator_share_bps as u32
            == BPS_DENOM as u32;
        let rewards = (MIN_TRIGGER_MULTIPLE_BPS..=MAX_TRIGGER_MULTIPLE_BPS).contains(&self.trigger_multiple_bps)
            && (MIN_CLAIM_BPS..=MAX_CLAIM_BPS).contains(&self.claim_bps)
            && (MIN_MAX_CLAIM_POOL_BPS..=MAX_MAX_CLAIM_POOL_BPS).contains(&self.max_claim_pool_bps)
            && (MIN_MIN_SELL_USD_CENTS..=MAX_MIN_SELL_USD_CENTS).contains(&self.min_sell_usd_cents)
            && (MIN_MIN_HOLD_SECS..=MAX_MIN_HOLD_SECS).contains(&self.min_hold_secs)
            && (MIN_REBUY_WINDOW_SECS..=MAX_REBUY_WINDOW_SECS).contains(&self.rebuy_window_secs)
            && (MIN_CLAIM_WINDOW_SECS..=MAX_CLAIM_WINDOW_SECS).contains(&self.claim_window_secs)
            && (1..=MAX_OPEN_TICKETS).contains(&(self.max_open_tickets as usize));
        let w = self.oracle_window_secs;
        let s = self.oracle_min_spacing_secs;
        let n = self.oracle_min_samples as i64;
        let oracle = (MIN_ORACLE_WINDOW_SECS..=MAX_ORACLE_WINDOW_SECS).contains(&w)
            && (MIN_ORACLE_MIN_SPACING_SECS..=MAX_ORACLE_MIN_SPACING_SECS).contains(&s)
            && n * ORACLE_MIN_SAMPLE_EVERY_SECS >= w
            && n <= w / s
            && n as usize <= OBSERVATION_CAPACITY
            && (MIN_KEEPER_STALE_SECS..=MAX_KEEPER_STALE_SECS).contains(&self.keeper_stale_secs)
            && self.keeper_stale_secs > s
            && (MIN_BUYBACK_MAX_DEVIATION_BPS..=MAX_BUYBACK_MAX_DEVIATION_BPS).contains(&self.buyback_max_deviation_bps)
            && (MIN_BUYBACK_MAX_POOL_BPS..=MAX_BUYBACK_MAX_POOL_BPS).contains(&self.buyback_max_pool_bps)
            // execute_buyback's haircut must stay < 100% (else every buyback fails).
            && (self.buyback_max_deviation_bps as u64 + BUYBACK_VENUE_FEE_ALLOWANCE_BPS + 2 * self.buyback_max_pool_bps as u64)
                < BPS_DENOM;
        let pyth = self.sol_usd_feed_id == PYTH_SOL_USD_FEED_ID
            && (MIN_MAX_PRICE_AGE_SECS..=MAX_MAX_PRICE_AGE_SECS).contains(&self.max_price_age_secs);
        let attest = (MIN_MAX_ATTEST_AGE_SECS..=MAX_MAX_ATTEST_AGE_SECS).contains(&self.max_attest_age_secs)
            && (MIN_ATTEST_TOKENS_PER_HOUR_BPS..=MAX_ATTEST_TOKENS_PER_HOUR_BPS)
                .contains(&self.max_attest_tokens_per_hour_bps)
            && (MIN_TICKET_CHALLENGE_SECS..=MAX_TICKET_CHALLENGE_SECS).contains(&self.ticket_challenge_secs)
            && self.attest_threshold == ATTEST_THRESHOLD;
        fees && rewards && oracle && pyth && attest
    }
}

/// M-1: reward terms snapshotted per coin at `register_coin` (`Coin.rewards`).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace)]
pub struct RewardTerms {
    pub trigger_multiple_bps: u32,
    pub claim_bps: u16,
    pub max_claim_pool_bps: u16,
    pub min_sell_usd_cents: u64,
    pub min_hold_secs: i64,
    pub rebuy_window_secs: i64,
    pub claim_window_secs: i64,
    pub max_open_tickets: u8,
}

/// D32: split of our fee share, snapshotted per coin (D14 spirit).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace)]
pub struct FeeSplitBps {
    pub buyback_bps: u16,
    pub platform_bps: u16,
    pub creator_bps: u16,
}

impl Global {
    pub fn is_keeper(&self, key: &Pubkey) -> bool {
        *key != Pubkey::default() && self.keepers.iter().any(|k| k == key)
    }
    /// A keeper whose key may count toward an attestation at `now`: past its 6h freeze, or a bootstrap keeper set by
    /// `initialize_global` (`keeper_added_at == 0`, no freeze; `set_keepers` never stores 0).
    pub fn is_active_attester(&self, key: &Pubkey, now: i64) -> bool {
        *key != Pubkey::default()
            && self
                .keepers
                .iter()
                .zip(self.keeper_added_at.iter())
                .any(|(k, at)| k == key && (*at == 0 || now >= at.saturating_add(KEEPER_ATTEST_FREEZE_SECS)))
    }
    /// `flag` is paused and the pause hasn't lapsed (M-3).
    pub fn is_paused(&self, flag: u8, now: i64) -> bool {
        self.paused & flag != 0 && now < self.pause_expires_at
    }
    /// M-2: the admin, or the guardian if one is set.
    pub fn is_admin_or_guardian(&self, key: &Pubkey) -> bool {
        *key == self.admin || (self.guardian != Pubkey::default() && *key == self.guardian)
    }
    pub fn is_allowed_config(&self, config: &Pubkey) -> bool {
        *config != Pubkey::default() && self.configs.iter().any(|c| c == config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_valid_and_bounds() {
        let p = Params::default();
        assert!(p.is_valid());
        let bad: [fn(&mut Params); 12] = [
            |p| p.fee_creator_share_bps += 1,
            |p| p.trigger_multiple_bps = 49_999,
            |p| p.claim_bps = 2_501,
            |p| p.max_open_tickets = 0,
            |p| p.oracle_min_samples = 1,
            |p| p.sol_usd_feed_id = [0; 32],
            |p| p.max_price_age_secs = 29,
            |p| p.max_attest_age_secs = MAX_MAX_ATTEST_AGE_SECS + 1,
            |p| p.max_attest_tokens_per_hour_bps = 0,
            |p| p.ticket_challenge_secs = 3_599,
            |p| p.attest_threshold = 1,
            |p| p.buyback_max_deviation_bps = 1_000_0,
        ];
        for f in bad {
            let mut q = p;
            f(&mut q);
            assert!(!q.is_valid());
        }
    }
}
