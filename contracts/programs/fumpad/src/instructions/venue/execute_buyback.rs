//! Post-graduation buyback crank. OWNER: venue/oracle module.
//!
//! Permissionless. Spends
//!   min(max_lamports, coin.buyback_lamports, buyback_max_pool_bps × effective quote depth)
//! of the coin's accrued pool-share fees on a PumpSwap buy whose tokens land directly in
//! the coin's reward vault — but only while spot is within ±buyback_max_deviation_bps of
//! the 30-min oracle median (no samples → InsufficientSamples). The slice cap bounds price
//! impact; the band bounds how much a sandwicher can make the buyback overpay; and the
//! received tokens must be at least the median-fair amount minus the band, fee and impact
//! allowances, so even a manipulated pool can't make it overpay beyond that.
//!
//! The PumpSwap `user` is the PUMPSWAP_SIGNER PDA (L-1, v0.6: no data, signs via seeds, owns
//! nothing but its WSOL ATA — the reward vault it buys into belongs to `pool_authority`, which
//! never signs here), paying from
//! its WSOL ATA. One-time client setup: PumpSwap `init_user_volume_accumulator(payer,
//! user = pumpswap_signer)`, because the signer holds no SOL to pay for it. The venue slice
//! must be exactly the 17 `buy_exact_quote_in_v2` accounts.
//!
//! remaining_accounts = PumpSwap `buy_exact_quote_in_v2` accounts with
//!   user = pumpswap_signer, user_base_token_account = reward_vault,
//!   user_quote_token_account = buyback_wsol.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::Token,
    token_2022::Token2022,
    token_interface::{Mint, TokenAccount},
};

use super::common::*;
use crate::{
    constants::*,
    error::FumpadError,
    events::BuybackExecuted,
    external::pumpswap::{self, token_amount, VenueExpect, WSOL_MINT},
    state::*,
};

/// Allowance for PumpSwap's own fees when checking the received amount (they are
/// 0.25–0.30% today; if PumpSwap raised them past this, buybacks would just stop).
pub const BUYBACK_VENUE_FEE_ALLOWANCE_BPS: u64 = 100;

#[event_cpi]
#[derive(Accounts)]
pub struct ExecuteBuyback<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
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
    #[account(seeds = [OBSERVATIONS_SEED, mint.key().as_ref()], bump)]
    pub observations: AccountLoader<'info, Observations>,
    #[account(
        mut,
        seeds = [REWARD_VAULT_SEED, mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::token_program = token_2022_program,
    )]
    pub reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: L-1 PDA ["pumpswap_signer"], no data; PumpSwap `user` for buybacks (signs via
    /// seeds). Holds nothing but `buyback_wsol`.
    #[account(mut, seeds = [PUMPSWAP_SIGNER_SEED], bump)]
    pub pumpswap_signer: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = cranker,
        associated_token::mint = wsol_mint,
        associated_token::authority = pumpswap_signer,
        associated_token::token_program = token_program,
    )]
    pub buyback_wsol: Box<InterfaceAccount<'info, TokenAccount>>,
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

fn mul_div(a: u128, b: u128, d: u128) -> Result<u128> {
    a.checked_mul(b).and_then(|x| x.checked_div(d)).ok_or_else(|| error!(FumpadError::MathOverflow))
}

pub fn handle_execute_buyback<'info>(ctx: Context<'info, ExecuteBuyback<'info>>, max_lamports: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let venue = ctx.remaining_accounts;
    let authority_bump = ctx.bumps.pumpswap_signer;
    let a = &mut *ctx.accounts;
    let p = a.global.params;

    require!(!a.global.is_paused(PAUSE_TRADE, now), FumpadError::Paused);
    require!(a.coin.status == CoinStatus::Graduated, FumpadError::WrongCoinStatus);

    let wsol_info = a.buyback_wsol.to_account_info();
    let vault_info = a.reward_vault.to_account_info();
    let (_, reserves) = pumpswap::validate_venue(
        venue,
        &VenueExpect {
            pool: a.coin.amm_pool,
            base_mint: a.mint.key(),
            user: a.pumpswap_signer.key(),
            user_base: vault_info.key(),
            user_quote: wsol_info.key(),
        },
    )?;

    // Oracle guard: spot within ±deviation of the median.
    let median = {
        let obs = a.observations.load()?;
        require_keys_eq!(obs.pool, a.coin.amm_pool, FumpadError::InvalidAccount);
        obs.median_price_q64(now, p.oracle_window_secs, p.oracle_min_samples)
            .ok_or(FumpadError::InsufficientSamples)?
    };
    let spot = reserves.spot_price_q64()?;
    let band = mul_div(median, p.buyback_max_deviation_bps as u128, BPS_DENOM as u128)?;
    require!(spot.abs_diff(median) <= band, FumpadError::PriceDeviation);

    // Slice.
    let cap = mul_div(reserves.quote as u128, p.buyback_max_pool_bps as u128, BPS_DENOM as u128)? as u64;
    let spend = max_lamports.min(a.coin.buyback_lamports).min(cap);
    require!(spend > 0, FumpadError::NothingToBuyBack);

    // Minimum acceptable tokens: fair amount at the median, less the deviation band,
    // the venue-fee allowance and twice the slice's max price impact.
    let haircut_bps = (p.buyback_max_deviation_bps as u64)
        .saturating_add(BUYBACK_VENUE_FEE_ALLOWANCE_BPS)
        .saturating_add(2 * p.buyback_max_pool_bps as u64);
    require!(haircut_bps < BPS_DENOM, FumpadError::InvalidParams);
    let fair_tokens = ((spend as u128) << 64).checked_div(median).ok_or(FumpadError::MathOverflow)?;
    let min_tokens = mul_div(fair_tokens, (BPS_DENOM - haircut_bps) as u128, BPS_DENOM as u128)?;
    let min_tokens = u64::try_from(min_tokens).map_err(|_| error!(FumpadError::MathOverflow))?.max(1);

    // Move `spend` lamports Coin → buyback WSOL account and wrap. Coin invariant: the
    // lamports leave together with the matching `buyback_lamports` decrement.
    let seeds: &[&[u8]] = &[PUMPSWAP_SIGNER_SEED, &[authority_bump]];
    wrap_from_program_account(
        &a.coin.to_account_info(),
        &a.pumpswap_signer.to_account_info(),
        seeds,
        &wsol_info,
        &a.system_program.to_account_info(),
        &a.token_program.to_account_info(),
        spend,
    )?;
    a.coin.buyback_lamports -= spend; // spend ≤ buyback_lamports

    let vault_before = token_amount(&vault_info)?;
    let wsol_before = token_amount(&wsol_info)?;
    pumpswap::cpi_buy_exact_quote_in(venue, &a.pumpswap_program.to_account_info(), spend, min_tokens, Some(seeds))?;
    let tokens_out = token_amount(&vault_info)?.checked_sub(vault_before).ok_or(FumpadError::MathOverflow)?;
    let spent = wsol_before.checked_sub(token_amount(&wsol_info)?).ok_or(FumpadError::MathOverflow)?;
    require!(tokens_out >= min_tokens, FumpadError::SlippageExceeded);
    require!(spent <= spend, FumpadError::InvalidAccount);
    // Any unspent remainder (rounding dust) stays wrapped in the protocol's buyback WSOL
    // account; it is accounted as spent from this coin's buyback balance.

    let ev = BuybackExecuted { mint: a.mint.key(), lamports_in: spend, tokens_out, ts: now };
    emit_event!(ctx, ev);
    Ok(())
}
