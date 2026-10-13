use anchor_lang::prelude::*;

use crate::{constants::*, error::FumpadError, events::PositionClosed, state::Position};

/// Most ticket PDAs `close_position` checks in one call (a position with more tickets can't be closed).
pub const MAX_CLOSE_POSITION_TICKETS: u64 = 64;

/// L-4: close an empty Position; rent back to whoever paid it (`rent_payer`, the attesting keeper). Signed by the
/// wallet or the rent payer. Requires no open (Open/Queued) ticket, and every ticket the position ever created to
/// be closed: remaining_accounts = ticket PDAs ["ticket", mint, wallet, seq] for seq 0..next_ticket_seq, none a
/// live fumpad account (so a re-created position, seq restarting at 0, can't collide with an old ticket).
#[event_cpi]
#[derive(Accounts)]
pub struct ClosePosition<'info> {
    pub signer: Signer<'info>,
    #[account(
        mut,
        seeds = [POSITION_SEED, position.mint.as_ref(), position.wallet.as_ref()],
        bump = position.bump,
        close = rent_payer,
    )]
    pub position: Box<Account<'info, Position>>,
    /// CHECK: = position.rent_payer.
    #[account(mut, address = position.rent_payer @ FumpadError::InvalidAccount)]
    pub rent_payer: UncheckedAccount<'info>,
}

pub fn handle_close_position(ctx: Context<ClosePosition>) -> Result<()> {
    let pos = &ctx.accounts.position;
    let (mint, wallet) = (pos.mint, pos.wallet);
    let signer = ctx.accounts.signer.key();
    require!(signer == wallet || signer == pos.rent_payer, FumpadError::Unauthorized);
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
        require!(*info.owner != crate::ID, FumpadError::PositionNotEmpty);
    }
    emit_event!(ctx, PositionClosed { mint, wallet, ts: Clock::get()?.unix_timestamp });
    Ok(())
}
