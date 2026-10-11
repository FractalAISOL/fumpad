use anchor_lang::prelude::*;

use crate::error::FumpadError;

// STUB — OWNER: rewards module. Replace the Accounts struct and handler.
#[derive(Accounts)]
pub struct RegisterHoldings<'info> {
    pub user: Signer<'info>,
}

pub fn handle_register_holdings(ctx: Context<RegisterHoldings>) -> Result<()> {
    let _ = &ctx;
    err!(FumpadError::NotImplemented)
}
