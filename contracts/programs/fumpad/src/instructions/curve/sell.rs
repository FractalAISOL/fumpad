use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::Token2022,
    token_interface::{self, Mint, TokenAccount, TransferChecked},
};

use super::{accrue_fees, bump_stats, inline_buyback, reserves_of, store_reserves};
use crate::math::reference::Touch;
use crate::{
    constants::*,
    error::FumpadError,
    events::{CurveCompleted, CurveReopened, Trade},
    instructions::rewards::hooks::{self, SellHookAccounts, SellInfo},
    math::{curve::quote_sell, fees::compute_fee, price::price_q64},
    state::{Coin, CoinStatus, Global, Position, PAUSE_TRADE},
};

/// Sell on the bonding curve. The user receives the curve's SOL output minus the
/// FUMPAD fee (see `curve/mod.rs`); `min_sol_out` applies to that net amount.
/// Also the D13 escape hatch: allowed on a coin that has been `Complete` for ≥ 7 days
/// (the coin goes back to `Curve`, emitting `CurveReopened`).
#[event_cpi]
#[derive(Accounts)]
pub struct Sell<'info> {
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
        mut,
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

    /// CHECK: ticket PDA for the position's next sequence number; created by
    /// `hooks::on_sell` only if the sell qualifies.
    #[account(
        mut,
        seeds = [TICKET_SEED, mint.key().as_ref(), user.key().as_ref(), &position.next_ticket_seq.to_le_bytes()],
        bump,
    )]
    pub ticket: UncheckedAccount<'info>,

    /// CHECK: Pyth PriceUpdateV2 for SOL/USD; validated by `hooks::on_sell`.
    pub sol_usd_price: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn handle_sell<'info>(ctx: Context<'info, Sell<'info>>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
    let a = &mut *ctx.accounts;
    require!(!a.global.is_paused(PAUSE_TRADE), FumpadError::Paused);
    require!(tokens_in > 0, FumpadError::ZeroAmount);
    let now = Clock::get()?.unix_timestamp;
    // D13 escape hatch: a coin stuck in `Complete` (graduation impossible, e.g. PumpSwap
    // blocks create_pool) for ESCAPE_HATCH_SECS reopens as a plain curve. Its reserves are
    // exactly a curve with real_token = 0, so the sell (and later buys) are ordinary curve
    // trades; if buys exhaust it again it re-completes (fresh 7-day clock) and `graduate`
    // can still run then — at the same final curve price, so the pool price invariant holds.
    let reopened = a.coin.status == CoinStatus::Complete
        && now >= a.coin.completed_at.saturating_add(ESCAPE_HATCH_SECS);
    if reopened {
        a.coin.status = CoinStatus::Curve;
    }
    let completed_at = a.coin.completed_at;
    if reopened {
        a.coin.completed_at = 0;
    }
    require!(a.coin.status == CoinStatus::Curve, FumpadError::WrongCoinStatus);
    let balance_before = a.user_token_account.amount;

    // ── Quote ──
    let mut r = reserves_of(&a.coin);
    let pre_spot = r.spot_price_q64().ok_or(FumpadError::MathOverflow)?;
    let gross = quote_sell(&r, tokens_in).ok_or(FumpadError::InsufficientReserves)?;
    require!(gross > 0, FumpadError::ZeroAmount);
    let fee = compute_fee(gross, &a.coin.fees).ok_or(FumpadError::MathOverflow)?;
    let net = gross.checked_sub(fee.total).ok_or(FumpadError::MathOverflow)?;
    require!(net >= min_sol_out, FumpadError::SlippageExceeded);
    r.apply_sell(tokens_in, gross).ok_or(FumpadError::MathOverflow)?;

    // ── Move value: tokens user → curve vault (SOL is paid out last, see below) ──
    let decimals = a.mint.decimals;
    token_interface::transfer_checked(
        CpiContext::new(
            a.token_program.key(),
            TransferChecked {
                from: a.user_token_account.to_account_info(),
                mint: a.mint.to_account_info(),
                to: a.curve_vault.to_account_info(),
                authority: a.user.to_account_info(),
            },
        ),
        tokens_in,
        decimals,
    )?;

    // ── Fees: platform + creator accrue; pool share buys back inline ──
    let coin = &mut a.coin;
    accrue_fees(coin, fee.platform, fee.creator)?;
    let bb = inline_buyback(coin, &mut r, fee.pool)?;
    store_reserves(coin, &r);
    bump_stats(coin, gross);
    // D10: exact curve touch point. The ticket (if any) is floored at the updated average
    // scaled by this sell's own slippage from `pre_spot` (D12).
    let post_spot = r.spot_price_q64().ok_or(FumpadError::MathOverflow)?;
    coin.touch_reference(now, pre_spot, post_spot, Touch::Curve);
    let reference_price_q64 = coin.reference.avg_q64;
    // A sell's buyback can only finish the curve in pathological dust states; handle it anyway.
    let completed = r.real_token == 0;
    if completed {
        coin.status = CoinStatus::Complete;
        coin.completed_at = now;
    }
    if bb.tokens_out > 0 {
        let pa_bump = [ctx.bumps.pool_authority];
        let pa_seeds: &[&[u8]] = &[POOL_AUTHORITY_SEED, &pa_bump];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                a.token_program.key(),
                TransferChecked {
                    from: a.curve_vault.to_account_info(),
                    mint: a.mint.to_account_info(),
                    to: a.reward_vault.to_account_info(),
                    authority: a.pool_authority.to_account_info(),
                },
                &[pa_seeds],
            ),
            bb.tokens_out,
            decimals,
        )?;
    }

    // ── Rewards hook ──
    a.position.init_if_new(a.user.key(), a.mint.key(), ctx.bumps.position);
    let user_info = a.user.to_account_info();
    let system_info = a.system_program.to_account_info();
    let ticket_info = a.ticket.to_account_info();
    let price_info = a.sol_usd_price.to_account_info();
    let ticket = hooks::on_sell(
        SellHookAccounts {
            global: &a.global,
            coin: &a.coin,
            position: &mut a.position,
            ticket: &ticket_info,
            sol_usd_price: &price_info,
            seller: &user_info,
            system_program: &system_info,
            program_id: ctx.program_id,
            event_authority: &a.event_authority,
        },
        SellInfo {
            tokens_sold: tokens_in,
            gross_lamports_out: gross,
            balance_before,
            reference_price_q64,
            pre_trade_spot_q64: pre_spot,
            now,
        },
    )?;
    if ticket.is_some() {
        a.coin.tickets_created = a.coin.tickets_created.saturating_add(1);
    }

    let mint = a.mint.key();
    let user = a.user.key();
    if reopened {
        emit_cpi!(CurveReopened { mint, completed_at, ts: now });
    }
    emit_cpi!(Trade {
        mint,
        user,
        is_buy: false,
        on_amm: false,
        token_amount: tokens_in,
        sol_amount: gross,
        fee_pool: fee.pool,
        fee_platform: fee.platform,
        fee_creator: fee.creator,
        pool_tokens_bought: bb.tokens_out,
        price_q64: price_q64(gross, tokens_in).ok_or(FumpadError::MathOverflow)?,
        virtual_sol_reserves: r.virtual_sol,
        virtual_token_reserves: r.virtual_token,
        ts: now,
        snipe_tax: 0,
        snipe_tax_bps: 0,
    });
    if completed {
        emit_cpi!(CurveCompleted { mint, ts: now });
    }

    // Pay the seller LAST. A direct lamport move is only reconciled by the runtime at
    // the next CPI that includes the account (or at instruction end); a CPI touching
    // only one side (e.g. the rewards hook paying ticket rent from the seller) would
    // otherwise fail with UnbalancedInstruction.
    ctx.accounts.coin.sub_lamports(net)?;
    ctx.accounts.user.add_lamports(net)?;
    Ok(())
}
