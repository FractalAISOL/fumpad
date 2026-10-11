use anchor_lang::prelude::*;

/// A fumble ticket: one qualifying sell. PDA ["ticket", mint, wallet, seq.to_le_bytes()].
/// Rent paid by the seller; refunded to `owner` on `close_ticket`.
#[account]
#[derive(InitSpace)]
pub struct Ticket {
    pub bump: u8,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub seq: u64,
    /// Tokens credited to this ticket, after rebuy debits.
    pub tokens: u64,
    /// Tokens credited at creation.
    pub original_tokens: u64,
    /// Execution price of the sell, before FUMPAD's fee: lamports per base unit, Q64.64.
    pub sell_price_q64: u128,
    pub sell_usd_cents: u64,
    pub sell_ts: i64,
    pub status: TicketStatus,
    /// Set when the ticket enters the claim queue (expiry stops counting from here).
    pub queued_at: i64,
    /// Tokens owed, fixed at queue entry or payout (claim_bps of `tokens`).
    pub claim_amount: u64,
    pub claimed_at: i64,
    /// D16: who paid the rent of this ticket's escrow token account (`process_queue`
    /// cranker); refunded to it by `withdraw_escrow`. Carved from `reserved` (size unchanged).
    pub escrow_payer: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum TicketStatus {
    Open,
    Queued,
    Claimed,
    Expired,
    /// Reduced to zero by rebuys.
    Voided,
    /// D16: paid from the queue into the ticket's escrow token account (["escrow", ticket])
    /// because the owner's ATA refused the transfer; `withdraw_escrow` → `Claimed`.
    Escrowed,
}
