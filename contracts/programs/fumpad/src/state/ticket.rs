use anchor_lang::prelude::*;

/// A fumble ticket: one attested qualifying sell (D31). PDA ["ticket", mint, wallet, seq.to_le_bytes()].
/// Rent paid by the attesting keeper (`rent_payer`), refunded to it by `close_ticket`.
#[account]
#[derive(InitSpace)]
pub struct Ticket {
    pub bump: u8,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub seq: u64,
    /// Tokens credited to this ticket, after rebuy debits.
    pub tokens: u64,
    /// Tokens credited at attestation.
    pub original_tokens: u64,
    /// Ticket price (engine's D10/D12 floor applied): lamports per base unit, Q64.64.
    pub sell_price_q64: u128,
    pub sell_usd_cents: u64,
    /// Block time of the sell.
    pub sell_ts: i64,
    pub status: TicketStatus,
    pub queued_at: i64,
    /// Tokens owed, fixed at queue entry or payout (claim_bps of `tokens`).
    pub claim_amount: u64,
    pub claimed_at: i64,
    /// D16: who paid the escrow token account's rent.
    pub escrow_payer: Pubkey,
    pub source: TicketSource,
    /// 0 DBC, 1 DAMM v2.
    pub venue: u8,
    /// Effective attestation time: when `attest_sell` ran, or later when the per-coin rate cap deferred the ticket
    /// (M-1). Claimable from `attested_at + ticket_challenge_secs`; the guardian may void it until then.
    pub attested_at: i64,
    pub rent_payer: Pubkey,
    /// The `consumed` marker of the attested sell.
    pub consumed: Pubkey,
    pub reserved: [u8; 16],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum TicketStatus {
    Open,
    Queued,
    Claimed,
    Expired,
    /// Reduced to zero by rebuys, or voided by the guardian in the challenge window.
    Voided,
    /// D16: paid into the ticket's escrow (owner's ATA refused); `withdraw_escrow` → `Claimed`.
    Escrowed,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum TicketSource {
    Outside,
    Router,
}
