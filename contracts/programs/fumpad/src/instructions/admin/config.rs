//! SPEC v0.7 §2/§7: the allow-list of FUMPAD DBC configs, changed only through a 48h timelock.

use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::FumpadError,
    events::{ConfigCancelled, ConfigQueued, ConfigUpdated},
    external::meteora,
    state::Global,
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

pub fn handle_queue_config(ctx: Context<QueueConfig>, config: Pubkey, add: bool) -> Result<()> {
    require_keys_neq!(config, Pubkey::default(), FumpadError::InvalidParams);
    let g = &ctx.accounts.global;
    if add {
        validate_config(&ctx.accounts.dbc_config)?;
        require!(!g.is_allowed_config(&config), FumpadError::InvalidParams);
    } else {
        require!(g.is_allowed_config(&config), FumpadError::ConfigNotAllowed);
    }
    let now = Clock::get()?.unix_timestamp;
    let eta = now.checked_add(CONFIG_TIMELOCK_SECS).ok_or(FumpadError::MathOverflow)?;
    let g = &mut ctx.accounts.global;
    g.pending_config = config;
    g.pending_config_add = add as u8;
    g.pending_config_eta = eta;
    emit_event!(ctx, ConfigQueued { config, add, eta, ts: now });
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
    let (config, add) = (g.pending_config, g.pending_config_add != 0);
    if add {
        validate_config(&ctx.accounts.dbc_config)?;
    }
    let g = &mut ctx.accounts.global;
    if add {
        require!(!g.is_allowed_config(&config), FumpadError::InvalidParams);
        let slot = g.configs.iter_mut().find(|c| **c == Pubkey::default()).ok_or(FumpadError::ConfigListFull)?;
        *slot = config;
    } else {
        let slot = g.configs.iter_mut().find(|c| **c == config).ok_or(FumpadError::ConfigNotAllowed)?;
        *slot = Pubkey::default();
    }
    g.pending_config = Pubkey::default();
    g.pending_config_add = 0;
    g.pending_config_eta = 0;
    emit_event!(ctx, ConfigUpdated { config, add, ts: now });
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
    emit_event!(ctx, ConfigCancelled { config, authority: ctx.accounts.authority.key(), ts: now });
    Ok(())
}
