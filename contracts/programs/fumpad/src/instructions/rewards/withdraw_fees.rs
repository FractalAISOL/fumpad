use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::FumpadError,
    events::FeesWithdrawn,
    state::{Coin, Global},
};

/// The coin creator withdraws their accrued fee share (unconditional, never paused).
#[event_cpi]
#[derive(Accounts)]
pub struct WithdrawCreatorFees<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut, seeds = [COIN_SEED, coin.mint.as_ref()], bump = coin.bump, has_one = creator @ FumpadError::Unauthorized)]
    pub coin: Box<Account<'info, Coin>>,
}

pub fn handle_withdraw_creator_fees(ctx: Context<WithdrawCreatorFees>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let amount = ctx.accounts.coin.creator_fees_unclaimed;
    require!(amount > 0, FumpadError::ZeroAmount);
    ctx.accounts.coin.creator_fees_unclaimed = 0;
    // Event CPI first: direct lamport moves must come after every CPI in the instruction.
    emit_event!(ctx, FeesWithdrawn {
        mint: ctx.accounts.coin.mint,
        recipient: ctx.accounts.creator.key(),
        lamports: amount,
        creator: true,
        ts: now,
    });
    move_coin_lamports(&ctx.accounts.coin, &ctx.accounts.creator.to_account_info(), amount)
}

/// Sweep a coin's platform fees to `global.platform_treasury`. Permissionless (fixed destination).
#[event_cpi]
#[derive(Accounts)]
pub struct WithdrawPlatformFees<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    #[account(mut, seeds = [COIN_SEED, coin.mint.as_ref()], bump = coin.bump)]
    pub coin: Box<Account<'info, Coin>>,
    /// CHECK: fixed destination from Global.
    #[account(mut, address = global.platform_treasury @ FumpadError::InvalidAccount)]
    pub platform_treasury: UncheckedAccount<'info>,
}

pub fn handle_withdraw_platform_fees(ctx: Context<WithdrawPlatformFees>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let amount = ctx.accounts.coin.platform_fees_unclaimed;
    require!(amount > 0, FumpadError::ZeroAmount);
    ctx.accounts.coin.platform_fees_unclaimed = 0;
    emit_event!(ctx, FeesWithdrawn {
        mint: ctx.accounts.coin.mint,
        recipient: ctx.accounts.platform_treasury.key(),
        lamports: amount,
        creator: false,
        ts: now,
    });
    move_coin_lamports(&ctx.accounts.coin, &ctx.accounts.platform_treasury.to_account_info(), amount)
}

/// Move `amount` lamports out of the program-owned Coin account. Must be the last thing the instruction does
/// (no CPI after a direct lamport move). Call AFTER zeroing the withdrawn counter: the account must keep at least
/// rent-exemption plus every lamport still tracked, so an accounting bug elsewhere can never over-withdraw.
pub fn move_coin_lamports(coin: &Account<Coin>, to: &AccountInfo, amount: u64) -> Result<()> {
    let info = coin.to_account_info();
    require_keys_neq!(info.key(), to.key(), FumpadError::InvalidAccount);
    let must_keep = Rent::get()?
        .minimum_balance(info.data_len())
        .checked_add(coin.creator_fees_unclaimed)
        .and_then(|v| v.checked_add(coin.platform_fees_unclaimed))
        .and_then(|v| v.checked_add(coin.buyback_lamports))
        .ok_or(FumpadError::MathOverflow)?;
    let left = info.lamports().checked_sub(amount).ok_or(FumpadError::MathOverflow)?;
    require!(left >= must_keep, FumpadError::LamportInvariant);
    info.sub_lamports(amount)?;
    to.add_lamports(amount)?;
    Ok(())
}
