//! Admin instructions. OWNER: foundation (lead).

use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::FumpadError,
    events::{ParamsCancelled, ParamsQueued, ParamsUpdated},
    state::{Global, Params},
};

#[derive(Accounts)]
pub struct InitializeGlobal<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + Global::INIT_SPACE, seeds = [GLOBAL_SEED], bump)]
    pub global: Account<'info, Global>,
    /// Only the program's upgrade authority may initialize (prevents front-running init).
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ FumpadError::Unauthorized)]
    pub program: Program<'info, crate::program::Fumpad>,
    #[account(constraint = program_data.upgrade_authority_address == Some(payer.key()) @ FumpadError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_global(
    ctx: Context<InitializeGlobal>,
    admin: Pubkey,
    platform_treasury: Pubkey,
    params: Params,
) -> Result<()> {
    require!(params.is_valid(), FumpadError::InvalidParams);
    let g = &mut ctx.accounts.global;
    g.bump = ctx.bumps.global;
    g.admin = admin;
    g.platform_treasury = platform_treasury;
    g.keepers = [Pubkey::default(); MAX_KEEPERS];
    g.paused = 0;
    g.params = params;
    g.pending_params = Params::default();
    g.pending_eta = 0;
    Ok(())
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [GLOBAL_SEED], bump = global.bump, has_one = admin @ FumpadError::Unauthorized)]
    pub global: Account<'info, Global>,
}

// ── D15: 48h timelock on parameter changes (queue → execute; cancel any time) ──
// There is no direct `update_params`. Pause flags (`set_pause`) stay immediate. Keepers
// (`set_keepers`) and the admin/treasury (`set_admin`) are not `Params` and stay immediate
// too (keeper-key rotation is incident response; neither can move user funds).

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
    emit_cpi!(ParamsQueued { params, eta, ts: now });
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
    emit_cpi!(ParamsUpdated { params, ts: now });
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct CancelParams<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [GLOBAL_SEED], bump = global.bump, has_one = admin @ FumpadError::Unauthorized)]
    pub global: Box<Account<'info, Global>>,
}

pub fn handle_cancel_params(ctx: Context<CancelParams>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let g = &mut ctx.accounts.global;
    require!(g.pending_eta != 0, FumpadError::NoPendingParams);
    g.pending_params = Params::default();
    g.pending_eta = 0;
    emit_cpi!(ParamsCancelled { ts: now });
    Ok(())
}

pub fn handle_set_pause(ctx: Context<AdminOnly>, paused: u8) -> Result<()> {
    ctx.accounts.global.paused = paused;
    Ok(())
}

pub fn handle_set_keepers(ctx: Context<AdminOnly>, keepers: [Pubkey; MAX_KEEPERS]) -> Result<()> {
    ctx.accounts.global.keepers = keepers;
    Ok(())
}

pub fn handle_set_admin(
    ctx: Context<AdminOnly>,
    new_admin: Pubkey,
    platform_treasury: Pubkey,
) -> Result<()> {
    require_keys_neq!(new_admin, Pubkey::default(), FumpadError::InvalidParams);
    ctx.accounts.global.admin = new_admin;
    ctx.accounts.global.platform_treasury = platform_treasury;
    Ok(())
}
