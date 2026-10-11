//! Pre-audit review of the venue / oracle module (router, record_samples, median,
//! D10 reference, execute_buyback), fixed in v0.3. Each `regression_*` test replays the
//! original `bug_*` scenario and asserts the attack now FAILS.
//!
//! All scenarios run on a real coin (create → curve → graduate into the real PumpSwap
//! program) via `flow.rs`. "Bundles" are consecutive transactions at the same timestamp.

use fumpad::{error::FumpadError, math::price::meets_multiple, state::*};
use solana_keypair::Keypair;

use crate::flow::*;
use crate::*;

const TEN_X: u32 = 100_000;

/// Whale fills the curve (≈85 SOL), graduate, observations + queue + buyback setup.
/// The ring's keeper clock starts at `init_observations` time.
fn graduated(f: &mut Flow) -> Keypair {
    let whale = f.env.new_user(1_000);
    ok(f.buy(&whale, 200 * SOL));
    assert_eq!(f.coin_state().status, CoinStatus::Complete);
    ok(f.graduate());
    f.post_graduation_setup();
    whale
}

/// (effective quote, base) of the pool.
fn pool_reserves(f: &Flow) -> (u128, u128) {
    let base = token_balance(&f.env, &f.pool_base) as u128;
    let quote = (f.spot_q64() * base) >> 64;
    (quote, base)
}

fn obs(f: &Flow) -> Observations {
    f.env.fetch_zc(&f.observations)
}

/// Fallback (non-keeper) sample, in its own isolated transaction.
fn fallback_sample(f: &mut Flow, who: &Keypair) -> litesvm::types::TransactionResult {
    let i = f.sample_ix(&kp_pk(who));
    f.env.send_as(who, &[i], &[who])
}

/// Direct PumpSwap dump of `dump` tokens by `trader` (outside FUMPAD).
fn direct_dump(f: &mut Flow, trader: &Keypair, dump: u64) {
    let i = f.direct_sell_ix(&kp_pk(trader), dump);
    ok(f.env.send_as(trader, &[cu_limit(400_000), i], &[trader]));
}

/// Direct PumpSwap buy (WSOL credited up front, as if wrapped). Returns the WSOL put in.
fn direct_buy(f: &mut Flow, trader: &Keypair, quote_in: u64) -> u64 {
    let i = f.direct_buy_ix(&kp_pk(trader), quote_in, true);
    ok(f.env.send_as(trader, &[cu_limit(400_000), i], &[trader]));
    quote_in
}

/// Direct PumpSwap buy that brings the pool's base reserve back to `b0`. Returns WSOL in.
fn direct_restore_base(f: &mut Flow, trader: &Keypair, q0: u128, b0: u128) -> u64 {
    let (_, b1) = pool_reserves(f);
    let need = q0 - q0 * b0 / b1;
    direct_buy(f, trader, (need * 1_004 / 1_000) as u64)
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. V-L1 — a fallback sampler can't lock the keeper out
// ═════════════════════════════════════════════════════════════════════════════

/// Was: spacing was checked against the last sample of ANY kind, so a fallback sampler
/// landing a sample every 10 s made every keeper sample fail with `SampleTooSoon` and kept
/// the coin in fallback mode indefinitely. Now a keeper sample is spaced only against the
/// previous KEEPER sample: it lands right next to the squatter's, closes the fallback path,
/// and the squatter is shut out.
#[test]
fn regression_fallback_sampler_cannot_lock_out_the_keeper() {
    let mut f = Flow::new();
    let _whale = graduated(&mut f);
    let squatter = f.env.new_user(10);
    f.env.warp(601); // keeper stale (no heartbeat yet / outage)

    // Squatter takes the slot; the keeper samples in the same second anyway.
    ok(fallback_sample(&mut f, &squatter));
    ok(f.keeper_sample());
    let o = obs(&f);
    assert_eq!(o.len, 2);
    assert_eq!((o.samples[0].fallback, o.samples[1].fallback), (1, 0));
    assert_eq!(o.last_keeper_sample_ts, f.now());
    for _ in 0..30 {
        f.env.warp(10);
        // Keeper is live again → the permissionless path is closed…
        expect_err(fallback_sample(&mut f, &squatter), FumpadError::Unauthorized);
        // …and the keeper's own spacing still applies (10 s vs its previous sample).
        ok(f.keeper_sample());
        expect_err(f.keeper_sample(), FumpadError::SampleTooSoon);
    }
    let o = obs(&f);
    assert_eq!(o.len, 32);
    assert_eq!((1..32).filter(|&i| o.samples[i].fallback == 0).count(), 31);
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. V-M1 — keeper outage: bundled fallback samples no longer decide the median
// ═════════════════════════════════════════════════════════════════════════════

/// Was: during a keeper outage an attacker's [pump][isolated fallback sample][dump] bundles
/// counted in the median like keeper samples, so ~60 pumped samples made a never-moved
/// ticket claimable. Now fallback samples are excluded from the median and from its
/// coverage: the claim fails with InsufficientSamples (claims pause during the outage), and
/// once the keeper is back its samples at the genuine price decide → TriggerNotMet.
#[test]
fn regression_keeper_outage_fallback_samples_do_not_set_the_median() {
    let mut f = Flow::new();
    let _whale = graduated(&mut f);
    // Honest seller: router buy, matures, router sell at the genuine price → ticket.
    let seller = f.env.new_user(100);
    let sk = kp_pk(&seller);
    ok(f.swap_buy(&seller, 5 * SOL));
    f.keeper_samples(45, 15); // ~11 min of healthy keeper sampling
    let ticket = f.next_ticket(&sk);
    ok(f.swap_sell(&seller, f.tokens(&sk)));
    let t = f.ticket(&ticket);
    assert_eq!(t.status, TicketStatus::Open);
    let genuine = f.spot_q64();

    // Keeper goes down. 10 min later sampling is permissionless.
    f.env.warp(601);
    let attacker = f.env.new_user(10);
    let ak = kp_pk(&attacker);
    let mk_ata = create_ata_ix(&ak, &ak, &f.mint, &T22);
    ok(f.env.send_as(&attacker, &[mk_ata], &[&attacker]));
    let (q0, _b0) = pool_reserves(&f);
    for i in 0..90 {
        if i % 3 != 2 {
            // Bundle: pump (×~16 price) → sample → dump back.
            let before = f.tokens(&ak);
            direct_buy(&mut f, &attacker, (q0 * 3) as u64);
            assert!(f.spot_q64() > genuine * 11);
            ok(fallback_sample(&mut f, &attacker));
            let got = f.tokens(&ak) - before;
            direct_dump(&mut f, &attacker, got);
        } else {
            ok(fallback_sample(&mut f, &attacker));
        }
        f.env.warp(10);
    }
    let o = obs(&f);
    assert_eq!((0..o.len as usize).filter(|&i| o.samples[i].fallback == 1).count(), 90);
    // No keeper median (the ~20 older keeper samples left in the window don't cover it).
    assert_eq!(f.median(), None);
    expect_err(f.claim(&seller, ticket), FumpadError::InsufficientSamples);
    assert_eq!(f.ticket(&ticket).status, TicketStatus::Open);
    // Even ignoring coverage, the keeper-only median is the genuine price.
    let p = Params::default();
    let m = o.median_price_q64(f.now(), p.oracle_window_secs, 1);
    assert!(m.is_none() || m.unwrap() < genuine * 2);

    // Keeper back: 30 min of honest samples → median ≈ genuine → not 10x.
    f.keeper_samples(125, 15);
    let median = f.median().unwrap();
    assert!(median < genuine * 2, "median {median} vs genuine {genuine}");
    assert!(!meets_multiple(median, t.sell_price_q64, TEN_X));
    expect_err(f.claim(&seller, ticket), FumpadError::TriggerNotMet);
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. V-M2 — fallback samples can't drag the D10 reference on an un-heartbeated coin
// ═════════════════════════════════════════════════════════════════════════════

/// Was: on a coin the keeper didn't heartbeat, [dump → fallback sample → rebuy] every
/// 150 s dragged the reference to < 1/10 of the genuine price in ~13 bundles, then a staged
/// crash sell got a ticket priced at the dragged reference that the honest median made
/// claimable. Now fallback samples are raise-only D10 touch points (they can't lower the
/// average nor the carried `last` spot), so the reference stays at the genuine price, the
/// staged sell's ticket is floored near it, and the claim fails.
#[test]
fn regression_fallback_samples_cannot_drag_reference() {
    let mut f = Flow::new();
    let whale = graduated(&mut f);
    let wk = kp_pk(&whale);
    f.keeper_samples(250, 15);
    f.env.warp(601);
    let genuine = f.spot_q64();
    let ref0 = f.coin_state().reference.avg_q64;
    assert!(ref0.abs_diff(genuine) * 100 < genuine, "honest reference ≈ spot");
    let (q0, b0) = pool_reserves(&f);
    let dump = (b0 * 347 / 100) as u64; // ~20x crash
    assert!(f.tokens(&wk) > dump + 30_000_000_000_000);

    // The same 14 staged bundles as the original PoC.
    for _ in 0..14 {
        direct_dump(&mut f, &whale, dump);
        ok(fallback_sample(&mut f, &whale)); // fallback touch at the crashed spot
        direct_restore_base(&mut f, &whale, q0, b0);
        assert!(f.coin_state().reference.avg_q64 >= ref0, "fallback samples never lower the reference");
        f.env.warp(150);
    }
    let r = f.coin_state().reference;
    assert!(r.avg_q64 >= ref0 && r.last_spot_q64 >= ref0 * 99 / 100);

    // Final bundle: dump → FUMPAD sell (ticket) → rebuy.
    direct_dump(&mut f, &whale, dump);
    let ticket = f.next_ticket(&wk);
    ok(f.swap_sell(&whale, 30_000_000_000_000));
    direct_restore_base(&mut f, &whale, q0, b0);
    let t = f.ticket(&ticket);
    assert_eq!(t.status, TicketStatus::Open);
    assert!(t.sell_price_q64 * 10 >= genuine * 8, "ticket {} floored near genuine {genuine}", t.sell_price_q64);

    f.keeper_samples(125, 15);
    let median = f.median().unwrap();
    assert!(median.abs_diff(genuine) * 10 < genuine, "median {median} ≈ genuine {genuine}");
    assert!(!meets_multiple(median, t.sell_price_q64, TEN_X));
    expect_err(f.claim(&whale, ticket), FumpadError::TriggerNotMet);
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. V-L2 — coverage requires time spread, not just a sample count
// ═════════════════════════════════════════════════════════════════════════════

/// Was: 84 samples 10 s apart (830 s) gave a "30-minute" median. Now keeper samples must
/// also be present in ≥ 5 of the window's 6 five-minute buckets: a price must have been
/// sampled over ≥ ~20 minutes of the window before a median exists.
#[test]
fn regression_median_coverage_requires_time_spread() {
    let mut f = Flow::new();
    let _whale = graduated(&mut f);
    f.env.warp(1_800);
    f.keeper_samples(84, 10);
    let o = obs(&f);
    let first = o.samples[0].ts;
    assert_eq!(f.now() - first, 830);
    assert_eq!(f.median(), None, "84 samples over 13.8 min: no median");
    // Keep sampling at full rate: the median appears only once ≥ 5 buckets are covered.
    let mut n = 84;
    while f.median().is_none() {
        f.keeper_samples(1, 10);
        n += 1;
        assert!(n < 300);
    }
    assert!(f.now() - first >= 1_200, "median after {} s", f.now() - first);
}
