use anchor_lang::prelude::*;

use crate::{constants::*, events::AutoClaimSet, state::Position};

/// D17: opt this wallet's position in one coin out of (`enabled = false`) or back into
/// (`true`) keeper auto-claim (`claim_for`). Covers every ticket of the position, current
/// and future. Owner-signed `claim` works either way. Default (new positions): enabled.
#[event_cpi]
#[derive(Accounts)]
pub struct SetAutoClaim<'info> {
    pub wallet: Signer<'info>,
    #[account(
        mut,
        seeds = [POSITION_SEED, position.mint.as_ref(), wallet.key().as_ref()],
        bump = position.bump,
    )]
    pub position: Box<Account<'info, Position>>,
}

pub fn handle_set_auto_claim(ctx: Context<SetAutoClaim>, enabled: bool) -> Result<()> {
    let pos = &mut ctx.accounts.position;
    pos.auto_claim_opt_out = u8::from(!enabled);
    let (mint, wallet) = (pos.mint, pos.wallet);
    emit_event!(ctx, AutoClaimSet { mint, wallet, enabled, ts: Clock::get()?.unix_timestamp });
    Ok(())
}
