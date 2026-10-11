//! Cross-module hooks. OWNER: rewards module. CALLERS: curve `buy`/`sell`, router `swap_buy`/`swap_sell`.
//!
//! The signatures here are the contract between modules — don't change them without
//! updating every caller. Callers include these accounts in their own Accounts structs:
//!
//!   position:       Account<Position>   — init_if_needed, seeds ["position", mint, user], payer = user
//!   ticket:         UncheckedAccount     — mut; PDA ["ticket", mint, user, position.next_ticket_seq]
//!                                          (created by `on_sell` only if the sell qualifies)
//!   sol_usd_price:  UncheckedAccount     — Pyth PriceUpdateV2 (owner checked in `on_sell`)
//!
//! and, for buys, the wallet's open tickets as the FIRST `position.open_count`
//! entries of `remaining_accounts` (router: venue accounts follow them).

use anchor_lang::prelude::*;

use crate::state::{Coin, Global, Position};

pub struct SellHookAccounts<'a, 'info> {
    pub global: &'a Global,
    pub coin: &'a Account<'info, Coin>,
    pub position: &'a mut Account<'info, Position>,
    pub ticket: &'a AccountInfo<'info>,
    pub sol_usd_price: &'a AccountInfo<'info>,
    /// The seller; pays ticket rent.
    pub seller: &'a AccountInfo<'info>,
    pub system_program: &'a AccountInfo<'info>,
    pub program_id: &'a Pubkey,
}

pub struct SellInfo {
    pub tokens_sold: u64,
    /// SOL received for the tokens before FUMPAD's fee (execution value).
    pub gross_lamports_out: u64,
    /// Seller's token balance immediately BEFORE the sell (caps eligibility).
    pub balance_before: u64,
    pub now: i64,
}

/// Called AFTER a sell executes. Settles the position, debits eligibility, and — if the
/// sell qualifies (USD ≥ min, seller ≠ creator, matured tokens, < max open tickets) —
/// creates the ticket. Never fails the sell for eligibility reasons: returns Ok(None).
/// Errors only on malformed accounts (wrong PDA, wrong Pyth owner).
pub fn on_sell(_accts: SellHookAccounts, _info: SellInfo) -> Result<Option<Pubkey>> {
    Ok(None) // TODO(rewards module)
}

pub struct BuyHookAccounts<'a, 'info> {
    pub global: &'a Global,
    pub coin: &'a Account<'info, Coin>,
    pub position: &'a mut Account<'info, Position>,
    /// Exactly the position's open tickets, in any order.
    pub open_tickets: &'a [AccountInfo<'info>],
}

/// Called AFTER a buy executes. Adds `tokens_bought` to the position's pending bucket
/// and applies the rebuy rule to open tickets whose sell was within the rebuy window.
pub fn on_buy(_accts: BuyHookAccounts, _tokens_bought: u64, _now: i64) -> Result<()> {
    Ok(()) // TODO(rewards module)
}
