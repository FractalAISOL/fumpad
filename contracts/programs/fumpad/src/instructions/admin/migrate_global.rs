//! `migrate_global`: the layout-upgrade hook (D39 keeps only the mechanism). v0.7 starts a fresh layout, so there
//! is no legacy layout to upgrade from: on a current-size Global this is a no-op, anything else is rejected
//! (`UnsupportedGlobalLayout`). A future layout change adds its old length here and grows the account in place
//! (copying every existing byte verbatim and filling only new fields — never a timelock bypass).

use anchor_lang::prelude::*;
use anchor_lang::Discriminator;

use crate::{constants::*, error::FumpadError, events::GlobalMigrated, state::Global};

/// Account length (with discriminator) of the current Global.
pub const GLOBAL_LEN: usize = 8 + Global::INIT_SPACE;
/// Offset of `Global.admin` (after the discriminator and `bump`).
pub const GLOBAL_ADMIN_OFFSET: usize = 8 + 1;

#[event_cpi]
#[derive(Accounts)]
pub struct MigrateGlobal<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: raw (may be an older layout); owner, PDA, discriminator and admin checked in the handler.
    #[account(mut, seeds = [GLOBAL_SEED], bump)]
    pub global: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_migrate_global(ctx: Context<MigrateGlobal>) -> Result<()> {
    let g = ctx.accounts.global.to_account_info();
    require_keys_eq!(*g.owner, crate::ID, FumpadError::InvalidAccount);
    let len = g.data_len();
    {
        let d = g.try_borrow_data()?;
        require!(len >= GLOBAL_ADMIN_OFFSET + 32 && d[..8] == *Global::DISCRIMINATOR, FumpadError::InvalidAccount);
        let admin = Pubkey::new_from_array(d[GLOBAL_ADMIN_OFFSET..GLOBAL_ADMIN_OFFSET + 32].try_into().unwrap());
        require_keys_eq!(admin, ctx.accounts.admin.key(), FumpadError::Unauthorized);
    }
    require!(len == GLOBAL_LEN, FumpadError::UnsupportedGlobalLayout);
    let ts = Clock::get()?.unix_timestamp;
    emit_event!(ctx, GlobalMigrated { old_len: len as u32, new_len: len as u32, ts });
    Ok(())
}
