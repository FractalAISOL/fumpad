//! DBC config derivation (D17 shape + D34 migration fee + D35 exact 8%) and the config allow-list.

use crate::meteora::{self, ConfigParameters};
use crate::*;
use fumpad::error::FumpadError;
use fumpad::external::meteora as m;

/// (swap_base_amount, migration_base_threshold, migration_sqrt_price) DBC computed for `params` (created for real
/// on the mainnet DBC binary).
fn dbc_amounts(env: &mut Env, params: &ConfigParameters) -> Option<(u64, u64, u128)> {
    let config = solana_keypair::Keypair::new();
    let i = meteora::create_config_ix(&kp_pk(&config), &env.fee_claimer(), &env.reward_pool(), &kp_pk(&env.payer), params);
    if let Err(e) = env.send(&[i], &[&config]) {
        if std::env::var("DBC_DEBUG").is_ok() {
            eprintln!("create_config failed: {:?}\n{}", e.err, e.meta.logs.join("\n"));
        }
        return None;
    }
    let d = env.data(&kp_pk(&config));
    Some((meteora::rd_u64(&d, 256), meteora::rd_u64(&d, 272), meteora::rd_u128(&d, 280)))
}

/// Launch a pool on `params` (raw DBC, no fumpad), complete it with a PartialFill buy, migrate it to DAMM v2 and
/// withdraw the leftover to ATA(reward_pool): the reward pool a coin on this config would receive.
pub(crate) fn leftover_after_migration(env: &mut Env, params: &ConfigParameters) -> u64 {
    let cfg = solana_keypair::Keypair::new();
    let i = meteora::create_config_ix(&kp_pk(&cfg), &env.fee_claimer(), &env.reward_pool(), &kp_pk(&env.payer), params);
    ok(env.send(&[i], &[&cfg]));
    let cfg = kp_pk(&cfg);
    let creator = env.new_user(10);
    let mint = solana_keypair::Keypair::new();
    let init = meteora::init_pool_ix(&cfg, &kp_pk(&creator), &kp_pk(&mint), &kp_pk(&creator), "D", "D", "d");
    ok(env.send_as(&creator, &[init], &[&creator, &mint]));
    let mint = kp_pk(&mint);
    env.advance_slots(20);
    let whale = env.new_user(300);
    let w = kp_pk(&whale);
    let need = params.migration_quote_threshold * 2;
    let mut ixs = meteora::wrap_sol_ixs(&w, need);
    ixs.push(meteora::create_ata_idempotent_ix(&w, &w, &mint, &TOKEN_2022));
    ixs.push(meteora::dbc_buy_ix(&cfg, &mint, &w, need, 0, m::SWAP_MODE_PARTIAL_FILL, false));
    ok(env.send_as(&whale, &ixs, &[&whale]));
    let nft = solana_keypair::Keypair::new();
    let mig = meteora::dbc_migration_ix(&cfg, &mint, &kp_pk(&nft), &w);
    ok(env.send_as(&whale, &[compute_budget_ix(1_000_000), mig], &[&whale, &nft]));
    let rp = env.reward_pool();
    let ata_ix = meteora::create_ata_idempotent_ix(&w, &rp, &mint, &TOKEN_2022);
    ok(env.send_as(&whale, &[ata_ix, meteora::dbc_withdraw_leftover_ix(&cfg, &mint, &rp)], &[&whale]));
    env.token_balance(&env.reward_vault(&mint))
}

/// Segment liquidity for which DBC computes swap_base + migration_base = `target` exactly (at `s0`), if any.
fn solve_liquidity(env: &mut Env, threshold: u64, s0: u128, c0: u128, lb: u128, l_guess: f64, target: u64) -> Option<u128> {
    let sum = |env: &mut Env, l: u128| -> Option<u64> {
        let p = meteora::fumpad_config_params(threshold, s0, c0, l, lb);
        dbc_amounts(env, &p).map(|(a, b, _)| a + b)
    };
    let (mut lo, mut hi) = ((l_guess * 0.995) as u128, (l_guess * 1.005) as u128);
    let (flo, fhi) = (sum(env, lo)?, sum(env, hi)?);
    assert!(flo < target && fhi > target, "bracket {flo} {fhi}");
    while hi - lo > 1 {
        let mid = lo + (hi - lo) / 2;
        match sum(env, mid)? {
            v if v == target => return Some(mid),
            v if v < target => lo = mid,
            _ => hi = mid,
        }
    }
    None
}

/// Derive a FUMPAD curve for `threshold` lamports raised: D17 shape (virtual 30 SOL → ×(115/30)² price), 1%
/// migration fee kept out of the LP, and a reward pool (DBC leftover after the real migration) of EXACTLY 80M
/// tokens. DBC's leftover = supply − swap_base − (migration_base − deposit dust), and the DAMM v2 deposit dust
/// depends on the exact amounts, so: solve swap + migration = 920M + d for small d and keep the first candidate
/// whose measured leftover (full launch → completion → migration → withdraw_leftover on the mainnet binaries) is
/// exactly 80M.
fn derive(env: &mut Env, threshold: u64) -> (u128, u128, u128, u128) {
    let q = threshold as f64;
    let f = 1.0 - meteora::MIGRATION_FEE_PERCENTAGE as f64 / 100.0;
    let n = meteora::TOTAL_SUPPLY - meteora::REWARD_POOL_TOKENS;
    let r = 115.0 / 30.0;
    let x = n as f64 / (q * (1.0 / r + f / (r * r))); // base units per lamport at the start
    let two64 = 18_446_744_073_709_551_616.0f64;
    let s0 = ((1.0 / x).sqrt() * two64) as u128;
    let sm = s0 as f64 * r;
    let c0 = (sm * 1.000_001) as u128;
    let l_guess = q * two64 * two64 / (sm - s0 as f64);
    let lb = (30_000_000_000_000f64 * c0 as f64) as u128; // ~30M tokens of buffer between c0 and MAX
    for ds in 0..16u128 {
        for d in 0..32u64 {
            let Some(l) = solve_liquidity(env, threshold, s0 + ds, c0, lb, l_guess, n + d) else { continue };
            let p = meteora::fumpad_config_params(threshold, s0 + ds, c0, l, lb);
            if leftover_after_migration(env, &p) == meteora::REWARD_POOL_TOKENS {
                return (s0 + ds, c0, l, lb);
            }
        }
    }
    panic!("no exact curve found");
}

/// Prints the curve constants for `tests/src/meteora.rs` (run with `--ignored --nocapture` after a DBC upgrade).
#[test]
#[ignore]
fn derive_exact_curves() {
    let mut env = Env::bare(fumpad::state::Params::default());
    for (name, t) in [("MAINNET", meteora::MAINNET_THRESHOLD), ("DEVNET", meteora::DEVNET_THRESHOLD)] {
        let (s0, c0, l, lb) = derive(&mut env, t);
        let p = meteora::fumpad_config_params(t, s0, c0, l, lb);
        let (swap, mig, sm) = dbc_amounts(&mut env, &p).unwrap();
        println!("pub const {name}_CURVE: (u128, u128, u128, u128) = ({s0}, {c0}, {l}, {lb});");
        println!("  // swap {swap} + migration {mig} = {} ; migration sqrt {sm}; ratio {}", swap + mig, (sm as f64 / s0 as f64).powi(2));
    }
}

#[test]
fn derived_configs_are_exact_and_d17_shaped() {
    let mut env = Env::bare(fumpad::state::Params::default());
    for (p, t) in [(meteora::mainnet_config_params(), 85 * SOL), (meteora::devnet_config_params(), 85 * SOL / 100)] {
        let (swap, mig, sm) = dbc_amounts(&mut env, &p).expect("create_config");
        // The reward pool after a real migration is exactly 8% (DBC leftover incl. the DAMM v2 deposit dust).
        assert_eq!(leftover_after_migration(&mut env, &p), meteora::REWARD_POOL_TOKENS);
        assert!(swap + mig >= meteora::TOTAL_SUPPLY - meteora::REWARD_POOL_TOKENS);
        let ratio = (sm as f64 / p.sqrt_start_price as f64).powi(2);
        assert!((ratio - (115.0f64 / 30.0).powi(2)).abs() < 0.01, "price ratio {ratio}");
        // Start market cap ≈ 30.39 SOL (SPEC v0.7 §2; mainnet) / 0.3039 SOL (devnet): supply × start price.
        let start_price = (p.sqrt_start_price as f64 / 18_446_744_073_709_551_616.0).powi(2);
        let mc_sol = start_price * meteora::TOTAL_SUPPLY as f64 / 1e9;
        let want = t as f64 / 1e9 * 30.39 / 85.0;
        assert!((mc_sol / want - 1.0).abs() < 0.01, "start MC {mc_sol} vs {want}");
        // Migration base = 99% of the raise at the migration price (LP opens at the curve's final price).
        let mig_price = (sm as f64 / 18_446_744_073_709_551_616.0).powi(2);
        let lp_quote = t as f64 * 0.99;
        assert!((mig as f64 * mig_price / lp_quote - 1.0).abs() < 1e-6);
    }
}

#[test]
fn config_allow_list_is_timelocked_and_validated() {
    let mut env = Env::new();
    let g = env.global();
    let other = env.create_dbc_config(&meteora::devnet_config_params());
    // Not yet allowed; queue → too early → 1 h → executes.
    ok(env.queue_config(other, true));
    assert_fumpad_err(env.execute_config(other), FumpadError::TimelockNotElapsed);
    env.warp(fumpad::CONFIG_TIMELOCK_SECS);
    ok(env.execute_config(other));
    let gl: fumpad::state::Global = env.fetch(&g);
    assert!(gl.is_allowed_config(&other) && gl.is_allowed_config(&env.config));
    // Adding twice is rejected; removing an unknown config is rejected.
    assert_fumpad_err(env.queue_config(other, true), FumpadError::InvalidParams);
    assert_fumpad_err(env.queue_config(Pubkey::new_unique(), false), FumpadError::ConfigNotAllowed);
    // Remove: timelocked too; the guardian can cancel a pending change.
    ok(env.queue_config(other, false));
    let admin = env.admin.insecure_clone();
    let cancel = ix(
        fumpad::accounts::GuardianOrAdmin { authority: kp_pk(&admin), global: g, event_authority: ev_auth(), program: fumpad::ID },
        fumpad::instruction::CancelConfig {},
    );
    ok(env.send(&[cancel], &[&admin]));
    assert_fumpad_err(env.execute_config(other), FumpadError::InvalidAccount); // pending cleared → address mismatch
    ok(env.queue_config(other, false));
    env.warp(fumpad::CONFIG_TIMELOCK_SECS);
    ok(env.execute_config(other));
    assert!(!env.fetch::<fumpad::state::Global>(&g).is_allowed_config(&other));
    // Non-admin can't queue.
    let rando = env.new_user(1);
    let i = ix(
        fumpad::accounts::QueueConfig { admin: kp_pk(&rando), global: g, dbc_config: other, event_authority: ev_auth(), program: fumpad::ID },
        fumpad::instruction::QueueConfig { config: other, add: true, policy: Default::default() },
    );
    assert_fumpad_err(env.send(&[i], &[&rando]), FumpadError::Unauthorized);
}

/// Every structural rule of INTERFACE §5.4 rejects a config that breaks it (created for real on DBC).
#[test]
fn queue_config_rejects_non_fumpad_configs() {
    let mut env = Env::new();
    let base = meteora::mainnet_config_params();
    let mut cases: Vec<(&str, ConfigParameters)> = vec![];
    let mut c = base.clone();
    c.creator_trading_fee_percentage = 10;
    cases.push(("creator trading fee", c));
    let mut c = base.clone();
    c.partner_permanent_locked_liquidity_percentage = 90;
    c.partner_liquidity_percentage = 10;
    cases.push(("partner liquidity unlocked", c));
    let mut c = base.clone();
    c.token_update_authority = 0;
    cases.push(("creator update authority", c));
    let mut c = base.clone();
    c.migrated_collect_fee_mode = 1;
    cases.push(("migrated fee both tokens", c));
    let mut c = base.clone();
    c.creator_migration_fee_percentage = 50;
    cases.push(("creator migration fee", c));
    let mut c = base.clone();
    c.token_type = 0;
    cases.push(("spl token", c));
    for (name, p) in cases {
        let cfg = env.create_dbc_config(&p);
        let r = env.queue_config(cfg, true);
        assert_eq!(err_code(&r), Some(fumpad_err(FumpadError::InvalidConfig)), "{name}");
    }
    // A config whose fee claimer is someone else.
    let k = solana_keypair::Keypair::new();
    let i = meteora::create_config_ix(&kp_pk(&k), &Pubkey::new_unique(), &env.reward_pool(), &kp_pk(&env.payer), &base);
    ok(env.send(&[i], &[&k]));
    assert_fumpad_err(env.queue_config(kp_pk(&k), true), FumpadError::InvalidConfig);
    // Not a DBC account at all.
    assert_fumpad_err(env.queue_config(env.global(), true), FumpadError::WrongVenue);
    // The account layout offsets fumpad reads match what DBC wrote.
    let d = env.data(&env.config.clone());
    assert_eq!(d.len(), m::DBC_CONFIG_LEN);
    assert_eq!(meteora::rd_pk(&d, m::CFG_FEE_CLAIMER), env.fee_claimer());
    assert_eq!(meteora::rd_pk(&d, m::CFG_LEFTOVER_RECEIVER), env.reward_pool());
    assert_eq!(meteora::rd_u64(&d, m::CFG_MIGRATION_QUOTE_THRESHOLD), meteora::MAINNET_THRESHOLD);
    assert_eq!(d[m::CFG_MIGRATION_FEE_PCT], 1);
    assert_eq!(meteora::rd_u64(&d, m::CFG_PRE_MIGRATION_SUPPLY), meteora::TOTAL_SUPPLY);
}

/// `tests/vectors/dbc_config.json`: the exact DBC `create_config` instruction data (mainnet + devnet) the admin
/// submits for the allow-listed FUMPAD configs, with the derived curve constants. Regenerate with
/// `UPDATE_VECTORS=1 cargo test -p tests dbc_config_vectors`.
#[test]
fn dbc_config_vectors_match_checked_in_file() {
    use anchor_lang::AnchorSerialize;
    let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
    let mut out = serde_json::Map::new();
    out.insert(
        "description".into(),
        "DBC 0.2.1 create_config instruction data (discriminator + borsh ConfigParameters) for the FUMPAD configs. Accounts: config (new keypair, signer), fee_claimer = fumpad PDA [\"fee_claimer\"], leftover_receiver = fumpad PDA [\"reward_pool\"], quote_mint = WSOL, payer, system_program, DBC event authority, DBC program. Then queue_config(config, true) -> 48h -> execute_config.".into(),
    );
    out.insert("fee_claimer".into(), Pubkey::find_program_address(&[fumpad::FEE_CLAIMER_SEED], &fumpad::ID).0.to_string().into());
    out.insert("leftover_receiver".into(), Pubkey::find_program_address(&[fumpad::REWARD_POOL_SEED], &fumpad::ID).0.to_string().into());
    for (name, p, curve) in [
        ("mainnet", meteora::mainnet_config_params(), meteora::MAINNET_CURVE),
        ("devnet", meteora::devnet_config_params(), meteora::DEVNET_CURVE),
        // First-coin launch config (2026-10-14): same curve, 99% → 3% over 25 slots, 3% migrated DAMM v2 fee.
        ("first_coin_mainnet", meteora::first_coin_mainnet_config_params(), meteora::MAINNET_CURVE),
        ("first_coin_devnet", meteora::first_coin_devnet_config_params(), meteora::DEVNET_CURVE),
    ] {
        let mut data = meteora::IX_CREATE_CONFIG.to_vec();
        p.serialize(&mut data).unwrap();
        out.insert(
            name.into(),
            serde_json::json!({
                "migration_quote_threshold": p.migration_quote_threshold.to_string(),
                "migration_fee_percentage": p.migration_fee_percentage,
                "sqrt_start_price": curve.0.to_string(),
                "curve": [
                    {"sqrt_price": curve.1.to_string(), "liquidity": curve.2.to_string()},
                    {"sqrt_price": meteora::MAX_SQRT_PRICE.to_string(), "liquidity": curve.3.to_string()},
                ],
                "fee_scheduler": {"cliff_fee_numerator": p.base_fee.cliff_fee_numerator, "number_of_period": p.base_fee.first_factor, "period_frequency_slots": p.base_fee.second_factor, "reduction_factor": p.base_fee.third_factor},
                "migrated_pool_fee_bps": p.migrated_pool_fee_bps,
                "create_config_data_hex": hex(&data),
            }),
        );
    }
    let text = serde_json::to_string_pretty(&serde_json::Value::Object(out)).unwrap() + "\n";
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("vectors/dbc_config.json");
    if std::env::var("UPDATE_VECTORS").is_ok() || !path.exists() {
        std::fs::write(&path, &text).unwrap();
    }
    assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
}
