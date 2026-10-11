use anchor_lang::prelude::*;

use crate::error::FumpadError;

// STUB — OWNER: rewards module. Replace the Accounts struct and handler.
#[derive(Accounts)]
pub struct ProcessQueue<'info> {
    pub user: Signer<'info>,
}

pub fn handle_process_queue(ctx: Context<ProcessQueue>, max_entries: u8) -> Result<()> {
    let _ = &ctx; let _ = (max_entries);
    err!(FumpadError::NotImplemented)
}
