use anchor_lang::prelude::*;

use crate::error::FumpadError;

// STUB — OWNER: curve module. Replace the Accounts struct and handler.
#[derive(Accounts)]
pub struct CreateCoin<'info> {
    pub user: Signer<'info>,
}

pub fn handle_create_coin(ctx: Context<CreateCoin>, name: String, symbol: String, uri: String) -> Result<()> {
    let _ = &ctx; let _ = (name, symbol, uri);
    err!(FumpadError::NotImplemented)
}
