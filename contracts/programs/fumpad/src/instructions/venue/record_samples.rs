//! Record PumpSwap spot-price samples for the 10x claim check. OWNER: venue/oracle module.
//!
//! remaining_accounts = N groups (1 ≤ N ≤ MAX_SAMPLE_COINS) of
//!   [coin (mut), observations (mut), pool, pool_base_vault, pool_quote_vault]
//!
//! Each sample is also a D10 touch point for the coin's reference price (ticket
//! sell-price floor, `math/reference.rs`), which is why the coin is writable: keeper
//! heartbeat samples close any interval an attacker opened with a staged spot.
//!
//! Rules (SPEC §5.4):
//! * Signer must be a registered keeper — or anyone, per coin, once that coin has had no
//!   keeper sample for more than `keeper_stale_secs` (flagged `fallback`).
//! * ≥ `oracle_min_spacing_secs` since the coin's previous sample (any kind).
//! * Transaction isolation: this must be a top-level instruction (not a CPI) and every
//!   other instruction in the transaction must be a compute-budget instruction. This stops
//!   "move the pool and sample it" inside one atomic transaction. It cannot stop a
//!   multi-transaction bundle — that is what keeper-only signing, the 30-min median and
//!   the coverage requirement are for (see docs in the module report).
//! * The whole batch fails on any bad group: the keeper builds batches from fresh state,
//!   and silently skipping would hide misconfiguration.

use anchor_lang::prelude::*;
use anchor_lang::{
    compat::solana_instructions_sysvar as ix_sysvar,
    solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT},
    Discriminator,
};

use crate::{constants::*, error::FumpadError, events::SampleRecorded, external::pumpswap, state::*};

pub const SAMPLE_GROUP_LEN: usize = 5;
pub const MAX_SAMPLE_COINS: usize = 10;
pub const COMPUTE_BUDGET_PROGRAM_ID: Pubkey = pubkey!("ComputeBudget111111111111111111111111111111");

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

/// The current instruction must be top-level, ours, and the only non-compute-budget
/// instruction in the transaction.
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
        let (coin_info, obs_info, pool_info, base_vault, quote_vault) = (&g[0], &g[1], &g[2], &g[3], &g[4]);

        // Coin: ours, canonical PDA, graduated, writable (reference update).
        require_keys_eq!(*coin_info.owner, crate::ID, FumpadError::InvalidAccount);
        require!(coin_info.is_writable, FumpadError::InvalidAccount);
        let mut coin = Coin::try_deserialize(&mut &coin_info.try_borrow_data()?[..])?;
        let coin_pda = Pubkey::create_program_address(&[COIN_SEED, coin.mint.as_ref(), &[coin.bump]], &crate::ID)
            .map_err(|_| error!(FumpadError::InvalidAccount))?;
        require_keys_eq!(coin_info.key(), coin_pda, FumpadError::InvalidAccount);
        require!(coin.status == CoinStatus::Graduated, FumpadError::WrongCoinStatus);

        // Pool + reserves (pool must be the coin's; vaults must be the pool's).
        require_keys_eq!(pool_info.key(), coin.amm_pool, FumpadError::WrongVenue);
        let pool = pumpswap::read_pool(pool_info)?;
        require_keys_eq!(pool.base_mint, coin.mint, FumpadError::WrongVenue);
        require_keys_eq!(pool.quote_mint, pumpswap::WSOL_MINT, FumpadError::WrongVenue);
        let price = pumpswap::read_reserves(&pool, base_vault, quote_vault)?.spot_price_q64()?;

        // Observations: ours, canonical PDA for this coin, writable.
        require_keys_eq!(*obs_info.owner, crate::ID, FumpadError::InvalidAccount);
        require!(obs_info.is_writable, FumpadError::InvalidAccount);
        let mut data = obs_info.try_borrow_mut_data()?;
        let size = std::mem::size_of::<Observations>();
        require!(data.len() >= 8 + size, FumpadError::InvalidAccount);
        require!(data[..8] == *Observations::DISCRIMINATOR, FumpadError::InvalidAccount);
        let obs: &mut Observations = bytemuck::try_from_bytes_mut(&mut data[8..8 + size])
            .map_err(|_| error!(FumpadError::InvalidAccount))?;
        let obs_pda =
            Pubkey::create_program_address(&[OBSERVATIONS_SEED, coin.mint.as_ref(), &[obs.bump]], &crate::ID)
                .map_err(|_| error!(FumpadError::InvalidAccount))?;
        require_keys_eq!(obs_info.key(), obs_pda, FumpadError::InvalidAccount);
        require_keys_eq!(obs.mint, coin.mint, FumpadError::InvalidAccount);
        require_keys_eq!(obs.pool, coin.amm_pool, FumpadError::InvalidAccount);

        // Who may sample.
        let fallback = !is_keeper;
        if fallback {
            let since_keeper = now.saturating_sub(obs.last_keeper_sample_ts);
            require!(since_keeper > p.keeper_stale_secs, FumpadError::Unauthorized);
        }
        // Spacing (also rejects the same coin twice in one batch).
        if let Some(last) = obs.last_ts() {
            require!(now >= last && now - last >= p.oracle_min_spacing_secs, FumpadError::SampleTooSoon);
        }

        obs.push(now, price, fallback);
        if !fallback {
            obs.last_keeper_sample_ts = now;
        }
        drop(data);

        // D10 touch point (a sample observes spot without moving it: pre = post).
        coin.touch_reference(now, price, price, false);
        coin.try_serialize(&mut &mut coin_info.try_borrow_mut_data()?[..])?;
        events.push(SampleRecorded { mint: coin.mint, price_q64: price, fallback, ts: now });
    }

    for ev in events {
        emit_cpi!(ev);
    }
    Ok(())
}
