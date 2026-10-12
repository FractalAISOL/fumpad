//! Router buy on a graduated coin's PumpSwap pool. OWNER: venue/oracle module.
//!
//! Fee convention (same as the curve, pump.fun style): `sol_in` is what goes into the
//! pool; FUMPAD's fee (`fee_bps` of the SOL actually spent) is charged ON TOP, in native
//! SOL, from the user's wallet.
//!
//! WSOL: the user never wraps. The program creates (if needed) the user's WSOL ATA,
//! wraps exactly `sol_in`, swaps, and closes the WSOL ATA again, so any unspent quote and
//! the ATA rent return to the user as SOL. NOTE: closing unwraps the WHOLE ATA, so WSOL
//! the user already held there comes back as native SOL too (value-neutral).
//!
//! remaining_accounts = [ the position's open tickets (exactly `position.open_count`) ,
//!                        the coin's ClaimQueue — only if one of those tickets is Queued ,
//!                        PumpSwap `buy_exact_quote_in_v2` accounts, in PumpSwap order ]
//! The venue slice's `user` is this instruction's `user`, its `user_base_token_account`
//! is `user_token_account`, its `user_quote_token_account` is `user_wsol`.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::Token,
    token_2022::Token2022,
    token_interface::{Mint, TokenAccount},
};

use super::common::*;
use crate::math::reference::Touch;
use crate::{
    constants::*,
    error::FumpadError,
    events::Trade,
    external::pumpswap::{self, token_amount, VenueExpect, WSOL_MINT},
    instructions::rewards::hooks::{self, BuyHookAccounts},
    math::{compute_fee, price_q64},
    state::*,
};

#[event_cpi]
#[derive(Accounts)]
pub struct SwapBuy<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    #[account(
        mut,
        seeds = [COIN_SEED, mint.key().as_ref()],
        bump = coin.bump,
        has_one = mint @ FumpadError::InvalidAccount,
    )]
    pub coin: Box<Account<'info, Coin>>,
    #[account(mint::token_program = token_2022_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, mint.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub position: Box<Account<'info, Position>>,
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = wsol_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_wsol: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = WSOL_MINT @ FumpadError::InvalidAccount)]
    pub wsol_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: address-checked; the only program the router CPIs into.
    #[account(address = PUMPSWAP_PROGRAM_ID @ FumpadError::WrongVenue)]
    pub pumpswap_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_swap_buy<'info>(ctx: Context<'info, SwapBuy<'info>>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let remaining = ctx.remaining_accounts;
    let a = &mut *ctx.accounts;

    require!(sol_in > 0, FumpadError::ZeroAmount);
    require!(!a.global.is_paused(PAUSE_TRADE, now), FumpadError::Paused);
    require!(a.coin.status == CoinStatus::Graduated, FumpadError::WrongCoinStatus);

    let (rebuy, venue) = hooks::split_rebuy_accounts(&a.position, remaining)?;

    let user_info = a.user.to_account_info();
    let token_acc_info = a.user_token_account.to_account_info();
    let wsol_info = a.user_wsol.to_account_info();
    let (pool, before) = pumpswap::validate_venue(
        venue,
        &VenueExpect {
            pool: a.coin.amm_pool,
            base_mint: a.mint.key(),
            user: user_info.key(),
            user_base: token_acc_info.key(),
            user_quote: wsol_info.key(),
        },
    )?;

    // Wrap exactly `sol_in`.
    let system_info = a.system_program.to_account_info();
    let token_program_info = a.token_program.to_account_info();
    transfer_sol(&system_info, &user_info, &wsol_info, sol_in)?;
    sync_native(&token_program_info, &wsol_info)?;

    let tokens_before = token_amount(&token_acc_info)?;
    let wsol_before = token_amount(&wsol_info)?;
    pumpswap::cpi_buy_exact_quote_in(venue, &a.pumpswap_program.to_account_info(), sol_in, min_tokens_out, None)?;
    let tokens_out = token_amount(&token_acc_info)?.checked_sub(tokens_before).ok_or(FumpadError::MathOverflow)?;
    let spent = wsol_before.checked_sub(token_amount(&wsol_info)?).ok_or(FumpadError::MathOverflow)?;
    require!(tokens_out > 0 && tokens_out >= min_tokens_out, FumpadError::SlippageExceeded);
    require!(spent > 0 && spent <= sol_in, FumpadError::InvalidAccount);

    // FUMPAD fee on top of the SOL actually spent, paid in native SOL into the Coin account.
    let fee = compute_fee(spent, &a.coin.fees).ok_or(FumpadError::MathOverflow)?;
    transfer_sol(&system_info, &user_info, &a.coin.to_account_info(), fee.total)?;
    accrue_fee(&mut a.coin, &fee)?;
    record_volume(&mut a.coin, spent);

    // Unwrap: unspent quote + ATA rent back to the user as SOL.
    unwrap_wsol(&token_program_info, &wsol_info, &user_info, &user_info)?;

    // Rewards bookkeeping.
    let position_bump = ctx.bumps.position;
    a.position.init_if_new(user_info.key(), a.mint.key(), position_bump);
    hooks::on_buy(
        BuyHookAccounts {
            global: &a.global,
            coin: &a.coin,
            position: &mut a.position,
            rebuy,
            event_authority: &a.event_authority,
        },
        tokens_out,
        tokens_before,
        now,
    )?;

    // D10: PumpSwap touch point (pre-trade effective spot, post-trade spot).
    let after = pumpswap::venue_reserves(venue, &pool)?;
    // A degenerate (empty-sided) pool has no spot: skip the update rather than fail the trade.
    if let (Ok(pre), Ok(post)) = (before.spot_price_q64(), after.spot_price_q64()) {
        a.coin.touch_reference(now, pre, post, Touch::Venue);
    }

    let ev = Trade {
        mint: a.mint.key(),
        user: user_info.key(),
        is_buy: true,
        on_amm: true,
        token_amount: tokens_out,
        sol_amount: spent,
        fee_pool: fee.pool,
        fee_platform: fee.platform,
        fee_creator: fee.creator,
        pool_tokens_bought: 0,
        price_q64: price_q64(spent, tokens_out).ok_or(FumpadError::MathOverflow)?,
        virtual_sol_reserves: after.quote,
        virtual_token_reserves: after.base,
        ts: now,
        snipe_tax: 0,
        snipe_tax_bps: 0,
    };
    emit_event!(ctx, ev);
    Ok(())
}
