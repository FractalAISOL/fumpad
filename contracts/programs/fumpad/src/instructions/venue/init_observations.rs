use anchor_lang::prelude::*;

use crate::error::FumpadError;

// STUB — OWNER: venue/oracle module. Replace the Accounts struct and handler.
#[derive(Accounts)]
pub struct InitObservations<'info> {
    pub user: Signer<'info>,
}

pub fn handle_init_observations(ctx: Context<InitObservations>) -> Result<()> {
    let _ = &ctx;
    err!(FumpadError::NotImplemented)
}
