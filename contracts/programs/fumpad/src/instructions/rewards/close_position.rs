use anchor_lang::prelude::*;

use crate::{constants::*, error::FumpadError, events::PositionClosed, state::Position};

/// Most ticket PDAs `close_position` checks in one call (account-list / CU bound; a position
/// with more tickets than this can't be closed — its rent stays, as before v0.6).
pub const MAX_CLOSE_POSITION_TICKETS: u64 = 64;

/// L-4 (v0.6): the position's wallet closes it and gets its rent back (~0.0032 SOL).
///
/// Requires no open (Open/Queued) ticket, and every ticket the position ever created to be
/// closed already: remaining_accounts = the ticket PDAs ["ticket", mint, wallet, seq] for
/// seq = 0..position.next_ticket_seq, in order, none of them a live FUMPAD account. That keeps
/// a later re-created position (its seq restarts at 0) from colliding with an old ticket.
/// Tracked hold credit (`matured` / `pending`) is forfeited: a re-created position treats the
/// wallet's tokens as freshly arrived (R-L2), like any new position.
#[event_cpi]
#[derive(Accounts)]
pub struct ClosePosition<'info> {
    #[account(mut)]
    pub wallet: Signer<'info>,
    #[account(
        mut,
        seeds = [POSITION_SEED, position.mint.as_ref(), wallet.key().as_ref()],
        bump = position.bump,
        close = wallet,
    )]
    pub position: Box<Account<'info, Position>>,
}

pub fn handle_close_position(ctx: Context<ClosePosition>) -> Result<()> {
    let pos = &ctx.accounts.position;
    let (mint, wallet) = (pos.mint, ctx.accounts.wallet.key());
    require!(pos.open_count == 0, FumpadError::PositionNotEmpty);
    let n = pos.next_ticket_seq;
    require!(n <= MAX_CLOSE_POSITION_TICKETS, FumpadError::PositionNotEmpty);
    let tickets = ctx.remaining_accounts;
    require!(tickets.len() as u64 == n, FumpadError::PositionNotEmpty);
    for (seq, info) in tickets.iter().enumerate() {
        let (key, _) = Pubkey::find_program_address(
            &[TICKET_SEED, mint.as_ref(), wallet.as_ref(), &(seq as u64).to_le_bytes()],
            &crate::ID,
        );
        require_keys_eq!(info.key(), key, FumpadError::InvalidAccount);
        // Closed (or never created): not a FUMPAD account. (Lamports sent to a closed address
        // don't matter — only a live program-owned Ticket would collide.)
        require!(*info.owner != crate::ID, FumpadError::PositionNotEmpty);
    }
    emit_event!(ctx, PositionClosed { mint, wallet, ts: Clock::get()?.unix_timestamp });
    Ok(())
}
