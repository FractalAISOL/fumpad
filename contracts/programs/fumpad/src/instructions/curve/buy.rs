use anchor_lang::prelude::*;

use crate::error::FumpadError;

// STUB — OWNER: curve module. Replace the Accounts struct and handler.
#[derive(Accounts)]
pub struct Buy<'info> {
    pub user: Signer<'info>,
}

pub fn handle_buy(ctx: Context<Buy>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
    let _ = &ctx; let _ = (sol_in, min_tokens_out);
    err!(FumpadError::NotImplemented)
}
