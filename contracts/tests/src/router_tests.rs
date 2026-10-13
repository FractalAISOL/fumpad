//! Router (SPEC v0.7 §3.1): user-signed DBC/DAMM v2 `swap2` pass-through, measured deltas, validation, pauses.

use crate::flow::*;
use crate::meteora::{self, WSOL};
use crate::*;
use fumpad::error::FumpadError;
use fumpad::events::RoutedTrade;
use fumpad::external::meteora as m;
use fumpad::state::PAUSE_TRADE;

fn setup() -> (Env, TCoin) {
    let mut env = Env::new();
    let c = env.launch(SOL / 10);
    env.skip_launch_window();
    (env, c)
}

#[test]
fn dbc_router_buy_and_sell_measure_exact_amounts() {
    let (mut env, c) = setup();
    let alice = env.new_user(100);
    let a = kp_pk(&alice);
    let pre_sqrt = meteora::rd_u128(&env.dbc_pool_data(&c), m::DBC_POOL_SQRT_PRICE);
    let meta = ok(env.router_buy(&c, &alice, 2 * SOL));
    let ev: RoutedTrade = event(&meta);
    assert_eq!((ev.mint, ev.trader, ev.venue, ev.is_buy), (c.mint, a, 0, true));
    assert_eq!(ev.base_amount, env.base_balance(&a, &c.mint));
    assert_eq!(ev.quote_gross, 2 * SOL);
    // 1.25% DBC fee (trading + protocol), measured from the pool counters.
    assert!(ev.fee.abs_diff(2 * SOL / 80) <= 2, "fee {}", ev.fee);
    assert_eq!(ev.pre_sqrt_price, pre_sqrt);
    assert_eq!(ev.post_sqrt_price, meteora::rd_u128(&env.dbc_pool_data(&c), m::DBC_POOL_SQRT_PRICE));
    assert_eq!(&meta.return_data.data[..8], &ev.base_amount.to_le_bytes()[..]);
    println!("router buy (DBC) CU {}", meta.compute_units_consumed);
    // Sell half: base out = exactly what left the ATA; quote_gross = received + fee.
    let wsol_before = env.token_balance(&wsol_ata(&a));
    let half = ev.base_amount / 2;
    let meta = ok(env.router_sell(&c, &alice, half));
    let ev: RoutedTrade = event(&meta);
    let received = env.token_balance(&wsol_ata(&a)) - wsol_before;
    assert_eq!((ev.is_buy, ev.base_amount), (false, half));
    assert_eq!(ev.quote_gross, received + ev.fee);
    assert!(ev.fee.abs_diff(ev.quote_gross / 80) <= 2);
    println!("router sell (DBC) CU {}", meta.compute_units_consumed);
    let coin = env.coin(&c);
    assert_eq!(coin.router_trade_count, 2);
    env.assert_coin_invariant(&c);
}

#[test]
fn damm_router_after_graduation() {
    let (mut env, c) = setup();
    env.graduate_coin(&c);
    let bob = env.new_user(100);
    let b = kp_pk(&bob);
    let meta = ok(env.router_buy(&c, &bob, SOL));
    let ev: RoutedTrade = event(&meta);
    assert_eq!((ev.venue, ev.quote_gross), (1, SOL));
    assert!(ev.fee.abs_diff(SOL / 80) <= 2, "fee {}", ev.fee);
    assert_eq!(ev.base_amount, env.base_balance(&b, &c.mint));
    println!("router buy (DAMM) CU {}", meta.compute_units_consumed);
    let meta = ok(env.router_sell(&c, &bob, ev.base_amount));
    let ev: RoutedTrade = event(&meta);
    assert!(ev.fee.abs_diff(ev.quote_gross / 80) <= 2);
    println!("router sell (DAMM) CU {}", meta.compute_units_consumed);
}

#[test]
fn regression_router_requires_canonical_ata_and_rejects_spoofed_accounts() {
    let (mut env, c) = setup();
    let other = env.launch(0);
    env.skip_launch_window();
    let alice = env.new_user(100);
    let a = kp_pk(&alice);
    ok(env.router_buy(&c, &alice, SOL));
    let mut prep = meteora::wrap_sol_ixs(&a, 5 * SOL);
    prep.push(meteora::create_ata_idempotent_ix(&a, &a, &other.mint, &TOKEN_2022));
    ok(env.send_as(&alice, &prep, &[&alice]));
    let good = env.router_buy_ix(&c, &a, SOL / 10, 0, 0);
    let try_with = |env: &mut Env, f: &dyn Fn(&mut solana_instruction::Instruction)| {
        let mut i = good.clone();
        f(&mut i);
        let r = env.send_as(&alice, &[i], &[&alice]);
        err_code(&r)
    };
    let n = 6; // Route accounts: trader, global, coin, venue_program, event_authority, program
    // Another coin's pool (and its vaults/mint) behind this coin.
    let o = meteora::dbc_swap_accounts(&other.config, &other.mint, &a, &wsol_ata(&a), &base_ata(&a, &other.mint), false);
    assert_eq!(
        try_with(&mut env, &|i| {
            for (k, mm) in o.iter().enumerate() {
                i.accounts[n + k].pubkey = addr(&mm.pubkey);
            }
        }),
        Some(fumpad_err(FumpadError::WrongVenue))
    );
    // DAMM program while the coin is on the curve.
    assert_eq!(try_with(&mut env, &|i| i.accounts[3].pubkey = addr(&meteora::DAMM)), Some(fumpad_err(FumpadError::WrongVenue)));
    // Referral set (would skew the fee measurement).
    assert_eq!(
        try_with(&mut env, &|i| i.accounts[n + 12].pubkey = addr(&wsol_ata(&a))),
        Some(fumpad_err(FumpadError::WrongVenue))
    );
    // Output = someone else's base ATA (non-canonical for the trader).
    let bob = env.new_user(10);
    let bob_ata = base_ata(&kp_pk(&bob), &c.mint);
    ok(env.send_as(&bob, &[meteora::create_ata_idempotent_ix(&kp_pk(&bob), &kp_pk(&bob), &c.mint, &TOKEN_2022)], &[&bob]));
    assert_eq!(try_with(&mut env, &|i| i.accounts[n + 4].pubkey = addr(&bob_ata)), Some(fumpad_err(FumpadError::InvalidAccount)));
    // Input WSOL account of someone else.
    let bob_wsol = wsol_ata(&kp_pk(&bob));
    env.fund_wsol(&bob, SOL);
    assert_eq!(try_with(&mut env, &|i| i.accounts[n + 3].pubkey = addr(&bob_wsol)), Some(fumpad_err(FumpadError::InvalidAccount)));
    // Too few venue accounts.
    assert_eq!(try_with(&mut env, &|i| { i.accounts.truncate(n + 10); }), Some(fumpad_err(FumpadError::WrongVenue)));
    // ExactOut mode / zero amount.
    let i = env.router_buy_ix(&c, &a, SOL / 10, 0, 2);
    assert_fumpad_err(env.send_as(&alice, &[i], &[&alice]), FumpadError::InvalidParams);
    let i = env.router_buy_ix(&c, &a, 0, 0, 0);
    assert_fumpad_err(env.send_as(&alice, &[i], &[&alice]), FumpadError::ZeroAmount);
    // Slippage is the venue's (min_out passed through).
    let i = env.router_buy_ix(&c, &a, SOL / 10, u64::MAX, 0);
    assert!(env.send_as(&alice, &[i], &[&alice]).is_err());
    let _ = WSOL;
}

#[test]
fn regression_pause_never_freezes_router_sells_and_lapses() {
    let (mut env, c) = setup();
    let alice = env.new_user(100);
    ok(env.router_buy(&c, &alice, SOL));
    let admin = env.admin.insecure_clone();
    ok(env.set_pause(&admin, PAUSE_TRADE));
    assert_fumpad_err(env.router_buy(&c, &alice, SOL), FumpadError::Paused);
    let bal = env.base_balance(&kp_pk(&alice), &c.mint);
    ok(env.router_sell(&c, &alice, bal / 3));
    // Third-party venues are unaffected by FUMPAD's flags.
    ok(env.direct_buy(&c, &alice, SOL));
    // Pauses lapse after 7 days unless renewed.
    env.warp(fumpad::MAX_PAUSE_SECS);
    ok(env.router_buy(&c, &alice, SOL));
}
