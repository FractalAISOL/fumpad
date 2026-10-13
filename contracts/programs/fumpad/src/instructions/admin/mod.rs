//! Admin / governance. Roles (M-2): `admin` queues params/configs (48h), proposes authority changes (48h), sets
//! keepers, pauses, migrates the layout; `guardian` can only stop things (pause, cancel_*, void_ticket); anyone
//! executes a queued change after its timelock. Every instruction emits an event (L-3).

use anchor_lang::prelude::*;

pub mod config;
pub mod migrate_global;
pub use config::*;
pub use migrate_global::*;

use crate::{
    constants::*,
    error::FumpadError,
    events::{
        AdminAccepted, AdminProposalCancelled, AdminProposed, GlobalInitialized, KeepersSet, ParamsCancelled,
        ParamsQueued, ParamsUpdated, PauseSet,
    },
    state::{Global, Params, PAUSE_ALL},
};

#[derive(Accounts)]
pub struct InitializeGlobal<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + Global::INIT_SPACE, seeds = [GLOBAL_SEED], bump)]
    pub global: Box<Account<'info, Global>>,
    /// Only the program's upgrade authority may initialize (prevents front-running init).
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ FumpadError::Unauthorized)]
    pub program: Program<'info, crate::program::Fumpad>,
    #[account(constraint = program_data.upgrade_authority_address == Some(payer.key()) @ FumpadError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
    /// CHECK: Anchor's event authority PDA (`#[event_cpi]` can't be used: this struct already has `program`).
    #[account(seeds = [b"__event_authority"], bump)]
    pub event_authority: UncheckedAccount<'info>,
}

pub fn handle_initialize_global(
    ctx: Context<InitializeGlobal>,
    admin: Pubkey,
    platform_treasury: Pubkey,
    cluster_tag: u8,
    params: Params,
) -> Result<()> {
    require!(params.is_valid(), FumpadError::InvalidParams);
    require_keys_neq!(admin, Pubkey::default(), FumpadError::InvalidParams);
    require_keys_neq!(platform_treasury, Pubkey::default(), FumpadError::InvalidParams);
    let g = &mut ctx.accounts.global;
    g.bump = ctx.bumps.global;
    g.admin = admin;
    g.platform_treasury = platform_treasury;
    g.guardian = admin;
    g.keepers = [Pubkey::default(); MAX_KEEPERS];
    g.keeper_added_at = [0; MAX_KEEPERS];
    g.cluster_tag = cluster_tag;
    g.paused = 0;
    g.pause_expires_at = 0;
    g.params = params;
    g.pending_params = Params::default();
    g.pending_eta = 0;
    g.pending_admin = Pubkey::default();
    g.pending_treasury = Pubkey::default();
    g.pending_guardian = Pubkey::default();
    g.pending_admin_eta = 0;
    g.configs = [Pubkey::default(); MAX_CONFIGS];
    g.pending_config = Pubkey::default();
    g.pending_config_add = 0;
    g.pending_config_eta = 0;
    g.reserved = [0; 128];
    let ts = Clock::get()?.unix_timestamp;
    emit_event!(ctx, GlobalInitialized { admin, platform_treasury, guardian: admin, cluster_tag, params, ts });
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [GLOBAL_SEED], bump = global.bump, has_one = admin @ FumpadError::Unauthorized)]
    pub global: Box<Account<'info, Global>>,
}

/// M-2: the admin or the guardian (stop-only actions).
#[event_cpi]
#[derive(Accounts)]
pub struct GuardianOrAdmin<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [GLOBAL_SEED],
        bump = global.bump,
        constraint = global.is_admin_or_guardian(authority.key) @ FumpadError::Unauthorized,
    )]
    pub global: Box<Account<'info, Global>>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct PermissionlessGlobal<'info> {
    /// Anyone (the change was approved when it was queued).
    pub caller: Signer<'info>,
    #[account(mut, seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
}

pub fn handle_queue_params(ctx: Context<AdminOnly>, params: Params) -> Result<()> {
    require!(params.is_valid(), FumpadError::InvalidParams);
    let now = Clock::get()?.unix_timestamp;
    let eta = now.checked_add(PARAMS_TIMELOCK_SECS).ok_or(FumpadError::MathOverflow)?;
    let g = &mut ctx.accounts.global;
    g.pending_params = params;
    g.pending_eta = eta;
    emit_event!(ctx, ParamsQueued { params, eta, ts: now });
    Ok(())
}

pub fn handle_execute_params(ctx: Context<PermissionlessGlobal>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let g = &mut ctx.accounts.global;
    require!(g.pending_eta != 0, FumpadError::NoPendingParams);
    require!(now >= g.pending_eta, FumpadError::TimelockNotElapsed);
    let params = g.pending_params;
    require!(params.is_valid(), FumpadError::InvalidParams);
    g.params = params;
    g.pending_params = Params::default();
    g.pending_eta = 0;
    emit_event!(ctx, ParamsUpdated { params, ts: now });
    Ok(())
}

pub fn handle_cancel_params(ctx: Context<GuardianOrAdmin>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let g = &mut ctx.accounts.global;
    require!(g.pending_eta != 0, FumpadError::NoPendingParams);
    g.pending_params = Params::default();
    g.pending_eta = 0;
    emit_event!(ctx, ParamsCancelled { authority: ctx.accounts.authority.key(), ts: now });
    Ok(())
}

/// M-2 / M-3: admin or guardian, immediate; non-zero flags lapse after 7 days unless renewed; 0 unpauses.
pub fn handle_set_pause(ctx: Context<GuardianOrAdmin>, paused: u8) -> Result<()> {
    require!(paused & !PAUSE_ALL == 0, FumpadError::InvalidParams);
    let now = Clock::get()?.unix_timestamp;
    let expires_at = if paused == 0 { 0 } else { now.checked_add(MAX_PAUSE_SECS).ok_or(FumpadError::MathOverflow)? };
    let g = &mut ctx.accounts.global;
    g.paused = paused;
    g.pause_expires_at = expires_at;
    emit_event!(ctx, PauseSet { paused, expires_at, authority: ctx.accounts.authority.key(), ts: now });
    Ok(())
}

/// Immediate (incident response). A key not in the previous set starts a 6h attestation freeze (SPEC v0.7 §7);
/// keys that stay keep their timestamp. Duplicates are rejected.
pub fn handle_set_keepers(ctx: Context<AdminOnly>, keepers: [Pubkey; MAX_KEEPERS]) -> Result<()> {
    for (i, k) in keepers.iter().enumerate() {
        require!(*k == Pubkey::default() || !keepers[..i].contains(k), FumpadError::InvalidParams);
    }
    let now = Clock::get()?.unix_timestamp;
    let g = &mut ctx.accounts.global;
    let mut added_at = [0i64; MAX_KEEPERS];
    for (i, k) in keepers.iter().enumerate() {
        if *k == Pubkey::default() {
            continue;
        }
        added_at[i] = match g.keepers.iter().position(|old| old == k) {
            Some(j) => g.keeper_added_at[j],
            None => now,
        };
    }
    g.keepers = keepers;
    g.keeper_added_at = added_at;
    emit_event!(ctx, KeepersSet { keepers, added_at, ts: now });
    Ok(())
}

pub fn handle_propose_admin(
    ctx: Context<AdminOnly>,
    new_admin: Pubkey,
    platform_treasury: Pubkey,
    guardian: Pubkey,
) -> Result<()> {
    for k in [new_admin, platform_treasury, guardian] {
        require_keys_neq!(k, Pubkey::default(), FumpadError::InvalidParams);
    }
    let now = Clock::get()?.unix_timestamp;
    let eta = now.checked_add(ADMIN_TIMELOCK_SECS).ok_or(FumpadError::MathOverflow)?;
    let g = &mut ctx.accounts.global;
    g.pending_admin = new_admin;
    g.pending_treasury = platform_treasury;
    g.pending_guardian = guardian;
    g.pending_admin_eta = eta;
    emit_event!(ctx, AdminProposed { admin: new_admin, platform_treasury, guardian, eta, ts: now });
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    /// Must be `Global.pending_admin`.
    pub new_admin: Signer<'info>,
    #[account(mut, seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
}

pub fn handle_accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let g = &mut ctx.accounts.global;
    require!(g.pending_admin_eta != 0, FumpadError::NoPendingAdmin);
    require_keys_eq!(ctx.accounts.new_admin.key(), g.pending_admin, FumpadError::Unauthorized);
    require!(now >= g.pending_admin_eta, FumpadError::TimelockNotElapsed);
    let previous_admin = g.admin;
    g.admin = g.pending_admin;
    g.platform_treasury = g.pending_treasury;
    g.guardian = g.pending_guardian;
    g.pending_admin = Pubkey::default();
    g.pending_treasury = Pubkey::default();
    g.pending_guardian = Pubkey::default();
    g.pending_admin_eta = 0;
    let (admin, platform_treasury, guardian) = (g.admin, g.platform_treasury, g.guardian);
    emit_event!(ctx, AdminAccepted { previous_admin, admin, platform_treasury, guardian, ts: now });
    Ok(())
}

pub fn handle_cancel_admin(ctx: Context<GuardianOrAdmin>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let g = &mut ctx.accounts.global;
    require!(g.pending_admin_eta != 0, FumpadError::NoPendingAdmin);
    g.pending_admin = Pubkey::default();
    g.pending_treasury = Pubkey::default();
    g.pending_guardian = Pubkey::default();
    g.pending_admin_eta = 0;
    emit_event!(ctx, AdminProposalCancelled { authority: ctx.accounts.authority.key(), ts: now });
    Ok(())
}
