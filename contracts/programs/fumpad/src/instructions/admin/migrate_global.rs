//! `migrate_global`: grow a Global written by an older program version to the current
//! layout in place. OWNER: foundation (lead).
//!
//! `Params` only ever grows by appending fields at its end, but `Params` appears twice in
//! `Global` (`params`, then `reserved`, then `pending_params`, `pending_eta`), so an append
//! is not a plain account append: both copies grow and everything after `params` shifts.
//! The handler therefore works on raw bytes (an old Global can't deserialize as
//! `Account<Global>`):
//!
//!   [disc 8][head][params p_old][reserved 128][pending p_old][eta 8]
//!     → [disc 8][head][params p_old ‖ tail][reserved 128][pending p_old ‖ tail][eta 8]
//!
//! where `tail` = the serialized bytes of the newly appended `Params` fields, taken from
//! `MigrateGlobalArgs`. Every pre-existing byte is copied verbatim, so the instruction can
//! only *fill new fields*: changing an existing param still needs `queue_params` → 48h →
//! `execute_params` (D15). On an already-current Global it is a no-op (idempotent, and it
//! can't be used to re-set the new fields later either). It never shrinks an account.

use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::{
    constants::*,
    error::FumpadError,
    events::GlobalMigrated,
    state::{Global, Params},
};

/// Bytes before `Global.params`: discriminator, bump, admin, platform_treasury, keepers, paused.
pub const GLOBAL_PARAMS_OFFSET: usize = 8 + 1 + 32 + 32 + 32 * MAX_KEEPERS + 1;
/// Offset of `Global.admin` (after the discriminator and `bump`).
pub const GLOBAL_ADMIN_OFFSET: usize = 8 + 1;
/// `Global.reserved` length.
pub const GLOBAL_RESERVED_LEN: usize = 128;
/// Serialized `Params` length of every older layout this instruction upgrades from.
/// v0.3/v0.4: 183 bytes (Global 672). Append the current length here when `Params` grows again.
pub const LEGACY_PARAMS_LENS: [usize; 1] = [183];

/// Account length (with discriminator) of a Global whose `Params` serializes to `params_len` bytes.
pub const fn global_len(params_len: usize) -> usize {
    GLOBAL_PARAMS_OFFSET + params_len + GLOBAL_RESERVED_LEN + params_len + 8
}

/// Values for the `Params` fields appended since the oldest supported layout. Fields a given
/// Global already has are ignored (its bytes are kept). v0.5 (D19): the snipe schedule.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct MigrateGlobalArgs {
    pub snipe_window_slots: u16,
    pub snipe_start_bps: u16,
}

impl MigrateGlobalArgs {
    /// Serialized `Params` whose appended fields hold these values (older fields are defaults
    /// and get overwritten by the account's own bytes).
    fn params_bytes(&self) -> Result<Vec<u8>> {
        let p = Params {
            snipe_window_slots: self.snipe_window_slots,
            snipe_start_bps: self.snipe_start_bps,
            ..Params::default()
        };
        let mut out = Vec::with_capacity(Params::INIT_SPACE);
        p.serialize(&mut out).map_err(|_| error!(FumpadError::InvalidParams))?;
        Ok(out)
    }
}

/// Pure byte transform (no account I/O) — unit-tested in `tests`. Returns `None` if `old` is
/// already the current layout; errors on an unknown or larger-than-current layout.
pub fn migrate_global_bytes(old: &[u8], args: &MigrateGlobalArgs) -> Result<Option<Vec<u8>>> {
    let p_new = Params::INIT_SPACE;
    let new_len = global_len(p_new);
    if old.len() == new_len {
        return Ok(None);
    }
    // Refuses to shrink (len > current) and unknown layouts alike.
    let p_old = LEGACY_PARAMS_LENS
        .iter()
        .copied()
        .find(|&p| p < p_new && global_len(p) == old.len())
        .ok_or(FumpadError::UnsupportedGlobalLayout)?;

    let full = args.params_bytes()?;
    require_eq!(full.len(), p_new, FumpadError::InvalidParams);
    let tail = &full[p_old..];

    let o = GLOBAL_PARAMS_OFFSET;
    let params = &old[o..o + p_old];
    let reserved = &old[o + p_old..o + p_old + GLOBAL_RESERVED_LEN];
    let pend_at = o + p_old + GLOBAL_RESERVED_LEN;
    let pending = &old[pend_at..pend_at + p_old];
    let eta = &old[pend_at + p_old..pend_at + p_old + 8];

    let mut out = Vec::with_capacity(new_len);
    out.extend_from_slice(&old[..o]);
    out.extend_from_slice(params);
    out.extend_from_slice(tail);
    out.extend_from_slice(reserved);
    // A change queued before the upgrade carries the same new-field values, so executing it
    // (after its original 48h) doesn't silently reset them.
    out.extend_from_slice(pending);
    out.extend_from_slice(tail);
    out.extend_from_slice(eta);
    require_eq!(out.len(), new_len, FumpadError::UnsupportedGlobalLayout);
    Ok(Some(out))
}

#[event_cpi]
#[derive(Accounts)]
pub struct MigrateGlobal<'info> {
    /// Must equal the admin stored in the Global; pays the extra rent.
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: raw on purpose — a legacy-layout Global can't deserialize as `Account<Global>`.
    /// Seeds + owner checked here; discriminator and admin checked in the handler.
    #[account(mut, seeds = [GLOBAL_SEED], bump, owner = crate::ID)]
    pub global: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_migrate_global(ctx: Context<MigrateGlobal>, args: MigrateGlobalArgs) -> Result<()> {
    let info = ctx.accounts.global.to_account_info();
    let old: Vec<u8> = {
        let data = info.try_borrow_data()?;
        require!(
            data.len() > GLOBAL_ADMIN_OFFSET + 32 && data[..8] == *Global::DISCRIMINATOR,
            FumpadError::InvalidAccount
        );
        let stored_admin = Pubkey::try_from(&data[GLOBAL_ADMIN_OFFSET..GLOBAL_ADMIN_OFFSET + 32])
            .map_err(|_| error!(FumpadError::InvalidAccount))?;
        require_keys_eq!(stored_admin, ctx.accounts.admin.key(), FumpadError::Unauthorized);
        data.to_vec()
    };

    let Some(new) = migrate_global_bytes(&old, &args)? else {
        return Ok(()); // already current: idempotent no-op
    };

    // The result must be a valid current Global with valid live params.
    let g = Global::try_deserialize(&mut new.as_slice())?;
    require!(g.params.is_valid(), FumpadError::InvalidParams);

    let rent = Rent::get()?.minimum_balance(new.len());
    let short = rent.saturating_sub(info.lamports());
    if short > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                system_program::Transfer { from: ctx.accounts.admin.to_account_info(), to: info.clone() },
            ),
            short,
        )?;
    }
    info.resize(new.len())?;
    info.try_borrow_mut_data()?.copy_from_slice(&new);

    emit_event!(ctx, GlobalMigrated {
        old_len: old.len() as u32,
        new_len: new.len() as u32,
        snipe_window_slots: g.params.snipe_window_slots,
        snipe_start_bps: g.params.snipe_start_bps,
        rent_paid: short,
        ts: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ARGS: MigrateGlobalArgs = MigrateGlobalArgs { snipe_window_slots: 6, snipe_start_bps: 5_000 };

    fn sample_global() -> Global {
        let mut params = Params::default();
        params.fee_bps = 150;
        params.graduation_lamports = 850_000_000;
        let mut pending = params;
        pending.fee_bps = 120;
        Global {
            bump: 254,
            admin: Pubkey::new_unique(),
            platform_treasury: Pubkey::new_unique(),
            keepers: [Pubkey::new_unique(), Pubkey::default(), Pubkey::new_unique()],
            paused: 0b101,
            params,
            reserved: [7u8; 128],
            pending_params: pending,
            pending_eta: 1_234_567,
        }
    }

    fn bytes(g: &Global) -> Vec<u8> {
        let mut v = Vec::new();
        g.try_serialize(&mut v).unwrap();
        v
    }

    /// Drop the last `n` bytes of both `Params` copies — the layout before they were appended.
    pub fn downgrade(new: &[u8], n: usize) -> Vec<u8> {
        let p = Params::INIT_SPACE;
        let o = GLOBAL_PARAMS_OFFSET;
        let mut v = Vec::new();
        v.extend_from_slice(&new[..o + p - n]);
        v.extend_from_slice(&new[o + p..o + p + GLOBAL_RESERVED_LEN + p - n]);
        v.extend_from_slice(&new[o + p + GLOBAL_RESERVED_LEN + p..]);
        v
    }

    #[test]
    fn layout_constants_match_global() {
        assert_eq!(global_len(Params::INIT_SPACE), 8 + Global::INIT_SPACE);
        assert_eq!(global_len(Params::INIT_SPACE), 680);
        assert_eq!(global_len(LEGACY_PARAMS_LENS[0]), 672);
        let g = sample_global();
        let b = bytes(&g);
        assert_eq!(b[GLOBAL_ADMIN_OFFSET..GLOBAL_ADMIN_OFFSET + 32], g.admin.to_bytes());
        assert_eq!(b[GLOBAL_PARAMS_OFFSET - 1], g.paused);
    }

    #[test]
    fn migrates_v04_layout_keeping_every_existing_byte() {
        let g = sample_global();
        let old = downgrade(&bytes(&g), 4);
        assert_eq!(old.len(), 672);
        let new = migrate_global_bytes(&old, &ARGS).unwrap().expect("migrated");
        let m = Global::try_deserialize(&mut new.as_slice()).unwrap();
        let mut want = g;
        want.params.snipe_window_slots = 6;
        want.params.snipe_start_bps = 5_000;
        want.pending_params.snipe_window_slots = 6;
        want.pending_params.snipe_start_bps = 5_000;
        assert_eq!(bytes(&m), bytes(&want));
    }

    #[test]
    fn current_layout_is_a_noop_and_others_are_rejected() {
        let b = bytes(&sample_global());
        assert!(migrate_global_bytes(&b, &ARGS).unwrap().is_none());
        let mut bigger = b.clone();
        bigger.extend_from_slice(&[0u8; 8]);
        assert!(migrate_global_bytes(&bigger, &ARGS).is_err());
        assert!(migrate_global_bytes(&b[..676], &ARGS).is_err());
        assert!(migrate_global_bytes(&b[..481], &ARGS).is_err());
    }
}
