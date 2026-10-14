//! `migrate_global`: the layout-upgrade hook (D39 keeps the mechanism). Admin only.
//!
//! * Fee policies (2026-10-14): Global grew from `GLOBAL_LEN_V1` (1,044 bytes) to `GLOBAL_LEN` (1,491) by appending
//!   `config_policies`, `config_coins`, `pending_config_policy` and 64 reserved bytes. On a 1,044-byte Global this
//!   grows the account in place (the admin pays the extra rent): every existing byte stays verbatim, the new bytes
//!   are zero = every allow-listed config `FEE_POLICY_STANDARD` with no coin count and no pending policy (a pending
//!   config add executes as standard). Registered coins are untouched (their `fee_policy_kind` byte was reserved = 0).
//!   Until it runs after the program upgrade, every instruction that loads Global fails to deserialize — run it right
//!   after the upgrade (services/LAUNCH-DAY.md / the devnet bootstrap `policies` step).
//! * Operators (2026-10-13 d): `Global.operators` was carved out of `reserved [u8; 64]` (same offset, same 1,044
//!   bytes), so a Global initialized before it reads `operators == [default; 2]`. On such a Global this fills
//!   `operators[0] = keepers[0]` — the key that ran the jobs keeper until now — so jobs keep running across the
//!   program upgrade (`OperatorsSet`). That is the one place where a key may be both attestor and operator; the
//!   admin then moves the jobs keeper to a fresh key with `set_operators` (and `set_keepers` refuses to keep an
//!   overlap). With operators already set, or no `keepers[0]`, it changes nothing.
//! * Any other length → `UnsupportedGlobalLayout`. A future layout change adds its old length here and grows the
//!   account in place (copying every existing byte verbatim and filling only new fields — never a timelock bypass).

use anchor_lang::prelude::*;
use anchor_lang::{system_program, Discriminator};

use crate::{
    constants::*,
    error::FumpadError,
    events::{GlobalMigrated, OperatorsSet},
    instructions::rewards::util::write_account,
    state::Global,
};

/// Account length (with discriminator) of the current Global.
pub const GLOBAL_LEN: usize = 8 + Global::INIT_SPACE;
/// Length of the Global before the fee policies (2026-10-13 layout, with operators).
pub const GLOBAL_LEN_V1: usize = 1_044;
/// Offset of `Global.admin` (after the discriminator and `bump`).
pub const GLOBAL_ADMIN_OFFSET: usize = 8 + 1;

#[event_cpi]
#[derive(Accounts)]
pub struct MigrateGlobal<'info> {
    /// Pays the rent of the grown account.
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
    let old_len = g.data_len();
    {
        let d = g.try_borrow_data()?;
        require!(old_len >= GLOBAL_ADMIN_OFFSET + 32 && d[..8] == *Global::DISCRIMINATOR, FumpadError::InvalidAccount);
        let admin = Pubkey::new_from_array(d[GLOBAL_ADMIN_OFFSET..GLOBAL_ADMIN_OFFSET + 32].try_into().unwrap());
        require_keys_eq!(admin, ctx.accounts.admin.key(), FumpadError::Unauthorized);
    }
    require!(old_len == GLOBAL_LEN || old_len == GLOBAL_LEN_V1, FumpadError::UnsupportedGlobalLayout);
    if old_len == GLOBAL_LEN_V1 {
        let rent = Rent::get()?.minimum_balance(GLOBAL_LEN);
        let have = g.lamports();
        if rent > have {
            system_program::transfer(
                CpiContext::new(
                    system_program::ID,
                    system_program::Transfer { from: ctx.accounts.admin.to_account_info(), to: g.clone() },
                ),
                rent - have,
            )?;
        }
        g.resize(GLOBAL_LEN)?;
        // The new tail must read as "standard policies, no counts, nothing pending" whatever the runtime left there.
        g.try_borrow_mut_data()?[GLOBAL_LEN_V1..].fill(0);
    }
    let mut global = Global::try_deserialize(&mut &g.try_borrow_data()?[..])?;
    let fill = global.operators.iter().all(|k| *k == Pubkey::default()) && global.keepers[0] != Pubkey::default();
    let ts = Clock::get()?.unix_timestamp;
    emit_event!(ctx, GlobalMigrated { old_len: old_len as u32, new_len: GLOBAL_LEN as u32, ts });
    if fill {
        global.operators = [Pubkey::default(); MAX_OPERATORS];
        global.operators[0] = global.keepers[0];
        write_account(&g, &global)?;
        emit_event!(ctx, OperatorsSet { operators: global.operators, ts });
    }
    Ok(())
}
