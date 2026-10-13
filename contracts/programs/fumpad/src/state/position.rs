use anchor_lang::prelude::*;

use crate::constants::MAX_OPEN_TICKETS;

/// A wallet's tickets on one coin. PDA ["position", mint, wallet]. v0.7 (SPEC §5.1): hold/rebuy bookkeeping moved
/// off-chain; the position keeps only the open-ticket list, counters and the auto-claim opt-out. Created by
/// `attest_sell` (rent paid by the attesting keeper, `rent_payer`).
#[account]
#[derive(InitSpace)]
pub struct Position {
    pub bump: u8,
    pub wallet: Pubkey,
    pub mint: Pubkey,
    /// Next ticket PDA seed.
    pub next_ticket_seq: u64,
    /// Open/queued ticket accounts (Pubkey::default() = empty slot).
    pub open_tickets: [Pubkey; MAX_OPEN_TICKETS],
    pub open_count: u8,
    /// D17: 1 = the wallet opted out of keeper auto-claim (`claim_for`) for this coin.
    pub auto_claim_opt_out: u8,
    /// Who paid this account's rent (refunded by `close_position`).
    pub rent_payer: Pubkey,
    pub tickets_created: u64,
    pub reserved: [u8; 32],
}

impl Position {
    pub fn auto_claim_enabled(&self) -> bool {
        self.auto_claim_opt_out == 0
    }
}
