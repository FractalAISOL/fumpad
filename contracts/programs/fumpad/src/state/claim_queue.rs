use anchor_lang::prelude::*;

use crate::constants::CLAIM_QUEUE_CAPACITY;

/// Per-coin claim queue, kept sorted by `sell_ts` ascending (ties by ticket key).
/// PDA ["claim_queue", mint]. Zero-copy; created by `init_claim_queue` after graduation.
/// Skip-ahead: `process_queue` pays, in order, every entry whose amount fits the
/// current per-claim cap and pool balance, skipping entries that don't fit.
/// OWNER: rewards module.
#[account(zero_copy)]
#[repr(C)]
pub struct ClaimQueue {
    pub mint: Pubkey,
    pub len: u16,
    pub bump: u8,
    pub _pad: [u8; 5],
    pub total_owed: u64,
    pub entries: [QueueEntry; CLAIM_QUEUE_CAPACITY],
}

#[zero_copy]
#[repr(C)]
pub struct QueueEntry {
    pub ticket: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub sell_ts: i64,
}
