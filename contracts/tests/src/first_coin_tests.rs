//! First-coin "launch config" + per-config fee policies (user decision 2026-10-14; INTERFACE §5.9, SPEC
//! Clarification 29). Both configs side by side on the mainnet DBC 0.2.1 / DAMM v2 0.2.4 binaries:
//! * standard config: 99% → 1.25% over 8 slots, 1.25% curve + DAMM fee, our 1% split 50/30/20, launch window → buyback;
//! * first-coin config: 99% → 3% over 25 slots (≈ 10 s), 3% curve + DAMM fee, our 2.4% split 1.0 buyback / 1.4 wallet
//!   (no platform, no creator), launch window → 100% wallet; `max_coins = 1`.

use crate::flow::*;
use crate::lifecycle_tests::assert_reward_pool_8pct;
use crate::meteora::{self, FIRST_COIN_PERIODS};
use crate::*;
use fumpad::error::FumpadError;
use fumpad::events::{BuybackExecuted, CoinRegistered, ConfigQueued, ConfigUpdated, FeesClaimed};
use fumpad::external::meteora as m;
use fumpad::state::{CoinFeePolicy, FeePolicy, Global, Params};
use fumpad::{FEE_POLICY_STANDARD, FEE_POLICY_WALLET_SPLIT};
use solana_keypair::Keypair;

const DBC_PARTNER_QUOTE_FEE: usize = 272;
const BUYBACK_SHARE: u16 = 100; // 1.0% of volume
const WALLET_SHARE: u16 = 140; // 1.4% of volume

fn first_policy(wallet: Pubkey, max_coins: u16) -> FeePolicy {
    FeePolicy { kind: FEE_POLICY_WALLET_SPLIT, buyback_share: BUYBACK_SHARE, wallet_share: WALLET_SHARE, max_coins, wallet }
}

/// The standard Env plus the first-coin config allow-listed with a wallet-split policy for a funded wallet.
fn setup(max_coins: u16) -> (Env, Pubkey, Pubkey) {
    let mut env = Env::new();
    let first = env.create_dbc_config(&meteora::first_coin_mainnet_config_params());
    let wallet = Pubkey::new_unique();
    env.svm.airdrop(&addr(&wallet), SOL).unwrap();
    env.allow_config_with(first, first_policy(wallet, max_coins));
    (env, first, wallet)
}

fn partner_fee(env: &Env, c: &TCoin) -> u64 {
    meteora::rd_u64(&env.dbc_pool_data(c), DBC_PARTNER_QUOTE_FEE)
}

fn skip_first_window(env: &mut Env) {
    env.advance_slots(FIRST_COIN_PERIODS as u64 + 1);
}

/// The wallet's exact share of a claim: ⌊claimed × 1.4 / 2.4⌋ (the rounding remainder goes to the buyback).
fn wallet_part(claimed: u64) -> u64 {
    (claimed as u128 * WALLET_SHARE as u128 / (BUYBACK_SHARE + WALLET_SHARE) as u128) as u64
}

#[test]
fn first_coin_registers_snapshot_and_fee_schedule_99_to_3_over_25_slots() {
    let (mut env, first, wallet) = setup(1);
    let fc = env.launch_on(first, SOL / 10);
    let sc = env.launch(SOL / 10);
    // Snapshot: kind in the Coin, details in the CoinFeePolicy PDA; the standard coin has neither.
    let coin = env.coin(&fc);
    assert_eq!(coin.launch_window_slots, FIRST_COIN_PERIODS as u64);
    assert_eq!(coin.fee_policy_kind, FEE_POLICY_WALLET_SPLIT);
    assert_eq!(coin.fee_split, Default::default(), "fee_split unused (zero) for a wallet-split coin");
    let snap: CoinFeePolicy = env.fetch(&env.fee_policy_pda(&fc.mint));
    assert_eq!((snap.mint, snap.dbc_config, snap.policy, snap.wallet_paid_lamports), (fc.mint, first, first_policy(wallet, 1), 0));
    assert_eq!(env.lamports(&env.fee_policy_pda(&fc.mint)), env.rent(152), "rent paid by the creator");
    let std = env.coin(&sc);
    assert_eq!((std.fee_policy_kind, std.fee_split, std.launch_window_slots), (FEE_POLICY_STANDARD, Params::default().fee_split(), 8));
    assert!(!env.exists(&env.fee_policy_pda(&sc.mint)));
    let g: Global = env.fetch(&env.global());
    assert_eq!((g.config_coins[0], g.config_coins[1]), (1, 1));
    // The creator's launch-tx buy gets DBC's min fee, which on this config is 3% (≈ 0.097 SOL reaches the curve,
    // vs ≈ 0.09875 at 1.25%).
    let (qf, qs) = (env.dbc_quote_reserve(&fc), env.dbc_quote_reserve(&sc));
    assert!(qf.abs_diff(SOL / 10 * 97 / 100) <= 2, "first coin creator buy at 3%: {qf}");
    assert!(qs.abs_diff(SOL / 10 * 9_875 / 10_000) <= 2, "standard creator buy at 1.25%: {qs}");
    // Launch slot: a sniper pays the 99% cliff on both.
    let sniper = env.new_user(100);
    ok(env.direct_buy(&fc, &sniper, 2 * SOL));
    assert!(partner_fee(&env, &fc) > SOL, "99% fee in the launch slot");
    // Slot 12: the standard window (8) is over, the first coin's (25) isn't.
    env.advance_slots(12);
    assert_fumpad_err(env.claim_fees(&fc), FumpadError::LaunchWindowActive);
    ok(env.claim_fees(&sc));
    // Mid-window fee, linear: 99% − 12 × 3.84% = 52.92% (partner: 80% of it).
    let p0 = partner_fee(&env, &fc);
    ok(env.direct_buy(&fc, &sniper, SOL));
    let mid = partner_fee(&env, &fc) - p0;
    assert!(mid.abs_diff(SOL * 5_292 / 10_000 * 8 / 10) <= SOL / 1_000, "fee at slot 12: {mid}");
    // From slot 25 on: exactly 3% (partner gets 80% of it = 2.4% of volume); standard: 1.25% (1.00%).
    skip_first_window(&mut env);
    let alice = env.new_user(100);
    for (c, want) in [(&fc, 10 * SOL * 24 / 1_000), (&sc, 10 * SOL / 100)] {
        let p0 = partner_fee(&env, c);
        ok(env.direct_buy(c, &alice, 10 * SOL));
        let got = partner_fee(&env, c) - p0;
        assert!(got.abs_diff(want) <= 4, "partner fee {got} vs {want}");
    }
    env.advance_slots(10_000);
    let p0 = partner_fee(&env, &fc);
    ok(env.direct_buy(&fc, &alice, 10 * SOL));
    assert!((partner_fee(&env, &fc) - p0).abs_diff(10 * SOL * 24 / 1_000) <= 4, "stays 3% forever on the curve");
}

#[test]
fn first_coin_launch_window_to_wallet_then_1_0_buyback_1_4_wallet_standard_unaffected() {
    let (mut env, first, wallet) = setup(1);
    let fc = env.launch_on(first, SOL / 10);
    let sc = env.launch(SOL / 10);
    let sniper = env.new_user(100);
    for c in [&fc, &sc] {
        ok(env.direct_buy(c, &sniper, 2 * SOL));
    }
    skip_first_window(&mut env);
    // Launch-window claim: first coin 100% → wallet; standard 100% → buyback.
    let accrued = partner_fee(&env, &fc);
    let w0 = env.lamports(&wallet);
    let meta = ok(env.claim_fees(&fc));
    let ev: FeesClaimed = event(&meta);
    assert_eq!(
        (ev.claimed, ev.to_buyback, ev.to_platform, ev.to_creator, ev.to_wallet, ev.fee_wallet, ev.launch_window),
        (accrued, 0, 0, 0, accrued, wallet, true)
    );
    assert_eq!(env.lamports(&wallet) - w0, accrued);
    let coin = env.coin(&fc);
    assert!(coin.launch_fees_settled);
    assert_eq!((coin.buyback_lamports, coin.platform_fees_unclaimed, coin.creator_fees_unclaimed), (0, 0, 0));
    assert_eq!(coin.fees_claimed_lamports, accrued);
    assert_eq!(env.fetch::<CoinFeePolicy>(&env.fee_policy_pda(&fc.mint)).wallet_paid_lamports, accrued);
    assert_eq!(env.lamports(&env.fee_claimer()), 0);
    assert!(!env.exists(&env.fee_wsol()));
    env.assert_coin_invariant(&fc);
    let s_accrued = partner_fee(&env, &sc);
    let ev: FeesClaimed = event(&ok(env.claim_fees(&sc)));
    assert_eq!((ev.to_buyback, ev.to_wallet, ev.fee_wallet), (s_accrued, 0, Pubkey::default()));
    assert_eq!(env.coin(&sc).buyback_lamports, s_accrued);

    // Normal trading: of our 2.4%, exactly 1.0/2.4 → buyback, 1.4/2.4 → wallet; nothing to platform / creator.
    let alice = env.new_user(100);
    for c in [&fc, &sc] {
        ok(env.router_buy(c, &alice, 7 * SOL));
        ok(env.direct_buy(c, &alice, 3 * SOL));
    }
    let accrued = partner_fee(&env, &fc);
    assert!(accrued.abs_diff(10 * SOL * 24 / 1_000) <= 8, "2.4% of 10 SOL: {accrued}");
    let w0 = env.lamports(&wallet);
    let before = env.coin(&fc);
    let meta = ok(env.claim_fees(&fc));
    let ev: FeesClaimed = event(&meta);
    let w = wallet_part(accrued);
    assert_eq!(
        (ev.claimed, ev.to_wallet, ev.to_buyback, ev.to_platform, ev.to_creator, ev.launch_window),
        (accrued, w, accrued - w, 0, 0, false)
    );
    assert!((accrued - w).abs_diff(10 * SOL / 100) <= 8, "1.0% of volume → buyback: {}", accrued - w);
    assert!(w.abs_diff(10 * SOL * 14 / 1_000) <= 8, "1.4% of volume → wallet: {w}");
    assert_eq!(env.lamports(&wallet) - w0, w);
    let coin = env.coin(&fc);
    assert_eq!(coin.buyback_lamports - before.buyback_lamports, accrued - w);
    assert_eq!((coin.platform_fees_unclaimed, coin.creator_fees_unclaimed), (0, 0));
    env.assert_coin_invariant(&fc);
    println!("claim_fees (wallet split) CU {}", meta.compute_units_consumed);
    // Standard coin in the same Global: 50/30/20 of its 1.00%, no wallet.
    let s_accrued = partner_fee(&env, &sc);
    let ev: FeesClaimed = event(&ok(env.claim_fees(&sc)));
    let split = fumpad::math::split_fee(s_accrued, &Params::default().fee_split());
    assert_eq!(
        (ev.to_buyback, ev.to_platform, ev.to_creator, ev.to_wallet, ev.fee_wallet),
        (split.buyback, split.platform, split.creator, 0, Pubkey::default())
    );
    env.assert_coin_invariant(&sc);
    assert_fumpad_err(env.claim_fees(&fc), FumpadError::NothingToClaim);
}

#[test]
fn first_coin_graduates_8pct_and_lp_fees_split_1_0_1_4() {
    let (mut env, first, wallet) = setup(1);
    let fc = env.launch_on(first, SOL / 10);
    skip_first_window(&mut env);
    ok(env.claim_fees(&fc));
    let nft = env.graduate_coin(&fc);
    let coin = env.coin(&fc);
    assert_eq!(coin.status, fumpad::state::CoinStatus::Graduated);
    assert_reward_pool_8pct(coin.leftover_tokens);
    // Residual DBC partner fees of the completing buy (3% curve fee): split like any later claim.
    let residual = partner_fee(&env, &fc);
    let ev: FeesClaimed = event(&ok(env.claim_fees(&fc)));
    assert_eq!((ev.to_wallet, ev.to_buyback), (wallet_part(residual), residual - wallet_part(residual)));
    // Post-graduation volume on DAMM v2 (3% pool fee, Meteora 20%): the 100%-locked position earns 2.4%.
    let bob = env.new_user(100);
    ok(env.router_buy(&fc, &bob, 4 * SOL));
    ok(env.direct_buy(&fc, &bob, 6 * SOL));
    let w0 = env.lamports(&wallet);
    let meta = ok(env.claim_lp_fees(&fc, &nft));
    let ev: FeesClaimed = event(&meta);
    assert_eq!(ev.venue, 1);
    assert!(ev.claimed.abs_diff(10 * SOL * 24 / 1_000) <= 10 * SOL / 10_000, "2.4% of 10 SOL as LP fees: {}", ev.claimed);
    let w = wallet_part(ev.claimed);
    assert_eq!((ev.to_wallet, ev.to_buyback, ev.to_platform, ev.to_creator, ev.fee_wallet), (w, ev.claimed - w, 0, 0, wallet));
    assert_eq!(env.lamports(&wallet) - w0, w);
    env.assert_coin_invariant(&fc);
    println!("claim_lp_fees (wallet split) CU {}", meta.compute_units_consumed);
    assert_fumpad_err(env.claim_lp_fees(&fc, &nft), FumpadError::NothingToClaim);
}

/// The buyback balance of a 3% coin feeds its reward pool like any coin: a full pre-graduation slice at the guard
/// price passes the min-out check (band 3% + 2% venue allowance + 2 × slice covers the 3% fee at spot = guard).
#[test]
fn first_coin_buyback_balance_buys_into_its_reward_pool() {
    let (mut env, first, _wallet) = setup(1);
    let fc = env.launch_on(first, SOL / 10);
    skip_first_window(&mut env);
    ok(env.claim_fees(&fc));
    let alice = env.new_user(100);
    ok(env.router_buy(&fc, &alice, 40 * SOL));
    ok(env.claim_fees(&fc));
    assert!(env.coin(&fc).buyback_lamports > 40 * SOL / 100 * 99 / 100, "≈1.0% of 40 SOL");
    env.pregrad_warmup(&fc);
    let k = env.op();
    let ev: BuybackExecuted = event(&ok(env.buyback(&fc, &k, u64::MAX)));
    assert!(ev.tokens_out > 0);
    assert_eq!(env.token_balance(&env.reward_vault(&fc.mint)), ev.tokens_out);
    env.assert_coin_invariant(&fc);
}

#[test]
fn coin_policy_snapshot_survives_config_removal_and_re_add() {
    let (mut env, first, wallet) = setup(1);
    let fc = env.launch_on(first, SOL / 10);
    // Admin removes the first-coin config right after the first launch (LAUNCH-DAY step).
    let meta = ok(env.queue_config(first, false));
    assert_eq!(event::<ConfigQueued>(&meta).policy, FeePolicy::default());
    env.warp(fumpad::CONFIG_TIMELOCK_SECS);
    let meta = ok(env.execute_config(first));
    let ev: ConfigUpdated = event(&meta);
    assert_eq!((ev.config, ev.add, ev.policy), (first, false, first_policy(wallet, 1)));
    let g: Global = env.fetch(&env.global());
    assert!(!g.is_allowed_config(&first));
    assert_eq!((g.config_policies[1], g.config_coins[1]), (FeePolicy::default(), 0));
    // New launches on it are refused; the existing coin keeps its routing.
    let creator = env.new_user(10);
    let mint = Keypair::new();
    let ixs = env.launch_ixs(&first, &kp_pk(&creator), &kp_pk(&mint), 0);
    assert_fumpad_err(env.send_as(&creator, &ixs, &[&creator, &mint]), FumpadError::ConfigNotAllowed);
    let sniper = env.new_user(100);
    ok(env.direct_buy(&fc, &sniper, SOL));
    let accrued = partner_fee(&env, &fc);
    let ev: FeesClaimed = event(&ok(env.claim_fees(&fc)));
    assert_eq!((ev.to_wallet, ev.fee_wallet, ev.launch_window), (accrued, wallet, true));
    // Re-adding the same config with another wallet (and no cap) affects only coins registered from then on.
    let wallet2 = Pubkey::new_unique();
    env.svm.airdrop(&addr(&wallet2), SOL).unwrap();
    env.allow_config_with(first, first_policy(wallet2, 0));
    let fc2 = env.launch_on(first, 0);
    assert_eq!(env.fetch::<CoinFeePolicy>(&env.fee_policy_pda(&fc2.mint)).policy.wallet, wallet2);
    assert_eq!(env.fetch::<CoinFeePolicy>(&env.fee_policy_pda(&fc.mint)).policy, first_policy(wallet, 1));
    let alice = env.new_user(100);
    ok(env.direct_buy(&fc, &alice, 10 * SOL));
    let k = env.op();
    let mut i = env.claim_fees_ix(&fc, &kp_pk(&k));
    let at = i.accounts.len() - 3; // fee_wallet sits right before the event-CPI pair
    i.accounts[at].pubkey = addr(&wallet2);
    assert_fumpad_err(env.send_as(&k, &[i], &[&k]), FumpadError::InvalidAccount);
    let ev: FeesClaimed = event(&ok(env.claim_fees(&fc)));
    assert_eq!(ev.fee_wallet, wallet);
}

#[test]
fn max_coins_caps_the_config_even_for_the_launch_signer() {
    let (mut env, first, _wallet) = setup(1);
    let launch_key = Keypair::new();
    env.set_params_timelocked(Params { launch_signer: kp_pk(&launch_key), ..Params::default() });
    let launch = |env: &mut Env, config: Pubkey| {
        let creator = env.new_user(10);
        let mint = Keypair::new();
        env.fund_wsol(&creator, SOL / 10);
        let mut ixs = env.launch_ixs(&config, &kp_pk(&creator), &kp_pk(&mint), SOL / 10);
        let reg = ixs.last_mut().unwrap();
        // Optional accounts `launch_signer`, `fee_policy`, then the event-CPI pair.
        let at = reg.accounts.len() - 4;
        reg.accounts[at] = solana_instruction::AccountMeta::new_readonly(addr(&kp_pk(&launch_key)), true);
        let size = env.tx_size(&creator, &ixs, &[&creator, &mint, &launch_key]);
        (env.send_as(&creator, &ixs, &[&creator, &mint, &launch_key]), size)
    };
    let (r, size) = launch(&mut env, first);
    ok(r);
    assert!(size <= 1232, "first-coin launch tx (co-signed, + fee_policy) {size} bytes");
    println!("first-coin launch tx {size} bytes");
    // A second coin on the first-coin config: refused even with a valid launch co-signature (leaked API key).
    let (r, _) = launch(&mut env, first);
    assert_fumpad_err(r, FumpadError::ConfigCoinLimit);
    // The standard config is uncapped.
    let cfg = env.config;
    ok(launch(&mut env, cfg).0);
    ok(launch(&mut env, cfg).0);
    let g: Global = env.fetch(&env.global());
    assert_eq!((g.config_coins[0], g.config_coins[1]), (2, 1));
}

#[test]
fn fee_policy_accounts_are_required_and_checked() {
    let (mut env, first, wallet) = setup(0);
    // register_coin without the fee_policy PDA / with another address.
    let creator = env.new_user(10);
    for (pda, want) in [(None, FumpadError::FeePolicyAccountsRequired), (Some(Pubkey::new_unique()), FumpadError::InvalidAccount)] {
        let mint = Keypair::new();
        let mut ixs = env.launch_ixs(&first, &kp_pk(&creator), &kp_pk(&mint), 0);
        let pool = meteora::dbc_pool_pda(&first, &kp_pk(&mint));
        *ixs.last_mut().unwrap() = env.register_coin_ix_with(&first, &pool, &kp_pk(&creator), &kp_pk(&mint), pda);
        assert_fumpad_err(env.send_as(&creator, &ixs, &[&creator, &mint]), want);
    }
    // A standard config ignores the slot (passing None is the norm).
    let sc = env.launch(0);
    assert_eq!(env.coin(&sc).fee_policy_kind, FEE_POLICY_STANDARD);
    let fc = env.launch_on(first, 0);
    skip_first_window(&mut env);
    let k = env.op();
    // claim_fees / claim_lp_fees of a wallet-split coin without its policy accounts.
    let mut i = env.claim_fees_ix(&fc, &kp_pk(&k));
    let n = i.accounts.len();
    for j in [n - 4, n - 3] {
        i.accounts[j] = solana_instruction::AccountMeta::new_readonly(addr(&fumpad::ID), false);
    }
    assert_fumpad_err(env.send_as(&k, &[i.clone()], &[&k]), FumpadError::FeePolicyAccountsRequired);
    // Wrong wallet.
    let mut i = env.claim_fees_ix(&fc, &kp_pk(&k));
    i.accounts[n - 3].pubkey = addr(&kp_pk(&k));
    assert_fumpad_err(env.send_as(&k, &[i], &[&k]), FumpadError::InvalidAccount);
    // Another coin's fee_policy PDA (seeds bound to the mint) is refused by the account constraints.
    let fc_other = env.launch_on(first, 0);
    assert_eq!(env.fetch::<CoinFeePolicy>(&env.fee_policy_pda(&fc_other.mint)).policy.wallet, wallet);
    let mut i = env.claim_fees_ix(&fc, &kp_pk(&k));
    i.accounts[n - 4].pubkey = addr(&env.fee_policy_pda(&fc_other.mint));
    assert!(env.send_as(&k, &[i], &[&k]).is_err());
    ok(env.claim_fees(&fc));
}

#[test]
fn fee_wallet_must_stay_rent_exempt() {
    let mut env = Env::new();
    let first = env.create_dbc_config(&meteora::first_coin_mainnet_config_params());
    let wallet = Pubkey::new_unique(); // never funded: 0 lamports
    env.allow_config_with(first, first_policy(wallet, 0));
    let fc = env.launch_on(first, 0);
    skip_first_window(&mut env);
    ok(env.claim_fees(&fc)); // nothing accrued: settles the launch flag, pays nothing
    assert_eq!(env.lamports(&wallet), 0);
    let alice = env.new_user(10);
    ok(env.direct_buy(&fc, &alice, SOL / 100)); // 2.4% of 0.01 SOL → wallet 140,000 lamports < rent minimum
    assert_fumpad_err(env.claim_fees(&fc), FumpadError::FeeWalletNotRentExempt);
    // Fees stay in DBC meanwhile; funding the wallet unblocks the claim.
    let accrued = partner_fee(&env, &fc);
    env.svm.airdrop(&addr(&wallet), env.rent(0)).unwrap();
    let ev: FeesClaimed = event(&ok(env.claim_fees(&fc)));
    assert_eq!((ev.claimed, ev.to_wallet), (accrued, wallet_part(accrued)));
    assert_eq!(env.lamports(&wallet), env.rent(0) + wallet_part(accrued));
}

#[test]
fn fee_policy_validation_on_queue_and_init() {
    let mut env = Env::new();
    let first = env.create_dbc_config(&meteora::first_coin_mainnet_config_params());
    let w = Pubkey::new_unique();
    let ok_policy = first_policy(w, 1);
    for bad in [
        FeePolicy { wallet: env.fee_claimer(), ..ok_policy },
        FeePolicy { wallet: env.reward_pool(), ..ok_policy },
        FeePolicy { wallet: env.global(), ..ok_policy },
        FeePolicy { wallet: env.buyback_pda(), ..ok_policy },
        FeePolicy { wallet: Pubkey::default(), ..ok_policy },
        FeePolicy { wallet_share: 0, ..ok_policy },
        FeePolicy { kind: 7, ..ok_policy },
        FeePolicy { kind: FEE_POLICY_STANDARD, ..ok_policy },
    ] {
        assert_fumpad_err(env.queue_config_with(first, true, bad), FumpadError::InvalidParams);
    }
    // A removal carries no policy.
    assert_fumpad_err(env.queue_config_with(env.config, false, ok_policy), FumpadError::InvalidParams);
    let meta = ok(env.queue_config_with(first, true, ok_policy));
    let ev: ConfigQueued = event(&meta);
    assert_eq!((ev.config, ev.add, ev.policy), (first, true, ok_policy));
    assert_eq!(env.fetch::<Global>(&env.global()).pending_config_policy, ok_policy);
    // Cancel clears the pending policy.
    let admin = env.admin.insecure_clone();
    let cancel = ix(
        fumpad::accounts::GuardianOrAdmin { authority: kp_pk(&admin), global: env.global(), event_authority: ev_auth(), program: fumpad::ID },
        fumpad::instruction::CancelConfig {},
    );
    ok(env.send(&[cancel], &[&admin]));
    assert_eq!(env.fetch::<Global>(&env.global()).pending_config_policy, FeePolicy::default());

    // initialize_global: more policies than configs, or an invalid one → InvalidParams.
    let mut env = Env::uninit();
    let std = env.create_dbc_config(&meteora::mainnet_config_params());
    let first = env.create_dbc_config(&meteora::first_coin_mainnet_config_params());
    let payer = kp_pk(&env.payer);
    let ks = [Pubkey::default(); 3];
    let ops = [Pubkey::default(); 2];
    for (configs, policies) in [
        (vec![std], vec![FeePolicy::default(), ok_policy]),
        (vec![std, first], vec![FeePolicy::default(), FeePolicy { wallet: env.fee_claimer(), ..ok_policy }]),
    ] {
        let i = env.initialize_global_ix_policies(&payer, Params::default(), ks, ops, &configs, policies);
        assert_fumpad_err(env.send(&[i], &[]), FumpadError::InvalidParams);
    }
}

/// Bootstrap (no timelock): `initialize_global` allow-lists both configs with their policies in one instruction;
/// the first coin can launch at once.
#[test]
fn bootstrap_initializes_both_configs_with_policies() {
    let mut env = Env::uninit();
    let std = env.create_dbc_config(&meteora::mainnet_config_params());
    let first = env.create_dbc_config(&meteora::first_coin_mainnet_config_params());
    let w = Pubkey::new_unique();
    env.svm.airdrop(&addr(&w), SOL).unwrap();
    let ks = [kp_pk(&env.keepers[0]), kp_pk(&env.keepers[1]), kp_pk(&env.keepers[2])];
    let i = env.initialize_global_ix_policies(
        &kp_pk(&env.payer),
        Params::default(),
        ks,
        env.operator_keys(),
        &[std, first],
        vec![FeePolicy::default(), first_policy(w, 1)],
    );
    println!("initialize_global ix data {} bytes ({} accounts)", i.data.len(), i.accounts.len());
    let meta = ok(env.send(&[i], &[]));
    let evs = events::<ConfigUpdated>(&meta);
    assert_eq!(evs.iter().map(|e| (e.config, e.policy)).collect::<Vec<_>>(), vec![(std, FeePolicy::default()), (first, first_policy(w, 1))]);
    let g: Global = env.fetch(&env.global());
    assert_eq!((g.configs[0], g.configs[1], g.config_policies[0], g.config_policies[1]), (std, first, FeePolicy::default(), first_policy(w, 1)));
    assert_eq!(env.data(&env.global()).len(), 1_491);
    env.config = std;
    let creator = env.new_user(10);
    let mint = Keypair::new();
    let ixs = env.launch_ixs(&first, &kp_pk(&creator), &kp_pk(&mint), 0);
    let meta = ok(env.send_as(&creator, &ixs, &[&creator, &mint]));
    let reg: CoinRegistered = event(&meta);
    assert_eq!((reg.dbc_config, reg.fee_policy, reg.launch_window_slots), (first, first_policy(w, 1), FIRST_COIN_PERIODS as u64));
    let std_coin = env.launch(0);
    assert_eq!(env.coin(&std_coin).fee_policy_kind, FEE_POLICY_STANDARD);
    let _ = m::VENUE_DBC;
}
