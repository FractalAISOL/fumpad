//! Admin instructions. OWNER: foundation (lead).
//!
//! Roles (v0.6, M-2):
//! * `admin` (Squads multisig) — queues params (48h, D15), proposes authority changes (48h),
//!   sets keepers, pauses, migrates the Global layout.
//! * `guardian` (separate multisig) — can only *stop* things: `set_pause`, `cancel_params`,
//!   `cancel_admin`. It can't queue, propose or execute. So a stolen admin key can't change
//!   params or rotate itself / the treasury / the guardian before the guardian cancels.
//! * anyone — `execute_params` after the 48h.
//! Every instruction here emits an event (L-3).

use anchor_lang::prelude::*;

pub mod migrate_global;
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
    /// Also the program account the L-3 event self-CPI needs.
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ FumpadError::Unauthorized)]
    pub program: Program<'info, crate::program::Fumpad>,
    #[account(constraint = program_data.upgrade_authority_address == Some(payer.key()) @ FumpadError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
    /// CHECK: L-3 (v0.6) — Anchor's event authority PDA (`#[event_cpi]` can't be used: this
    /// struct already has a `program` account).
    #[account(seeds = [b"__event_authority"], bump)]
    pub event_authority: UncheckedAccount<'info>,
}

/// The guardian starts as the admin (M-2); hand it to its own multisig with `propose_admin`.
pub fn handle_initialize_global(
    ctx: Context<InitializeGlobal>,
    admin: Pubkey,
    platform_treasury: Pubkey,
    params: Params,
) -> Result<()> {
    require!(params.is_valid(), FumpadError::InvalidParams);
    require_keys_neq!(admin, Pubkey::default(), FumpadError::InvalidParams);
    let g = &mut ctx.accounts.global;
    g.bump = ctx.bumps.global;
    g.admin = admin;
    g.platform_treasury = platform_treasury;
    g.keepers = [Pubkey::default(); MAX_KEEPERS];
    g.paused = 0;
    g.params = params;
    g.guardian = admin;
    g.pause_expires_at = 0;
    g.pending_admin_eta = 0;
    g.reserved = [0; 80];
    g.pending_params = Params::default();
    g.pending_eta = 0;
    g.pending_admin = Pubkey::default();
    g.pending_treasury = Pubkey::default();
    g.pending_guardian = Pubkey::default();
    let ts = Clock::get()?.unix_timestamp;
    emit_event!(ctx, GlobalInitialized { admin, platform_treasury, guardian: admin, params, ts });
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

// ── D15: 48h timelock on parameter changes (queue → execute; cancel any time) ──
// There is no direct `update_params`. Pauses are immediate (and lapse after 7 days, M-3).
// Keepers (`set_keepers`) are immediate (key rotation is incident response; keepers can't
// move funds). Admin / treasury / guardian changes are timelocked two-step (M-2).

#[event_cpi]
#[derive(Accounts)]
pub struct QueueParams<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [GLOBAL_SEED], bump = global.bump, has_one = admin @ FumpadError::Unauthorized)]
    pub global: Box<Account<'info, Global>>,
}

/// Queue `params` (replaces anything already queued and restarts the 48h clock).
pub fn handle_queue_params(ctx: Context<QueueParams>, params: Params) -> Result<()> {
    require!(params.is_valid(), FumpadError::InvalidParams);
    let now = Clock::get()?.unix_timestamp;
    let eta = now.checked_add(PARAMS_TIMELOCK_SECS).ok_or(FumpadError::MathOverflow)?;
    let g = &mut ctx.accounts.global;
    g.pending_params = params;
    g.pending_eta = eta;
    emit_event!(ctx, ParamsQueued { params, eta, ts: now });
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct ExecuteParams<'info> {
    /// Anyone (the change was approved when it was queued).
    pub caller: Signer<'info>,
    #[account(mut, seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
}

/// Apply the queued params once `pending_eta` has passed. Permissionless.
pub fn handle_execute_params(ctx: Context<ExecuteParams>) -> Result<()> {
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

/// M-2: the admin or the guardian drops the queued params change.
pub fn handle_cancel_params(ctx: Context<GuardianOrAdmin>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let g = &mut ctx.accounts.global;
    require!(g.pending_eta != 0, FumpadError::NoPendingParams);
    g.pending_params = Params::default();
    g.pending_eta = 0;
    emit_event!(ctx, ParamsCancelled { ts: now, authority: ctx.accounts.authority.key() });
    Ok(())
}

/// M-2 / M-3: admin or guardian, immediate. Non-zero flags are in force for
/// `MAX_PAUSE_SECS` (7 days) and then lapse unless renewed by another `set_pause`; 0 unpauses.
/// Curve sells are never paused (M-3).
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

pub fn handle_set_keepers(ctx: Context<AdminOnly>, keepers: [Pubkey; MAX_KEEPERS]) -> Result<()> {
    ctx.accounts.global.keepers = keepers;
    let ts = Clock::get()?.unix_timestamp;
    emit_event!(ctx, KeepersSet { keepers, ts });
    Ok(())
}

/// M-2: propose a new authority set (replaces any open proposal, restarts the 48h). To change
/// only the treasury or the guardian, propose the current admin and accept with it.
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
    /// Must be `Global.pending_admin` (proves the new key works before it takes over).
    pub new_admin: Signer<'info>,
    #[account(mut, seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
}

/// M-2: the proposed admin applies the proposal once its 48h have passed.
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

/// M-2: the admin or the guardian drops the open authority proposal.
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
