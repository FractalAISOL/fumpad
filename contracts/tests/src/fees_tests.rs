//! Fees (SPEC v0.7 §3.2/§3.3, D32/D33): partner fee claims on DBC and LP-fee claims on DAMM v2 through the
//! `fee_claimer` PDA; launch-window routing; 50/30/20 split; withdrawals; Coin lamport invariant.

use crate::flow::*;
use crate::meteora::{self};
use crate::*;
use fumpad::error::FumpadError;
use fumpad::events::{FeesClaimed, FeesWithdrawn};
use fumpad::external::meteora as m;

const DBC_PARTNER_QUOTE_FEE: usize = 272;

fn partner_fee(env: &Env, c: &TCoin) -> u64 {
    meteora::rd_u64(&env.dbc_pool_data(c), DBC_PARTNER_QUOTE_FEE)
}

#[test]
fn launch_window_fees_go_100_percent_to_buyback_then_split_50_30_20() {
    let mut env = Env::new();
    let c = env.launch(SOL / 10);
    // Snipers in the launch window pay the 99% scheduler fee (buys AND sells).
    let sniper = env.new_user(100);
    ok(env.direct_buy(&c, &sniper, 2 * SOL));
    env.advance_slots(2);
    let s = env.base_balance(&kp_pk(&sniper), &c.mint);
    ok(env.direct_sell(&c, &sniper, s / 2));
    // First claim is refused inside the window.
    assert_fumpad_err(env.claim_fees(&c), FumpadError::LaunchWindowActive);
    env.skip_launch_window();
    let accrued = partner_fee(&env, &c);
    assert!(accrued > SOL, "99% fees accrued to the partner: {accrued}");
    let k = env.op();
    let k_before = env.lamports(&kp_pk(&k));
    let meta = ok(env.claim_fees(&c));
    let ev: FeesClaimed = event(&meta);
    assert_eq!((ev.claimed, ev.to_buyback, ev.to_platform, ev.to_creator, ev.launch_window), (accrued, accrued, 0, 0, true));
    let coin = env.coin(&c);
    assert!(coin.launch_fees_settled);
    assert_eq!(coin.buyback_lamports, accrued);
    assert_eq!(partner_fee(&env, &c), 0);
    assert!(!env.exists(&env.fee_wsol()), "transient WSOL account closed");
    assert_eq!(env.lamports(&env.fee_claimer()), 0, "fee_claimer keeps nothing");
    assert_eq!(k_before - env.lamports(&kp_pk(&k)), meta.fee, "the caller pays only the tx fee (rent refunded)");
    env.assert_coin_invariant(&c);
    println!("claim_fees (DBC) CU {}", meta.compute_units_consumed);

    // Normal trading → exact 50/30/20.
    let alice = env.new_user(100);
    ok(env.router_buy(&c, &alice, 7 * SOL));
    ok(env.direct_buy(&c, &alice, 3 * SOL));
    let accrued = partner_fee(&env, &c);
    assert!(accrued.abs_diff(10 * SOL / 100) <= 4, "1.00% partner share of 10 SOL: {accrued}");
    let meta = ok(env.claim_fees(&c));
    let ev: FeesClaimed = event(&meta);
    let split = fumpad::math::split_fee(accrued, &fumpad::state::Params::default().fee_split());
    assert_eq!((ev.claimed, ev.to_buyback, ev.to_platform, ev.to_creator, ev.launch_window), (accrued, split.buyback, split.platform, split.creator, false));
    let coin = env.coin(&c);
    assert_eq!(coin.platform_fees_unclaimed, split.platform);
    assert_eq!(coin.creator_fees_unclaimed, split.creator);
    env.assert_coin_invariant(&c);
    // Nothing new → NothingToClaim.
    assert_fumpad_err(env.claim_fees(&c), FumpadError::NothingToClaim);
}

#[test]
fn first_claim_with_nothing_accrued_still_settles_launch_flag() {
    let mut env = Env::new();
    let c = env.launch(0);
    env.skip_launch_window();
    ok(env.claim_fees(&c));
    assert!(env.coin(&c).launch_fees_settled);
    assert_eq!(env.coin(&c).buyback_lamports, 0);
}

#[test]
fn lp_fees_from_all_post_graduation_volume() {
    let mut env = Env::new();
    let c = env.launch(SOL / 10);
    env.skip_launch_window();
    let nft = env.graduate_coin(&c);
    // LP fees need the launch flag settled first.
    assert_fumpad_err(env.claim_lp_fees(&c, &nft), FumpadError::LaunchFeesUnsettled);
    ok(env.claim_fees(&c)); // settles (claims the residual DBC partner fees, 100% to buyback)
    let bob = env.new_user(100);
    ok(env.router_buy(&c, &bob, 4 * SOL));
    ok(env.direct_buy(&c, &bob, 6 * SOL)); // a third-party swap on DAMM v2
    let b = env.base_balance(&kp_pk(&bob), &c.mint);
    ok(env.direct_sell(&c, &bob, b / 2));
    let coin_before = env.coin(&c);
    let meta = ok(env.claim_lp_fees(&c, &nft));
    let ev: FeesClaimed = event(&meta);
    assert_eq!(ev.venue, 1);
    // ≈1.00% of the volume (1.25% pool fee, 20% to Meteora); the locked position owns 100% of the LP fees.
    assert!(ev.claimed > 10 * SOL / 100, "LP fees {}", ev.claimed);
    let coin = env.coin(&c);
    assert_eq!(coin.creator_fees_unclaimed - coin_before.creator_fees_unclaimed, ev.to_creator);
    assert_eq!(ev.to_buyback + ev.to_platform + ev.to_creator, ev.claimed);
    env.assert_coin_invariant(&c);
    assert_eq!(env.token_balance(&env.reward_vault(&c.mint)), coin.leftover_tokens, "OnlyB: no base fees");
    println!("claim_lp_fees CU {}", meta.compute_units_consumed);
    // Second claim right away: nothing.
    assert_fumpad_err(env.claim_lp_fees(&c, &nft), FumpadError::NothingToClaim);
}

#[test]
fn fee_claims_reject_spoofed_accounts() {
    let mut env = Env::new();
    let c = env.launch(SOL / 10);
    let other = env.launch(SOL / 10);
    env.skip_launch_window();
    let k = env.op();
    // Another coin's pool under this coin.
    let mut i = env.claim_fees_ix(&c, &kp_pk(&k));
    i.accounts[5].pubkey = addr(&other.pool);
    assert!(env.send_as(&k, &[i], &[&k]).is_err());
    // Wrong vault.
    let mut i = env.claim_fees_ix(&c, &kp_pk(&k));
    i.accounts[6].pubkey = addr(&other.base_vault());
    assert_fumpad_err(env.send_as(&k, &[i], &[&k]), FumpadError::WrongVenue);
    // Not the reward vault as base destination.
    let mut i = env.claim_fees_ix(&c, &kp_pk(&k));
    i.accounts[10].pubkey = addr(&base_ata(&kp_pk(&k), &c.mint));
    assert_fumpad_err(env.send_as(&k, &[i], &[&k]), FumpadError::InvalidAccount);
    // Fake DBC program.
    let mut i = env.claim_fees_ix(&c, &kp_pk(&k));
    let last = i.accounts.len() - 3;
    i.accounts[last].pubkey = addr(&meteora::DAMM);
    assert_fumpad_err(env.send_as(&k, &[i], &[&k]), FumpadError::WrongVenue);
    // claim_lp_fees before graduation.
    let nft = Pubkey::new_unique();
    let coin = env.coin(&c);
    assert_eq!(coin.damm_pool, Pubkey::default());
    let r = env.claim_lp_fees(&c, &nft);
    assert!(r.is_err());
}

#[test]
fn creator_and_platform_withdrawals() {
    let mut env = Env::new();
    let c = env.launch(SOL / 10);
    env.skip_launch_window();
    ok(env.claim_fees(&c));
    let alice = env.new_user(100);
    ok(env.router_buy(&c, &alice, 20 * SOL));
    ok(env.claim_fees(&c));
    let coin = env.coin(&c);
    let creator = c.creator.insecure_clone();
    // Someone else can't take the creator's share.
    let rando = env.new_user(1);
    let w = ix(
        fumpad::accounts::WithdrawCreatorFees { creator: kp_pk(&rando), coin: c.coin_pda(), event_authority: ev_auth(), program: fumpad::ID },
        fumpad::instruction::WithdrawCreatorFees {},
    );
    assert_fumpad_err(env.send_as(&rando, &[w], &[&rando]), FumpadError::Unauthorized);
    let w = ix(
        fumpad::accounts::WithdrawCreatorFees { creator: kp_pk(&creator), coin: c.coin_pda(), event_authority: ev_auth(), program: fumpad::ID },
        fumpad::instruction::WithdrawCreatorFees {},
    );
    let before = env.lamports(&kp_pk(&creator));
    let meta = ok(env.send_as(&creator, &[w.clone()], &[&creator]));
    let ev: FeesWithdrawn = event(&meta);
    assert_eq!((ev.lamports, ev.creator), (coin.creator_fees_unclaimed, true));
    assert_eq!(env.lamports(&kp_pk(&creator)) + meta.fee - before, coin.creator_fees_unclaimed);
    assert_fumpad_err(env.send_as(&creator, &[w], &[&creator]), FumpadError::ZeroAmount);
    // Platform fees: permissionless, only to the treasury.
    let p = ix(
        fumpad::accounts::WithdrawPlatformFees {
            caller: kp_pk(&env.payer),
            global: env.global(),
            coin: c.coin_pda(),
            platform_treasury: kp_pk(&env.treasury),
            event_authority: ev_auth(),
            program: fumpad::ID,
        },
        fumpad::instruction::WithdrawPlatformFees {},
    );
    let t0 = env.lamports(&kp_pk(&env.treasury));
    ok(env.send(&[p.clone()], &[]));
    assert_eq!(env.lamports(&kp_pk(&env.treasury)) - t0, coin.platform_fees_unclaimed);
    let mut bad = p;
    bad.accounts[3].pubkey = addr(&kp_pk(&rando));
    assert!(env.send(&[bad], &[]).is_err());
    env.assert_coin_invariant(&c);
    let coin = env.coin(&c);
    assert_eq!(coin.buyback_lamports + env.rent(8 + <fumpad::state::Coin as anchor_lang::Space>::INIT_SPACE), env.lamports(&c.coin_pda()));
    let _ = m::VENUE_DBC;
}
