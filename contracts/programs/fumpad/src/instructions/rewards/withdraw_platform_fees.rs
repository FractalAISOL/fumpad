use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::FumpadError,
    events::FeesWithdrawn,
    state::{Coin, Global},
};

use super::withdraw_creator_fees::move_coin_lamports;

/// Sweep a coin's accrued platform fees to `global.platform_treasury`. Permissionless:
/// the destination is fixed, so anyone (e.g. the keeper) may trigger it.
#[event_cpi]
#[derive(Accounts)]
pub struct WithdrawPlatformFees<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Account<'info, Global>,
    #[account(mut, seeds = [COIN_SEED, coin.mint.as_ref()], bump = coin.bump)]
    pub coin: Account<'info, Coin>,
    /// CHECK: fixed destination from Global.
    #[account(mut, address = global.platform_treasury @ FumpadError::InvalidAccount)]
    pub platform_treasury: UncheckedAccount<'info>,
}

pub fn handle_withdraw_platform_fees(ctx: Context<WithdrawPlatformFees>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let amount = ctx.accounts.coin.platform_fees_unclaimed;
    require!(amount > 0, FumpadError::ZeroAmount);
    ctx.accounts.coin.platform_fees_unclaimed = 0;
    // Event CPI first: direct lamport moves must come after every CPI in the instruction.
    emit_cpi!(FeesWithdrawn {
        mint: ctx.accounts.coin.mint,
        recipient: ctx.accounts.platform_treasury.key(),
        lamports: amount,
        creator: false,
        ts: now,
    });
    move_coin_lamports(&ctx.accounts.coin, &ctx.accounts.platform_treasury.to_account_info(), amount)
}
