//! `migrate_global`: grow a v0.3/v0.4 (672-byte) Global to the current layout in place.

use anchor_lang::{prelude::Pubkey, AccountSerialize, Space};
use fumpad::{
    error::FumpadError,
    events::GlobalMigrated,
    instructions::{global_len, MigrateGlobalArgs, GLOBAL_ADMIN_OFFSET, GLOBAL_PARAMS_OFFSET, GLOBAL_RESERVED_LEN},
    state::{Global, Params},
};

use crate::flow::{event_authority, expect_err, ok, Flow, SYSTEM};
use crate::*;

const OLD_PARAMS_LEN: usize = 183;
const ARGS: MigrateGlobalArgs = MigrateGlobalArgs { snipe_window_slots: 4, snipe_start_bps: 9_900 };

fn migrate_ix(env: &Env, admin: &Pubkey, args: MigrateGlobalArgs) -> solana_instruction::Instruction {
    ix(
        fumpad::accounts::MigrateGlobal {
            admin: *admin,
            global: env.global_pda(),
            system_program: SYSTEM,
            event_authority: event_authority(),
            program: fumpad::ID,
        },
        fumpad::instruction::MigrateGlobal { args },
    )
}

fn migrate(env: &mut Env, args: MigrateGlobalArgs) -> litesvm::types::TransactionResult {
    let admin = env.admin.insecure_clone();
    let i = migrate_ix(env, &kp_pk(&admin), args);
    env.send(&[i], &[&admin])
}

/// The v0.4 bytes of a current Global: both `Params` copies without the 4 bytes v0.5 appended.
fn downgrade(new: &[u8]) -> Vec<u8> {
    let p = Params::INIT_SPACE;
    let n = p - OLD_PARAMS_LEN;
    let o = GLOBAL_PARAMS_OFFSET;
    let mut v = Vec::new();
    v.extend_from_slice(&new[..o + p - n]);
    v.extend_from_slice(&new[o + p..o + p + GLOBAL_RESERVED_LEN + p - n]);
    v.extend_from_slice(&new[o + p + GLOBAL_RESERVED_LEN + p..]);
    v
}

/// Overwrite the Global PDA with `data` at the rent-exempt minimum for its size.
fn put_global(env: &mut Env, data: Vec<u8>) {
    let key = env.global_pda();
    let lamports = env.svm.minimum_balance_for_rent_exemption(data.len());
    env.svm
        .set_account(
            addr(&key),
            solana_account::Account { lamports, data, owner: addr(&fumpad::ID), executable: false, rent_epoch: 0 },
        )
        .unwrap();
}

fn global_bytes(env: &Env) -> Vec<u8> {
    env.account(&env.global_pda()).unwrap().data
}

fn ser(g: &Global) -> Vec<u8> {
    let mut v = Vec::new();
    g.try_serialize(&mut v).unwrap();
    v
}

/// A Global with non-default everything (pause bits, keepers, a queued change), crafted
/// into the v0.4 672-byte layout.
fn legacy_env() -> (Env, Global) {
    let mut env = Env::new();
    // A small (devnet-style) curve: 0.3 SOL virtual, 0.85 SOL raise, no graduation fee.
    let mut p = crate::curve_tests::curve_params(300_000_000, 850_000_000, 0);
    p.fee_bps = 150;
    env.set_params_timelocked(p);
    let mut queued = p;
    queued.fee_bps = 120;
    ok(env.queue_params(queued));
    let admin = env.admin.insecure_clone();
    ok(env.send(
        &[ix(
            fumpad::accounts::AdminOnly { admin: kp_pk(&admin), global: env.global_pda() },
            fumpad::instruction::SetPause { paused: fumpad::state::PAUSE_CLAIMS },
        )],
        &[&admin],
    ));
    let before: Global = env.fetch(&env.global_pda());
    let old = downgrade(&global_bytes(&env));
    assert_eq!(old.len(), 672);
    put_global(&mut env, old);
    (env, before)
}

#[test]
fn migrates_672_byte_global_keeping_existing_fields() {
    let (mut env, before) = legacy_env();
    let gk = env.global_pda();
    assert!(env.svm.get_account(&addr(&gk)).unwrap().data.len() == 672);
    let admin_before = env.lamports(&kp_pk(&env.admin));
    let global_before = env.lamports(&gk);

    let args = MigrateGlobalArgs { snipe_window_slots: 6, snipe_start_bps: 5_000 };
    let m = ok(migrate(&mut env, args));

    let acc = env.account(&gk).unwrap();
    assert_eq!(acc.data.len(), 680);
    assert_eq!(acc.data.len(), 8 + Global::INIT_SPACE);
    assert_eq!(acc.lamports, env.svm.minimum_balance_for_rent_exemption(680));
    let rent_paid = acc.lamports - global_before;
    assert!(rent_paid > 0);
    // Admin paid exactly the extra rent (the fee payer is `payer`, not the admin).
    assert_eq!(admin_before - env.lamports(&kp_pk(&env.admin)), rent_paid);

    let g: Global = env.fetch(&gk);
    let mut want = before;
    want.params.snipe_window_slots = 6;
    want.params.snipe_start_bps = 5_000;
    want.pending_params.snipe_window_slots = 6;
    want.pending_params.snipe_start_bps = 5_000;
    assert_eq!(ser(&g), ser(&want), "every pre-existing field must be untouched");
    assert_eq!(g.paused, fumpad::state::PAUSE_CLAIMS);
    assert!(g.pending_eta > 0);

    let ev = crate::flow::events::<GlobalMigrated>(&m);
    assert_eq!(ev.len(), 1);
    assert_eq!((ev[0].old_len, ev[0].new_len), (672, 680));
    assert_eq!((ev[0].snipe_window_slots, ev[0].snipe_start_bps, ev[0].rent_paid), (6, 5_000, rent_paid));

    // The 48h timelock still governs existing params: the change queued before the upgrade
    // executes on its original schedule and keeps the migrated snipe values.
    env.warp(fumpad::PARAMS_TIMELOCK_SECS);
    ok(env.execute_params());
    let g: Global = env.fetch(&gk);
    assert_eq!(g.params.fee_bps, 120);
    assert_eq!((g.params.snipe_window_slots, g.params.snipe_start_bps), (6, 5_000));
}

#[test]
fn migrate_is_idempotent_and_cannot_rewrite_new_fields() {
    let (mut env, _) = legacy_env();
    ok(migrate(&mut env, ARGS));
    let once = global_bytes(&env);
    let admin_before = env.lamports(&kp_pk(&env.admin));
    // Second call with different values: success, nothing changes (not a timelock bypass).
    let m = ok(migrate(&mut env, MigrateGlobalArgs { snipe_window_slots: 0, snipe_start_bps: 0 }));
    assert_eq!(global_bytes(&env), once);
    assert_eq!(env.lamports(&kp_pk(&env.admin)), admin_before);
    assert!(crate::flow::events::<GlobalMigrated>(&m).is_empty());
}

#[test]
fn migrate_on_fresh_current_global_is_noop() {
    let mut env = Env::new();
    let before = global_bytes(&env);
    ok(migrate(&mut env, MigrateGlobalArgs { snipe_window_slots: 1, snipe_start_bps: 1 }));
    assert_eq!(global_bytes(&env), before);
}

#[test]
fn non_admin_rejected() {
    let (mut env, _) = legacy_env();
    let before = global_bytes(&env);
    let rando = env.new_user(5);
    let i = migrate_ix(&env, &kp_pk(&rando), ARGS);
    expect_err(env.send(&[i], &[&rando]), FumpadError::Unauthorized);
    assert_eq!(global_bytes(&env), before);
    // Also on an already-current Global.
    let mut env = Env::new();
    let rando = env.new_user(5);
    let i = migrate_ix(&env, &kp_pk(&rando), ARGS);
    expect_err(env.send(&[i], &[&rando]), FumpadError::Unauthorized);
}

#[test]
fn refuses_to_shrink_or_guess_unknown_layouts() {
    let mut env = Env::new();
    let cur = global_bytes(&env);
    let mut bigger = cur.clone();
    bigger.extend_from_slice(&[0u8; 8]);
    put_global(&mut env, bigger.clone());
    expect_err(migrate(&mut env, ARGS), FumpadError::UnsupportedGlobalLayout);
    assert_eq!(global_bytes(&env), bigger);
    put_global(&mut env, cur[..676].to_vec());
    expect_err(migrate(&mut env, ARGS), FumpadError::UnsupportedGlobalLayout);
}

#[test]
fn invalid_new_values_rejected() {
    let (mut env, _) = legacy_env();
    let before = global_bytes(&env);
    let bad = MigrateGlobalArgs { snipe_window_slots: fumpad::MAX_SNIPE_WINDOW_SLOTS + 1, snipe_start_bps: 9_900 };
    expect_err(migrate(&mut env, bad), FumpadError::InvalidParams);
    let bad = MigrateGlobalArgs { snipe_window_slots: 4, snipe_start_bps: fumpad::MAX_SNIPE_START_BPS + 1 };
    expect_err(migrate(&mut env, bad), FumpadError::InvalidParams);
    assert_eq!(global_bytes(&env), before);
}

#[test]
fn rejects_wrong_discriminator() {
    let (mut env, _) = legacy_env();
    let mut d = global_bytes(&env);
    d[0] ^= 0xff;
    put_global(&mut env, d);
    expect_err(migrate(&mut env, ARGS), FumpadError::InvalidAccount);
}

/// The real devnet Global (v0.4 program, scaled params), admin swapped for the test admin.
#[test]
fn migrates_real_devnet_global_dump() {
    let mut env = Env::new();
    let gk = env.global_pda();
    load_account_fixture(&mut env.svm, "devnet_global_v04.json");
    let mut acc = env.account(&gk).expect("fixture is the Global PDA");
    assert_eq!(acc.data.len(), 672);
    let original = acc.data.clone();
    acc.data[GLOBAL_ADMIN_OFFSET..GLOBAL_ADMIN_OFFSET + 32].copy_from_slice(kp_pk(&env.admin).as_ref());
    env.svm.set_account(addr(&gk), acc).unwrap();

    ok(migrate(&mut env, ARGS));
    let data = global_bytes(&env);
    assert_eq!(data.len(), global_len(Params::INIT_SPACE));
    // Every old byte is still there, at its old position shifted past the inserted tails.
    assert_eq!(downgrade(&data)[GLOBAL_ADMIN_OFFSET + 32..], original[GLOBAL_ADMIN_OFFSET + 32..]);
    let g: Global = env.fetch(&gk);
    // Devnet runs test windows (30 s hold, 5-min oracle window, 15 samples) that the v0.6
    // bounds (M-1 / L-2) no longer accept for NEW changes; migration keeps them as they are
    // (it only validates the fields it fills), and the next queued change must be in bounds.
    assert!(!g.params.is_valid());
    assert_eq!((g.params.min_hold_secs, g.params.oracle_window_secs, g.params.oracle_min_samples), (30, 300, 15));
    assert_eq!((g.params.snipe_window_slots, g.params.snipe_start_bps), (4, 9_900));
    expect_err(env.queue_params(g.params), FumpadError::InvalidParams);
}

/// After an upgrade every instruction that loads `Account<Global>` fails on the old layout
/// until `migrate_global` runs; then trading works again (buy at the snipe-free offset).
#[test]
fn protocol_resumes_after_migration() {
    let mut f = Flow::new();
    let cur = global_bytes(&f.env);
    put_global(&mut f.env, downgrade(&cur));
    let user = f.env.new_user(10);
    let res = f.buy(&user, SOL / 10);
    assert!(res.is_err(), "old-layout Global must not deserialize");
    ok(migrate(&mut f.env, ARGS));
    assert_eq!(global_bytes(&f.env), cur);
    ok(f.buy(&user, SOL / 10));
}
