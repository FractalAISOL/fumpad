use anchor_lang::prelude::*;

use crate::error::FumpadError;

// STUB — OWNER: rewards module. Replace the Accounts struct and handler.
#[derive(Accounts)]
pub struct InitClaimQueue<'info> {
    pub user: Signer<'info>,
}

pub fn handle_init_claim_queue(ctx: Context<InitClaimQueue>) -> Result<()> {
    let _ = &ctx;
    err!(FumpadError::NotImplemented)
}
