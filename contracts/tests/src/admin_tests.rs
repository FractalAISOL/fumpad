//! Governance (timelocks, guardian, two-step admin, pauses + expiry, params bounds, migrate_global) and the v0.6
//! `regression_*` scenarios whose attack still applies to v0.7.

use crate::meteora;
use crate::*;
use fumpad::error::FumpadError;
use fumpad::events::*;
use fumpad::state::{Global, Params, PAUSE_ALL, PAUSE_GRADUATE};
use solana_keypair::Keypair;

fn guardian_ix(authority: &Pubkey, global: Pubkey, data: impl anchor_lang::InstructionData) -> solana_instruction::Instruction {
    ix(fumpad::accounts::GuardianOrAdmin { authority: *authority, global, event_authority: ev_auth(), program: fumpad::ID }, data)
}

fn admin_ix(admin: &Pubkey, global: Pubkey, data: impl anchor_lang::InstructionData) -> solana_instruction::Instruction {
    ix(fumpad::accounts::AdminOnly { admin: *admin, global, event_authority: ev_auth(), program: fumpad::ID }, data)
}

/// Hand the guardian role to its own key (propose → 6 h → accept). Returns the guardian.
fn with_guardian(env: &mut Env) -> Keypair {
    let guardian = env.new_user(10);
    let (admin, g) = (env.admin.insecure_clone(), env.global());
    let i = admin_ix(
        &kp_pk(&admin),
        g,
        fumpad::instruction::ProposeAdmin { new_admin: kp_pk(&admin), platform_treasury: kp_pk(&env.treasury), guardian: kp_pk(&guardian) },
    );
    ok(env.send(&[i], &[&admin]));
    env.warp(fumpad::ADMIN_TIMELOCK_SECS);
    let i = ix(fumpad::accounts::AcceptAdmin { new_admin: kp_pk(&admin), global: g, event_authority: ev_auth(), program: fumpad::ID }, fumpad::instruction::AcceptAdmin {});
    ok(env.send(&[i], &[&admin]));
    guardian
}

#[test]
fn initialize_global_only_by_upgrade_authority_and_validates() {
    // A stranger (not the upgrade authority) can't initialize, not even with an empty bootstrap.
    let mut env = Env::uninit();
    let rando = env.new_user(10);
    let i = env.initialize_global_ix_by(&kp_pk(&rando), Params::default(), [Pubkey::default(); 3], &[]);
    assert_fumpad_err(env.send_as(&rando, &[i], &[&rando]), FumpadError::Unauthorized);
    // Duplicate bootstrap keepers, invalid params → InvalidParams.
    let k = kp_pk(&env.keepers[0]);
    let i = env.initialize_global_ix(Params::default(), [k, k, Pubkey::default()], &[]);
    assert_fumpad_err(env.send(&[i], &[]), FumpadError::InvalidParams);
    let mut p = Params::default();
    p.ticket_challenge_secs = 10;
    let i = env.initialize_global_ix(p, [Pubkey::default(); 3], &[]);
    assert_fumpad_err(env.send(&[i], &[]), FumpadError::InvalidParams);
    // The upgrade authority succeeds once; a second init is impossible (PDA exists).
    let i = env.initialize_global_ix(Params::default(), [Pubkey::default(); 3], &[]);
    ok(env.send(&[i], &[]));
    env.warp(1);
    let i = env.initialize_global_ix(Params::default(), [Pubkey::default(); 3], &[]);
    assert!(env.send(&[i], &[]).is_err());
}

/// Bootstrap (deploy runbook): the upgrade authority's `initialize_global` sets the initial keepers and DBC config
/// allow-list with no 6h attest freeze and no 1 h config timelock; every later change keeps its freeze / timelock.
#[test]
fn bootstrap_keepers_attest_immediately_and_bootstrap_config_registers_immediately() {
    let mut env = Env::uninit();
    let config = env.create_dbc_config(&meteora::mainnet_config_params());
    let keepers = [kp_pk(&env.keepers[0]), kp_pk(&env.keepers[1]), kp_pk(&env.keepers[2])];
    let i = env.initialize_global_ix(Params::default(), keepers, &[config]);
    let meta = ok(env.send(&[i], &[]));
    let g: Global = env.fetch(&env.global());
    assert_eq!((g.keepers, g.keeper_added_at, g.configs[0], g.cluster_tag), (keepers, [0; 3], config, CLUSTER_TAG));
    assert!(g.configs[1..].iter().all(|c| *c == Pubkey::default()));
    assert_eq!((g.pending_config_eta, g.pending_eta), (0, 0));
    assert_eq!(event::<GlobalInitialized>(&meta).admin, kp_pk(&env.admin));
    let ks: KeepersSet = event(&meta);
    assert_eq!((ks.keepers, ks.added_at), (keepers, [0; 3]));
    let cu: ConfigUpdated = event(&meta);
    assert_eq!((cu.config, cu.add), (config, true));
    // The bootstrap config registers coins right away (no 1 h timelock), and the bootstrap keepers attest right away (no 6h).
    env.config = config;
    let t0 = env.now();
    let c = env.launch(SOL / 10);
    env.skip_launch_window();
    env.warp(60);
    let r = env.sell_record(&c, &Pubkey::new_unique(), 10_000_000_000, 1 << 50);
    ok(env.attest_sell(&r, &[0, 1]));
    let r = env.sell_record(&c, &Pubkey::new_unique(), 10_000_000_000, 1 << 50);
    ok(env.attest_sell(&r, &[2, 1]));
    assert!(env.now() - t0 < fumpad::KEEPER_ATTEST_FREEZE_SECS);
    // A later set_keepers still freezes the NEW key for 6h; bootstrap keys that stay keep "no freeze".
    let fresh = env.new_user(10);
    ok(env.set_keepers([keepers[0], keepers[1], kp_pk(&fresh)]));
    let g: Global = env.fetch(&env.global());
    assert_eq!(g.keeper_added_at, [0, 0, env.now()]);
    env.keepers[2] = fresh.insecure_clone();
    let r = env.sell_record(&c, &Pubkey::new_unique(), 10_000_000_000, 1 << 50);
    assert_fumpad_err(env.attest_sell(&r, &[2, 0]), FumpadError::NotEnoughKeeperSignatures);
    ok(env.attest_sell(&r, &[0, 1]));
    env.warp(fumpad::KEEPER_ATTEST_FREEZE_SECS);
    let r = env.sell_record(&c, &Pubkey::new_unique(), 10_000_000_000, 1 << 50);
    ok(env.attest_sell(&r, &[2, 0]));
    // A bootstrap key removed and re-added is a new key: frozen again.
    ok(env.set_keepers([Pubkey::default(), keepers[1], kp_pk(&fresh)]));
    ok(env.set_keepers([keepers[0], keepers[1], kp_pk(&fresh)]));
    let r = env.sell_record(&c, &Pubkey::new_unique(), 10_000_000_000, 1 << 50);
    assert_fumpad_err(env.attest_sell(&r, &[0, 2]), FumpadError::NotEnoughKeeperSignatures);
    // A later config add keeps its 1 h timelock.
    let second = env.create_dbc_config(&meteora::mainnet_config_params());
    ok(env.queue_config(second, true));
    assert_fumpad_err(env.execute_config(second), FumpadError::TimelockNotElapsed);
}

/// Bootstrap configs are validated exactly like `execute_config` add: non-FUMPAD configs, non-DBC accounts,
/// duplicates and more than 8 are rejected (the whole init fails).
#[test]
fn bootstrap_rejects_invalid_configs() {
    let mut env = Env::uninit();
    let good = env.create_dbc_config(&meteora::mainnet_config_params());
    let mut p = meteora::mainnet_config_params();
    p.creator_trading_fee_percentage = 10;
    let bad = env.create_dbc_config(&p);
    let none = [Pubkey::default(); 3];
    let i = env.initialize_global_ix(Params::default(), none, &[good, bad]);
    assert_fumpad_err(env.send(&[i], &[]), FumpadError::InvalidConfig);
    // fee claimer not ours
    let k = Keypair::new();
    let i = meteora::create_config_ix(&kp_pk(&k), &Pubkey::new_unique(), &env.reward_pool(), &kp_pk(&env.payer), &meteora::mainnet_config_params());
    ok(env.send(&[i], &[&k]));
    let i = env.initialize_global_ix(Params::default(), none, &[kp_pk(&k)]);
    assert_fumpad_err(env.send(&[i], &[]), FumpadError::InvalidConfig);
    // not a DBC account
    let i = env.initialize_global_ix(Params::default(), none, &[kp_pk(&env.admin)]);
    assert!(env.send(&[i], &[]).is_err());
    // duplicate
    let i = env.initialize_global_ix(Params::default(), none, &[good, good]);
    assert_fumpad_err(env.send(&[i], &[]), FumpadError::InvalidParams);
    // more than 8
    let nine: Vec<Pubkey> = (0..9).map(|_| good).collect();
    let i = env.initialize_global_ix(Params::default(), none, &nine);
    assert_fumpad_err(env.send(&[i], &[]), FumpadError::ConfigListFull);
    // A config that isn't bootstrapped can't register a coin.
    let i = env.initialize_global_ix(Params::default(), none, &[good]);
    ok(env.send(&[i], &[]));
    let g: Global = env.fetch(&env.global());
    assert_eq!(&g.configs[..2], &[good, Pubkey::default()]);
    let other = env.create_dbc_config(&meteora::mainnet_config_params());
    let creator = env.new_user(10);
    let mint = Keypair::new();
    let ixs = env.launch_ixs(&other, &kp_pk(&creator), &kp_pk(&mint), 0);
    assert_fumpad_err(env.send_as(&creator, &ixs, &[&creator, &mint]), FumpadError::ConfigNotAllowed);
}

#[test]
fn params_timelock_bounds_and_cancel() {
    let mut env = Env::new();
    let mut p = Params::default();
    p.ticket_challenge_secs = 12 * 3_600;
    ok(env.queue_params(p));
    assert_fumpad_err(env.execute_params(), FumpadError::TimelockNotElapsed);
    env.warp(fumpad::PARAMS_TIMELOCK_SECS);
    let meta = ok(env.execute_params());
    assert_eq!(event::<ParamsUpdated>(&meta).params, p);
    assert_eq!(env.fetch::<Global>(&env.global()).params, p);
    assert_fumpad_err(env.execute_params(), FumpadError::NoPendingParams);
    // Guardian / admin cancel.
    ok(env.queue_params(Params::default()));
    let admin = env.admin.insecure_clone();
    let g = env.global();
    ok(env.send(&[guardian_ix(&kp_pk(&admin), g, fumpad::instruction::CancelParams {})], &[&admin]));
    assert_fumpad_err(env.execute_params(), FumpadError::NoPendingParams);
}

/// v0.6 L-2 / D23 (+ v0.7 attestation params): degenerate values never get queued.
#[test]
fn regression_params_is_valid_rejects_degenerate_values() {
    let mut env = Env::new();
    let bad: Vec<fn(&mut Params)> = vec![
        |p| p.fee_buyback_share_bps = 9_000,
        |p| p.trigger_multiple_bps = 10_001,
        |p| p.claim_bps = 10_000,
        |p| p.max_claim_pool_bps = 10_000,
        |p| p.min_sell_usd_cents = 1,
        |p| p.min_hold_secs = 1,
        |p| p.rebuy_window_secs = 0,
        |p| p.claim_window_secs = 1,
        |p| p.max_open_tickets = 0,
        |p| p.oracle_window_secs = 60,
        |p| p.oracle_min_samples = 1,
        |p| p.keeper_stale_secs = 5,
        |p| p.buyback_max_deviation_bps = 0,
        |p| p.buyback_max_pool_bps = 1_000,
        |p| p.sol_usd_feed_id = [7; 32],
        |p| p.max_price_age_secs = 0,
        |p| p.max_attest_age_secs = 10,
        |p| p.max_attest_tokens_per_hour_bps = 0,
        |p| p.ticket_challenge_secs = 0,
        |p| p.attest_threshold = 1,
    ];
    for (i, f) in bad.into_iter().enumerate() {
        let mut p = Params::default();
        f(&mut p);
        let r = env.queue_params(p);
        assert_eq!(err_code(&r), Some(fumpad_err(FumpadError::InvalidParams)), "case {i}");
    }
}

/// v0.6 M-2: a stolen admin key can't change params, configs or rotate authorities before the guardian cancels.
#[test]
fn regression_stolen_admin_key_cannot_outrun_the_guardian() {
    let mut env = Env::new();
    let guardian = with_guardian(&mut env);
    let (admin, g) = (env.admin.insecure_clone(), env.global());
    let thief = env.new_user(10);
    // Thief (holding the admin key) proposes itself + queues params + a config change.
    let i = admin_ix(&kp_pk(&admin), g, fumpad::instruction::ProposeAdmin { new_admin: kp_pk(&thief), platform_treasury: kp_pk(&thief), guardian: kp_pk(&thief) });
    ok(env.send(&[i], &[&admin]));
    let mut p = Params::default();
    p.claim_bps = 2_500;
    ok(env.queue_params(p));
    let evil_cfg = env.create_dbc_config(&meteora::mainnet_config_params());
    ok(env.queue_config(evil_cfg, true));
    // Accept before 6 h fails; the guardian cancels all three.
    let i = ix(fumpad::accounts::AcceptAdmin { new_admin: kp_pk(&thief), global: g, event_authority: ev_auth(), program: fumpad::ID }, fumpad::instruction::AcceptAdmin {});
    assert_fumpad_err(env.send(&[i.clone()], &[&thief]), FumpadError::TimelockNotElapsed);
    for d in [
        guardian_ix(&kp_pk(&guardian), g, fumpad::instruction::CancelAdmin {}),
        guardian_ix(&kp_pk(&guardian), g, fumpad::instruction::CancelParams {}),
        guardian_ix(&kp_pk(&guardian), g, fumpad::instruction::CancelConfig {}),
    ] {
        ok(env.send(&[d], &[&guardian]));
    }
    env.warp(fumpad::ADMIN_TIMELOCK_SECS);
    assert_fumpad_err(env.send(&[i], &[&thief]), FumpadError::NoPendingAdmin);
    assert_fumpad_err(env.execute_params(), FumpadError::NoPendingParams);
    assert!(env.execute_config(evil_cfg).is_err());
    // The guardian can't queue or propose.
    let i = admin_ix(&kp_pk(&guardian), g, fumpad::instruction::QueueParams { params: Params::default() });
    assert_fumpad_err(env.send(&[i], &[&guardian]), FumpadError::Unauthorized);
    // Proposals need non-zero keys.
    let i = admin_ix(&kp_pk(&admin), g, fumpad::instruction::ProposeAdmin { new_admin: Pubkey::default(), platform_treasury: kp_pk(&thief), guardian: kp_pk(&thief) });
    assert_fumpad_err(env.send(&[i], &[&admin]), FumpadError::InvalidParams);
}

/// v0.6 M-3 / L-5 (+ v0.7 PAUSE_ATTEST): pauses are immediate, bounded to PAUSE_ALL, lapse after 7 days; router
/// sells are never paused; PAUSE_GRADUATE stops only fumpad's bookkeeping, never Meteora's own migration.
#[test]
fn regression_pause_semantics_and_expiry() {
    let mut env = Env::new();
    let guardian = with_guardian(&mut env);
    assert_fumpad_err(env.set_pause(&guardian, PAUSE_ALL << 1), FumpadError::InvalidParams);
    let meta = ok(env.set_pause(&guardian, PAUSE_ALL));
    let ev: PauseSet = event(&meta);
    assert_eq!((ev.paused, ev.expires_at, ev.authority), (PAUSE_ALL, env.now() + fumpad::MAX_PAUSE_SECS, kp_pk(&guardian)));
    let rando = env.new_user(1);
    assert_fumpad_err(env.set_pause(&rando, 0), FumpadError::Unauthorized);
    ok(env.set_pause(&guardian, 0));
    // A coin completing while graduation is paused: Meteora's migration still runs; ours waits.
    let c = env.launch(SOL / 10);
    env.skip_launch_window();
    let holder = env.new_user(100);
    ok(env.router_buy(&c, &holder, 5 * SOL));
    env.complete_curve(&c);
    ok(env.set_pause(&guardian, PAUSE_GRADUATE));
    let k = env.keepers[0].insecure_clone();
    let (r, _) = env.migrate(&c, &k);
    assert_fumpad_err(r, FumpadError::Paused);
    let nft = Keypair::new();
    let mig = meteora::dbc_migration_ix(&c.config, &c.mint, &kp_pk(&nft), &kp_pk(&k));
    ok(env.send_as(&k, &[compute_budget_ix(1_000_000), mig], &[&k, &nft]));
    assert_fumpad_err(env.graduate(&c, &k, &kp_pk(&nft)), FumpadError::Paused);
    // Lapses after 7 days.
    env.warp(fumpad::MAX_PAUSE_SECS);
    ok(env.graduate(&c, &k, &kp_pk(&nft)));
    // Holders can always sell on DAMM v2 (router or direct), whatever fumpad's flags.
    ok(env.set_pause(&guardian, PAUSE_ALL));
    let b = env.base_balance(&kp_pk(&holder), &c.mint);
    ok(env.router_sell(&c, &holder, b / 2));
    ok(env.direct_sell(&c, &holder, b / 4));
}

/// v0.6 M-1: a params change never re-prices live coins (reward terms + fee split snapshotted per coin).
#[test]
fn regression_params_changes_cannot_reprice_live_coins() {
    let mut env = Env::new();
    let c = env.launch(SOL / 10);
    env.skip_launch_window();
    let mut p = Params::default();
    p.claim_bps = 2_500;
    p.trigger_multiple_bps = 50_000;
    p.fee_buyback_share_bps = 3_000;
    p.fee_platform_share_bps = 5_000;
    env.set_params_timelocked(p);
    let coin = env.coin(&c);
    assert_eq!(coin.rewards, Params::default().reward_terms());
    assert_eq!(coin.fee_split, Params::default().fee_split());
    // Fees of the old coin still split 50/30/20; a new coin snapshots the new terms.
    ok(env.claim_fees(&c));
    let alice = env.new_user(100);
    ok(env.router_buy(&c, &alice, 10 * SOL));
    let meta = ok(env.claim_fees(&c));
    let ev: FeesClaimed = event(&meta);
    assert_eq!(ev.to_platform, ev.claimed * 3_000 / 10_000);
    let c2 = env.launch(0);
    assert_eq!(env.coin(&c2).fee_split, p.fee_split());
    assert_eq!(env.coin(&c2).rewards.claim_bps, 2_500);
}

/// v0.6 L-3: every governance change emits an event the indexer can follow.
#[test]
fn regression_admin_changes_emit_events() {
    let mut env = Env::new();
    let (admin, g) = (env.admin.insecure_clone(), env.global());
    let meta = ok(env.set_keepers([kp_pk(&env.keepers[0]), Pubkey::default(), Pubkey::default()]));
    assert_eq!(event::<KeepersSet>(&meta).keepers[0], kp_pk(&env.keepers[0]));
    let meta = ok(env.queue_params(Params::default()));
    assert_eq!(event::<ParamsQueued>(&meta).eta, env.now() + fumpad::PARAMS_TIMELOCK_SECS);
    let meta = ok(env.send(&[guardian_ix(&kp_pk(&admin), g, fumpad::instruction::CancelParams {})], &[&admin]));
    assert_eq!(event::<ParamsCancelled>(&meta).authority, kp_pk(&admin));
    let cfg = env.create_dbc_config(&meteora::devnet_config_params());
    let meta = ok(env.queue_config(cfg, true));
    assert_eq!(event::<ConfigQueued>(&meta).config, cfg);
    env.warp(fumpad::CONFIG_TIMELOCK_SECS);
    let meta = ok(env.execute_config(cfg));
    assert!(event::<ConfigUpdated>(&meta).add);
    let i = admin_ix(&kp_pk(&admin), g, fumpad::instruction::ProposeAdmin { new_admin: kp_pk(&admin), platform_treasury: kp_pk(&admin), guardian: kp_pk(&admin) });
    let meta = ok(env.send(&[i], &[&admin]));
    assert_eq!(event::<AdminProposed>(&meta).platform_treasury, kp_pk(&admin));
    let meta = ok(env.send(&[guardian_ix(&kp_pk(&admin), g, fumpad::instruction::CancelAdmin {})], &[&admin]));
    assert_eq!(event::<AdminProposalCancelled>(&meta).authority, kp_pk(&admin));
}

#[test]
fn migrate_global_is_a_noop_on_the_current_layout() {
    let mut env = Env::new();
    let (admin, g) = (env.admin.insecure_clone(), env.global());
    let before = env.data(&g);
    let i = ix(
        fumpad::accounts::MigrateGlobal { admin: kp_pk(&admin), global: g, system_program: SYSTEM, event_authority: ev_auth(), program: fumpad::ID },
        fumpad::instruction::MigrateGlobal {},
    );
    let meta = ok(env.send(&[i.clone()], &[&admin]));
    let ev: GlobalMigrated = event(&meta);
    assert_eq!((ev.old_len, ev.new_len), (before.len() as u32, before.len() as u32));
    assert_eq!(env.data(&g), before);
    let rando = env.new_user(1);
    let mut bad = i;
    bad.accounts[0].pubkey = rando.pubkey();
    assert_fumpad_err(env.send(&[bad], &[&rando]), FumpadError::Unauthorized);
    // An unknown (longer) layout is refused.
    let mut acc = env.svm.get_account(&addr(&g)).unwrap();
    acc.data.extend_from_slice(&[0u8; 8]);
    env.svm.set_account(addr(&g), acc).unwrap();
    let i = ix(
        fumpad::accounts::MigrateGlobal { admin: kp_pk(&admin), global: g, system_program: SYSTEM, event_authority: ev_auth(), program: fumpad::ID },
        fumpad::instruction::MigrateGlobal {},
    );
    assert_fumpad_err(env.send(&[i], &[&admin]), FumpadError::UnsupportedGlobalLayout);
}

/// SPEC v0.7 §4: graduation rejects wrong pools/positions, refuses before migration, is idempotent per step, and
/// spends the migration fee + surplus exactly (refund → prefund → platform).
#[test]
fn graduation_adversarial_and_migration_fee_accounting() {
    let mut env = Env::new();
    let c = env.launch(SOL / 10);
    let other = env.launch(SOL / 10);
    env.skip_launch_window();
    env.complete_curve(&c);
    let k = env.keepers[0].insecure_clone();
    // Before migration.
    assert_fumpad_err(env.graduate(&c, &k, &Pubkey::new_unique()), FumpadError::NotMigrated);
    // migrate_pool with another coin's accounts / a different payer.
    let nft = Keypair::new();
    let mut i = env.migrate_pool_ix(&c, &kp_pk(&k), &kp_pk(&nft));
    let o = meteora::migration_accounts(&other.config, &other.mint, &kp_pk(&nft), &kp_pk(&k));
    i.accounts[6].pubkey = addr(&o[0].pubkey);
    assert_fumpad_err(env.send_as(&k, &[compute_budget_ix(1_000_000), i], &[&k, &nft]), FumpadError::WrongVenue);
    // A stranger migrates directly on DBC (Meteora's keeper path) and withdraws the leftover itself.
    let stranger = env.new_user(10);
    let nft = Keypair::new();
    let mig = meteora::dbc_migration_ix(&c.config, &c.mint, &kp_pk(&nft), &kp_pk(&stranger));
    ok(env.send_as(&stranger, &[compute_budget_ix(1_000_000), mig], &[&stranger, &nft]));
    let wl = meteora::dbc_withdraw_leftover_ix(&c.config, &c.mint, &env.reward_pool());
    ok(env.send_as(&stranger, &[wl], &[&stranger]));
    crate::lifecycle_tests::assert_reward_pool_8pct(env.token_balance(&env.reward_vault(&c.mint)));
    // Wrong position (another NFT) / wrong DAMM pool.
    let mut i = env.graduate_ix(&c, &kp_pk(&k), &kp_pk(&nft), &kp_pk(&k));
    i.accounts[9].pubkey = addr(&other.damm_pool());
    assert_fumpad_err(env.send_as(&k, &[i], &[&k]), FumpadError::InvalidMigratedPool);
    let fake_nft = Pubkey::new_unique();
    let i = env.graduate_ix(&c, &kp_pk(&k), &fake_nft, &kp_pk(&k));
    assert!(env.send_as(&k, &[i], &[&k]).is_err());
    // Graduate: leftover already withdrawn by the stranger (skipped), migration fee + surplus claimed and spent.
    let caller_before = env.lamports(&kp_pk(&k));
    let meta = ok(env.graduate(&c, &k, &kp_pk(&nft)));
    let ev: Graduated = event(&meta);
    // Someone else withdrew it; still recorded (REVIEW-v0.7 I-1).
    crate::lifecycle_tests::assert_reward_pool_8pct(ev.leftover_tokens);
    assert_eq!(ev.migrator_refund, 0, "no migrate_pool record");
    assert_eq!(ev.migration_fee, meteora::MAINNET_THRESHOLD / 100);
    assert_eq!(ev.migrator_refund + ev.caller_refund + ev.setup_prefunded + ev.platform_fee, ev.migration_fee + ev.surplus);
    assert_eq!(ev.setup_prefunded, env.rent(fumpad::instructions::OBSERVATIONS_SPACE) + env.rent(fumpad::instructions::CLAIM_QUEUE_SPACE));
    assert_eq!(env.coin(&c).platform_fees_unclaimed, ev.platform_fee);
    assert!(caller_before - env.lamports(&kp_pk(&k)) <= meta.fee + 1, "graduate costs the caller only its tx fee");
    env.assert_coin_invariant(&c);
    // Twice → WrongCoinStatus.
    assert_fumpad_err(env.graduate(&c, &k, &kp_pk(&nft)), FumpadError::WrongCoinStatus);
}

/// v0.6 V-M1/V-L1/V-L2: fallback samplers can't lock the keeper out nor set the median; coverage needs spread.
#[test]
fn regression_fallback_samples_never_decide_the_median() {
    let mut env = Env::new();
    let c = env.launch(SOL / 10);
    env.skip_launch_window();
    env.graduate_coin(&c);
    let rando = env.new_user(10);
    env.warp(fumpad::DEFAULT_KEEPER_STALE_SECS + 1);
    // A fallback sampler fills 30 min of samples: the keeper can still sample next to them, and the median
    // (claims / buybacks) ignores them all.
    for _ in 0..121 {
        let i = env.record_samples_ix(&kp_pk(&rando), &[&c]);
        ok(env.send_as(&rando, &[i], &[&rando]));
        env.warp(15);
    }
    ok(env.sample(0, &[&c]));
    let obs: fumpad::state::Observations = env.fetch_zc(&c.observations());
    assert!(obs.median_price_q64(env.now(), 1_800, 84).is_none());
    // 84 keeper samples bunched in 14 minutes don't make a 30-minute median.
    for _ in 0..84 {
        env.warp(10);
        ok(env.sample(1, &[&c]));
    }
    let obs: fumpad::state::Observations = env.fetch_zc(&c.observations());
    assert!(obs.median_price_q64(env.now(), 1_800, 84).is_none());
}

/// SPEC v0.7 C-TL (2026-10-14): the timelock values themselves — 1 h for routine changes (params, DBC-config
/// allow-list), 6 h for authority changes (admin / platform_treasury / guardian).
#[test]
fn timelock_values_are_1h_routine_6h_authority() {
    assert_eq!(fumpad::PARAMS_TIMELOCK_SECS, 3_600);
    assert_eq!(fumpad::CONFIG_TIMELOCK_SECS, 3_600);
    assert_eq!(fumpad::ADMIN_TIMELOCK_SECS, 6 * 3_600);
    // Unchanged by C-TL.
    assert_eq!(fumpad::KEEPER_ATTEST_FREEZE_SECS, 6 * 3_600);
    assert_eq!(fumpad::MAX_PAUSE_SECS, 7 * 86_400);
}

/// C-TL: `execute_params` fails at 1 h − 1 s and succeeds at exactly 1 h; the eta in the event is now + 1 h.
#[test]
fn params_timelock_boundary_1h() {
    let mut env = Env::new();
    let mut p = Params::default();
    p.ticket_challenge_secs = 12 * 3_600;
    let meta = ok(env.queue_params(p));
    let eta = env.now() + 3_600;
    assert_eq!(event::<ParamsQueued>(&meta).eta, eta);
    assert_eq!(env.fetch::<Global>(&env.global()).pending_eta, eta);
    env.warp(3_600 - 1);
    assert_fumpad_err(env.execute_params(), FumpadError::TimelockNotElapsed);
    env.warp(1);
    assert_eq!(env.now(), eta);
    ok(env.execute_params());
    assert_eq!(env.fetch::<Global>(&env.global()).params, p);
}

/// C-TL: `execute_config` (add and remove) fails at 1 h − 1 s and succeeds at exactly 1 h.
#[test]
fn config_timelock_boundary_1h() {
    let mut env = Env::new();
    let g = env.global();
    let other = env.create_dbc_config(&meteora::devnet_config_params());
    for add in [true, false] {
        let meta = ok(env.queue_config(other, add));
        let eta = env.now() + 3_600;
        assert_eq!(event::<ConfigQueued>(&meta).eta, eta);
        env.warp(3_600 - 1);
        assert_fumpad_err(env.execute_config(other), FumpadError::TimelockNotElapsed);
        env.warp(1);
        ok(env.execute_config(other));
        assert_eq!(env.fetch::<Global>(&g).is_allowed_config(&other), add);
    }
}

/// C-TL: `accept_admin` (admin + platform_treasury + guardian) fails at 6 h − 1 s and succeeds at exactly 6 h.
#[test]
fn admin_timelock_boundary_6h() {
    let mut env = Env::new();
    let (admin, g) = (env.admin.insecure_clone(), env.global());
    let (new_admin, treasury, guardian) = (env.new_user(10), env.new_user(1), env.new_user(1));
    let i = admin_ix(
        &kp_pk(&admin),
        g,
        fumpad::instruction::ProposeAdmin { new_admin: kp_pk(&new_admin), platform_treasury: kp_pk(&treasury), guardian: kp_pk(&guardian) },
    );
    let meta = ok(env.send(&[i], &[&admin]));
    let eta = env.now() + 6 * 3_600;
    assert_eq!(event::<AdminProposed>(&meta).eta, eta);
    assert_eq!(env.fetch::<Global>(&g).pending_admin_eta, eta);
    let accept = ix(
        fumpad::accounts::AcceptAdmin { new_admin: kp_pk(&new_admin), global: g, event_authority: ev_auth(), program: fumpad::ID },
        fumpad::instruction::AcceptAdmin {},
    );
    env.warp(6 * 3_600 - 1);
    assert_fumpad_err(env.send_as(&new_admin, &[accept.clone()], &[&new_admin]), FumpadError::TimelockNotElapsed);
    env.warp(1);
    assert_eq!(env.now(), eta);
    ok(env.send_as(&new_admin, &[accept], &[&new_admin]));
    let gl: Global = env.fetch(&g);
    assert_eq!((gl.admin, gl.platform_treasury, gl.guardian), (kp_pk(&new_admin), kp_pk(&treasury), kp_pk(&guardian)));
}

/// C-TL: the guardian can still cancel each pending change inside its (shorter) window — at 1 h − 1 s for params
/// and configs, at 6 h − 1 s for the admin proposal — and nothing executes afterwards.
#[test]
fn guardian_cancels_within_the_short_windows() {
    let mut env = Env::new();
    let guardian = with_guardian(&mut env);
    let (admin, g) = (env.admin.insecure_clone(), env.global());
    let thief = env.new_user(10);
    // Params + config: cancelled 1 s before the 1 h eta.
    let mut p = Params::default();
    p.claim_bps = 2_500;
    ok(env.queue_params(p));
    let cfg = env.create_dbc_config(&meteora::mainnet_config_params());
    ok(env.queue_config(cfg, true));
    env.warp(3_600 - 1);
    ok(env.send(&[guardian_ix(&kp_pk(&guardian), g, fumpad::instruction::CancelParams {})], &[&guardian]));
    ok(env.send(&[guardian_ix(&kp_pk(&guardian), g, fumpad::instruction::CancelConfig {})], &[&guardian]));
    env.warp(1);
    assert_fumpad_err(env.execute_params(), FumpadError::NoPendingParams);
    assert!(env.execute_config(cfg).is_err());
    // Admin proposal: cancelled 1 s before the 6 h eta.
    let i = admin_ix(&kp_pk(&admin), g, fumpad::instruction::ProposeAdmin { new_admin: kp_pk(&thief), platform_treasury: kp_pk(&thief), guardian: kp_pk(&thief) });
    ok(env.send(&[i], &[&admin]));
    env.warp(6 * 3_600 - 1);
    ok(env.send(&[guardian_ix(&kp_pk(&guardian), g, fumpad::instruction::CancelAdmin {})], &[&guardian]));
    env.warp(1);
    let accept = ix(fumpad::accounts::AcceptAdmin { new_admin: kp_pk(&thief), global: g, event_authority: ev_auth(), program: fumpad::ID }, fumpad::instruction::AcceptAdmin {});
    assert_fumpad_err(env.send_as(&thief, &[accept], &[&thief]), FumpadError::NoPendingAdmin);
    let gl: Global = env.fetch(&g);
    assert_eq!((gl.admin, gl.guardian), (kp_pk(&admin), kp_pk(&guardian)));
    assert_eq!(gl.params, Params::default());
    assert!(!gl.is_allowed_config(&cfg));
}
