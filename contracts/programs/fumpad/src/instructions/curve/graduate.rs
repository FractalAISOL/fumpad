use anchor_lang::prelude::*;

use crate::error::FumpadError;

// STUB — OWNER: curve module. Replace the Accounts struct and handler.
#[derive(Accounts)]
pub struct Graduate<'info> {
    pub user: Signer<'info>,
}

pub fn handle_graduate(ctx: Context<Graduate>) -> Result<()> {
    let _ = &ctx;
    err!(FumpadError::NotImplemented)
}
