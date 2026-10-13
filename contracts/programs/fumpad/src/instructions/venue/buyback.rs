//! SPEC v0.7 §3.4: spend the coin's buyback balance on its own pool, tokens straight into the reward vault.
//! The swap payer is the `buyback` PDA (owns only its WSOL ATA); the venue account list is pinned exactly.

use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use anchor_spl::{
    associated_token::{get_associated_token_address_with_program_id, AssociatedToken},
    token::Token,
    token_2022::Token2022,
    token_interface::{Mint, TokenAccount},
};

use crate::{
    constants::*,
    error::FumpadError,
    events::BuybackExecuted,
    external::meteora::{self, DAMM_V2_PROGRAM_ID, DBC_PROGRAM_ID},
    math::price_q64_from_sqrt,
    state::*,
};

use super::common::{token_amount, wrap_from_coin};

#[event_cpi]
#[derive(Accounts)]
pub struct ExecuteBuyback<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    #[account(mut, seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump, has_one = mint @ FumpadError::InvalidAccount)]
    pub coin: Box<Account<'info, Coin>>,
    #[account(mint::token_program = token_2022_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: PDA ["observations", mint]; loaded (graduated coins) in the handler; unused pre-graduation.
    #[account(seeds = [OBSERVATIONS_SEED, mint.key().as_ref()], bump)]
    pub observations: UncheckedAccount<'info>,
    /// CHECK: PDA ["buyback"] (no data); the venue `payer`.
    #[account(mut, seeds = [BUYBACK_SEED], bump)]
    pub buyback: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = cranker,
        associated_token::mint = wsol_mint,
        associated_token::authority = buyback,
        associated_token::token_program = token_program,
    )]
    pub buyback_wsol: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: ATA(reward_pool, mint, Token-2022).
    #[account(
        mut,
        address = get_associated_token_address_with_program_id(&super::fees::reward_pool_key(), &mint.key(), &anchor_spl::token_2022::ID)
            @ FumpadError::InvalidAccount,
    )]
    pub reward_vault: UncheckedAccount<'info>,
    #[account(address = WSOL_MINT @ FumpadError::InvalidAccount)]
    pub wsol_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: DBC (coin `Curve`) or DAMM v2 (coin `Graduated`).
    pub venue_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

fn mul_div(a: u128, b: u128, d: u128) -> Result<u128> {
    a.checked_mul(b).and_then(|x| x.checked_div(d)).ok_or_else(|| error!(FumpadError::MathOverflow))
}

pub fn handle_execute_buyback<'info>(ctx: Context<'info, ExecuteBuyback<'info>>, max_in: u64) -> Result<()> {
    let clock = Clock::get()?;
    let (now, slot) = (clock.unix_timestamp, clock.slot);
    let venue_accounts = ctx.remaining_accounts;
    let buyback_bump = ctx.bumps.buyback;
    let a = &mut *ctx.accounts;
    let p = a.global.params;
    require!(!a.global.is_paused(PAUSE_TRADE, now), FumpadError::Paused);

    let mint = a.mint.key();
    let buyback_key = a.buyback.key();
    let wsol_key = a.buyback_wsol.key();
    let vault_key = a.reward_vault.key();

    // Guard price, spot, slice cap and the exact venue account list.
    let (venue, guard, spot, cap, expected): (u8, u128, u128, u64, Vec<Pubkey>) = match a.coin.status {
        CoinStatus::Curve => {
            // Pre-graduation: operator-only (the jobs keeper; never an attestor key), after the anti-snipe window,
            // spot within ±band of BOTH the median of the recent operator samples (the guard price) and the last
            // operator sample (≤ 60 s old).
            require!(a.global.is_operator(&a.cranker.key()), FumpadError::Unauthorized);
            require!(
                slot >= a.coin.launch_slot.saturating_add(a.coin.launch_window_slots),
                FumpadError::LaunchWindowActive
            );
            require_keys_eq!(a.venue_program.key(), DBC_PROGRAM_ID, FumpadError::WrongVenue);
            let pool_info = venue_accounts.get(2).ok_or(FumpadError::WrongVenue)?;
            require_keys_eq!(pool_info.key(), a.coin.dbc_pool, FumpadError::WrongVenue);
            let pool = meteora::read_dbc_pool(pool_info)?;
            require!(pool.migration_progress == meteora::DBC_PROGRESS_PRE_BONDING, FumpadError::WrongCoinStatus);
            require!(
                a.coin.pregrad_sample_ts > 0 && now.saturating_sub(a.coin.pregrad_sample_ts) <= PREGRAD_SAMPLE_MAX_AGE_SECS,
                FumpadError::StaleSample
            );
            // L5: the guard is the median of the recent keeper samples (≥ 4 within 5 min, spanning ≥ 60 s), so one
            // sample taken at a moved spot can't steer it; spot must also stay within the band of the latest sample.
            let median = a.coin.pregrad_ring.median_q64(now).ok_or(FumpadError::InsufficientSamples)?;
            let latest = a.coin.pregrad_sample_price_q64;
            let latest_band = mul_div(latest, p.buyback_max_deviation_bps as u128, BPS_DENOM as u128)?;
            let config_info = venue_accounts.get(1).ok_or(FumpadError::WrongVenue)?;
            require_keys_eq!(config_info.key(), a.coin.dbc_config, FumpadError::WrongVenue);
            let threshold = {
                let d = meteora::checked_data(
                    config_info,
                    &DBC_PROGRAM_ID,
                    &meteora::ACC_DBC_POOL_CONFIG,
                    meteora::DBC_CONFIG_LEN,
                )?;
                meteora::rd_u64(&d, meteora::CFG_MIGRATION_QUOTE_THRESHOLD)
            };
            let slice = mul_div(pool.quote_reserve as u128, p.buyback_max_pool_bps as u128, BPS_DENOM as u128)? as u64;
            // Never complete the curve: quote_reserve + spend must stay below the threshold.
            let room = threshold.saturating_sub(pool.quote_reserve).saturating_sub(1);
            let expected = vec![
                meteora::DBC_POOL_AUTHORITY,
                a.coin.dbc_config,
                a.coin.dbc_pool,
                wsol_key,
                vault_key,
                pool.base_vault,
                pool.quote_vault,
                mint,
                WSOL_MINT,
                buyback_key,
                anchor_spl::token_2022::ID,
                anchor_spl::token::ID,
                DBC_PROGRAM_ID,
                meteora::DBC_EVENT_AUTHORITY,
                DBC_PROGRAM_ID,
            ];
            let spot = price_q64_from_sqrt(pool.sqrt_price).ok_or(FumpadError::MathOverflow)?;
            require!(spot.abs_diff(latest) <= latest_band, FumpadError::PriceDeviation);
            (meteora::VENUE_DBC, median, spot, slice.min(room), expected)
        }
        CoinStatus::Graduated => {
            require_keys_eq!(a.venue_program.key(), DAMM_V2_PROGRAM_ID, FumpadError::WrongVenue);
            let pool_info = venue_accounts.get(1).ok_or(FumpadError::WrongVenue)?;
            require_keys_eq!(pool_info.key(), a.coin.damm_pool, FumpadError::WrongVenue);
            let pool = meteora::read_damm_pool(pool_info)?;
            // D38: never buy on a pool its DAMM v2 operator disabled (its spot is frozen, not a market price).
            require!(pool.pool_status == meteora::DAMM_POOL_STATUS_ENABLED, FumpadError::PoolDisabled);
            let median = {
                let info = a.observations.to_account_info();
                require_keys_eq!(*info.owner, crate::ID, FumpadError::InsufficientSamples);
                let d = info.try_borrow_data()?;
                let size = core::mem::size_of::<Observations>();
                require!(d.len() >= 8 + size && d[..8] == *Observations::DISCRIMINATOR, FumpadError::InvalidAccount);
                let obs: &Observations =
                    bytemuck::try_from_bytes(&d[8..8 + size]).map_err(|_| error!(FumpadError::InvalidAccount))?;
                require_keys_eq!(obs.pool, a.coin.damm_pool, FumpadError::InvalidAccount);
                obs.median_price_q64(now, p.oracle_window_secs, p.oracle_min_samples)
                    .ok_or(FumpadError::InsufficientSamples)?
            };
            let slice = mul_div(pool.token_b_amount as u128, p.buyback_max_pool_bps as u128, BPS_DENOM as u128)? as u64;
            let expected = vec![
                meteora::DAMM_POOL_AUTHORITY,
                a.coin.damm_pool,
                wsol_key,
                vault_key,
                pool.token_a_vault,
                pool.token_b_vault,
                mint,
                WSOL_MINT,
                buyback_key,
                anchor_spl::token_2022::ID,
                anchor_spl::token::ID,
                DAMM_V2_PROGRAM_ID,
                meteora::DAMM_EVENT_AUTHORITY,
                DAMM_V2_PROGRAM_ID,
            ];
            let spot = price_q64_from_sqrt(pool.sqrt_price).ok_or(FumpadError::MathOverflow)?;
            (meteora::VENUE_DAMM, median, spot, slice, expected)
        }
        CoinStatus::Complete => return err!(FumpadError::WrongCoinStatus),
    };
    meteora::require_exact_accounts(venue_accounts, &expected)?;
    require!(guard > 0, FumpadError::StaleSample);
    let band = mul_div(guard, p.buyback_max_deviation_bps as u128, BPS_DENOM as u128)?;
    require!(spot.abs_diff(guard) <= band, FumpadError::PriceDeviation);

    let spend = max_in.min(a.coin.buyback_lamports).min(cap);
    require!(spend > 0, FumpadError::NothingToBuyBack);

    // Minimum acceptable tokens: fair amount at the guard price less the band, the venue fee allowance and twice
    // the slice's max price impact.
    let haircut_bps = (p.buyback_max_deviation_bps as u64)
        .saturating_add(BUYBACK_VENUE_FEE_ALLOWANCE_BPS)
        .saturating_add(2 * p.buyback_max_pool_bps as u64);
    require!(haircut_bps < BPS_DENOM, FumpadError::InvalidParams);
    let fair_tokens = ((spend as u128) << 64).checked_div(guard).ok_or(FumpadError::MathOverflow)?;
    let min_tokens = mul_div(fair_tokens, (BPS_DENOM - haircut_bps) as u128, BPS_DENOM as u128)?;
    let min_tokens = u64::try_from(min_tokens).map_err(|_| error!(FumpadError::MathOverflow))?.max(1);

    // Coin → buyback WSOL (wrapped). Coin invariant: the lamports leave with the matching buyback decrement.
    let seeds: &[&[u8]] = &[BUYBACK_SEED, &[buyback_bump]];
    let wsol_info = a.buyback_wsol.to_account_info();
    wrap_from_coin(
        &a.coin.to_account_info(),
        &a.buyback.to_account_info(),
        seeds,
        &wsol_info,
        &a.system_program.to_account_info(),
        &a.token_program.to_account_info(),
        spend,
    )?;
    a.coin.buyback_lamports -= spend; // spend ≤ buyback_lamports

    let vault_info = a.reward_vault.to_account_info();
    let vault_before = token_amount(&vault_info)?;
    let wsol_before = token_amount(&wsol_info)?;
    meteora::invoke_passthrough(
        &a.venue_program.to_account_info(),
        venue_accounts,
        meteora::swap2_data(spend, min_tokens, meteora::SWAP_MODE_EXACT_IN),
        Some((&buyback_key, seeds)),
    )?;
    let tokens_out = token_amount(&vault_info)?.checked_sub(vault_before).ok_or(FumpadError::MathOverflow)?;
    let spent = wsol_before.checked_sub(token_amount(&wsol_info)?).ok_or(FumpadError::MathOverflow)?;
    require!(tokens_out >= min_tokens, FumpadError::SlippageExceeded);
    require!(spent <= spend, FumpadError::InvalidAccount);
    // Rounding dust stays wrapped in ATA(buyback, WSOL); it counts as spent from this coin's balance.
    a.coin.buyback_spent_lamports = a.coin.buyback_spent_lamports.saturating_add(spend);
    a.coin.buyback_tokens = a.coin.buyback_tokens.saturating_add(tokens_out);

    let ev = BuybackExecuted { mint, venue, lamports_in: spend, tokens_out, guard_price_q64: guard, spot_price_q64: spot, ts: now };
    emit_event!(ctx, ev);
    Ok(())
}
