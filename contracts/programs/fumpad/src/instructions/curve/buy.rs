use anchor_lang::{prelude::*, system_program};
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::Token2022,
    token_interface::{self, Mint, TokenAccount, TransferChecked},
};

use super::{accrue_fees, bump_stats, inline_buyback, reserves_of, store_reserves};
use crate::{
    constants::*,
    error::FumpadError,
    events::{CurveCompleted, Trade},
    instructions::rewards::hooks::{self, BuyHookAccounts},
    math::{curve::quote_buy, fees::compute_fee, price::price_q64},
    state::{Coin, CoinStatus, Global, Position, PAUSE_TRADE},
};

/// Buy on the bonding curve. `sol_in` = lamports offered to the curve; the FUMPAD fee
/// is charged on top of the lamports actually used (see `curve/mod.rs`).
///
/// remaining_accounts: the position's open tickets (exactly `position.open_count`,
/// any order) — consumed by `hooks::on_buy` for the rebuy rule.
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
    let p = a.global.params;
    require!(!a.global.is_paused(PAUSE_TRADE), FumpadError::Paused);
    require!(a.coin.status == CoinStatus::Curve, FumpadError::WrongCoinStatus);
    require!(sol_in > 0, FumpadError::ZeroAmount);
    let now = Clock::get()?.unix_timestamp;

    // ── Quote ──
    let mut r = reserves_of(&a.coin);
    let q = quote_buy(&r, sol_in).ok_or(FumpadError::MathOverflow)?;
    require!(q.tokens_out > 0, FumpadError::ZeroAmount);
    require!(q.tokens_out >= min_tokens_out, FumpadError::SlippageExceeded);
    let fee = compute_fee(q.sol_used, &p).ok_or(FumpadError::MathOverflow)?;
    r.apply_buy(&q).ok_or(FumpadError::MathOverflow)?;

    // ── Move value: SOL (curve + fee) user → coin; tokens curve vault → user ──
    let total_in = q.sol_used.checked_add(fee.total).ok_or(FumpadError::MathOverflow)?;
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

    // ── Fees: platform + creator accrue; pool share buys back inline ──
    let coin = &mut a.coin;
    accrue_fees(coin, fee.platform, fee.creator)?;
    let bb = inline_buyback(coin, &mut r, fee.pool)?;
    store_reserves(coin, &r);
    bump_stats(coin, q.sol_used);
    let completed = r.real_token == 0;
    if completed {
        coin.status = CoinStatus::Complete;
        coin.completed_at = now;
    }
    if bb.tokens_out > 0 {
        vault_transfer(a, a.reward_vault.to_account_info(), bb.tokens_out, decimals, &[pa_seeds])?;
    }

    // ── Rewards hook ──
    let open = a.position.open_count as usize;
    require!(ctx.remaining_accounts.len() >= open, FumpadError::OpenTicketsMismatch);
    a.position.init_if_new(a.user.key(), a.mint.key(), ctx.bumps.position);
    hooks::on_buy(
        BuyHookAccounts {
            global: &a.global,
            coin: &a.coin,
            position: &mut a.position,
            open_tickets: &ctx.remaining_accounts[..open],
            event_authority: &a.event_authority,
        },
        q.tokens_out,
        now,
    )?;

    let mint = a.mint.key();
    let user = a.user.key();
    emit_cpi!(Trade {
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
    });
    if completed {
        emit_cpi!(CurveCompleted { mint, ts: now });
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
