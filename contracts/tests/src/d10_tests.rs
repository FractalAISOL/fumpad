//! D10 — reference-price floor on ticket sell prices (SPEC §5.3, `math/reference.rs`).
//!
//! Exploits (must no longer yield an exploitable ticket):
//!   * curve, two wallets: A dumps via FUMPAD → B sells (ticket) → A rebuys, one tx;
//!   * PumpSwap, one wallet: direct dump → FUMPAD `swap_sell` (ticket) → direct rebuy,
//!     one bundle (same timestamp);
//!   * idle-coin variant: a staged crashed "last spot", then ≥10 idle minutes.
//! Honest behaviour: normal sells, a genuine slow decline.

use fumpad::{
    error::FumpadError,
    events::{TicketCreated, Trade},
    math::{price::meets_multiple, reference::REFERENCE_MAX_UNCONFIRMED_SECS},
    state::*,
};
use solana_keypair::Keypair;

use crate::flow::*;
use crate::*;

const TEN_X: u32 = 100_000;

/// |a − b| ≤ b × ppm / 1e6
fn close(a: u128, b: u128, ppm: u128) -> bool {
    a.abs_diff(b) * 1_000_000 <= b * ppm
}

/// Curve the whale fills (≈85 SOL), graduate, oracle + queue setup. Returns the whale.
fn graduated(f: &mut Flow) -> Keypair {
    let whale = f.env.new_user(1_000);
    ok(f.buy(&whale, 200 * SOL));
    assert_eq!(f.coin_state().status, CoinStatus::Complete);
    ok(f.graduate());
    f.post_graduation_setup();
    whale
}

/// Effective quote/base of the pool.
fn pool_reserves(f: &Flow) -> (u128, u128) {
    let base = token_balance(&f.env, &f.pool_base) as u128;
    let quote = (f.spot_q64() * base) >> 64;
    (quote, base)
}

/// The PumpSwap bundle: `dumper` dumps `dump` tokens directly, `seller` sells
/// `sell_tokens` through FUMPAD, `dumper` buys back directly until the pool's base
/// reserve is back where it started. Three transactions, same timestamp (a Jito bundle).
/// Returns the seller's FUMPAD sell metadata.
fn pumpswap_bundle(
    f: &mut Flow,
    dumper: &Keypair,
    seller: &Keypair,
    dump: u64,
    sell_tokens: u64,
) -> litesvm::types::TransactionMetadata {
    let (q0, b0) = pool_reserves(f);
    let d = kp_pk(dumper);
    let i = f.direct_sell_ix(&d, dump);
    ok(f.env.send_as(dumper, &[cu_limit(400_000), i], &[dumper]));
    let i = f.swap_sell_ix(&kp_pk(seller), sell_tokens);
    let m = ok(f.env.send_as(seller, &[cu_limit(1_400_000), i], &[seller]));
    // Buy back D + S tokens: quote needed ≈ k/b0 − k/b1, grossed up for PumpSwap's fees.
    let (_, b1) = pool_reserves(f);
    let need = q0 - q0 * b0 / b1;
    let quote_in = (need * 1_004 / 1_000) as u64;
    let i = f.direct_buy_ix(&d, quote_in, true);
    ok(f.env.send_as(dumper, &[cu_limit(400_000), i], &[dumper]));
    m
}

// ═════════════════════════════════════════════════════════════════════════════
// Exploits
// ═════════════════════════════════════════════════════════════════════════════

/// Curve, two wallets, one transaction: A dumps via FUMPAD, B sells (ticket), A rebuys.
/// B's ticket is priced at the pre-attack reference, and the later claim — when the coin
/// trades at ~14x B's *execution* price, which would have paid without D10 — is rejected.
#[test]
fn exploit_curve_two_wallet_dump_sell_rebuy_is_neutralized() {
    let mut f = Flow::new();
    let a = f.env.new_user(1_000);
    let b = f.env.new_user(100);
    let (ak, bk) = (kp_pk(&a), kp_pk(&b));
    ok(f.buy(&b, 2 * SOL)); // B: cheap early tokens
    ok(f.buy(&a, 75 * SOL)); // A: pushes the curve ~11x
    f.env.warp(700); // B matured; the post-A spot has stood > 10 min
    let pre_attack = f.spot_q64();

    // One transaction (atomic): A sells everything, B sells everything, A rebuys.
    let a_tokens = f.tokens(&ak);
    let b_tokens = f.tokens(&bk);
    let a_ticket = f.next_ticket(&ak);
    let b_ticket = f.next_ticket(&bk);
    let sell_a = f.sell_ix(&ak, a_tokens);
    let sell_b = f.sell_ix(&bk, b_tokens);
    let mut rebuy = f.buy_ix(&ak, 75 * SOL);
    // A's own dump also made a ticket (seq 0) — the rebuy must pass it (and voids it).
    rebuy.accounts.push(solana_instruction::AccountMeta { pubkey: addr(&a_ticket), is_signer: false, is_writable: true });
    let m = ok(f.env.send_as(&a, &[cu_limit(1_400_000), sell_a, sell_b, rebuy], &[&a, &b]));

    let trades = events::<Trade>(&m);
    let b_exec = trades.iter().find(|t| t.user == bk).unwrap().price_q64;
    assert!(b_exec * 8 < pre_attack, "the dump crashed B's execution price ({b_exec} vs {pre_attack})");
    let created = events::<TicketCreated>(&m);
    assert_eq!(created.len(), 2);
    let tb = f.ticket(&b_ticket);
    assert_eq!(tb.status, TicketStatus::Open);
    // D10: B's ticket is priced at the pre-attack reference, not the crashed execution.
    assert!(close(tb.sell_price_q64, pre_attack, 1_000), "ticket {} vs pre-attack {pre_attack}", tb.sell_price_q64);
    // A's own ticket was voided by A's rebuy.
    assert_eq!(f.ticket(&a_ticket).status, TicketStatus::Voided);
    f.assert_invariant();

    // Coin completes and graduates; keeper samples for 30 min at the pool's price.
    let c = f.env.new_user(1_000);
    ok(f.buy(&c, 200 * SOL));
    ok(f.graduate());
    f.post_graduation_setup();
    f.keeper_samples(125, 15);
    let median = f.median().unwrap();
    // Without D10 this ticket would be claimable: the coin trades ≥10x B's execution price.
    assert!(meets_multiple(median, b_exec, TEN_X), "median {median} vs exec {b_exec}");
    assert!(!meets_multiple(median, tb.sell_price_q64, TEN_X));
    expect_err(f.claim(&b, b_ticket), FumpadError::TriggerNotMet);
}

/// PumpSwap, one wallet, one bundle: direct dump (~20x crash) → FUMPAD swap_sell →
/// direct rebuy. The ticket is priced at the pre-attack reference; a claim when the coin
/// is back at its normal price (= 20x the crashed price) is rejected.
#[test]
fn exploit_pumpswap_dump_swap_sell_rebuy_is_neutralized() {
    let mut f = Flow::new();
    let whale = graduated(&mut f);
    let wk = kp_pk(&whale);
    f.keeper_samples(250, 15); // honest flat market for ~1 h; whale's curve tokens long matured
    f.env.warp(5);
    let pre_attack = f.spot_q64();
    let ref_before = f.coin_state().reference.avg_q64;
    assert!(close(ref_before, pre_attack, 5_000), "honest reference ≈ spot after 1 h flat");
    let (_, base) = pool_reserves(&f);

    // Crash ~20x: base × √20 ≈ 4.47 → dump 3.47 × base reserve.
    let dump = (base * 347 / 100) as u64;
    assert!(f.tokens(&wk) > dump + 30_000_000_000_000);
    let ticket = f.next_ticket(&wk);
    let m = pumpswap_bundle(&mut f, &whale, &whale, dump, 30_000_000_000_000);

    let exec = events::<Trade>(&m)[0].price_q64;
    assert!(exec * 15 < pre_attack, "crash too small: exec {exec} vs {pre_attack}");
    let t = f.ticket(&ticket);
    assert_eq!(t.owner, wk);
    // The staged crash got zero weight: the ticket is at (or above) the pre-attack reference.
    assert!(t.sell_price_q64 >= ref_before);
    assert!(close(t.sell_price_q64, pre_attack, 5_000), "ticket {} vs pre-attack {pre_attack}", t.sell_price_q64);
    assert!(close(f.spot_q64(), pre_attack, 20_000), "bundle restored the price");
    f.assert_invariant();

    // The coin trades at its normal price (~20x the crashed one) for 30 min.
    f.keeper_samples(125, 15);
    let median = f.median().unwrap();
    assert!(meets_multiple(median, exec, TEN_X), "without D10 this would pay");
    expect_err(f.claim(&whale, ticket), FumpadError::TriggerNotMet);
    assert_eq!(f.ticket(&ticket).status, TicketStatus::Open);
}

/// Idle-coin variant: the attacker first stages a crashed "last spot" (dump → FUMPAD
/// touch → rebuy), lets the coin sit idle for an hour (no trades, no keeper), then runs
/// the bundle. Folding max(last, pre-spot) with α ≤ 1/4 bounds the damage to a quarter
/// of the gap; a single honest touch point (keeper heartbeat) in between erases it.
#[test]
fn exploit_idle_coin_staged_last_spot_is_bounded() {
    for heartbeat in [false, true] {
        let mut f = Flow::new();
        let whale = graduated(&mut f);
        let wk = kp_pk(&whale);
        f.keeper_samples(250, 15); // honest flat market for ~1 h
        f.env.warp(5);
        let pre_attack = f.spot_q64();
        let ref_before = f.coin_state().reference.avg_q64;
        assert!(close(ref_before, pre_attack, 5_000));
        let (_, base) = pool_reserves(&f);
        let dump = (base * 347 / 100) as u64;

        // Stage: crash, a dust FUMPAD sell records the crashed spot as `last`, restore.
        pumpswap_bundle(&mut f, &whale, &whale, dump, 1_000_000_000_000);
        let c = f.coin_state();
        assert!(c.reference.last_spot_q64 * 15 < pre_attack, "staged crashed last spot");
        assert!(c.reference.avg_q64 >= ref_before, "the staging bundle itself got zero weight");

        f.env.warp(3_600);
        if heartbeat {
            ok(f.keeper_sample()); // keeper heartbeat at the genuine price
            f.env.warp(60);
        }
        let ticket = f.next_ticket(&wk);
        let m = pumpswap_bundle(&mut f, &whale, &whale, dump, 30_000_000_000_000);
        let exec = events::<Trade>(&m)[0].price_q64;
        let t = f.ticket(&ticket);
        if heartbeat {
            assert!(t.sell_price_q64 >= ref_before, "heartbeat erased the staged spot");
            assert!(close(t.sell_price_q64, pre_attack, 5_000));
        } else {
            // One idle interval moves the reference at most 1/4 of the way to the crash.
            assert_eq!(REFERENCE_MAX_UNCONFIRMED_SECS, 150);
            let staged = f.coin_state().reference.last_spot_q64.min(exec);
            let bound = ref_before - (ref_before - staged) / 4;
            assert!(t.sell_price_q64 + 1 >= bound, "ticket {} vs bound {bound}", t.sell_price_q64);
            assert!(t.sell_price_q64 * 100 >= pre_attack * 74 && t.sell_price_q64 < pre_attack);
        }
        // Either way the ticket is nowhere near 10x-able at the normal price.
        f.keeper_samples(125, 15);
        let median = f.median().unwrap();
        assert!(meets_multiple(median, exec, TEN_X));
        expect_err(f.claim(&whale, ticket), FumpadError::TriggerNotMet);
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// Honest behaviour
// ═════════════════════════════════════════════════════════════════════════════

/// Normal sells. Rising market (the reference lags below spot): ticket = execution price
/// exactly. Flat market: the reference equals the pre-sale spot, so the ticket is the
/// pre-sale spot — above execution only by the sell's own price impact.
#[test]
fn honest_sells_ticket_at_execution_price() {
    let mut f = Flow::new();
    let s = f.env.new_user(100);
    let sk = kp_pk(&s);
    ok(f.buy(&s, 3 * SOL));
    f.env.warp(600);
    let other = f.env.new_user(100);
    ok(f.buy(&other, 20 * SOL)); // genuine rally 60 s before the sell
    f.env.warp(60);
    let t1 = f.next_ticket(&sk);
    let m = ok(f.sell(&s, f.tokens(&sk) / 3));
    let exec = events::<Trade>(&m)[0].price_q64;
    let t = f.ticket(&t1);
    assert_eq!(t.sell_price_q64, exec, "rising market: ticket = execution price");
    assert!(f.coin_state().reference.avg_q64 < exec);

    // Flat market (nothing for 20 min): reference = spot; ticket within impact of exec.
    f.env.warp(1_200);
    let pre = f.spot_q64();
    let t2 = f.next_ticket(&sk);
    let m = ok(f.sell(&s, f.tokens(&sk) / 10));
    let exec = events::<Trade>(&m)[0].price_q64;
    let t = f.ticket(&t2);
    assert_eq!(t.sell_price_q64, pre);
    assert!(close(t.sell_price_q64, exec, 20_000), "≤2% (the sell's own impact)");
    assert_eq!(f.coin_state().tickets_created, 2);

    // Same on PumpSwap after graduation.
    let _whale = graduated(&mut f);
    let p = f.env.new_user(100);
    let pk_ = kp_pk(&p);
    ok(f.swap_buy(&p, 2 * SOL));
    f.keeper_samples(50, 15); // 12.5 min of flat market
    let t3 = f.next_ticket(&pk_);
    let pre = f.spot_q64();
    let m = ok(f.swap_sell(&p, f.tokens(&pk_) / 2));
    let exec = events::<Trade>(&m)[0].price_q64;
    let t = f.ticket(&t3);
    assert!(t.sell_price_q64 >= exec && t.sell_price_q64 <= pre);
    assert!(close(t.sell_price_q64, exec, 30_000), "ticket {} exec {exec}", t.sell_price_q64);
    f.assert_invariant();
}

/// Genuine slow decline: sellers exit every minute for an hour (curve price −~60%).
/// The final seller's ticket tracks the decline: far below the starting price, within a
/// 10-minute lag of the execution price.
#[test]
fn honest_slow_decline_is_tracked() {
    let mut f = Flow::new();
    let s = f.env.new_user(100);
    let sk = kp_pk(&s);
    let mut holders: Vec<Keypair> = (0..6).map(|_| f.env.new_user(100)).collect();
    for h in &holders {
        ok(f.buy(h, 10 * SOL));
    }
    ok(f.buy(&s, 3 * SOL));
    f.env.warp(600);
    let start = f.spot_q64();
    // 60 sells, one per minute, each ~1/10 of what one holder has left.
    let mut spots = vec![];
    for i in 0..60 {
        f.env.warp(60);
        let h = &holders[i % holders.len()];
        let amt = f.tokens(&kp_pk(h)) / 10;
        ok(f.sell(h, amt));
        spots.push(f.spot_q64());
    }
    holders.clear();
    let now_spot = f.spot_q64();
    assert!(now_spot * 100 < start * 55, "price fell: {now_spot} vs {start}");
    let t = f.next_ticket(&sk);
    let m = ok(f.sell(&s, f.tokens(&sk)));
    let exec = events::<Trade>(&m)[0].price_q64;
    let tp = f.ticket(&t).sell_price_q64;
    // Tracks the decline with the 10-minute time constant: between the pre-sale spot and
    // the spot ~one time constant earlier (an EMA lags a convex decline slightly more than
    // τ), within 20% of execution, and far below where the hour started.
    let earlier = spots[spots.len() - 15];
    assert!(tp >= exec && tp >= now_spot);
    assert!(tp <= earlier, "ticket {tp} vs spot 15 min ago {earlier} (exec {exec})");
    assert!(tp * 100 <= exec * 120);
    assert!(tp * 100 < start * 60);
}
