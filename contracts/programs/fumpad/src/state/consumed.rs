use anchor_lang::prelude::*;

/// D31 replay marker: one attested trade (sell) or one (trade, ticket) debit (rebuy).
/// Sell PDA ["consumed", sha256(signature), ix_key LE]; rebuy PDA ["consumed", sha256(signature), ix_key LE, ticket].
/// Closable (`close_consumed`) only once its ticket is closed and the trade is older than the max attestation age
/// bound, so it can never let the same trade be attested twice.
///
/// REVIEW-v0.7 L-2: a guardian `void_ticket(.., reopen = true)` turns a sell marker into `kind = 2` (reopened): the
/// same trade may then be attested once more with a DIFFERENT message (a corrected record); the voided message
/// itself (`message_hash`) stays refused. The re-attestation turns the marker back into a live sell marker.
#[account]
#[derive(InitSpace)]
pub struct Consumed {
    pub bump: u8,
    /// 0 sell, 1 rebuy.
    pub kind: u8,
    pub ticket: Pubkey,
    pub rent_payer: Pubkey,
    pub block_time: i64,
    /// Sell markers: first 16 bytes of sha256 of the attested 284-byte message (zero for rebuy markers).
    pub message_hash: [u8; 16],
}

pub const CONSUMED_KIND_SELL: u8 = 0;
pub const CONSUMED_KIND_REBUY: u8 = 1;
/// A sell marker whose ticket the guardian voided as correctable (L-2): one corrected re-attestation allowed.
pub const CONSUMED_KIND_SELL_REOPENED: u8 = 2;
