//! D10 — reference-price floor on ticket sell prices (SPEC §5.3, `math/reference.rs`),
//! refined by D12: ticket = max(execution, reference × execution ÷ pre-trade spot).
//!
//! Exploits (must no longer yield an exploitable ticket):
//!   * curve, two wallets: A dumps via FUMPAD → B sells (ticket) → A rebuys, one tx;
//!   * PumpSwap, one wallet: direct dump → FUMPAD `swap_sell` (ticket) → direct rebuy,
//!     one bundle (same timestamp);
//!   * idle-coin variant: a staged crashed "last spot", then ≥10 idle minutes.
//! D12 ratio-gaming attempts: a huge own sell after a crash, a pump before the sell, and
//! the residual "inventory-backed self-impact round trip" (documented, bounded).
//! Honest behaviour: normal sells (big ones too), a genuine slow decline.

use fumpad::{
    error::FumpadError,
    events::{TicketCreated, Trade},
    math::{
        price::meets_multiple,
        reference::{ticket_price_q64, REFERENCE_MAX_UNCONFIRMED_SECS},
    },
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
/// Returns the seller's FUMPAD sell metadata and the spot right before that sell.
fn pumpswap_bundle(
    f: &mut Flow,
    dumper: &Keypair,
    seller: &Keypair,
    dump: u64,
    sell_tokens: u64,
) -> (litesvm::types::TransactionMetadata, u128) {
    let (q0, b0) = pool_reserves(f);
    let d = kp_pk(dumper);
    if dump > 0 {
        let i = f.direct_sell_ix(&d, dump);
        ok(f.env.send_as(dumper, &[cu_limit(400_000), i], &[dumper]));
    }
    let pre_sell = f.spot_q64();
    let i = f.swap_sell_ix(&kp_pk(seller), sell_tokens);
    let m = ok(f.env.send_as(seller, &[cu_limit(1_400_000), i], &[seller]));
    // Buy back D + S tokens: quote needed ≈ k/b0 − k/b1, grossed up for PumpSwap's fees.
    let (_, b1) = pool_reserves(f);
    let need = q0 - q0 * b0 / b1;
    let quote_in = (need * 1_004 / 1_000) as u64;
    let i = f.direct_buy_ix(&d, quote_in, true);
    ok(f.env.send_as(dumper, &[cu_limit(400_000), i], &[dumper]));
    (m, pre_sell)
}

/// The D12 ticket price the program must have recorded for a sell (exact recomputation).
fn d12_price(f: &Flow, exec: u128, pre_sell: u128) -> u128 {
    ticket_price_q64(exec, f.coin_state().reference.avg_q64, pre_sell)
}

// ═════════════════════════════════════════════════════════════════════════════
// Exploits
// ═════════════════════════════════════════════════════════════════════════════

/// Curve, two wallets, one transaction: A dumps via FUMPAD, B sells (ticket), A rebuys.
/// B sells into the crashed curve, so B's own slippage ratio (execution ÷ pre-trade spot)
/// is ≈ 1 and B's ticket stays at ≈ the pre-attack reference (D12 scales the reference by
/// only B's own impact); the later claim — when the coin trades at ~14x B's *execution*
/// price, which would have paid without D10 — is rejected.
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
    // B's pre-trade spot = the curve right after A's dump (A's Trade event reserves).
    let ta = trades.iter().find(|t| t.user == ak && !t.is_buy).unwrap();
    let b_pre = ((ta.virtual_sol_reserves as u128) << 64) / ta.virtual_token_reserves as u128;
    assert!(b_pre * 8 < pre_attack);
    let created = events::<TicketCreated>(&m);
    assert_eq!(created.len(), 2);
    let tb = f.ticket(&b_ticket);
    assert_eq!(tb.status, TicketStatus::Open);
    // The reference ignored the crash (zero weight) …
    assert!(close(f.coin_state().reference.avg_q64, pre_attack, 1_000));
    // … and B's ticket = reference × B's own slippage ratio (exact), far above the crash.
    assert_eq!(tb.sell_price_q64, d12_price(&f, b_exec, b_pre));
    assert!(tb.sell_price_q64 * 100 >= pre_attack * 90, "ticket {} vs pre-attack {pre_attack}", tb.sell_price_q64);
    assert!(tb.sell_price_q64 > b_exec * 7);
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
    let (m, pre_sell) = pumpswap_bundle(&mut f, &whale, &whale, dump, 30_000_000_000_000);

    let exec = events::<Trade>(&m)[0].price_q64;
    assert!(exec * 15 < pre_attack, "crash too small: exec {exec} vs {pre_attack}");
    let t = f.ticket(&ticket);
    assert_eq!(t.owner, wk);
    // The staged crash got zero weight in the reference, and the sell's own slippage on
    // the crashed pool is small: ticket = reference × ratio ≈ the pre-attack price.
    assert!(f.coin_state().reference.avg_q64 >= ref_before);
    assert_eq!(t.sell_price_q64, d12_price(&f, exec, pre_sell));
    assert!(t.sell_price_q64 * 100 >= pre_attack * 95, "ticket {} vs pre-attack {pre_attack}", t.sell_price_q64);
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
        let _ = pumpswap_bundle(&mut f, &whale, &whale, dump, 1_000_000_000_000);
        let c = f.coin_state();
        assert!(c.reference.last_spot_q64 * 15 < pre_attack, "staged crashed last spot");
        assert!(c.reference.avg_q64 >= ref_before, "the staging bundle itself got zero weight");

        f.env.warp(3_600);
        if heartbeat {
            ok(f.keeper_sample()); // keeper heartbeat at the genuine price
            f.env.warp(60);
        }
        let ticket = f.next_ticket(&wk);
        let (m, pre_sell) = pumpswap_bundle(&mut f, &whale, &whale, dump, 30_000_000_000_000);
        let exec = events::<Trade>(&m)[0].price_q64;
        let t = f.ticket(&ticket);
        let reference = f.coin_state().reference.avg_q64;
        assert_eq!(t.sell_price_q64, d12_price(&f, exec, pre_sell));
        if heartbeat {
            assert!(reference >= ref_before, "heartbeat erased the staged spot");
            assert!(t.sell_price_q64 * 100 >= pre_attack * 95);
        } else {
            // One idle interval moves the reference at most 1/4 of the way to the crash;
            // the ticket is that reference × the sell's own (small) slippage ratio.
            assert_eq!(REFERENCE_MAX_UNCONFIRMED_SECS, 150);
            let staged = f.coin_state().reference.last_spot_q64.min(exec);
            let bound = ref_before - (ref_before - staged) / 4;
            assert!(reference + 1 >= bound, "reference {reference} vs bound {bound}");
            assert!(t.sell_price_q64 * 100 >= pre_attack * 70 && t.sell_price_q64 < pre_attack);
        }
        // Either way the ticket is nowhere near 10x-able at the normal price.
        f.keeper_samples(125, 15);
        let median = f.median().unwrap();
        assert!(meets_multiple(median, exec, TEN_X));
        expect_err(f.claim(&whale, ticket), FumpadError::TriggerNotMet);
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// D12: gaming the slippage ratio
// ═════════════════════════════════════════════════════════════════════════════

/// One graduated coin after ~1 h of flat, keeper-sampled market; whale holds ~550M tokens.
fn flat_graduated() -> (Flow, Keypair) {
    let mut f = Flow::new();
    let whale = graduated(&mut f);
    f.keeper_samples(250, 15);
    f.env.warp(5);
    (f, whale)
}

/// The same sale S (¼ of the pool's base reserve) by the same matured whale, with the
/// pre-trade spot (a) untouched, (b) crashed ~20x first, (c) pumped ~9x first — each
/// manipulation undone in the same bundle. Moving the pre-trade spot never lowers the
/// ticket below the honest one:
///   (b) the crashed pool is deeper in base, so S's own slippage is SMALLER (ratio → 1);
///   (c) S executes into the pumped price, so execution itself is higher.
/// Returns (ticket price, pre-attack spot, execution) per mode.
fn sale_after_manipulation(mode: u8) -> (u128, u128, u128) {
    let (mut f, whale) = flat_graduated();
    let wk = kp_pk(&whale);
    let pre_attack = f.spot_q64();
    let (q, base) = pool_reserves(&f);
    let s = (base / 4) as u64;
    let ticket = f.next_ticket(&wk);
    let m = match mode {
        0 => ok(f.swap_sell(&whale, s)),
        1 => pumpswap_bundle(&mut f, &whale, &whale, (base * 347 / 100) as u64, s).0,
        _ => {
            // Pump: buy with 2× the pool's quote (price ×9), sell S via FUMPAD, dump back.
            let before = f.tokens(&wk);
            let i = f.direct_buy_ix(&wk, (2 * q) as u64, true);
            ok(f.env.send_as(&whale, &[cu_limit(400_000), i], &[&whale]));
            let bought = f.tokens(&wk) - before;
            assert!(f.spot_q64() > pre_attack * 8);
            let m = ok(f.swap_sell(&whale, s));
            let i = f.direct_sell_ix(&wk, bought);
            ok(f.env.send_as(&whale, &[cu_limit(400_000), i], &[&whale]));
            m
        }
    };
    let exec = events::<Trade>(&m)[0].price_q64;
    let t = f.ticket(&ticket);
    assert_eq!(t.tokens, s);
    (t.sell_price_q64, pre_attack, exec)
}

#[test]
fn d12_moving_pre_trade_spot_never_lowers_the_ticket() {
    let (honest, pre, honest_exec) = sale_after_manipulation(0);
    // Honest: own slippage ≈ 20% (> the 10% cap) → ticket floored at ≈ 90% of reference.
    assert!(honest >= honest_exec && honest_exec * 100 <= pre * 81);
    assert!(honest * 100 >= pre * 89 && honest * 100 <= pre * 91, "{honest} vs {pre}");
    let (crashed, pre_c, exec_c) = sale_after_manipulation(1);
    assert_eq!(pre_c, pre, "identical worlds");
    assert!(exec_c * 15 < pre, "the sale executed at the crashed price");
    assert!(crashed >= honest, "crash first: {crashed} < honest {honest}");
    assert!(crashed * 100 >= pre * 93, "deeper pool → ratio ≈ 1 → ticket ≈ reference: {crashed} vs {pre}");
    let (pumped, pre_p, exec_p) = sale_after_manipulation(2);
    assert_eq!(pre_p, pre);
    assert!(pumped >= honest && pumped == exec_p, "pump first: ticket = (higher) execution");
    println!("D12 same sale: honest {honest}, after crash {crashed}, after pump {pumped} (pre {pre})");
}

/// Self-impact round trip (SPEC §5.3): an attacker holding inventory sells a LARGE amount
/// through FUMPAD and buys it back directly on PumpSwap in the same bundle. Uncapped D12
/// would price the ticket like an honest exit (≈ ½ the reference here); the 10% cap
/// limits the discount to 10%, at the cost of honest exits with > 10% own impact. Further
/// bounds: the inventory must be held
/// (matured ≥ 10 min for the ticket's part), and the round trip costs FUMPAD's 1% (half
/// of it funds the reward pool) + PumpSwap's 2 × 0.25% on the whole sale.
#[test]
fn d12_self_impact_round_trip_discount_is_capped() {
    let (mut f, whale) = flat_graduated();
    let wk = kp_pk(&whale);
    let pre = f.spot_q64();
    let (q0, b0) = pool_reserves(&f);
    let s = b0 as u64;
    let ticket = f.next_ticket(&wk);
    let m = ok(f.swap_sell(&whale, s));
    let trades = events::<Trade>(&m);
    let tr = &trades[0];
    let fee = tr.fee_pool + tr.fee_platform + tr.fee_creator;
    let tp = f.ticket(&ticket).sell_price_q64;
    assert_eq!(tp, d12_price(&f, tr.price_q64, pre));
    assert!(tr.price_q64 * 100 <= pre * 50, "the sale's own slippage ≈ ½");
    assert!(tp * 100 >= pre * 89 && tp * 100 <= pre * 91, "discount capped at 10% (D12 cap): {tp} vs {pre}");

    // Buy the same amount back directly on PumpSwap (outside FUMPAD: no rebuy debit).
    let (_, b1) = pool_reserves(&f);
    let quote_in = ((q0 - q0 * b0 / b1) * 1_004 / 1_000) as u64;
    let before = f.tokens(&wk);
    let i = f.direct_buy_ix(&wk, quote_in, true);
    ok(f.env.send_as(&whale, &[cu_limit(400_000), i], &[&whale]));
    let back = f.tokens(&wk) - before;
    assert!(close(back as u128, s as u128, 2_000) && close(f.spot_q64(), pre, 5_000), "price restored");
    // Cost of the round trip (extra tokens bought back valued at spot): ≥ 1.4% of the sale.
    let net = tr.sol_amount - fee;
    let extra_value = ((back as i128 - s as i128) * pre as i128) >> 64;
    let cost = quote_in as i128 - net as i128 - extra_value;
    assert!(cost * 1_000 >= tr.sol_amount as i128 * 14, "cost {cost} on a {} sale", tr.sol_amount);
    println!(
        "D12 residual: sale {} lamports, round-trip cost {cost} ({} bps), ticket at {}% of pre-sale spot",
        tr.sol_amount,
        cost * 10_000 / tr.sol_amount as i128,
        tp * 100 / pre
    );
}

// ═════════════════════════════════════════════════════════════════════════════
// Honest behaviour
// ═════════════════════════════════════════════════════════════════════════════

/// Normal sells. Rising market (the reference lags below spot): ticket = execution price
/// exactly. Flat market: the reference equals the pre-sale spot, so (D12) the ticket is
/// the execution price too — until the sell's own impact exceeds 10%, where the floor is
/// capped at 90% of the reference.
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

    // Flat market (nothing for 20 min): reference = spot exactly → ticket = execution.
    f.env.warp(1_200);
    let pre = f.spot_q64();
    let t2 = f.next_ticket(&sk);
    let m = ok(f.sell(&s, f.tokens(&sk) / 10));
    let exec = events::<Trade>(&m)[0].price_q64;
    let t = f.ticket(&t2);
    assert_eq!(f.coin_state().reference.avg_q64, pre);
    assert_eq!(t.sell_price_q64, exec, "flat market: ticket = execution price");
    // Big honest sell in a flat market: ~a quarter of the price gone to its own impact,
    // still ticket = execution price (D10 alone would have priced it at the pre-sale spot).
    let big = f.env.new_user(100);
    let bk = kp_pk(&big);
    ok(f.buy(&big, 30 * SOL));
    f.env.warp(1_200);
    let pre = f.spot_q64();
    let t_big = f.next_ticket(&bk);
    let m = ok(f.sell(&big, f.tokens(&bk)));
    let exec = events::<Trade>(&m)[0].price_q64;
    assert!(exec * 100 < pre * 80, "a big sell: exec {exec} vs pre {pre}");
    // Own impact > 10%: floor capped at 90% of the reference (= pre-sale spot, flat market).
    let tb = f.ticket(&t_big).sell_price_q64;
    assert!(tb > exec && close(tb, pre * 9 / 10, 1_000), "big curve sell: ticket {tb} vs 0.9 × pre {}", pre * 9 / 10);
    assert_eq!(f.coin_state().tickets_created, 3);

    // Same on PumpSwap after graduation.
    let _whale = graduated(&mut f);
    let p = f.env.new_user(100);
    let pk_ = kp_pk(&p);
    ok(f.swap_buy(&p, 2 * SOL));
    f.keeper_samples(50, 15); // 12.5 min of flat market
    let t3 = f.next_ticket(&pk_);
    let pre = f.spot_q64();
    let m = ok(f.swap_sell(&p, f.tokens(&pk_) / 2));
    println!("CU: swap_sell creating a ticket = {}", m.compute_units_consumed);
    let exec = events::<Trade>(&m)[0].price_q64;
    let t = f.ticket(&t3);
    assert!(t.sell_price_q64 >= exec && t.sell_price_q64 <= pre);
    // The keeper-sampled reference is within rounding of spot → ticket ≈ execution.
    assert!(close(t.sell_price_q64, exec, 1_000), "ticket {} exec {exec}", t.sell_price_q64);
    // Big honest router sell (half the pool's base reserve) in a flat market.
    f.keeper_samples(50, 15);
    let (_, base) = pool_reserves(&f);
    let w = _whale.insecure_clone();
    let t4 = f.next_ticket(&kp_pk(&w));
    let pre = f.spot_q64();
    let ref_before = f.coin_state().reference.avg_q64;
    let m = ok(f.swap_sell(&w, (base / 2) as u64));
    let exec = events::<Trade>(&m)[0].price_q64;
    assert!(exec * 100 < pre * 70);
    let t4p = f.ticket(&t4).sell_price_q64;
    // Own impact > 10% → floor = 90% of the reference. The keeper-sampled reference lags
    // spot slightly after the earlier sale, so compare against the reference itself (the
    // hook folds the interval since the last sample first: allow 1%).
    assert!(t4p > exec, "ticket above execution");
    assert!(close(t4p, ref_before * 9 / 10, 10_000), "big router sell: ticket {t4p} vs 0.9 × ref {}", ref_before * 9 / 10);
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
