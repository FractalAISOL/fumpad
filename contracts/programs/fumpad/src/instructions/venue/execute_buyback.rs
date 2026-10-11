use anchor_lang::prelude::*;

use crate::error::FumpadError;

// STUB — OWNER: venue/oracle module. Replace the Accounts struct and handler.
#[derive(Accounts)]
pub struct ExecuteBuyback<'info> {
    pub user: Signer<'info>,
}

pub fn handle_execute_buyback(ctx: Context<ExecuteBuyback>, max_lamports: u64) -> Result<()> {
    let _ = &ctx; let _ = (max_lamports);
    err!(FumpadError::NotImplemented)
}
