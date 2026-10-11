use anchor_lang::prelude::*;

use crate::error::FumpadError;

// STUB — OWNER: rewards module. Replace the Accounts struct and handler.
#[derive(Accounts)]
pub struct WithdrawCreatorFees<'info> {
    pub user: Signer<'info>,
}

pub fn handle_withdraw_creator_fees(ctx: Context<WithdrawCreatorFees>) -> Result<()> {
    let _ = &ctx;
    err!(FumpadError::NotImplemented)
}
