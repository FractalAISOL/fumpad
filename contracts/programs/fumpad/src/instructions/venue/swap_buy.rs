use anchor_lang::prelude::*;

use crate::error::FumpadError;

// STUB — OWNER: venue/oracle module. Replace the Accounts struct and handler.
#[derive(Accounts)]
pub struct SwapBuy<'info> {
    pub user: Signer<'info>,
}

pub fn handle_swap_buy(ctx: Context<SwapBuy>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
    let _ = &ctx; let _ = (sol_in, min_tokens_out);
    err!(FumpadError::NotImplemented)
}
