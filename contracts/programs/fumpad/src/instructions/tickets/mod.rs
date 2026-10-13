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
    state::{Consumed, Global, Position, Ticket, TicketStatus},
};

/// SPEC v0.7 §5.3: the guardian (or admin) voids a bad attestation inside its challenge window.
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
    #[account(
        mut,
        seeds = [TICKET_SEED, ticket.mint.as_ref(), ticket.owner.as_ref(), &ticket.seq.to_le_bytes()],
        bump = ticket.bump,
    )]
    pub ticket: Box<Account<'info, Ticket>>,
    #[account(mut, seeds = [POSITION_SEED, ticket.mint.as_ref(), ticket.owner.as_ref()], bump = position.bump)]
    pub position: Box<Account<'info, Position>>,
}

pub fn handle_void_ticket(ctx: Context<VoidTicket>, reason: u8) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let window = ctx.accounts.global.params.ticket_challenge_secs;
    let t = &mut ctx.accounts.ticket;
    require!(t.status == TicketStatus::Open, FumpadError::TicketNotOpen);
    require!(now < t.attested_at.saturating_add(window), FumpadError::ChallengeWindowOver);
    t.status = TicketStatus::Voided;
    let (ticket, mint, owner) = (t.key(), t.mint, t.owner);
    logic::remove_open(&mut ctx.accounts.position, &ticket);
    let authority = ctx.accounts.authority.key();
    emit_event!(ctx, TicketVoided { ticket, mint, owner, reason, authority, ts: now });
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
