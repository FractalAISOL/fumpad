//! D11: settle LP fees skimmed by the `fumpad_lp_locker`. Permissionless.
//!
//! The locker's `skim` pays the WSOL side of withdrawn fee growth into ATA(coin PDA, WSOL)
//! (base tokens go straight to the reward vault). This instruction unwraps it — closes the
//! ATA to the caller, who forwards exactly the unwrapped SOL to the Coin account and keeps
//! the ATA's rent reserve (the skim caller re-creates the ATA idempotently, so a keeper doing
//! both nets zero) — and credits it 60% platform / 40% creator. Coin lamport invariant:
//! lamports and the two fee counters grow by the same amount.

use anchor_lang::{prelude::*, system_program};
use anchor_spl::{
    token::Token,
    token_interface::{self, CloseAccount, Mint, TokenAccount},
};

use crate::{
    constants::*,
    error::FumpadError,
    events::LpFeesSettled,
    external::pumpswap::WSOL_MINT,
    state::{Coin, CoinStatus},
};

#[event_cpi]
#[derive(Accounts)]
pub struct SettleLpFees<'info> {
    /// Anyone; receives the ATA's rent reserve.
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [COIN_SEED, coin.mint.as_ref()], bump = coin.bump)]
    pub coin: Box<Account<'info, Coin>>,
    #[account(address = WSOL_MINT @ FumpadError::InvalidAccount)]
    pub wsol_mint: Box<InterfaceAccount<'info, Mint>>,
    /// ATA(coin, WSOL): the locker's fixed quote destination for this coin.
    #[account(
        mut,
        associated_token::mint = wsol_mint,
        associated_token::authority = coin,
        associated_token::token_program = token_program,
    )]
    pub lp_fee_wsol: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_settle_lp_fees(ctx: Context<SettleLpFees>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &mut *ctx.accounts;
    require!(a.coin.status == CoinStatus::Graduated, FumpadError::WrongCoinStatus);
    // Native account: lamports = rent reserve + wrapped SOL (+ any unsynced donation).
    let reserve = a.lp_fee_wsol.is_native.ok_or(FumpadError::InvalidAccount)?;
    let lamports = a.lp_fee_wsol.to_account_info().lamports().checked_sub(reserve).ok_or(FumpadError::MathOverflow)?;
    require!(lamports > 0, FumpadError::NothingToSettle);

    let mint = a.coin.mint;
    let bump = [a.coin.bump];
    let coin_seeds: &[&[u8]] = &[COIN_SEED, mint.as_ref(), &bump];
    token_interface::close_account(CpiContext::new_with_signer(
        a.token_program.key(),
        CloseAccount {
            account: a.lp_fee_wsol.to_account_info(),
            destination: a.cranker.to_account_info(),
            authority: a.coin.to_account_info(),
        },
        &[coin_seeds],
    ))?;
    system_program::transfer(
        CpiContext::new(
            a.system_program.key(),
            system_program::Transfer { from: a.cranker.to_account_info(), to: a.coin.to_account_info() },
        ),
        lamports,
    )?;

    let platform = ((lamports as u128) * LP_FEE_PLATFORM_SHARE_BPS as u128 / BPS_DENOM as u128) as u64;
    let creator = lamports - platform;
    let coin = &mut a.coin;
    coin.platform_fees_unclaimed = coin.platform_fees_unclaimed.checked_add(platform).ok_or(FumpadError::MathOverflow)?;
    coin.creator_fees_unclaimed = coin.creator_fees_unclaimed.checked_add(creator).ok_or(FumpadError::MathOverflow)?;
    emit_cpi!(LpFeesSettled { mint, lamports, platform, creator, ts: now });
    Ok(())
}
