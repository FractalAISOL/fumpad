use anchor_lang::prelude::*;

use crate::error::FumpadError;

// STUB — OWNER: venue/oracle module. Replace the Accounts struct and handler.
#[derive(Accounts)]
pub struct SwapSell<'info> {
    pub user: Signer<'info>,
}

pub fn handle_swap_sell(ctx: Context<SwapSell>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
    let _ = &ctx; let _ = (tokens_in, min_sol_out);
    err!(FumpadError::NotImplemented)
}
