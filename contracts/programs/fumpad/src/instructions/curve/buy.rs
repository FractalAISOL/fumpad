use anchor_lang::{prelude::*, system_program};
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::Token2022,
    token_interface::{self, Mint, TokenAccount, TransferChecked},
};

use super::{accrue_fees, bump_stats, inline_buyback, reserves_of, store_reserves};
use crate::math::reference::Touch;
use crate::{
    constants::*,
    error::FumpadError,
    events::{CurveCompleted, Trade},
    instructions::rewards::hooks::{self, BuyHookAccounts},
    math::{
        curve::quote_buy,
        fees::{compute_fee, snipe_curve_offer, snipe_tax, snipe_tax_bps},
        price::price_q64,
    },
    state::{Coin, CoinStatus, Global, Position, PAUSE_TRADE},
};

/// Buy on the bonding curve. `sol_in` = lamports offered to the curve; the FUMPAD fee
/// is charged on top of the lamports actually used (see `curve/mod.rs`).
///
/// D19: in the first `coin.snipe.window_slots` slots after launch a snipe tax of
/// `snipe_tax_bps` is carved out of `sol_in` (only the rest is offered to the curve; the
/// normal fee is on that rest), so the buyer's total never exceeds `sol_in` + normal fee.
/// The tax goes entirely to the reward pool (inline buyback); `Trade.snipe_tax` /
/// `snipe_tax_bps` report it. The creator's buy bundled with `create_coin` is exempt.
///
/// remaining_accounts: the position's open tickets (exactly `position.open_count`,
/// any order), then the coin's ClaimQueue only if one of them is `Queued` — consumed by
/// `hooks::on_buy` for the rebuy rule (`hooks::split_rebuy_accounts`).
#[event_cpi]
#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,

    #[account(mut, seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump, has_one = mint)]
    pub coin: Box<Account<'info, Coin>>,

    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: PDA; token authority of the vaults.
    #[account(seeds = [POOL_AUTHORITY_SEED], bump)]
    pub pool_authority: UncheckedAccount<'info>,

    #[account(mut, seeds = [CURVE_VAULT_SEED, mint.key().as_ref()], bump)]
    pub curve_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut, seeds = [REWARD_VAULT_SEED, mint.key().as_ref()], bump)]
    pub reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, mint.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub position: Box<Account<'info, Position>>,

    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_buy<'info>(ctx: Context<'info, Buy<'info>>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
    let a = &mut *ctx.accounts;
    require!(!a.global.is_paused(PAUSE_TRADE), FumpadError::Paused);
    require!(a.coin.status == CoinStatus::Curve, FumpadError::WrongCoinStatus);
    require!(sol_in > 0, FumpadError::ZeroAmount);
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // Canonical ATA balance before the buy (R-L2 observation).
    let balance_before = a.user_token_account.amount;

    // ── D19 snipe tax ──
    // Exempt: the creator's buy that is the coin's very first trade, in the launch slot —
    // i.e. the buy bundled with `create_coin` (nothing can trade in between inside one
    // transaction). A second creator buy, a later slot, or any other wallet (dev alts
    // included) pays the schedule.
    let creator_launch_buy =
        a.user.key() == a.coin.creator && clock.slot == a.coin.snipe.launch_slot && a.coin.trade_count == 0;
    let snipe_bps = if creator_launch_buy { 0 } else { snipe_tax_bps(&a.coin.snipe, clock.slot) };
    let curve_offer = snipe_curve_offer(sol_in, snipe_bps).ok_or(FumpadError::MathOverflow)?;

    // ── Quote ──
    let mut r = reserves_of(&a.coin);
    let pre_spot = r.spot_price_q64().ok_or(FumpadError::MathOverflow)?;
    let q = quote_buy(&r, curve_offer).ok_or(FumpadError::MathOverflow)?;
    require!(q.tokens_out > 0, FumpadError::ZeroAmount);
    require!(q.tokens_out >= min_tokens_out, FumpadError::SlippageExceeded);
    let fee = compute_fee(q.sol_used, &a.coin.fees).ok_or(FumpadError::MathOverflow)?;
    // Tax follows the SOL the curve actually took (a completing buy uses less than offered).
    let snipe = snipe_tax(q.sol_used, snipe_bps).ok_or(FumpadError::MathOverflow)?;
    r.apply_buy(&q).ok_or(FumpadError::MathOverflow)?;

    // ── Move value: SOL (curve + fee + snipe tax) user → coin; tokens curve vault → user ──
    let total_in = q
        .sol_used
        .checked_add(fee.total)
        .and_then(|t| t.checked_add(snipe))
        .ok_or(FumpadError::MathOverflow)?;
    system_program::transfer(
        CpiContext::new(
            a.system_program.key(),
            system_program::Transfer { from: a.user.to_account_info(), to: a.coin.to_account_info() },
        ),
        total_in,
    )?;
    let pa_bump = [ctx.bumps.pool_authority];
    let pa_seeds: &[&[u8]] = &[POOL_AUTHORITY_SEED, &pa_bump];
    let decimals = a.mint.decimals;
    vault_transfer(a, a.user_token_account.to_account_info(), q.tokens_out, decimals, &[pa_seeds])?;

    // ── Fees: platform + creator accrue; pool share + the whole snipe tax buy back inline ──
    let coin = &mut a.coin;
    accrue_fees(coin, fee.platform, fee.creator)?;
    let pool_lamports = fee.pool.checked_add(snipe).ok_or(FumpadError::MathOverflow)?;
    let bb = inline_buyback(coin, &mut r, pool_lamports)?;
    store_reserves(coin, &r);
    bump_stats(coin, q.sol_used);
    // D10: exact curve touch point (post-trade spot includes the inline buyback).
    let post_spot = r.spot_price_q64().ok_or(FumpadError::MathOverflow)?;
    coin.touch_reference(now, pre_spot, post_spot, Touch::Curve);
    let completed = r.real_token == 0;
    if completed {
        coin.status = CoinStatus::Complete;
        coin.completed_at = now;
    }
    if bb.tokens_out > 0 {
        vault_transfer(a, a.reward_vault.to_account_info(), bb.tokens_out, decimals, &[pa_seeds])?;
    }

    // ── Rewards hook ──
    let (rebuy, rest) = hooks::split_rebuy_accounts(&a.position, ctx.remaining_accounts)?;
    require!(rest.is_empty(), FumpadError::OpenTicketsMismatch);
    a.position.init_if_new(a.user.key(), a.mint.key(), ctx.bumps.position);
    hooks::on_buy(
        BuyHookAccounts {
            global: &a.global,
            coin: &a.coin,
            position: &mut a.position,
            rebuy,
            event_authority: &a.event_authority,
        },
        q.tokens_out,
        balance_before,
        now,
    )?;

    let mint = a.mint.key();
    let user = a.user.key();
    emit_event!(ctx, Trade {
        mint,
        user,
        is_buy: true,
        on_amm: false,
        token_amount: q.tokens_out,
        sol_amount: q.sol_used,
        fee_pool: fee.pool,
        fee_platform: fee.platform,
        fee_creator: fee.creator,
        pool_tokens_bought: bb.tokens_out,
        price_q64: price_q64(q.sol_used, q.tokens_out).ok_or(FumpadError::MathOverflow)?,
        virtual_sol_reserves: r.virtual_sol,
        virtual_token_reserves: r.virtual_token,
        ts: now,
        snipe_tax: snipe,
        snipe_tax_bps: snipe_bps,
    });
    if completed {
        emit_event!(ctx, CurveCompleted { mint, ts: now });
    }
    Ok(())
}

/// Tokens out of the curve vault, signed by the pool authority PDA.
fn vault_transfer<'info>(
    a: &Buy<'info>,
    to: AccountInfo<'info>,
    amount: u64,
    decimals: u8,
    signer: &[&[&[u8]]],
) -> Result<()> {
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            a.token_program.key(),
            TransferChecked {
                from: a.curve_vault.to_account_info(),
                mint: a.mint.to_account_info(),
                to,
                authority: a.pool_authority.to_account_info(),
            },
            signer,
        ),
        amount,
        decimals,
    )
}
