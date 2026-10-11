use anchor_lang::prelude::*;

use crate::error::FumpadError;

// STUB — OWNER: rewards module. Replace the Accounts struct and handler.
#[derive(Accounts)]
pub struct Claim<'info> {
    pub user: Signer<'info>,
}

pub fn handle_claim(ctx: Context<Claim>) -> Result<()> {
    let _ = &ctx;
    err!(FumpadError::NotImplemented)
}
