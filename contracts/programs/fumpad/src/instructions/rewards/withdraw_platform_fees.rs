use anchor_lang::prelude::*;

use crate::error::FumpadError;

// STUB — OWNER: rewards module. Replace the Accounts struct and handler.
#[derive(Accounts)]
pub struct WithdrawPlatformFees<'info> {
    pub user: Signer<'info>,
}

pub fn handle_withdraw_platform_fees(ctx: Context<WithdrawPlatformFees>) -> Result<()> {
    let _ = &ctx;
    err!(FumpadError::NotImplemented)
}
