use anchor_lang::prelude::*;

use crate::constants::*;

/// Singleton config. PDA ["global"].
#[account]
#[derive(InitSpace)]
pub struct Global {
    pub bump: u8,
    /// Squads multisig in production.
    pub admin: Pubkey,
    /// Receives the platform share of fees on `withdraw_platform_fees`.
    pub platform_treasury: Pubkey,
    /// Keys allowed to sign `record_samples`. Pubkey::default() = empty slot.
    pub keepers: [Pubkey; MAX_KEEPERS],
    /// Bitmask of `PAUSE_*` flags.
    pub paused: u8,
    pub params: Params,
    pub reserved: [u8; 128],
}

pub const PAUSE_LAUNCH: u8 = 1 << 0;
pub const PAUSE_TRADE: u8 = 1 << 1;
pub const PAUSE_CLAIMS: u8 = 1 << 2;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct Params {
    // Token + curve
    pub total_supply: u64,
    pub reward_pool_supply: u64,
    pub curve_supply: u64,
    pub lp_supply: u64,
    pub initial_virtual_sol: u64,
    pub initial_virtual_token: u64,
    pub graduation_lamports: u64,
    /// Taken from raised SOL at graduation (covers account rent; may include a platform fee).
    pub graduation_fee_lamports: u64,

    // Fees (bps of the SOL side of every FUMPAD trade)
    pub fee_bps: u16,
    pub fee_pool_share_bps: u16,
    pub fee_platform_share_bps: u16,
    pub fee_creator_share_bps: u16,

    // Rewards
    pub trigger_multiple_bps: u32,
    pub claim_bps: u16,
    pub max_claim_pool_bps: u16,
    pub min_sell_usd_cents: u64,
    pub min_hold_secs: i64,
    pub rebuy_window_secs: i64,
    pub claim_window_secs: i64,
    pub max_open_tickets: u8,

    // Oracle / buyback
    pub oracle_window_secs: i64,
    pub oracle_min_spacing_secs: i64,
    pub oracle_min_samples: u16,
    pub keeper_stale_secs: i64,
    pub buyback_max_deviation_bps: u16,
    pub buyback_max_pool_bps: u16,

    // Pyth
    pub sol_usd_feed_id: [u8; 32],
    pub max_price_age_secs: u64,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            total_supply: DEFAULT_TOTAL_SUPPLY,
            reward_pool_supply: DEFAULT_REWARD_POOL_SUPPLY,
            curve_supply: DEFAULT_CURVE_SUPPLY,
            lp_supply: DEFAULT_LP_SUPPLY,
            initial_virtual_sol: DEFAULT_INITIAL_VIRTUAL_SOL,
            initial_virtual_token: DEFAULT_INITIAL_VIRTUAL_TOKEN,
            graduation_lamports: DEFAULT_GRADUATION_LAMPORTS,
            graduation_fee_lamports: 0,
            fee_bps: DEFAULT_FEE_BPS,
            fee_pool_share_bps: DEFAULT_FEE_POOL_SHARE_BPS,
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
        }
    }
}

impl Params {
    /// Structural sanity checks run on initialize/update.
    pub fn is_valid(&self) -> bool {
        self.fee_pool_share_bps as u32 + self.fee_platform_share_bps as u32 + self.fee_creator_share_bps as u32
            == BPS_DENOM as u32
            && (self.fee_bps as u64) < BPS_DENOM
            && self.reward_pool_supply.checked_add(self.curve_supply).and_then(|s| s.checked_add(self.lp_supply))
                == Some(self.total_supply)
            && self.initial_virtual_token > self.curve_supply
            && self.initial_virtual_sol > 0
            && self.graduation_lamports > self.graduation_fee_lamports
            && self.trigger_multiple_bps as u64 > BPS_DENOM
            && self.claim_bps as u64 <= BPS_DENOM
            && self.max_claim_pool_bps as u64 <= BPS_DENOM
            && self.max_open_tickets as usize <= MAX_OPEN_TICKETS
            && self.oracle_min_spacing_secs > 0
            && self.oracle_window_secs > self.oracle_min_spacing_secs
            && (self.oracle_min_samples as usize) <= OBSERVATION_CAPACITY
    }
}

impl Global {
    pub fn is_keeper(&self, key: &Pubkey) -> bool {
        *key != Pubkey::default() && self.keepers.iter().any(|k| k == key)
    }
    pub fn is_paused(&self, flag: u8) -> bool {
        self.paused & flag != 0
    }
}
