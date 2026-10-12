//! `migrate_global`: grow a Global written by an older program version to the current
//! layout in place. OWNER: foundation (lead).
//!
//! `Params` only ever grows by appending fields at its end, but `Params` appears twice in
//! `Global` (`params`, then the 128-byte governance/reserved region, then `pending_params`,
//! `pending_eta`), so an append is not a plain account append: both copies grow and
//! everything after `params` shifts. v0.6 also appended the M-2 authority proposal
//! (`pending_admin`, `pending_treasury`, `pending_guardian`, 96 bytes) at the very end and
//! carved `guardian`, `pause_expires_at`, `pending_admin_eta` out of the old `reserved`. The
//! handler therefore works on raw bytes (an old Global can't deserialize as `Account<Global>`):
//!
//!   [disc 8][head][params p_old][region 128][pending p_old][eta 8]                       (≤ v0.5)
//!     → [disc 8][head][params p_old ‖ tail][region' 128][pending p_old ‖ tail][eta 8][proposal 96]
//!
//! where `tail` = the serialized bytes of the newly appended `Params` fields, taken from
//! `MigrateGlobalArgs`; `region'` = the old region with its first 48 (always-zero, reserved)
//! bytes set to guardian = the stored admin, pause_expires_at = now + 7 days if any pause flag
//! is set (else 0), pending_admin_eta = 0; the proposal is empty. Every other pre-existing
//! byte is copied verbatim, so the instruction can only *fill new fields*: changing an
//! existing param still needs `queue_params` → 48h → `execute_params` (D15). On an
//! already-current Global it is a no-op (idempotent, and it can't be used to re-set the new
//! fields later either). It never shrinks an account.

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
/// Length of the region between `params` and `pending_params`: v0.6 `guardian` (32) +
/// `pause_expires_at` (8) + `pending_admin_eta` (8) + `reserved` (80); ≤ v0.5 all `reserved`.
pub const GLOBAL_RESERVED_LEN: usize = 128;
/// v0.6 (M-2): `pending_admin` + `pending_treasury` + `pending_guardian`, appended after
/// `pending_eta`.
pub const GOVERNANCE_TAIL_LEN: usize = 96;
/// Serialized `Params` length of every older (pre-v0.6, no governance tail) layout this
/// instruction upgrades from: v0.3/v0.4 183 bytes (Global 672), v0.5 187 (Global 680).
/// When the layout changes again, add the current one here.
pub const LEGACY_PARAMS_LENS: [usize; 2] = [183, 187];

/// Account length (with discriminator) of a pre-v0.6 Global whose `Params` is `params_len` bytes.
pub const fn legacy_global_len(params_len: usize) -> usize {
    GLOBAL_PARAMS_OFFSET + params_len + GLOBAL_RESERVED_LEN + params_len + 8
}

/// Account length (with discriminator) of a current-layout Global with `params_len`-byte `Params`.
pub const fn global_len(params_len: usize) -> usize {
    legacy_global_len(params_len) + GOVERNANCE_TAIL_LEN
}

/// Values for the `Params` fields appended since the oldest supported layout. Fields a given
/// Global already has are ignored (its bytes are kept). v0.5 (D19): the snipe schedule.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct MigrateGlobalArgs {
    pub snipe_window_slots: u16,
    pub snipe_start_bps: u16,
}

impl MigrateGlobalArgs {
    /// The D19 caps of `Params::is_valid` for the fields these args fill.
    pub fn within_caps(&self) -> bool {
        self.snipe_window_slots <= MAX_SNIPE_WINDOW_SLOTS && self.snipe_start_bps <= MAX_SNIPE_START_BPS
    }

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
/// already the current layout; errors on an unknown or larger-than-current layout. `now`
/// starts the 7-day expiry (M-3) of pause flags that were set before the upgrade.
pub fn migrate_global_bytes(old: &[u8], args: &MigrateGlobalArgs, now: i64) -> Result<Option<Vec<u8>>> {
    let p_new = Params::INIT_SPACE;
    let new_len = global_len(p_new);
    if old.len() == new_len {
        return Ok(None);
    }
    // Refuses to shrink (len > current) and unknown layouts alike.
    let p_old = LEGACY_PARAMS_LENS
        .iter()
        .copied()
        .find(|&p| p <= p_new && legacy_global_len(p) == old.len())
        .ok_or(FumpadError::UnsupportedGlobalLayout)?;

    let full = args.params_bytes()?;
    require_eq!(full.len(), p_new, FumpadError::InvalidParams);
    let tail = &full[p_old..];

    let o = GLOBAL_PARAMS_OFFSET;
    let params = &old[o..o + p_old];
    let region = &old[o + p_old..o + p_old + GLOBAL_RESERVED_LEN];
    let pend_at = o + p_old + GLOBAL_RESERVED_LEN;
    let pending = &old[pend_at..pend_at + p_old];
    let eta = &old[pend_at + p_old..pend_at + p_old + 8];

    // M-2 / M-3: guardian = the stored admin; set pause flags get the 7-day expiry.
    let admin = &old[GLOBAL_ADMIN_OFFSET..GLOBAL_ADMIN_OFFSET + 32];
    let paused = old[o - 1];
    let pause_expires_at: i64 =
        if paused == 0 { 0 } else { now.checked_add(MAX_PAUSE_SECS).ok_or(FumpadError::MathOverflow)? };

    let mut out = Vec::with_capacity(new_len);
    out.extend_from_slice(&old[..o]);
    out.extend_from_slice(params);
    out.extend_from_slice(tail);
    out.extend_from_slice(admin); // guardian
    out.extend_from_slice(&pause_expires_at.to_le_bytes());
    out.extend_from_slice(&0i64.to_le_bytes()); // pending_admin_eta
    out.extend_from_slice(&region[48..]); // reserved (80)
    // A change queued before the upgrade carries the same new-field values, so executing it
    // (after its original 48h) doesn't silently reset them.
    out.extend_from_slice(pending);
    out.extend_from_slice(tail);
    out.extend_from_slice(eta);
    out.extend_from_slice(&[0u8; GOVERNANCE_TAIL_LEN]); // no authority proposal
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

    let now = Clock::get()?.unix_timestamp;
    let Some(new) = migrate_global_bytes(&old, &args, now)? else {
        return Ok(()); // already current: idempotent no-op
    };

    // The result must be a valid current Global, and the fields it fills must be within their
    // caps. Existing params are NOT re-validated: they were valid when set, and v0.6 tightened
    // `Params::is_valid` (M-1 / L-2) — a Global with older, looser params (e.g. devnet's test
    // windows) must still migrate. New bounds apply to the next `queue_params`.
    let g = Global::try_deserialize(&mut new.as_slice())?;
    require!(args.within_caps(), FumpadError::InvalidParams);

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
        ts: now,
        guardian: g.guardian,
        pause_expires_at: g.pause_expires_at,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ARGS: MigrateGlobalArgs = MigrateGlobalArgs { snipe_window_slots: 6, snipe_start_bps: 5_000 };
    const NOW: i64 = 1_800_000_000;

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
            guardian: Pubkey::default(),
            pause_expires_at: 0,
            pending_admin_eta: 0,
            reserved: [7u8; 80],
            pending_params: pending,
            pending_eta: 1_234_567,
            pending_admin: Pubkey::default(),
            pending_treasury: Pubkey::default(),
            pending_guardian: Pubkey::default(),
        }
    }

    fn bytes(g: &Global) -> Vec<u8> {
        let mut v = Vec::new();
        g.try_serialize(&mut v).unwrap();
        v
    }

    /// The pre-v0.6 bytes of `new`: governance tail dropped, and the last `n` bytes of both
    /// `Params` copies dropped (the layout before they were appended). The carved region is
    /// kept as is (callers zero `guardian`/`pause_expires_at`/`pending_admin_eta` first).
    pub fn downgrade(new: &[u8], n: usize) -> Vec<u8> {
        let p = Params::INIT_SPACE;
        let o = GLOBAL_PARAMS_OFFSET;
        let mut v = Vec::new();
        v.extend_from_slice(&new[..o + p - n]);
        v.extend_from_slice(&new[o + p..o + p + GLOBAL_RESERVED_LEN + p - n]);
        v.extend_from_slice(&new[o + p + GLOBAL_RESERVED_LEN + p..new.len() - GOVERNANCE_TAIL_LEN]);
        v
    }

    #[test]
    fn layout_constants_match_global() {
        assert_eq!(global_len(Params::INIT_SPACE), 8 + Global::INIT_SPACE);
        assert_eq!(global_len(Params::INIT_SPACE), 776);
        assert_eq!(legacy_global_len(LEGACY_PARAMS_LENS[0]), 672);
        assert_eq!(legacy_global_len(LEGACY_PARAMS_LENS[1]), 680);
        assert_eq!(32 + 8 + 8 + 80, GLOBAL_RESERVED_LEN);
        let g = sample_global();
        let b = bytes(&g);
        assert_eq!(b[GLOBAL_ADMIN_OFFSET..GLOBAL_ADMIN_OFFSET + 32], g.admin.to_bytes());
        assert_eq!(b[GLOBAL_PARAMS_OFFSET - 1], g.paused);
    }

    fn expected(g: &Global, snipe: bool) -> Global {
        let mut want = g.clone();
        if snipe {
            want.params.snipe_window_slots = 6;
            want.params.snipe_start_bps = 5_000;
            want.pending_params.snipe_window_slots = 6;
            want.pending_params.snipe_start_bps = 5_000;
        }
        want.guardian = g.admin;
        want.pause_expires_at = NOW + MAX_PAUSE_SECS; // paused = 0b101
        want
    }

    #[test]
    fn migrates_v04_layout_keeping_every_existing_byte() {
        let g = sample_global();
        let old = downgrade(&bytes(&g), 4);
        assert_eq!(old.len(), 672);
        let new = migrate_global_bytes(&old, &ARGS, NOW).unwrap().expect("migrated");
        let m = Global::try_deserialize(&mut new.as_slice()).unwrap();
        assert_eq!(bytes(&m), bytes(&expected(&g, true)));
    }

    #[test]
    fn migrates_v05_layout_adding_the_governance_fields() {
        let g = sample_global();
        let old = downgrade(&bytes(&g), 0);
        assert_eq!(old.len(), 680);
        let new = migrate_global_bytes(&old, &ARGS, NOW).unwrap().expect("migrated");
        let m = Global::try_deserialize(&mut new.as_slice()).unwrap();
        // Snipe fields already existed: kept (args ignored).
        assert_eq!(bytes(&m), bytes(&expected(&g, false)));
        // Not paused → no expiry.
        let mut unpaused = g;
        unpaused.paused = 0;
        let new = migrate_global_bytes(&downgrade(&bytes(&unpaused), 0), &ARGS, NOW).unwrap().unwrap();
        assert_eq!(Global::try_deserialize(&mut new.as_slice()).unwrap().pause_expires_at, 0);
    }

    #[test]
    fn current_layout_is_a_noop_and_others_are_rejected() {
        let b = bytes(&sample_global());
        assert!(migrate_global_bytes(&b, &ARGS, NOW).unwrap().is_none());
        let mut bigger = b.clone();
        bigger.extend_from_slice(&[0u8; 8]);
        assert!(migrate_global_bytes(&bigger, &ARGS, NOW).is_err());
        assert!(migrate_global_bytes(&b[..676], &ARGS, NOW).is_err());
        assert!(migrate_global_bytes(&b[..681], &ARGS, NOW).is_err());
        assert!(migrate_global_bytes(&b[..481], &ARGS, NOW).is_err());
    }
}
