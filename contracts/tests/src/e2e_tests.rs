//! End-to-end lifecycle on one real coin, default params, nothing fabricated except the
//! Pyth SOL/USD account bytes:
//!
//!   create_coin → curve trading by many wallets (tickets after the 10-min hold; a creator
//!   sell, a sub-$50 sell and a rebuy-voided ticket that must not count) → curve completes
//!   → graduate → init_observations + init_claim_queue → router trades → router buys push
//!   the price ≥10x the tickets → keeper samples every 15 s for 31 min → instant claims,
//!   over-cap claims queued, skip-ahead → execute_buyback grows the pool → process_queue
//!   pays → D11: non-FUMPAD traders trade straight on PumpSwap (as Jupiter would) → the LP
//!   locker skims the fee growth → settle_lp_fees → fee withdrawals → 90-day expiry + close.
//!   The Coin lamport invariant is checked after every stage.

use anchor_lang::prelude::{AccountMeta as Meta, Pubkey};
use fumpad::{
    error::FumpadError,
    events::{BuybackExecuted, ClaimPaid, ClaimQueued, TicketCreated, Trade},
    instructions::rewards::logic::{claim_amount, claim_cap},
    math::price::meets_multiple,
    state::*,
};
use solana_keypair::Keypair;

use crate::flow::*;
use crate::*;

const M: u64 = 1_000_000; // one token (6 decimals)
const DAY: i64 = 86_400;

/// Token-2022 transfer_checked (plain wallet-to-wallet transfer, outside FUMPAD).
fn transfer_ix(f: &Flow, from: &Pubkey, to: &Pubkey, amount: u64) -> solana_instruction::Instruction {
    let mut data = vec![12u8];
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(fumpad::TOKEN_DECIMALS);
    raw_ix(
        T22,
        vec![w(ata(from, &f.mint, &T22)), r(f.mint), w(ata(to, &f.mint, &T22)), Meta::new(*from, true)],
        data,
    )
}

fn register_holdings_ix(f: &Flow, user: &Pubkey) -> solana_instruction::Instruction {
    let open = f.rebuy_metas(user);
    ix_with_remaining(
        fumpad::accounts::RegisterHoldings {
            user: *user,
            global: f.env.global_pda(),
            coin: f.coin,
            mint: f.mint,
            position: f.position_key(user),
            user_token_account: ata(user, &f.mint, &T22),
            token_program: T22,
            system_program: SYSTEM,
            event_authority: event_authority(),
            program: fumpad::ID,
        },
        fumpad::instruction::RegisterHoldings {},
        &open,
    )
}

/// Sell on the curve and return (ticket key if created, metadata).
fn curve_sell(f: &mut Flow, who: &Keypair, tokens: u64) -> (Option<Pubkey>, litesvm::types::TransactionMetadata) {
    let key = f.next_ticket(&kp_pk(who));
    let m = ok(f.sell(who, tokens));
    let created = events::<TicketCreated>(&m);
    assert!(created.len() <= 1);
    (created.first().map(|t| { assert_eq!(t.ticket, key); key }), m)
}

#[test]
fn full_lifecycle() {
    let mut f = Flow::new();
    let p = Params::default();
    let creator = f.creator.insecure_clone();
    let [gina, bob, alice, frank, carol, dave, erin, whale, trader, pusher] =
        core::array::from_fn(|_| f.env.new_user(1_000));
    let ck = kp_pk(&creator);
    f.assert_invariant();

    // ── 1. Curve: buys (cheapest first), then the 10-minute hold ──────────────────
    let mut cu_buy = 0;
    for (who, sol) in [(&gina, 12), (&bob, 8), (&alice, 2), (&frank, 1), (&carol, 1), (&dave, 2), (&erin, 2), (&creator, 1)] {
        let m = ok(f.buy(who, sol * SOL));
        cu_buy = cu_buy.max(m.compute_units_consumed);
    }
    f.assert_invariant();
    // Selling before the hold elapses never makes a ticket.
    let (t, _) = curve_sell(&mut f, &alice, 1_000 * M);
    assert!(t.is_none());
    f.env.warp(600);

    // ── 2. Curve sells (distinct timestamps = queue order) ────────────────────────
    let mut tickets: Vec<(&str, Pubkey)> = vec![];
    let mut cu_sell = 0;
    for (name, who, tokens) in [
        ("gina", &gina, 150_000_000 * M), // claim ≫ 10% of pool: queued forever
        ("bob", &bob, 100_000_000 * M),   // tuned to just over the cap later
        ("alice", &alice, 20_000_000 * M),
        ("frank", &frank, 10_000_000 * M),
        ("erin", &erin, 10_000_000 * M), // will expire
        ("dave", &dave, 10_000_000 * M), // voided by his rebuy
    ] {
        f.env.warp(3);
        let (t, m) = curve_sell(&mut f, who, tokens);
        cu_sell = cu_sell.max(m.compute_units_consumed);
        let t = t.unwrap_or_else(|| panic!("{name} should get a ticket"));
        assert_eq!(f.ticket(&t).tokens, tokens);
        tickets.push((name, t));
    }
    let tk = |n: &str| tickets.iter().find(|(x, _)| *x == n).unwrap().1;
    // Creator's sell: no ticket (wallet-based exclusion).
    f.env.warp(3);
    let half = f.tokens(&ck) / 2;
    let (t, m) = curve_sell(&mut f, &creator, half);
    assert!(t.is_none());
    assert_eq!(events::<Trade>(&m)[0].user, ck);
    // Sub-$50 sell: no ticket (≈ $20 at $150/SOL).
    f.env.warp(3);
    let (t, m) = curve_sell(&mut f, &carol, 1_000_000 * M);
    assert!(t.is_none());
    assert!(events::<Trade>(&m)[0].sol_amount < 50 * SOL / 150);
    assert_eq!(f.position(&kp_pk(&carol)).unwrap().open_count, 0);
    // Dave rebuys within 7 days: his ticket is debited to zero → Voided, leaves his list.
    f.env.warp(3);
    ok(f.buy(&dave, 3 * SOL));
    assert_eq!(f.ticket(&tk("dave")).status, TicketStatus::Voided);
    assert_eq!(f.position(&kp_pk(&dave)).unwrap().open_count, 0);
    ok(f.close_ticket(&dave, tk("dave"))); // owner closes, rent back
    assert!(f.env.account(&tk("dave")).map_or(true, |a| a.lamports == 0));
    assert_eq!(f.coin_state().tickets_created, 6);
    f.assert_invariant();

    // ── 3. Curve completes, graduation, post-graduation setup ────────────────────
    let m = ok(f.buy(&whale, 200 * SOL));
    assert_eq!(events::<fumpad::events::CurveCompleted>(&m).len(), 1);
    assert_eq!(f.coin_state().status, CoinStatus::Complete);
    expect_err(f.buy(&whale, SOL), FumpadError::WrongCoinStatus);
    f.assert_invariant();
    let ref_at_completion = f.coin_state().reference;
    ok(f.graduate());
    let c = f.coin_state();
    assert_eq!(c.status, CoinStatus::Graduated);
    assert_eq!(c.reference, ref_at_completion, "D10 reference carried through graduation");
    f.post_graduation_setup();
    f.assert_invariant();

    // ── 4. Router trades: round trips (unmatured → no tickets) build buyback fees ──
    let mut cu_swap_sell = 0;
    for _ in 0..3 {
        ok(f.swap_buy(&trader, 60 * SOL));
        f.env.warp(5);
        let m = ok(f.swap_sell(&trader, f.tokens(&kp_pk(&trader))));
        assert!(events::<TicketCreated>(&m).is_empty());
        cu_swap_sell = cu_swap_sell.max(m.compute_units_consumed);
        f.env.warp(5);
    }
    f.assert_invariant();

    // Push the price ≥ 10.5x the highest ticket we'll claim, via router buys.
    let claimed = ["gina", "bob", "alice", "frank"];
    let max_ticket_price = claimed.iter().map(|n| f.ticket(&tk(n)).sell_price_q64).max().unwrap();
    while f.spot_q64() * 10 < max_ticket_price * 105 {
        ok(f.swap_buy(&pusher, 10 * SOL));
        f.env.warp(2);
    }
    f.assert_invariant();

    // ── 5. Keeper samples every 15 s for 31 min (isolated txs, spacing respected) ──
    f.keeper_samples(124, 15);
    let median = f.median().expect("coverage met");
    for n in claimed {
        assert!(meets_multiple(median, f.ticket(&tk(n)).sell_price_q64, p.trigger_multiple_bps), "{n} not 10x");
    }

    // ── 6. Claims ────────────────────────────────────────────────────────────────
    // Alice: fits the 10%-of-pool cap → paid instantly.
    let pool0 = f.pool_tokens();
    let a_before = f.tokens(&kp_pk(&alice));
    let m = ok(f.claim(&alice, tk("alice")));
    let cu_claim = m.compute_units_consumed;
    let paid = events::<ClaimPaid>(&m);
    assert_eq!((paid.len(), paid[0].from_queue), (1, false));
    assert_eq!(paid[0].amount, claim_amount(20_000_000 * M, p.claim_bps));
    assert_eq!(f.tokens(&kp_pk(&alice)) - a_before, 2_000_000 * M);
    assert_eq!(f.pool_tokens(), pool0 - 2_000_000 * M);
    assert_eq!(f.ticket(&tk("alice")).status, TicketStatus::Claimed);

    // Gina: 15M ≫ cap → queued (never expires).
    let m = ok(f.claim(&gina, tk("gina")));
    assert_eq!(events::<ClaimQueued>(&m)[0].queue_len, 1);
    assert_eq!(f.ticket(&tk("gina")).status, TicketStatus::Queued);

    // Bob: tune his ticket to just over the cap with an exact rebuy (a plain transfer in,
    // then register_holdings — the rebuy rule debits the ticket by exactly that amount).
    let pool1 = f.pool_tokens();
    let target = pool1 + pool1 / 300; // claim = 10% × target > 10% × pool
    let delta = f.ticket(&tk("bob")).tokens - target;
    let (wk, bk) = (kp_pk(&whale), kp_pk(&bob));
    let i = transfer_ix(&f, &wk, &bk, delta);
    ok(f.env.send_as(&whale, &[i], &[&whale]));
    let i = register_holdings_ix(&f, &bk);
    ok(f.env.send_as(&bob, &[i], &[&bob]));
    assert_eq!(f.ticket(&tk("bob")).tokens, target);
    let bob_amount = claim_amount(target, p.claim_bps);
    assert!(bob_amount > claim_cap(pool1, p.max_claim_pool_bps));
    let m = ok(f.claim(&bob, tk("bob")));
    assert_eq!(events::<ClaimQueued>(&m)[0].queue_len, 2);

    // Frank (younger than both waiting entries): fits → skips ahead, paid instantly.
    let m = ok(f.claim(&frank, tk("frank")));
    assert_eq!(events::<ClaimPaid>(&m).len(), 1);
    assert_eq!(f.ticket(&tk("frank")).status, TicketStatus::Claimed);
    let q = f.queue_state();
    assert_eq!((q.len, q.entries[0].ticket, q.entries[1].ticket), (2, tk("gina"), tk("bob")));
    assert_eq!(q.total_owed, claim_amount(150_000_000 * M, p.claim_bps) + bob_amount);
    // Nothing fits yet: the crank pays nobody.
    let order = [(tk("gina"), kp_pk(&gina)), (tk("bob"), bk)];
    let m = ok(f.process_queue(8, &order));
    assert!(events::<ClaimPaid>(&m).is_empty());
    assert_eq!(f.queue_state().len, 2);
    f.assert_invariant();

    // ── 7. Buyback grows the pool until Bob's entry fits ─────────────────────────
    let pool_before_bb = f.pool_tokens();
    let mut rounds = 0;
    while !fumpad::instructions::rewards::logic::fits(bob_amount, f.pool_tokens(), p.max_claim_pool_bps) {
        rounds += 1;
        assert!(rounds <= 20, "buyback never made the claim fit");
        assert!(f.coin_state().buyback_lamports > 0, "ran out of buyback fees");
        let m = ok(f.execute_buyback(u64::MAX));
        let bb = &events::<BuybackExecuted>(&m)[0];
        assert!(bb.tokens_out > 0);
        f.assert_invariant();
        // Keep spot within ±3% of the median: the creator sells the same amount back via
        // the router (creator sells never make tickets) and the keeper keeps sampling.
        let m = ok(f.swap_sell(&creator, bb.tokens_out));
        assert!(events::<TicketCreated>(&m).is_empty());
        f.keeper_samples(1, 15);
    }
    assert!(f.pool_tokens() > pool_before_bb);
    // Crank: Gina (oldest) still doesn't fit → skipped; Bob is paid.
    let b_before = f.tokens(&bk);
    let m = ok(f.process_queue(8, &order));
    let paid = events::<ClaimPaid>(&m);
    assert_eq!(paid.len(), 1);
    assert_eq!((paid[0].ticket, paid[0].amount, paid[0].from_queue), (tk("bob"), bob_amount, true));
    assert_eq!(f.tokens(&bk) - b_before, bob_amount);
    assert_eq!(f.ticket(&tk("bob")).status, TicketStatus::Claimed);
    let q = f.queue_state();
    assert_eq!((q.len, q.entries[0].ticket), (1, tk("gina")));
    assert!(!f.open_tickets(&bk).contains(&tk("bob")));
    ok(f.close_ticket(&bob, tk("bob")));
    f.assert_invariant();

    // ── 7b. D11: outside volume earns LP fees for the coin ──────────────────────
    // Traders that never touch FUMPAD (Jupiter routing straight to PumpSwap) round-trip
    // 5 × 40 SOL. The locker's LP earns PumpSwap's 0.20% LP fee on it; a skim withdraws
    // exactly the growth (base → reward pool, WSOL → ATA(coin, WSOL)); settle credits the
    // SOL 60/40 to platform/creator. The principal stays locked.
    let p_locked = f.lp_principal();
    let lp_before = f.locked_lp();
    assert_eq!((f.lock_state().lp_skimmed, lp_before), (0, f.lock_state().lp_locked), "nothing skimmed yet");
    let jup = f.env.new_user(10);
    let jk = kp_pk(&jup);
    ok(f.env.send_as(&jup, &[create_ata_ix(&jk, &jk, &f.mint, &T22)], &[&jup]));
    for _ in 0..5 {
        let before = f.tokens(&jk);
        let i = f.direct_buy_ix(&jk, 40 * SOL, true);
        ok(f.env.send_as(&jup, &[cu_limit(400_000), i], &[&jup]));
        let got = f.tokens(&jk) - before;
        let i = f.direct_sell_ix(&jk, got);
        ok(f.env.send_as(&jup, &[cu_limit(400_000), i], &[&jup]));
    }
    assert!(f.position(&jk).is_none(), "never touched FUMPAD");
    assert!(f.locked_value() > p_locked * 1.001);
    let (pool_before_skim, c_before) = (f.pool_tokens(), f.coin_state());
    let m = ok(f.skim());
    let cu_skim = m.compute_units_consumed;
    let sk = &locker_events::<fumpad_lp_locker::Skimmed>(&m)[0];
    assert!(sk.lp_withdrawn > 0 && sk.base_out > 0 && sk.quote_out > 0);
    assert_eq!(f.pool_tokens(), pool_before_skim + sk.base_out, "reward pool grew");
    assert_eq!(f.locked_lp(), lp_before - sk.lp_withdrawn);
    assert!(f.locked_value() >= p_locked, "principal intact");
    let m = ok(f.settle_lp_fees());
    let cu_settle = m.compute_units_consumed;
    let c = f.coin_state();
    let platform = sk.quote_out * 6 / 10;
    assert_eq!(c.platform_fees_unclaimed, c_before.platform_fees_unclaimed + platform);
    assert_eq!(c.creator_fees_unclaimed, c_before.creator_fees_unclaimed + sk.quote_out - platform);
    f.assert_invariant();

    // ── 8. Fee withdrawals ──────────────────────────────────────────────────────
    let c = f.coin_state();
    assert!(c.creator_fees_unclaimed > 0 && c.platform_fees_unclaimed > 0);
    let before = f.env.lamports(&ck);
    ok(f.withdraw_creator_fees());
    assert!(f.env.lamports(&ck) + 10_000 >= before + c.creator_fees_unclaimed);
    let treasury = kp_pk(&f.env.treasury);
    let before = f.env.lamports(&treasury);
    ok(f.withdraw_platform_fees());
    assert_eq!(f.env.lamports(&treasury), before + c.platform_fees_unclaimed);
    let c = f.coin_state();
    assert_eq!((c.creator_fees_unclaimed, c.platform_fees_unclaimed), (0, 0));
    f.assert_invariant();

    // ── 9. 90 days later ─────────────────────────────────────────────────────────
    f.env.warp(91 * DAY);
    expect_err(f.claim(&erin, tk("erin")), FumpadError::TicketExpired);
    let erin_before = f.env.lamports(&kp_pk(&erin));
    let rent = f.env.lamports(&tk("erin"));
    let stranger = f.env.new_user(1);
    ok(f.close_ticket(&stranger, tk("erin"))); // anyone may close an expired ticket
    assert_eq!(f.env.lamports(&kp_pk(&erin)), erin_before + rent);
    assert_eq!(f.position(&kp_pk(&erin)).unwrap().open_count, 0);
    // Queued claims never expire and can't be closed.
    expect_err(f.close_ticket(&stranger, tk("gina")), FumpadError::TicketNotClosable);
    assert_eq!(f.ticket(&tk("gina")).status, TicketStatus::Queued);
    f.assert_invariant();

    let c = f.coin_state();
    assert_eq!(c.tokens_paid_out, 2_000_000 * M + 1_000_000 * M + bob_amount);
    println!(
        "CU: curve buy ≤ {cu_buy}, curve sell (ticket) ≤ {cu_sell}, swap_sell ≤ {cu_swap_sell}, claim {cu_claim}, \
         skim {cu_skim}, settle_lp_fees {cu_settle}; buyback rounds {rounds}"
    );
}
