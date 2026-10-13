use anchor_lang::prelude::*;

use crate::constants::*;
use crate::state::{CoinFees, SnipeConfig};

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
    /// Bitmask of `PAUSE_*` flags; in force only until `pause_expires_at` (M-3).
    pub paused: u8,
    pub params: Params,
    /// M-2 (v0.6): may `set_pause`, `cancel_params` and `cancel_admin` — never queue or
    /// propose. Pubkey::default() = none (only the admin can then). Carved from `reserved`.
    pub guardian: Pubkey,
    /// M-3 (v0.6): `paused` flags lapse at this unix time (`set_pause` sets now +
    /// `MAX_PAUSE_SECS`; renewing needs another `set_pause`). Carved from `reserved`.
    pub pause_expires_at: i64,
    /// M-2 (v0.6): earliest `accept_admin` time of the proposed authority change
    /// (`pending_admin`, …); 0 = no proposal. Carved from `reserved`.
    pub pending_admin_eta: i64,
    pub reserved: [u8; 80],
    /// D15: params queued by `queue_params`, applied by `execute_params` once
    /// `pending_eta` has passed. `pending_eta == 0` = nothing queued.
    /// (Appended in v0.3: Global grew by `Params::INIT_SPACE + 8` bytes.)
    pub pending_params: Params,
    pub pending_eta: i64,
    /// M-2 (appended in v0.6, Global 680 → 776 bytes): the authority set proposed by
    /// `propose_admin`, applied by `accept_admin` — signed by `pending_admin` itself — once
    /// `pending_admin_eta` has passed (48h). The guardian or the admin can `cancel_admin`.
    pub pending_admin: Pubkey,
    pub pending_treasury: Pubkey,
    pub pending_guardian: Pubkey,
}

pub const PAUSE_LAUNCH: u8 = 1 << 0;
/// Curve buys, router buys/sells and buybacks. Never curve sells (M-3: holders can always exit).
pub const PAUSE_TRADE: u8 = 1 << 1;
pub const PAUSE_CLAIMS: u8 = 1 << 2;
/// L-5 (v0.6): `graduate` (e.g. during a PumpSwap incident). The D13 hatch still opens after 7 days.
pub const PAUSE_GRADUATE: u8 = 1 << 3;
/// Every defined flag; `set_pause` rejects other bits.
pub const PAUSE_ALL: u8 = PAUSE_LAUNCH | PAUSE_TRADE | PAUSE_CLAIMS | PAUSE_GRADUATE;

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

    // D19 snipe protection (appended in v0.5; snapshotted per coin at `create_coin`)
    /// Curve buys within this many slots after the launch slot pay the snipe tax (0 = off).
    pub snipe_window_slots: u16,
    /// Tax at the launch slot, bps; the schedule is min(this, ⌈10_000·(W − d)/W⌉) at offset d.
    pub snipe_start_bps: u16,
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
            graduation_fee_lamports: DEFAULT_GRADUATION_FEE_LAMPORTS,
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
            snipe_window_slots: DEFAULT_SNIPE_WINDOW_SLOTS,
            snipe_start_bps: DEFAULT_SNIPE_START_BPS,
        }
    }
}

impl Params {
    /// D14: the fee parameters a new coin snapshots at `create_coin`.
    pub fn coin_fees(&self) -> CoinFees {
        CoinFees {
            graduation_fee_lamports: self.graduation_fee_lamports,
            fee_bps: self.fee_bps,
            fee_pool_share_bps: self.fee_pool_share_bps,
            fee_platform_share_bps: self.fee_platform_share_bps,
            fee_creator_share_bps: self.fee_creator_share_bps,
        }
    }

    /// D19: the snipe schedule a new coin snapshots at `create_coin` (launch slot = now).
    pub fn snipe_config(&self, launch_slot: u64) -> SnipeConfig {
        SnipeConfig { launch_slot, window_slots: self.snipe_window_slots, start_bps: self.snipe_start_bps }
    }

    /// M-1: the reward terms a new coin snapshots at `create_coin` (live tickets keep them).
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

    /// Checks run on initialize / queue / execute / migrate: the D14 caps plus a bounded range
    /// for every param (M-1 / L-2, v0.6 — constants.rs), and D20 curve consistency.
    pub fn is_valid(&self) -> bool {
        let fees = self.graduation_fee_lamports <= MAX_GRADUATION_FEE_LAMPORTS
            && self.fee_bps <= MAX_FEE_BPS
            && self.fee_pool_share_bps as u32 + self.fee_platform_share_bps as u32 + self.fee_creator_share_bps as u32
                == BPS_DENOM as u32;
        let supply = self.reward_pool_supply.checked_add(self.curve_supply).and_then(|s| s.checked_add(self.lp_supply))
            == Some(self.total_supply)
            && self.reward_pool_supply > 0
            && self.lp_supply > 0
            && self.curve_supply > 0
            && self.initial_virtual_token > self.curve_supply
            && self.initial_virtual_sol > 0
            && self.curve_consistent();
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
            // execute_buyback's haircut must stay < 100% (else every buyback is InvalidParams).
            && (self.buyback_max_deviation_bps as u64
                + crate::instructions::venue::execute_buyback::BUYBACK_VENUE_FEE_ALLOWANCE_BPS
                + 2 * self.buyback_max_pool_bps as u64)
                < BPS_DENOM;
        // The feed is pinned to Pyth SOL/USD: a different feed needs a program upgrade.
        let pyth = self.sol_usd_feed_id == PYTH_SOL_USD_FEED_ID
            && (MIN_MAX_PRICE_AGE_SECS..=MAX_MAX_PRICE_AGE_SECS).contains(&self.max_price_age_secs);
        let snipe = self.snipe_window_slots <= MAX_SNIPE_WINDOW_SLOTS && self.snipe_start_bps <= MAX_SNIPE_START_BPS;
        fees && supply && rewards && oracle && pyth && snipe
    }

    /// D20 / L-2: the curve constants, `graduation_lamports` and the graduation fee agree.
    /// With V0 = initial_virtual_sol, T0 = initial_virtual_token, T1 = T0 − curve_supply (virtual
    /// tokens left at completion), V1 = V0·T0/T1 and raise R = V1 − V0:
    ///   * `graduation_lamports` ≈ R (it is informational — the curve completes when its tokens
    ///     run out — but must describe the curve);
    ///   * R > graduation fee (else no coin could ever graduate);
    ///   * LP opening price (R − fee) / lp_supply ≈ curve final price V1 / T1 (continuity).
    /// "≈" = within `CURVE_CONSISTENCY_TOLERANCE_BPS`.
    pub fn curve_consistent(&self) -> bool {
        fn close(a: u128, b: u128) -> bool {
            a.abs_diff(b).checked_mul(BPS_DENOM as u128).is_some_and(|d| {
                b.checked_mul(CURVE_CONSISTENCY_TOLERANCE_BPS as u128).is_some_and(|t| d <= t)
            })
        }
        let (v0, t0) = (self.initial_virtual_sol as u128, self.initial_virtual_token as u128);
        let Some(t1) = t0.checked_sub(self.curve_supply as u128).filter(|&t| t > 0) else { return false };
        let v1 = v0 * t0 / t1; // < 2^128: both factors < 2^64
        let raise = v1 - v0;
        let fee = self.graduation_fee_lamports as u128;
        if raise <= fee || !close(self.graduation_lamports as u128, raise) {
            return false;
        }
        match ((raise - fee).checked_mul(t1), v1.checked_mul(self.lp_supply as u128)) {
            (Some(lp_open), Some(curve_end)) => close(lp_open, curve_end),
            _ => false,
        }
    }
}

/// M-1 (v0.6): reward terms snapshotted per coin at `create_coin` (`Coin.rewards`), like the
/// fees (D14): a params change (timelocked, bounded) applies only to coins created after it.
/// Coins created before v0.6 hold zeros and keep using `Global.params` (`Coin::reward_params`).
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

impl RewardTerms {
    /// Zeros = a coin created before v0.6 (no snapshot).
    pub fn is_set(&self) -> bool {
        self.trigger_multiple_bps != 0
    }

    /// `global` with these terms applied (when set).
    pub fn apply(&self, global: &Params) -> Params {
        if !self.is_set() {
            return *global;
        }
        Params {
            trigger_multiple_bps: self.trigger_multiple_bps,
            claim_bps: self.claim_bps,
            max_claim_pool_bps: self.max_claim_pool_bps,
            min_sell_usd_cents: self.min_sell_usd_cents,
            min_hold_secs: self.min_hold_secs,
            rebuy_window_secs: self.rebuy_window_secs,
            claim_window_secs: self.claim_window_secs,
            max_open_tickets: self.max_open_tickets,
            ..*global
        }
    }
}

impl Global {
    pub fn is_keeper(&self, key: &Pubkey) -> bool {
        *key != Pubkey::default() && self.keepers.iter().any(|k| k == key)
    }
    /// `flag` is paused and the pause hasn't lapsed (M-3).
    pub fn is_paused(&self, flag: u8, now: i64) -> bool {
        self.paused & flag != 0 && now < self.pause_expires_at
    }
    /// M-2: the admin, or the guardian if one is set.
    pub fn is_admin_or_guardian(&self, key: &Pubkey) -> bool {
        *key == self.admin || (self.guardian != Pubkey::default() && *key == self.guardian)
    }
}
