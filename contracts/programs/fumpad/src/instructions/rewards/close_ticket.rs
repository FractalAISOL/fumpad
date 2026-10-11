use anchor_lang::prelude::*;

use crate::error::FumpadError;

// STUB — OWNER: rewards module. Replace the Accounts struct and handler.
#[derive(Accounts)]
pub struct CloseTicket<'info> {
    pub user: Signer<'info>,
}

pub fn handle_close_ticket(ctx: Context<CloseTicket>) -> Result<()> {
    let _ = &ctx;
    err!(FumpadError::NotImplemented)
}
