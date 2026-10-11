//! Admin instructions. OWNER: foundation (lead).

use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::FumpadError,
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
    Ok(())
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [GLOBAL_SEED], bump = global.bump, has_one = admin @ FumpadError::Unauthorized)]
    pub global: Account<'info, Global>,
}

// TODO(phase 4): 48h timelock on param changes (queue + execute).
pub fn handle_update_params(ctx: Context<AdminOnly>, params: Params) -> Result<()> {
    require!(params.is_valid(), FumpadError::InvalidParams);
    ctx.accounts.global.params = params;
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
