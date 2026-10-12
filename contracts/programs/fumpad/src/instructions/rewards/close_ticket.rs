use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::FumpadError,
    events::TicketClosed,
    state::{ClaimQueue, Global, Position, Ticket, TicketStatus},
};

use super::{logic, queue};

/// Close a finished ticket and refund its rent to the owner.
/// - Claimed / Voided: owner only.
/// - Open past `sell_ts + claim_window` (→ Expired) or Expired: anyone (rent still goes to
///   the owner), so stale tickets can be cleaned up and free their open-ticket slot.
/// - Queued: never (D5 — queued claims don't expire). Escrowed: not until
///   `withdraw_escrow` (then Claimed).
/// `claim_queue` is optional (rebuys remove a voided ticket's entry themselves, R-L1).
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
        close = owner,
    )]
    pub ticket: Box<Account<'info, Ticket>>,
    /// CHECK: rent recipient; must be the ticket owner.
    #[account(mut, address = ticket.owner @ FumpadError::InvalidAccount)]
    pub owner: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [POSITION_SEED, ticket.mint.as_ref(), ticket.owner.as_ref()],
        bump = position.bump,
    )]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, seeds = [CLAIM_QUEUE_SEED, ticket.mint.as_ref()], bump)]
    pub claim_queue: Option<AccountLoader<'info, ClaimQueue>>,
}

pub fn handle_close_ticket(ctx: Context<CloseTicket>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let p = &ctx.accounts.global.params;
    let t = &ctx.accounts.ticket;
    let ticket_key = t.key();
    let is_owner = ctx.accounts.caller.key() == t.owner;

    let final_status = match t.status {
        TicketStatus::Open => {
            let deadline = t.sell_ts.checked_add(p.claim_window_secs).ok_or(FumpadError::MathOverflow)?;
            require!(now > deadline, FumpadError::TicketNotClosable);
            TicketStatus::Expired
        }
        TicketStatus::Expired => TicketStatus::Expired,
        // Queued: D5, never expires. Escrowed: tokens still waiting in its escrow
        // (`withdraw_escrow` first).
        TicketStatus::Queued | TicketStatus::Escrowed => return err!(FumpadError::TicketNotClosable),
        s @ (TicketStatus::Claimed | TicketStatus::Voided) => {
            require!(is_owner, FumpadError::Unauthorized);
            s
        }
    };

    // A ticket voided while queued already left the queue in the voiding rebuy (R-L1);
    // if the queue is passed anyway, removing is a harmless no-op (kept for old clients).
    if let Some(q) = ctx.accounts.claim_queue.as_ref() {
        let mut q = q.load_mut()?;
        require_keys_eq!(q.mint, t.mint, FumpadError::InvalidAccount);
        if final_status == TicketStatus::Voided {
            queue::remove(&mut q, &ticket_key);
        }
    }

    logic::remove_open(&mut ctx.accounts.position, &ticket_key);
    let owner = t.owner;
    ctx.accounts.ticket.status = final_status;
    emit_event!(ctx, TicketClosed { ticket: ticket_key, owner, final_status: final_status as u8, ts: now });
    Ok(())
}
