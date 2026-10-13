//! Oracle samples (SPEC v0.7 §6) and buybacks (§3.4): pre-graduation keeper-only guard against the last keeper
//! sample, post-graduation median guard, slices, pinned account lists, sandwich resistance.

use crate::flow::*;
use crate::meteora::{self, WSOL};
use crate::*;
use fumpad::error::FumpadError;
use fumpad::events::{BuybackExecuted, SampleRecorded};
use fumpad::external::meteora as m;
use fumpad::state::{CoinStatus, Observations};
use solana_keypair::Keypair;

impl Env {
    pub fn buyback_ix(&self, c: &TCoin, cranker: &Pubkey, max_in: u64) -> solana_instruction::Instruction {
        let coin = self.coin(c);
        let bb = self.buyback_pda();
        let bb_wsol = wsol_ata(&bb);
        let vault = self.reward_vault(&c.mint);
        let (program, rem) = if coin.status == CoinStatus::Graduated {
            (meteora::DAMM, meteora::damm_swap_accounts(&coin.damm_pool, &c.mint, &bb, &bb_wsol, &vault))
        } else {
            (meteora::DBC, meteora::dbc_swap_accounts(&c.config, &c.mint, &bb, &bb_wsol, &vault, false))
        };
        // The buyback PDA signs via seeds, not as a transaction signer.
        let rem: Vec<_> = rem.into_iter().map(|mut a| { a.is_signer = false; a }).collect();
        ix_rem(
            fumpad::accounts::ExecuteBuyback {
                cranker: *cranker,
                global: self.global(),
                coin: c.coin_pda(),
                mint: c.mint,
                observations: c.observations(),
                buyback: bb,
                buyback_wsol: bb_wsol,
                reward_vault: vault,
                wsol_mint: WSOL,
                venue_program: program,
                token_program: SPL_TOKEN,
                token_2022_program: TOKEN_2022,
                associated_token_program: ATA_PROGRAM,
                system_program: SYSTEM,
                event_authority: ev_auth(),
                program: fumpad::ID,
            },
            fumpad::instruction::ExecuteBuyback { max_in },
            &rem,
        )
    }

    pub fn buyback(&mut self, c: &TCoin, cranker: &Keypair, max_in: u64) -> litesvm::types::TransactionResult {
        let i = self.buyback_ix(c, &kp_pk(cranker), max_in);
        self.send_as(cranker, &[i], &[cranker])
    }
}

/// A coin past its launch window with a funded buyback balance (launch-window claim).
fn funded_curve_coin() -> (Env, TCoin) {
    let mut env = Env::new();
    let c = env.launch(SOL / 10);
    let sniper = env.new_user(100);
    ok(env.direct_buy(&c, &sniper, 2 * SOL)); // 99% fee → buyback balance
    env.skip_launch_window();
    let alice = env.new_user(100);
    ok(env.router_buy(&c, &alice, 20 * SOL)); // depth for slices
    ok(env.claim_fees(&c));
    assert!(env.coin(&c).buyback_lamports > SOL);
    (env, c)
}

#[test]
fn pre_graduation_samples_are_keeper_only_and_spaced() {
    let (mut env, c) = funded_curve_coin();
    let meta = ok(env.sample(0, &[&c]));
    let ev: SampleRecorded = event(&meta);
    let sqrt = meteora::rd_u128(&env.dbc_pool_data(&c), m::DBC_POOL_SQRT_PRICE);
    assert_eq!((ev.venue, ev.price_q64, ev.fallback), (0, sqrt_to_q64(sqrt), false));
    let coin = env.coin(&c);
    assert_eq!((coin.pregrad_sample_price_q64, coin.pregrad_sample_ts), (ev.price_q64, env.now()));
    assert!(!env.exists(&c.observations()), "no ring before graduation");
    // Spacing ≥ 10 s.
    env.warp(5);
    assert_fumpad_err(env.sample(1, &[&c]), FumpadError::SampleTooSoon);
    env.warp(5);
    ok(env.sample(1, &[&c]));
    // Not a keeper → Unauthorized (no fallback pre-graduation).
    env.warp(3_600);
    let rando = env.new_user(1);
    let i = env.record_samples_ix(&kp_pk(&rando), &[&c]);
    assert_fumpad_err(env.send_as(&rando, &[i], &[&rando]), FumpadError::Unauthorized);
    // Isolation: no other instruction in the sampling transaction.
    let k = env.keepers[0].insecure_clone();
    let i = env.record_samples_ix(&kp_pk(&k), &[&c]);
    let alice = env.new_user(10);
    let mut ixs = meteora::wrap_sol_ixs(&kp_pk(&k), SOL / 100);
    ixs.push(i.clone());
    assert_fumpad_err(env.send_as(&k, &ixs, &[&k]), FumpadError::SampleTxNotIsolated);
    ok(env.send_as(&k, &[compute_budget_ix(200_000), i], &[&k]));
    let _ = alice;
}

#[test]
fn pre_graduation_buyback_keeper_only_guarded_and_never_completes() {
    let (mut env, c) = funded_curve_coin();
    let k = env.keepers[0].insecure_clone();
    // No sample yet → StaleSample.
    assert_fumpad_err(env.buyback(&c, &k, SOL), FumpadError::StaleSample);
    ok(env.sample(0, &[&c]));
    // Not a keeper → Unauthorized.
    let rando = env.new_user(10);
    assert_fumpad_err(env.buyback(&c, &rando, SOL), FumpadError::Unauthorized);
    let quote = env.dbc_quote_reserve(&c);
    let vault = env.reward_vault(&c.mint);
    let before = env.coin(&c).buyback_lamports;
    let meta = ok(env.buyback(&c, &k, u64::MAX));
    let ev: BuybackExecuted = event(&meta);
    // Slice ≤ 0.5% of the curve's quote reserve.
    assert_eq!(ev.lamports_in, quote * 50 / 10_000);
    assert_eq!(env.token_balance(&vault), ev.tokens_out);
    assert_eq!(env.coin(&c).buyback_lamports, before - ev.lamports_in);
    assert_eq!(ev.venue, 0);
    env.assert_coin_invariant(&c);
    println!("execute_buyback (DBC) CU {}", meta.compute_units_consumed);
    // Sample older than 60 s → StaleSample.
    env.warp(61);
    assert_fumpad_err(env.buyback(&c, &k, SOL), FumpadError::StaleSample);
    // Sandwich: sample, then pump the curve > 3% before the buyback → PriceDeviation.
    ok(env.sample(0, &[&c]));
    let pumper = env.new_user(100);
    ok(env.direct_buy(&c, &pumper, 10 * SOL));
    assert_fumpad_err(env.buyback(&c, &k, SOL), FumpadError::PriceDeviation);
    // Never completes the curve: push the curve right below the threshold; the slice is capped to the room left.
    let dumper = env.new_user(10);
    let _ = dumper;
    let whale = env.new_user(200);
    let room = meteora::MAINNET_THRESHOLD - env.dbc_quote_reserve(&c);
    // Buy until only ~0.001 SOL of room remains (fee 1.25% charged on top of what reaches the curve).
    ok(env.direct_buy(&c, &whale, (room - 1_000_000) * 10_000 / 9_875));
    env.warp(11);
    ok(env.sample(0, &[&c]));
    let q = env.dbc_quote_reserve(&c);
    let left = meteora::MAINNET_THRESHOLD - q;
    let meta = ok(env.buyback(&c, &k, u64::MAX));
    let ev: BuybackExecuted = event(&meta);
    assert!(ev.lamports_in < left, "slice {} vs room {left}", ev.lamports_in);
    assert!(env.dbc_quote_reserve(&c) < meteora::MAINNET_THRESHOLD, "curve not completed by a buyback");
}

#[test]
fn buyback_pinned_accounts_and_pause() {
    let (mut env, c) = funded_curve_coin();
    let k = env.keepers[0].insecure_clone();
    ok(env.sample(0, &[&c]));
    let good = env.buyback_ix(&c, &kp_pk(&k), SOL);
    let n = 16; // named accounts incl. event-CPI pair
    // Output redirected to the keeper's own token account (the PDA signs the venue CPI).
    let mut i = good.clone();
    let mine = base_ata(&kp_pk(&k), &c.mint);
    ok(env.send_as(&k, &[meteora::create_ata_idempotent_ix(&kp_pk(&k), &kp_pk(&k), &c.mint, &TOKEN_2022)], &[&k]));
    i.accounts[n + 4].pubkey = addr(&mine);
    assert_fumpad_err(env.send_as(&k, &[i], &[&k]), FumpadError::WrongVenue);
    // A foreign account appended to the PDA-signed CPI.
    let mut i = good.clone();
    i.accounts.push(solana_instruction::AccountMeta::new(addr(&env.reward_vault(&c.mint)), false));
    assert_fumpad_err(env.send_as(&k, &[i], &[&k]), FumpadError::WrongVenue);
    // Referral slot used.
    let mut i = good.clone();
    i.accounts[n + 12].pubkey = addr(&mine);
    assert_fumpad_err(env.send_as(&k, &[i], &[&k]), FumpadError::WrongVenue);
    // PAUSE_TRADE stops buybacks.
    let admin = env.admin.insecure_clone();
    ok(env.set_pause(&admin, fumpad::state::PAUSE_TRADE));
    assert_fumpad_err(env.send_as(&k, &[good.clone()], &[&k]), FumpadError::Paused);
    ok(env.set_pause(&admin, 0));
    ok(env.send_as(&k, &[good], &[&k]));
}

#[test]
fn post_graduation_samples_ring_and_fallback() {
    let mut env = Env::new();
    let c = env.launch(SOL / 10);
    env.skip_launch_window();
    env.graduate_coin(&c);
    let meta = ok(env.sample(0, &[&c]));
    let ev: SampleRecorded = event(&meta);
    let sqrt = meteora::rd_u128(&env.data(&env.coin(&c).damm_pool), m::DAMM_POOL_SQRT_PRICE);
    assert_eq!((ev.venue, ev.price_q64), (1, sqrt_to_q64(sqrt)));
    let obs: Observations = env.fetch_zc(&c.observations());
    assert_eq!((obs.len, obs.keeper_sampled), (1, 1));
    println!("record_samples 1 coin CU {}", meta.compute_units_consumed);
    // Fallback: anyone after 10 min without a keeper sample; flagged, never counts.
    let rando = env.new_user(1);
    let i = env.record_samples_ix(&kp_pk(&rando), &[&c]);
    assert_fumpad_err(env.send_as(&rando, &[i.clone()], &[&rando]), FumpadError::Unauthorized);
    env.warp(fumpad::DEFAULT_KEEPER_STALE_SECS + 1);
    let meta = ok(env.send_as(&rando, &[i], &[&rando]));
    assert!(event::<SampleRecorded>(&meta).fallback);
    // The keeper can sample right next to a fallback sample (spacing vs its own samples).
    ok(env.sample(0, &[&c]));
    // Same coin twice in one batch → SampleTooSoon.
    env.warp(20);
    assert_fumpad_err(env.sample(0, &[&c, &c]), FumpadError::SampleTooSoon);
}

#[test]
fn post_graduation_buyback_median_guard_and_slice() {
    let mut env = Env::new();
    let c = env.launch(SOL / 10);
    let sniper = env.new_user(100);
    ok(env.direct_buy(&c, &sniper, 3 * SOL));
    env.skip_launch_window();
    ok(env.claim_fees(&c));
    env.graduate_coin(&c);
    let k = env.keepers[1].insecure_clone();
    // No samples → InsufficientSamples (permissionless after graduation; the median is the guard).
    let rando = env.new_user(10);
    assert_fumpad_err(env.buyback(&c, &rando, SOL), FumpadError::InsufficientSamples);
    env.sample_for(&c, 1_800);
    let pool = env.coin(&c).damm_pool;
    let depth = meteora::rd_u64(&env.data(&pool), m::DAMM_POOL_TOKEN_B_AMOUNT);
    let meta = ok(env.buyback(&c, &rando, u64::MAX));
    let ev: BuybackExecuted = event(&meta);
    assert_eq!(ev.lamports_in, (depth as u128 * 50 / 10_000) as u64);
    assert_eq!(ev.venue, 1);
    println!("execute_buyback (DAMM) CU {}", meta.compute_units_consumed);
    // Pump the pool > 3% above the 30-min median → PriceDeviation (sandwich guard).
    let pumper = env.new_user(200);
    ok(env.direct_buy(&c, &pumper, 20 * SOL));
    assert_fumpad_err(env.buyback(&c, &k, SOL), FumpadError::PriceDeviation);
    env.assert_coin_invariant(&c);
}
