use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    constants::*,
    error::FumpadError,
    events::HoldingsRegistered,
    state::{Coin, Global, Position},
};

use super::{
    hooks::{apply_rebuy, split_rebuy_accounts},
    logic,
};

/// Lets a wallet that acquired tokens outside FUMPAD (or before tracking) become eligible:
/// the canonical Token-2022 ATA balance not yet tracked by the position is added as
/// *pending* (the 10-minute hold starts now). Counts as a rebuy for the rebuy rule.
///
/// remaining_accounts: exactly the position's open tickets (writable), any order, then the
/// coin's ClaimQueue (writable) only if one of them is `Queued`.
#[event_cpi]
#[derive(Accounts)]
pub struct RegisterHoldings<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Account<'info, Global>,
    #[account(seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump, has_one = mint)]
    pub coin: Account<'info, Coin>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, mint.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, Position>,
    #[account(
        associated_token::mint = mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(address = anchor_spl::token_2022::ID)]
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handle_register_holdings(ctx: Context<RegisterHoldings>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let p = ctx.accounts.global.params;
    let user = ctx.accounts.user.key();
    let mint = ctx.accounts.mint.key();
    let balance = ctx.accounts.user_token_account.amount;

    let position = &mut ctx.accounts.position;
    position.init_if_new(user, mint, ctx.bumps.position);
    position.settle(now, p.min_hold_secs);
    logic::cap_tracked(position, balance);
    let tracked = position.matured.saturating_add(position.pending);
    let added = balance.saturating_sub(tracked);
    require!(added > 0, FumpadError::ZeroAmount);

    let (rebuy, rest) = split_rebuy_accounts(position, ctx.remaining_accounts)?;
    require!(rest.is_empty(), FumpadError::OpenTicketsMismatch);
    apply_rebuy(&p, position, &rebuy, added, now, &ctx.accounts.event_authority)?;
    position.add(added, now, p.min_hold_secs);
    position.last_balance = balance; // R-L2: observed

    emit_cpi!(HoldingsRegistered { mint, wallet: user, added, ts: now });
    Ok(())
}
