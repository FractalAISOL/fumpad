use anchor_lang::prelude::*;

use crate::error::FumpadError;

// STUB — OWNER: venue/oracle module. Replace the Accounts struct and handler.
#[derive(Accounts)]
pub struct RecordSamples<'info> {
    pub user: Signer<'info>,
}

pub fn handle_record_samples(ctx: Context<RecordSamples>) -> Result<()> {
    let _ = &ctx;
    err!(FumpadError::NotImplemented)
}
