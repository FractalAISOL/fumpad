use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::{
    constants::*,
    error::FumpadError,
    events::EscrowWithdrawn,
    state::{Global, Ticket, TicketStatus, PAUSE_CLAIMS},
};

/// D16: the owner of an `Escrowed` ticket moves its escrowed payout to any token account
/// they own for this mint (e.g. a fresh one without memo requirements). The escrow account
/// is closed and its rent refunded to whoever paid it (the `process_queue` cranker,
/// `ticket.escrow_payer`). The ticket becomes `Claimed` (then closable by its owner).
#[event_cpi]
#[derive(Accounts)]
pub struct WithdrawEscrow<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        seeds = [TICKET_SEED, mint.key().as_ref(), owner.key().as_ref(), &ticket.seq.to_le_bytes()],
        bump = ticket.bump,
        has_one = owner @ FumpadError::Unauthorized,
        has_one = mint,
    )]
    pub ticket: Box<Account<'info, Ticket>>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, ticket.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = pool_authority,
        token::token_program = token_program,
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: PDA signer that owns the escrow account.
    #[account(seeds = [POOL_AUTHORITY_SEED], bump)]
    pub pool_authority: UncheckedAccount<'info>,
    /// Any token account of the owner for this mint.
    #[account(
        mut,
        token::mint = mint,
        token::authority = owner,
        token::token_program = token_program,
    )]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: rent refund recipient; must be `ticket.escrow_payer`.
    #[account(mut, address = ticket.escrow_payer @ FumpadError::InvalidAccount)]
    pub escrow_payer: UncheckedAccount<'info>,
    #[account(address = anchor_spl::token_2022::ID)]
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_withdraw_escrow(ctx: Context<WithdrawEscrow>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &mut *ctx.accounts;
    require!(!a.global.is_paused(PAUSE_CLAIMS), FumpadError::Paused);
    require!(a.ticket.status == TicketStatus::Escrowed, FumpadError::NoEscrow);
    let amount = a.escrow.amount; // = ticket.claim_amount (+ anything donated to it)
    let seeds: &[&[&[u8]]] = &[&[POOL_AUTHORITY_SEED, &[ctx.bumps.pool_authority]]];
    if amount > 0 {
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                a.token_program.key(),
                TransferChecked {
                    from: a.escrow.to_account_info(),
                    mint: a.mint.to_account_info(),
                    to: a.destination.to_account_info(),
                    authority: a.pool_authority.to_account_info(),
                },
                seeds,
            ),
            amount,
            a.mint.decimals,
        )?;
    }
    token_interface::close_account(CpiContext::new_with_signer(
        a.token_program.key(),
        CloseAccount {
            account: a.escrow.to_account_info(),
            destination: a.escrow_payer.to_account_info(),
            authority: a.pool_authority.to_account_info(),
        },
        seeds,
    ))?;
    a.ticket.status = TicketStatus::Claimed;
    let ticket = a.ticket.key();
    let ev = EscrowWithdrawn {
        mint: a.mint.key(),
        ticket,
        owner: a.owner.key(),
        destination: a.destination.key(),
        amount,
        ts: now,
    };
    emit_cpi!(ev);
    Ok(())
}
