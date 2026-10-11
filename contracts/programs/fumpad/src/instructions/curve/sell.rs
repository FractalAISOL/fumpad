use anchor_lang::prelude::*;

use crate::error::FumpadError;

// STUB — OWNER: curve module. Replace the Accounts struct and handler.
#[derive(Accounts)]
pub struct Sell<'info> {
    pub user: Signer<'info>,
}

pub fn handle_sell(ctx: Context<Sell>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
    let _ = &ctx; let _ = (tokens_in, min_sol_out);
    err!(FumpadError::NotImplemented)
}
