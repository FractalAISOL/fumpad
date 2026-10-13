//! `migrate_global`: the layout-upgrade hook (D39 keeps the mechanism). Admin only.
//!
//! * Operators (2026-10-13 d): `Global.operators` was carved out of `reserved [u8; 64]` (same offset, same 1,044
//!   bytes), so a Global initialized before it reads `operators == [default; 2]`. On such a Global this fills
//!   `operators[0] = keepers[0]` — the key that ran the jobs keeper until now — so jobs keep running across the
//!   program upgrade (`OperatorsSet`). That is the one place where a key may be both attestor and operator; the
//!   admin then moves the jobs keeper to a fresh key with `set_operators` (and `set_keepers` refuses to keep an
//!   overlap). With operators already set, or no `keepers[0]`, it changes nothing.
//! * Any other length → `UnsupportedGlobalLayout`. A future layout change adds its old length here and grows the
//!   account in place (copying every existing byte verbatim and filling only new fields — never a timelock bypass).

use anchor_lang::prelude::*;
use anchor_lang::Discriminator;

use crate::{
    constants::*,
    error::FumpadError,
    events::{GlobalMigrated, OperatorsSet},
    instructions::rewards::util::write_account,
    state::Global,
};

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
    let mut global = Global::try_deserialize(&mut &g.try_borrow_data()?[..])?;
    let fill = global.operators.iter().all(|k| *k == Pubkey::default()) && global.keepers[0] != Pubkey::default();
    let ts = Clock::get()?.unix_timestamp;
    emit_event!(ctx, GlobalMigrated { old_len: len as u32, new_len: len as u32, ts });
    if fill {
        global.operators = [Pubkey::default(); MAX_OPERATORS];
        global.operators[0] = global.keepers[0];
        write_account(&g, &global)?;
        emit_event!(ctx, OperatorsSet { operators: global.operators, ts });
    }
    Ok(())
}
