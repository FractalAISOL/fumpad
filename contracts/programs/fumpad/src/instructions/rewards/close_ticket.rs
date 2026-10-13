use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::FumpadError,
    events::TicketClosed,
    state::{ClaimQueue, Coin, Global, Position, Ticket, TicketStatus},
};

use super::{logic, queue};

/// Close a finished ticket and refund its rent to `rent_payer` (the attesting keeper). Permissionless for every
/// terminal state: Claimed, Voided, Expired, and Open past `sell_ts + claim_window` (→ Expired). Queued (D5) and
/// Escrowed (`withdraw_escrow` first) are never closable. `claim_queue` is optional (voids remove their own entry).
#[event_cpi]
#[derive(Accounts)]
pub struct CloseTicket<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    #[account(
        mut,
        seeds = [TICKET_SEED, ticket.mint.as_ref(), ticket.owner.as_ref(), &ticket.seq.to_le_bytes()],
        bump = ticket.bump,
        close = rent_payer,
    )]
    pub ticket: Box<Account<'info, Ticket>>,
    /// CHECK: rent recipient; must be `ticket.rent_payer`.
    #[account(mut, address = ticket.rent_payer @ FumpadError::InvalidAccount)]
    pub rent_payer: UncheckedAccount<'info>,
    #[account(mut, seeds = [POSITION_SEED, ticket.mint.as_ref(), ticket.owner.as_ref()], bump = position.bump)]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, seeds = [CLAIM_QUEUE_SEED, ticket.mint.as_ref()], bump)]
    pub claim_queue: Option<AccountLoader<'info, ClaimQueue>>,
    #[account(seeds = [COIN_SEED, ticket.mint.as_ref()], bump = coin.bump)]
    pub coin: Box<Account<'info, Coin>>,
}

pub fn handle_close_ticket(ctx: Context<CloseTicket>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let p = ctx.accounts.coin.reward_params(&ctx.accounts.global.params);
    let t = &ctx.accounts.ticket;
    let ticket_key = t.key();

    let final_status = match t.status {
        TicketStatus::Open => {
            let deadline = t.sell_ts.checked_add(p.claim_window_secs).ok_or(FumpadError::MathOverflow)?;
            require!(now > deadline, FumpadError::TicketNotClosable);
            TicketStatus::Expired
        }
        TicketStatus::Queued | TicketStatus::Escrowed => return err!(FumpadError::TicketNotClosable),
        s @ (TicketStatus::Expired | TicketStatus::Claimed | TicketStatus::Voided) => s,
    };

    if let Some(q) = ctx.accounts.claim_queue.as_ref() {
        let mut q = q.load_mut()?;
        require_keys_eq!(q.mint, t.mint, FumpadError::InvalidAccount);
        if final_status == TicketStatus::Voided {
            queue::remove(&mut q, &ticket_key);
        }
    }

    logic::remove_open(&mut ctx.accounts.position, &ticket_key);
    let (owner, rent_payer) = (t.owner, t.rent_payer);
    ctx.accounts.ticket.status = final_status;
    emit_event!(ctx, TicketClosed { ticket: ticket_key, owner, final_status: final_status as u8, rent_payer, ts: now });
    Ok(())
}
