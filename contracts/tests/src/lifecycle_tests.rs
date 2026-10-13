//! Launch → curve (router + third-party) → completion (PartialFill) → migration → graduation → 8% exact.

use crate::flow::*;
use crate::meteora::{self, WSOL};
use crate::*;
use fumpad::error::FumpadError;
use fumpad::external::meteora as m;
use fumpad::state::CoinStatus;

#[test]
fn launch_registers_coin_with_snapshot() {
    let mut env = Env::new();
    let c = env.launch(SOL / 10);
    let coin = env.coin(&c);
    assert_eq!(coin.status, CoinStatus::Curve);
    assert_eq!(coin.mint, c.mint);
    assert_eq!(coin.creator, kp_pk(&c.creator));
    assert_eq!(coin.dbc_pool, c.pool);
    assert_eq!(coin.dbc_config, env.config);
    assert_eq!(coin.launch_window_slots, 8);
    assert_eq!(coin.total_supply, meteora::TOTAL_SUPPLY);
    assert_eq!(coin.rewards, fumpad::state::Params::default().reward_terms());
    assert!(!coin.launch_fees_settled);
    // The creator's top-level first buy got DBC's min fee (1.25%), not the 99% scheduler.
    let d = env.dbc_pool_data(&c);
    let quote = meteora::rd_u64(&d, m::DBC_POOL_QUOTE_RESERVE);
    assert!(quote > SOL / 10 * 98 / 100, "creator buy at min fee: reserve {quote}");
    // Reward vault exists (empty) and is owned by the reward_pool PDA.
    assert!(env.exists(&env.reward_vault(&c.mint)));
    assert_eq!(env.token_balance(&env.reward_vault(&c.mint)), 0);
    env.assert_coin_invariant(&c);
}

#[test]
fn launch_tx_fits_and_sniper_in_same_slot_pays_99_percent() {
    let mut env = Env::new();
    let creator = env.new_user(10);
    let mint = solana_keypair::Keypair::new();
    env.fund_wsol(&creator, SOL / 10);
    let ixs = env.launch_ixs(&env.config.clone(), &kp_pk(&creator), &kp_pk(&mint), SOL / 10);
    let size = env.tx_size(&creator, &ixs, &[&creator, &mint]);
    assert!(size <= 1232, "launch tx {size} bytes");
    ok(env.send_as(&creator, &ixs, &[&creator, &mint]));
    let c = TCoin { mint: kp_pk(&mint), creator, config: env.config, pool: meteora::dbc_pool_pda(&env.config, &kp_pk(&mint)) };
    // A sniper in the launch slot pays the 99% scheduler fee (direct DBC swap).
    let sniper = env.new_user(10);
    let q0 = env.dbc_quote_reserve(&c);
    ok(env.direct_buy(&c, &sniper, SOL));
    let q1 = env.dbc_quote_reserve(&c);
    assert!(q1 - q0 < SOL / 50, "sniper reached the curve with only {} lamports", q1 - q0);
    println!("launch tx {size} bytes");
}

#[test]
fn register_coin_rejections() {
    let mut env = Env::new();
    // Pool on a config that is not allow-listed.
    let other = env.create_dbc_config(&meteora::mainnet_config_params());
    let creator = env.new_user(10);
    let mint = solana_keypair::Keypair::new();
    let ixs = env.launch_ixs(&other, &kp_pk(&creator), &kp_pk(&mint), 0);
    assert_fumpad_err(env.send_as(&creator, &ixs, &[&creator, &mint]), FumpadError::ConfigNotAllowed);
    // Someone else than the pool creator registering.
    let creator = env.new_user(10);
    let mint = solana_keypair::Keypair::new();
    let cfg = env.config;
    let init = meteora::init_pool_ix(&cfg, &kp_pk(&creator), &kp_pk(&mint), &kp_pk(&creator), "X", "X", "x");
    ok(env.send_as(&creator, &[init], &[&creator, &mint]));
    let pool = meteora::dbc_pool_pda(&cfg, &kp_pk(&mint));
    let rando = env.new_user(10);
    let reg = env.register_coin_ix(&cfg, &pool, &kp_pk(&rando), &kp_pk(&mint));
    assert_fumpad_err(env.send_as(&rando, &[reg], &[&rando]), FumpadError::Unauthorized);
    // Launch pause.
    let admin = env.admin.insecure_clone();
    ok(env.set_pause(&admin, fumpad::state::PAUSE_LAUNCH));
    let reg = env.register_coin_ix(&cfg, &pool, &kp_pk(&creator), &kp_pk(&mint));
    assert_fumpad_err(env.send_as(&creator, &[reg.clone()], &[&creator]), FumpadError::Paused);
    ok(env.set_pause(&admin, 0));
    ok(env.send_as(&creator, &[reg.clone()], &[&creator]));
    // Twice → the Coin PDA already exists.
    assert!(env.send_as(&creator, &[reg], &[&creator]).is_err());
}

#[test]
fn full_lifecycle_to_graduation_with_exact_reward_pool() {
    let mut env = Env::new();
    let c = env.launch(SOL / 10);
    env.skip_launch_window();
    // Router + third-party trades on the curve.
    let alice = env.new_user(100);
    let bob = env.new_user(100);
    ok(env.router_buy(&c, &alice, 5 * SOL));
    ok(env.direct_buy(&c, &bob, 3 * SOL));
    let a_tokens = env.base_balance(&kp_pk(&alice), &c.mint);
    ok(env.router_sell(&c, &alice, a_tokens / 2));
    ok(env.direct_sell(&c, &bob, env.base_balance(&kp_pk(&bob), &c.mint) / 3));
    env.assert_coin_invariant(&c);

    // Completion via router PartialFill: an ExactIn overshoot reverts on DBC, PartialFill takes what fits.
    let whale = env.new_user(200);
    let r = env.router_buy_mode(&c, &whale, 100 * SOL, m::SWAP_MODE_EXACT_IN);
    assert!(r.is_err(), "ExactIn overshoot must revert on DBC");
    ok(env.router_buy_mode(&c, &whale, 100 * SOL, m::SWAP_MODE_PARTIAL_FILL));
    let coin = env.coin(&c);
    assert_eq!(coin.status, CoinStatus::Complete);
    let d = env.dbc_pool_data(&c);
    assert!(meteora::rd_u64(&d, m::DBC_POOL_QUOTE_RESERVE) >= meteora::MAINNET_THRESHOLD);
    // Router trades now refused (curve done; DBC also refuses).
    assert_fumpad_err(env.router_buy(&c, &alice, SOL), FumpadError::WrongCoinStatus);

    // Migration through the wrapper (caller pays DBC's flash rent, recorded for a refund) → graduate.
    let k = env.keepers[1].insecure_clone();
    let k_before = env.lamports(&kp_pk(&k));
    let (r, nft) = env.migrate(&c, &k);
    let meta = ok(r);
    println!("migrate_pool CU {}", meta.compute_units_consumed);
    let coin = env.coin(&c);
    assert_eq!(coin.migrator, kp_pk(&k));
    assert!(coin.migrator_cost > 0, "flash rent");
    let vault = env.reward_vault(&c.mint);
    let meta = ok(env.graduate(&c, &k, &nft));
    println!("graduate CU {}", meta.compute_units_consumed);
    let coin = env.coin(&c);
    assert_eq!(coin.status, CoinStatus::Graduated);
    assert_eq!(coin.damm_pool, c.damm_pool());
    // D35: 8% of supply in the reward vault (DBC leftover), measured. Exact on a single-swap completion
    // (`config_tests`); every extra swap rounds its output down in the pool's favour, so a real trading path can
    // only add a few base units of dust (10⁻⁶ token each) — never less than 80M.
    assert_reward_pool_8pct(coin.leftover_tokens);
    assert_eq!(env.token_balance(&vault), coin.leftover_tokens);
    // D36: LP NFT owned by fee_claimer, 100% permanently locked.
    let nft_acc = env.data(&meteora::damm_position_nft_account(&nft));
    assert_eq!(meteora::rd_pk(&nft_acc, 32), env.fee_claimer());
    let pos = env.data(&meteora::damm_position(&nft));
    let pool = env.data(&c.damm_pool());
    assert_eq!(meteora::rd_u128(&pos, m::DAMM_POSITION_PERMANENT_LOCKED), meteora::rd_u128(&pool, m::DAMM_POOL_LIQUIDITY));
    assert_eq!(meteora::rd_u128(&pos, m::DAMM_POSITION_UNLOCKED), 0);
    // D34: migration fee (1% of the raise) → migrator refund → setup prefund → platform.
    assert_eq!(coin.migration_fee_lamports >= meteora::MAINNET_THRESHOLD / 100, true);
    let k_after = env.lamports(&kp_pk(&k));
    assert!(k_after + 20_000 >= k_before, "migrator refunded (net {} lamports)", k_before as i64 - k_after as i64);
    assert_eq!(env.lamports(&c.observations()), env.rent(fumpad::instructions::OBSERVATIONS_SPACE));
    assert_eq!(env.lamports(&c.claim_queue()), env.rent(fumpad::instructions::CLAIM_QUEUE_SPACE));
    env.assert_coin_invariant(&c);
    // Setup costs the keeper only fees.
    let k2 = env.keepers[2].insecure_clone();
    let before = env.lamports(&kp_pk(&k2));
    env.post_grad_setup(&c, &k2);
    assert!(before - env.lamports(&kp_pk(&k2)) < 100_000);
    // Graduated: router uses DAMM v2, third parties too.
    ok(env.router_buy(&c, &alice, SOL));
    ok(env.direct_buy(&c, &bob, SOL));
    ok(env.router_sell(&c, &alice, env.base_balance(&kp_pk(&alice), &c.mint) / 2));
    assert_eq!(env.token_balance(&env.reward_vault(&c.mint)), coin.leftover_tokens);
    let _ = WSOL;
}

/// The devnet config (0.85 SOL raise) graduates with the same exact 8% reward pool.
#[test]
fn devnet_config_graduates_with_exact_reward_pool() {
    let mut env = Env::bare(fumpad::state::Params::default());
    let cfg = env.create_dbc_config(&meteora::devnet_config_params());
    env.allow_config(cfg);
    env.config = cfg;
    let c = env.launch(SOL / 100);
    env.skip_launch_window();
    let whale = env.new_user(10);
    ok(env.router_buy_mode(&c, &whale, 2 * SOL, m::SWAP_MODE_PARTIAL_FILL));
    let k = env.keepers[0].insecure_clone();
    let (r, nft) = env.migrate(&c, &k);
    ok(r);
    ok(env.graduate(&c, &k, &nft));
    assert_reward_pool_8pct(env.token_balance(&env.reward_vault(&c.mint)));
    let coin = env.coin(&c);
    // Devnet fee (1% of 0.85 SOL) is smaller than the setup rent: funds steps in order, rest left to the keeper.
    assert!(coin.migration_fee_lamports >= meteora::DEVNET_THRESHOLD / 100);
    env.assert_coin_invariant(&c);
}

/// D35: ≥ 80,000,000 tokens and at most 0.001 token of swap-rounding dust above it.
#[track_caller]
pub fn assert_reward_pool_8pct(tokens: u64) {
    assert!(
        (meteora::REWARD_POOL_TOKENS..=meteora::REWARD_POOL_TOKENS + 1_000).contains(&tokens),
        "reward pool {tokens} base units"
    );
}
