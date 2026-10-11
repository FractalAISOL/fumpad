use anchor_lang::prelude::*;

use crate::constants::OBSERVATION_CAPACITY;

/// Ring buffer of PumpSwap spot-price samples for one graduated coin.
/// PDA ["observations", mint]. Zero-copy; created by `init_observations` after graduation.
/// OWNER: venue/oracle module.
#[account(zero_copy)]
#[repr(C)]
pub struct Observations {
    pub mint: Pubkey,
    pub pool: Pubkey,
    /// Index the next sample will be written to.
    pub head: u16,
    /// Number of valid samples (≤ capacity).
    pub len: u16,
    pub bump: u8,
    pub _pad: [u8; 3],
    pub last_keeper_sample_ts: i64,
    pub samples: [Observation; OBSERVATION_CAPACITY],
}

#[zero_copy]
#[repr(C)]
pub struct Observation {
    pub ts: i64,
    /// 1 if recorded through the permissionless fallback path.
    pub fallback: u64,
    pub price_q64: u128,
}

impl Observations {
    /// Median price of samples with `ts > now - window_secs`, or None if fewer than
    /// `min_samples` such samples exist. Used by `claim` (10x check) and `execute_buyback`
    /// (deviation guard). Implemented by the venue/oracle module.
    pub fn median_price_q64(&self, now: i64, window_secs: i64, min_samples: u16) -> Option<u128> {
        let _ = (now, window_secs, min_samples);
        None // TODO(venue/oracle module)
    }
}
