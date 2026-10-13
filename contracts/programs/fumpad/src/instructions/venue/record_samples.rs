//! SPEC v0.7 §6: keeper price samples. remaining_accounts = 1..=10 groups of `[coin (mut), pool, observations (mut)]`.
//!
//! * Graduated coin: pool = `coin.damm_pool`, price from DAMM v2 `sqrt_price` (offset 456), pushed into the ring
//!   (`["observations", mint]`). v0.6 rules: keeper samples, or anyone once the coin had no keeper sample for
//!   `keeper_stale_secs` (flagged fallback, never counted for medians); keeper spacing vs the previous keeper sample.
//! * Curve coin: pool = `coin.dbc_pool`, DBC `sqrt_price` (offset 280); keeper only; stored in the Coin
//!   (`pregrad_sample_*` = the latest, and pushed into the 5-sample `pregrad_ring`, L5) for the pre-graduation
//!   buyback guard only (never for claims, D1). The observations account of the group is ignored.
//! * Complete coin (curve done, not graduated): skipped (no sample, no event, no error).
//! * The transaction must contain nothing but compute-budget instructions besides this one (no "move the pool and
//!   sample it" in one atomic transaction).

use anchor_lang::prelude::*;
use anchor_lang::{
    compat::solana_instructions_sysvar as ix_sysvar,
    solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT},
    Discriminator,
};

use crate::{
    constants::*,
    error::FumpadError,
    events::SampleRecorded,
    external::meteora,
    instructions::rewards::util::write_account,
    math::price_q64_from_sqrt,
    state::*,
};

pub const SAMPLE_GROUP_LEN: usize = 3;
pub const MAX_SAMPLE_COINS: usize = 10;

#[event_cpi]
#[derive(Accounts)]
pub struct RecordSamples<'info> {
    pub sampler: Signer<'info>,
    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    /// CHECK: address-checked instructions sysvar.
    #[account(address = ix_sysvar::ID @ FumpadError::InvalidAccount)]
    pub instructions: UncheckedAccount<'info>,
}

/// The current instruction must be top-level, ours, and the only non-compute-budget instruction in the transaction.
pub fn require_isolated(ixs: &AccountInfo) -> Result<()> {
    require!(get_stack_height() == TRANSACTION_LEVEL_STACK_HEIGHT, FumpadError::SampleTxNotIsolated);
    let current = ix_sysvar::load_current_index_checked(ixs)? as usize;
    let count = {
        let d = ixs.try_borrow_data()?;
        require!(d.len() >= 2, FumpadError::InvalidAccount);
        u16::from_le_bytes([d[0], d[1]]) as usize
    };
    for i in 0..count {
        let ix = ix_sysvar::load_instruction_at_checked(i, ixs)?;
        if i == current {
            require_keys_eq!(ix.program_id, crate::ID, FumpadError::SampleTxNotIsolated);
        } else {
            require_keys_eq!(ix.program_id, COMPUTE_BUDGET_PROGRAM_ID, FumpadError::SampleTxNotIsolated);
        }
    }
    Ok(())
}

pub fn handle_record_samples<'info>(ctx: Context<'info, RecordSamples<'info>>) -> Result<()> {
    require_isolated(&ctx.accounts.instructions.to_account_info())?;
    let now = Clock::get()?.unix_timestamp;
    let p = ctx.accounts.global.params;
    let is_keeper = ctx.accounts.global.is_keeper(&ctx.accounts.sampler.key());
    let rem = ctx.remaining_accounts;
    require!(
        !rem.is_empty() && rem.len() % SAMPLE_GROUP_LEN == 0 && rem.len() / SAMPLE_GROUP_LEN <= MAX_SAMPLE_COINS,
        FumpadError::InvalidAccount
    );

    let mut events: Vec<SampleRecorded> = Vec::with_capacity(rem.len() / SAMPLE_GROUP_LEN);
    for g in rem.chunks_exact(SAMPLE_GROUP_LEN) {
        let (coin_info, pool_info, obs_info) = (&g[0], &g[1], &g[2]);
        require_keys_eq!(*coin_info.owner, crate::ID, FumpadError::InvalidAccount);
        require!(coin_info.is_writable, FumpadError::InvalidAccount);
        let mut coin = Coin::try_deserialize(&mut &coin_info.try_borrow_data()?[..])?;
        let coin_pda = Pubkey::create_program_address(&[COIN_SEED, coin.mint.as_ref(), &[coin.bump]], &crate::ID)
            .map_err(|_| error!(FumpadError::InvalidAccount))?;
        require_keys_eq!(coin_info.key(), coin_pda, FumpadError::InvalidAccount);

        match coin.status {
            CoinStatus::Curve => {
                // Pre-graduation: keeper only, DBC spot, stored in the coin.
                require!(is_keeper, FumpadError::Unauthorized);
                require_keys_eq!(pool_info.key(), coin.dbc_pool, FumpadError::WrongVenue);
                let pool = meteora::read_dbc_pool(pool_info)?;
                if coin.pregrad_sample_ts != 0 {
                    let last = coin.pregrad_sample_ts;
                    require!(now >= last && now - last >= p.oracle_min_spacing_secs, FumpadError::SampleTooSoon);
                }
                let price = price_q64_from_sqrt(pool.sqrt_price).ok_or(FumpadError::MathOverflow)?;
                coin.pregrad_sample_price_q64 = price;
                coin.pregrad_sample_ts = now;
                coin.pregrad_ring.push(now, price);
                write_account(coin_info, &coin)?;
                events.push(SampleRecorded { mint: coin.mint, venue: meteora::VENUE_DBC, price_q64: price, fallback: false, ts: now });
            }
            CoinStatus::Graduated => {
                require_keys_eq!(pool_info.key(), coin.damm_pool, FumpadError::WrongVenue);
                let pool = meteora::read_damm_pool(pool_info)?;
                require!(pool.token_a_mint == coin.mint && pool.token_b_mint == WSOL_MINT, FumpadError::WrongVenue);
                let price = price_q64_from_sqrt(pool.sqrt_price).ok_or(FumpadError::MathOverflow)?;

                require_keys_eq!(*obs_info.owner, crate::ID, FumpadError::InvalidAccount);
                require!(obs_info.is_writable, FumpadError::InvalidAccount);
                let mut data = obs_info.try_borrow_mut_data()?;
                let size = core::mem::size_of::<Observations>();
                require!(data.len() >= 8 + size, FumpadError::InvalidAccount);
                require!(data[..8] == *Observations::DISCRIMINATOR, FumpadError::InvalidAccount);
                let obs: &mut Observations = bytemuck::try_from_bytes_mut(&mut data[8..8 + size])
                    .map_err(|_| error!(FumpadError::InvalidAccount))?;
                let obs_pda =
                    Pubkey::create_program_address(&[OBSERVATIONS_SEED, coin.mint.as_ref(), &[obs.bump]], &crate::ID)
                        .map_err(|_| error!(FumpadError::InvalidAccount))?;
                require_keys_eq!(obs_info.key(), obs_pda, FumpadError::InvalidAccount);
                require_keys_eq!(obs.mint, coin.mint, FumpadError::InvalidAccount);
                require_keys_eq!(obs.pool, coin.damm_pool, FumpadError::InvalidAccount);

                let fallback = !is_keeper;
                if fallback {
                    let since_keeper = now.saturating_sub(obs.last_keeper_sample_ts);
                    require!(since_keeper > p.keeper_stale_secs, FumpadError::Unauthorized);
                    if let Some(last) = obs.last_ts() {
                        require!(now >= last && now - last >= p.oracle_min_spacing_secs, FumpadError::SampleTooSoon);
                    }
                } else if obs.keeper_sampled != 0 {
                    let last = obs.last_keeper_sample_ts;
                    require!(now >= last && now - last >= p.oracle_min_spacing_secs, FumpadError::SampleTooSoon);
                }
                obs.push(now, price, fallback);
                if !fallback {
                    obs.last_keeper_sample_ts = now;
                    obs.keeper_sampled = 1;
                }
                events.push(SampleRecorded { mint: coin.mint, venue: meteora::VENUE_DAMM, price_q64: price, fallback, ts: now });
            }
            // Any router buy can complete a curve between building and landing a batch: skip it, don't fail the
            // other coins (REVIEW-v0.7 note). No event for a skipped coin.
            CoinStatus::Complete => continue,
        }
    }

    for ev in events {
        emit_event!(ctx, ev);
    }
    Ok(())
}
