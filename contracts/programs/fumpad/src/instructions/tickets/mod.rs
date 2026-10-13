//! D31 tickets by attestation: `attest_sell`, `attest_rebuy`, the guardian's `void_ticket` (challenge window) and
//! `close_consumed`.

use anchor_lang::prelude::*;

pub mod attest_rebuy;
pub mod attest_sell;
pub use attest_rebuy::*;
pub use attest_sell::*;

use crate::{
    constants::*,
    error::FumpadError,
    events::{ConsumedClosed, TicketVoided},
    instructions::rewards::logic,
    state::{Coin, Consumed, Global, Position, Ticket, TicketStatus, CONSUMED_KIND_SELL, CONSUMED_KIND_SELL_REOPENED},
};

/// SPEC v0.7 §5.3: the guardian (or admin) voids a bad attestation inside its challenge window.
/// `reopen` (REVIEW-v0.7 L-2): the attestation was wrong but the trade may be honest (engine bug: wrong amount,
/// price, venue bit…) — the sell's replay marker is reopened so the keepers can attest the corrected record of the
/// same trade once (any message but the voided one). `reopen = false` keeps the trade consumed forever (fraud).
/// The voided tokens' rate-cap capacity is released (M-1). The tx references `coin` and `mint` (review L3).
#[event_cpi]
#[derive(Accounts)]
pub struct VoidTicket<'info> {
    pub authority: Signer<'info>,
    #[account(
        seeds = [GLOBAL_SEED],
        bump = global.bump,
        constraint = global.is_admin_or_guardian(authority.key) @ FumpadError::Unauthorized,
    )]
    pub global: Box<Account<'info, Global>>,
    #[account(mut, seeds = [COIN_SEED, ticket.mint.as_ref()], bump = coin.bump)]
    pub coin: Box<Account<'info, Coin>>,
    /// CHECK: the ticket's mint (address-checked; referenced so mint-history crawls see voids).
    #[account(address = ticket.mint @ FumpadError::InvalidAccount)]
    pub mint: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [TICKET_SEED, ticket.mint.as_ref(), ticket.owner.as_ref(), &ticket.seq.to_le_bytes()],
        bump = ticket.bump,
    )]
    pub ticket: Box<Account<'info, Ticket>>,
    #[account(mut, seeds = [POSITION_SEED, ticket.mint.as_ref(), ticket.owner.as_ref()], bump = position.bump)]
    pub position: Box<Account<'info, Position>>,
    /// The sell's replay marker (`ticket.consumed`).
    #[account(mut, address = ticket.consumed @ FumpadError::InvalidAccount)]
    pub consumed: Box<Account<'info, Consumed>>,
}

pub fn handle_void_ticket(ctx: Context<VoidTicket>, reason: u8, reopen: bool) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let p = ctx.accounts.global.params;
    let t = &mut ctx.accounts.ticket;
    require!(t.status == TicketStatus::Open, FumpadError::TicketNotOpen);
    require!(now < t.attested_at.saturating_add(p.ticket_challenge_secs), FumpadError::ChallengeWindowOver);
    t.status = TicketStatus::Voided;
    let (ticket, mint, owner, tokens, effective_at) = (t.key(), t.mint, t.owner, t.tokens, t.attested_at);
    logic::remove_open(&mut ctx.accounts.position, &ticket);
    ctx.accounts.coin.release_attest(now, tokens, p.max_attest_tokens_per_hour_bps, effective_at);
    if reopen {
        let m = &mut ctx.accounts.consumed;
        require!(m.kind == CONSUMED_KIND_SELL && m.ticket == ticket, FumpadError::InvalidAccount);
        m.kind = CONSUMED_KIND_SELL_REOPENED;
    }
    let (authority, coin) = (ctx.accounts.authority.key(), ctx.accounts.coin.key());
    emit_event!(ctx, TicketVoided { ticket, mint, owner, reason, authority, ts: now, coin, reopened: reopen });
    Ok(())
}

/// Close a replay marker once its ticket is closed AND the trade is older than `MAX_MAX_ATTEST_AGE_SECS`, so the
/// same trade can never be attested again (attestations older than the max age are rejected). Rent → rent_payer.
#[event_cpi]
#[derive(Accounts)]
pub struct CloseConsumed<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    #[account(mut, close = rent_payer)]
    pub consumed: Box<Account<'info, Consumed>>,
    /// CHECK: = consumed.rent_payer.
    #[account(mut, address = consumed.rent_payer @ FumpadError::InvalidAccount)]
    pub rent_payer: UncheckedAccount<'info>,
    /// CHECK: = consumed.ticket; must no longer be a live fumpad account.
    #[account(address = consumed.ticket @ FumpadError::InvalidAccount)]
    pub ticket: UncheckedAccount<'info>,
}

pub fn handle_close_consumed(ctx: Context<CloseConsumed>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let c = &ctx.accounts.consumed;
    require!(*ctx.accounts.ticket.owner != crate::ID, FumpadError::ConsumedNotClosable);
    require!(now > c.block_time.saturating_add(MAX_MAX_ATTEST_AGE_SECS), FumpadError::ConsumedNotClosable);
    let (consumed, ticket, rent_payer) = (c.key(), c.ticket, c.rent_payer);
    emit_event!(ctx, ConsumedClosed { consumed, ticket, rent_payer, ts: now });
    Ok(())
}
