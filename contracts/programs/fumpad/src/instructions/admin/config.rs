//! SPEC v0.7 §2/§7: the allow-list of FUMPAD DBC configs, changed only through the 1 h config timelock (`CONFIG_TIMELOCK_SECS`). Each slot
//! carries a fee policy (INTERFACE §5.9) that `register_coin` snapshots into the coin.

use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::FumpadError,
    events::{ConfigCancelled, ConfigQueued, ConfigUpdated},
    external::meteora,
    state::{FeePolicy, Global},
};

/// fumpad's `fee_claimer` and `reward_pool` PDAs (the DBC config's fee claimer and leftover receiver).
pub fn fee_claimer_and_reward_pool() -> (Pubkey, Pubkey) {
    (
        Pubkey::find_program_address(&[FEE_CLAIMER_SEED], &crate::ID).0,
        Pubkey::find_program_address(&[REWARD_POOL_SEED], &crate::ID).0,
    )
}

/// Check a DBC config's FUMPAD shape (INTERFACE §5.4).
pub fn validate_config(info: &AccountInfo) -> Result<meteora::DbcConfig> {
    let (fee_claimer, reward_pool) = fee_claimer_and_reward_pool();
    meteora::read_fumpad_config(info, &fee_claimer, &reward_pool)
}

/// A config's fee policy (INTERFACE §5.9): `FeePolicy::is_valid`, and a wallet-split wallet is none of fumpad's
/// own PDAs (lamports sent there would be stranded or corrupt our accounting) → `InvalidParams`.
pub fn validate_fee_policy(p: &FeePolicy) -> Result<()> {
    require!(p.is_valid(), FumpadError::InvalidParams);
    if p.wallet != Pubkey::default() {
        let (fee_claimer, reward_pool) = fee_claimer_and_reward_pool();
        for seed in [GLOBAL_SEED, BUYBACK_SEED, FEE_WSOL_SEED] {
            require_keys_neq!(p.wallet, Pubkey::find_program_address(&[seed], &crate::ID).0, FumpadError::InvalidParams);
        }
        for k in [fee_claimer, reward_pool, crate::ID, crate::EVENT_AUTHORITY_AND_BUMP.0] {
            require_keys_neq!(p.wallet, k, FumpadError::InvalidParams);
        }
    }
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(config: Pubkey)]
pub struct QueueConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [GLOBAL_SEED], bump = global.bump, has_one = admin @ FumpadError::Unauthorized)]
    pub global: Box<Account<'info, Global>>,
    /// CHECK: the DBC config (validated when adding).
    #[account(address = config @ FumpadError::InvalidAccount)]
    pub dbc_config: UncheckedAccount<'info>,
}

/// `policy`: the fee policy of the slot when adding (`FeePolicy::default()` = standard); must be default when
/// removing. To change a listed config's policy: remove, then add with the new policy (two timelocks; coins
/// already registered keep their snapshot either way).
pub fn handle_queue_config(ctx: Context<QueueConfig>, config: Pubkey, add: bool, policy: FeePolicy) -> Result<()> {
    require_keys_neq!(config, Pubkey::default(), FumpadError::InvalidParams);
    let g = &ctx.accounts.global;
    if add {
        validate_config(&ctx.accounts.dbc_config)?;
        validate_fee_policy(&policy)?;
        require!(!g.is_allowed_config(&config), FumpadError::InvalidParams);
    } else {
        require!(policy == FeePolicy::default(), FumpadError::InvalidParams);
        require!(g.is_allowed_config(&config), FumpadError::ConfigNotAllowed);
    }
    let now = Clock::get()?.unix_timestamp;
    let eta = now.checked_add(CONFIG_TIMELOCK_SECS).ok_or(FumpadError::MathOverflow)?;
    let g = &mut ctx.accounts.global;
    g.pending_config = config;
    g.pending_config_add = add as u8;
    g.pending_config_eta = eta;
    g.pending_config_policy = policy;
    emit_event!(ctx, ConfigQueued { config, add, eta, ts: now, policy });
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct ExecuteConfig<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    /// CHECK: must be the pending config (re-validated when adding).
    #[account(address = global.pending_config @ FumpadError::InvalidAccount)]
    pub dbc_config: UncheckedAccount<'info>,
}

pub fn handle_execute_config(ctx: Context<ExecuteConfig>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let g = &ctx.accounts.global;
    require!(g.pending_config_eta != 0, FumpadError::NoPendingConfig);
    require!(now >= g.pending_config_eta, FumpadError::TimelockNotElapsed);
    let (config, add, pending_policy) = (g.pending_config, g.pending_config_add != 0, g.pending_config_policy);
    if add {
        validate_config(&ctx.accounts.dbc_config)?;
        validate_fee_policy(&pending_policy)?;
    }
    let g = &mut ctx.accounts.global;
    let policy = if add {
        require!(!g.is_allowed_config(&config), FumpadError::InvalidParams);
        let i = g.configs.iter().position(|c| *c == Pubkey::default()).ok_or(FumpadError::ConfigListFull)?;
        g.configs[i] = config;
        g.config_policies[i] = pending_policy;
        g.config_coins[i] = 0;
        pending_policy
    } else {
        // Registered coins keep working and keep their own policy snapshot (Coin policy tail / `Coin.fee_split`).
        let i = g.config_slot(&config).ok_or(FumpadError::ConfigNotAllowed)?;
        let old = g.config_policies[i];
        g.configs[i] = Pubkey::default();
        g.config_policies[i] = FeePolicy::default();
        g.config_coins[i] = 0;
        old
    };
    g.pending_config = Pubkey::default();
    g.pending_config_add = 0;
    g.pending_config_eta = 0;
    g.pending_config_policy = FeePolicy::default();
    emit_event!(ctx, ConfigUpdated { config, add, ts: now, policy });
    Ok(())
}

pub fn handle_cancel_config(ctx: Context<super::GuardianOrAdmin>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let g = &mut ctx.accounts.global;
    require!(g.pending_config_eta != 0, FumpadError::NoPendingConfig);
    let config = g.pending_config;
    g.pending_config = Pubkey::default();
    g.pending_config_add = 0;
    g.pending_config_eta = 0;
    g.pending_config_policy = FeePolicy::default();
    emit_event!(ctx, ConfigCancelled { config, authority: ctx.accounts.authority.key(), ts: now });
    Ok(())
}
