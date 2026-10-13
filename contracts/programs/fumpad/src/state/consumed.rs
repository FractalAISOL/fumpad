use anchor_lang::prelude::*;

/// D31 replay marker: one attested trade (sell) or one (trade, ticket) debit (rebuy).
/// Sell PDA ["consumed", sha256(signature), ix_key LE]; rebuy PDA ["consumed", sha256(signature), ix_key LE, ticket].
/// Closable (`close_consumed`) only once its ticket is closed and the trade is older than the max attestation age
/// bound, so it can never let the same trade be attested twice.
#[account]
#[derive(InitSpace)]
pub struct Consumed {
    pub bump: u8,
    /// 0 sell, 1 rebuy.
    pub kind: u8,
    pub ticket: Pubkey,
    pub rent_payer: Pubkey,
    pub block_time: i64,
}

pub const CONSUMED_KIND_SELL: u8 = 0;
pub const CONSUMED_KIND_REBUY: u8 = 1;
