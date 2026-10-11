//! Pre-audit review of the rewards module, fixed in v0.3: each `regression_*` test replays
//! the original `bug_*` scenario and asserts the attack now FAILS (R-L2 also pins down the
//! documented residual).
//!
//! Queue tests reuse the fabricated `rewards_tests::World` (tickets written exactly as
//! `on_sell` writes them; claim / process_queue / register_holdings are the real program).
//! Eligibility tests use `flow::Flow` (real coin, real curve, real PumpSwap).

use anchor_lang::prelude::{AccountMeta, Pubkey};
use fumpad::{
    error::FumpadError,
    math::price::price_q64,
    state::{CoinStatus, TicketStatus},
};
use litesvm::types::TransactionResult;
use solana_keypair::Keypair;

use crate::flow::{self as fl, Flow};
use crate::rewards_tests::World;
use crate::*;

const DAY: i64 = 86_400;
const M: u64 = 1_000_000; // 1 token (6 decimals)
const POOL: u64 = 50_000_000 * M;

#[track_caller]
fn ok(res: TransactionResult) -> litesvm::types::TransactionMetadata {
    match res {
        Ok(m) => m,
        Err(e) => panic!("tx failed: {:?}\n{:#?}", e.err, e.meta.logs),
    }
}

#[track_caller]
fn assert_fumpad_err(res: TransactionResult, e: FumpadError) {
    let c = 6000 + e as u32;
    match res {
        Ok(_) => panic!("expected custom error {c}, tx succeeded"),
        Err(f) => {
            let s = format!("{:?}", f.err);
            assert!(s.contains(&format!("Custom({c})")), "expected Custom({c}), got {s}\n{:#?}", f.meta.logs);
        }
    }
}

fn token_amount(env: &Env, key: &Pubkey) -> u64 {
    let d = env.account(key).map(|a| a.data).unwrap_or_default();
    if d.len() < 72 {
        return 0;
    }
    u64::from_le_bytes(d[64..72].try_into().unwrap())
}

/// Same sell price as `rewards_tests` (World's samples sit at exactly 10x of it).
fn base_price() -> u128 {
    price_q64(1_000, M).unwrap()
}

// ═══════════════════════════════════════════════════════════════════════════
// HIGH (R-H1, D16) — memo-refusing queue entries
// ═══════════════════════════════════════════════════════════════════════════

/// Was: process_queue skipped an entry whose ATA requires memos but kept it forever, and it
/// still counted as an older fitting entry, forcing every newer claim into the queue; ~256
/// such entries (52 wallets × 5) filled the queue for good (QueueFull for everyone).
/// Now: the crank pays a refusing entry into the ticket's escrow (the entry leaves the
/// queue), newer claims are paid instantly again, and a wallet can hold at most 2 queue
/// entries per coin (the 3rd claim reverts with WalletQueueLimit; ticket stays Open).
#[test]
fn regression_memo_refusing_entries_are_escrowed_and_cannot_fill_the_queue() {
    let mut w = World::new(); // graduated, 50M-token pool, median at 10x of base_price()
    let now = w.now();

    // 1) The anchor entry: queued while the pool was momentarily low, then memos on.
    let a0 = w.user(0);
    let t0 = w.add_ticket(&a0.key, 1_000 * M, base_price(), now - 3 * DAY); // owes 100 tokens
    w.set_pool(1);
    ok(w.claim(&a0, t0));
    w.set_pool(POOL);
    w.set_balance(&a0, 0, true);

    // The crank escrows it: the entry leaves the queue.
    ok(w.process(10, &[(t0, a0.key)]));
    assert_eq!(w.queue_state().len, 0);
    assert_eq!(w.ticket(&t0).status, TicketStatus::Escrowed);
    assert_eq!(token_amount(&w.env, &w.escrow_key(&t0)), 100 * M);

    // 2) An honest, newer, small claim on a 50M pool is paid instantly.
    let h = w.user(0);
    let th = w.add_ticket(&h.key, 1_000 * M, base_price(), now - DAY);
    ok(w.claim(&h, th));
    assert_eq!(w.ticket(&th).status, TicketStatus::Claimed);

    // 3) Queue-filling attempt: with claims forced into the queue (pool too small to pay
    //    them), each wallet gets at most 2 entries; the 3rd reverts and stays Open.
    w.set_pool(1_000 * M); // cap 100 → a 101-token claim doesn't fit
    let mut attackers: Vec<(Pubkey, Pubkey)> = vec![];
    let mut wallets = vec![];
    for i in 0..3i64 {
        let u = w.user(0);
        for j in 0..5i64 {
            let t = w.add_ticket(&u.key, 1_010 * M, base_price(), now - 2 * DAY + i * 5 + j);
            if j < 2 {
                ok(w.claim(&u, t));
                assert_eq!(w.ticket(&t).status, TicketStatus::Queued);
                attackers.push((t, u.key));
            } else {
                assert_fumpad_err(w.claim(&u, t), FumpadError::WalletQueueLimit);
                assert_eq!(w.ticket(&t).status, TicketStatus::Open);
            }
        }
        w.set_balance(&u, 0, true); // memos on
        wallets.push(u);
    }
    assert_eq!(w.queue_state().len, 6);

    // 4) Pool back: one crank pass escrows every refusing entry; the queue is empty and an
    //    honest claimant is paid at once (no QueueFull, no forced queueing).
    w.set_pool(POOL);
    ok(w.process(10, &attackers));
    assert_eq!(w.queue_state().len, 0);
    for (t, _) in &attackers {
        assert_eq!(w.ticket(t).status, TicketStatus::Escrowed);
    }
    let h2 = w.user(0);
    let t2 = w.add_ticket(&h2.key, 1_000 * M, base_price(), now - DAY / 2);
    ok(w.claim(&h2, t2));
    assert_eq!(w.ticket(&t2).status, TicketStatus::Claimed);

    // 5) The attacker still gets exactly what was owed, via withdraw_escrow.
    let side = w.side_account(&a0);
    ok(w.withdraw_escrow(&a0, t0, side));
    assert_eq!(token_amount(&w.env, &side), 100 * M);
}

// ═══════════════════════════════════════════════════════════════════════════
// LOW (R-L1) — queue amount after a rebuy debit is exact
// ═══════════════════════════════════════════════════════════════════════════

/// Was: `apply_rebuy` lowered a queued ticket's `claim_amount` but its queue entry kept the
/// old (larger) amount until a crank re-synced it, so `has_older_fitting` and the crank's
/// halt rule read the stale amount and newer claims jumped ahead. Now the rebuy updates the
/// entry in the same instruction (the ClaimQueue account is required when a ticket is
/// Queued): newer claims queue behind A, and a crank omitting A halts instead of paying them.
#[test]
fn regression_rebuy_updates_queue_entry_so_order_holds() {
    let mut w = World::new();
    let now = w.now();
    w.set_pool(1_000 * M); // cap 100
    let a = w.user(0);
    let ta = w.add_ticket(&a.key, 2_000 * M, base_price(), now - 3 * DAY); // owes 200 > cap
    ok(w.claim(&a, ta));
    assert_eq!(w.ticket(&ta).status, TicketStatus::Queued);

    // A rebuys 1_400 within 7 days → ticket 600 tokens, owes 60; the entry follows at once.
    w.set_balance(&a, 1_400 * M, false);
    ok(w.register(&a, &[ta]));
    let tk = w.ticket(&ta);
    assert_eq!((tk.status, tk.claim_amount), (TicketStatus::Queued, 60 * M));
    let q = w.queue_state();
    assert_eq!((q.entries[0].amount, q.total_owed), (60 * M, 60 * M), "queue entry exact");

    // (1) claim path: newer B (owes 100, fits) waits behind the older fitting A.
    let b = w.user(0);
    let tb = w.add_ticket(&b.key, 1_000 * M, base_price(), now - 2 * DAY);
    ok(w.claim(&b, tb));
    assert_eq!(w.ticket(&tb).status, TicketStatus::Queued, "B no longer jumps ahead of A");

    // (2) crank path: a crank passing only a newer entry halts at A.
    let c = w.user(0);
    let tc = w.add_ticket(&c.key, 950 * M, base_price(), now - DAY);
    ok(w.claim(&c, tc));
    assert_eq!(w.ticket(&tc).status, TicketStatus::Queued);
    ok(w.process(10, &[(tc, c.key)]));
    assert_eq!(w.ticket(&tc).status, TicketStatus::Queued, "C not paid ahead of fitting A");
    assert_eq!(w.ticket(&ta).status, TicketStatus::Queued);
    // A full crank pays in order: A first.
    ok(w.process(10, &[(ta, a.key), (tb, b.key), (tc, c.key)]));
    assert_eq!(w.ticket(&ta).status, TicketStatus::Claimed);
    assert_eq!(token_amount(&w.env, &a.ata), 1_460 * M, "A paid its exact 60");
}

// ═══════════════════════════════════════════════════════════════════════════
// LOW (R-L2) — matured eligibility vs tokens that arrive unseen
// ═══════════════════════════════════════════════════════════════════════════

fn t22_transfer(f: &mut Flow, from: &Keypair, to: &Pubkey, amount: u64) {
    let fk = kp_pk(from);
    let payer = kp_pk(&f.env.payer);
    let create = fl::create_ata_ix(&payer, to, &f.mint, &fl::T22);
    let mut data = vec![12u8]; // TransferChecked
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(6);
    let i = fl::raw_ix(
        fl::T22,
        vec![
            fl::w(fl::ata(&fk, &f.mint, &fl::T22)),
            fl::r(f.mint),
            fl::w(fl::ata(to, &f.mint, &fl::T22)),
            AccountMeta::new_readonly(fk, true),
        ],
        data,
    );
    let p = f.env.payer.insecure_clone();
    ok(f.env.send_as(&p, &[create, i], &[&p, from]));
}

/// Was: `matured` was a credit capped only by the balance seen at a sell, so tokens bought
/// seconds ago by anyone, handed to a wallet holding matured credit, were dumped with a
/// ticket (no 10-min hold). Now Position.last_balance records the balance FUMPAD last
/// observed; anything above it at the sell arrived unseen and is sold FIRST, without
/// eligibility. Part 1: A still holds its matured bag and dumps the fresh tokens → no
/// ticket. Part 2 (original scenario, bag moved out first): only the part of the fresh
/// tokens up to the previously observed balance can still use the old credit — the
/// documented residual (FUMPAD can't see transfers between its touch points, SPEC §5.3),
/// bounded by a credit that required really holding that many tokens for 10 min.
#[test]
fn regression_unseen_arrivals_cannot_ride_matured_credit() {
    // Part 1: bag kept, fresh tokens handed over and dumped at once → no ticket.
    let mut f = Flow::new();
    let a = f.env.new_user(100);
    let ak = kp_pk(&a);
    ok(f.buy(&a, 2 * SOL));
    let x = f.tokens(&ak);
    f.env.warp(3_600);
    let c = f.env.new_user(100);
    let ck = kp_pk(&c);
    ok(f.buy(&c, 2 * SOL));
    let y = f.tokens(&ck);
    t22_transfer(&mut f, &c, &ak, y);
    let tk = f.next_ticket(&ak);
    ok(f.sell(&a, y));
    assert!(f.env.account(&tk).map_or(true, |acc| acc.lamports == 0), "fresh tokens: no ticket");
    let p = f.position(&ak).unwrap();
    assert_eq!((p.matured, p.last_balance), (x, x), "the held bag keeps its credit");
    // Selling the held bag afterwards still qualifies (it was held ≥ 10 min).
    let tk = f.next_ticket(&ak);
    ok(f.sell(&a, x));
    assert_eq!(f.ticket(&tk).tokens, x);

    // Part 2: the original scenario — bag moved out unseen, MORE fresh tokens arrive.
    let mut f = Flow::new();
    let a = f.env.new_user(100);
    let ak = kp_pk(&a);
    ok(f.buy(&a, 2 * SOL));
    let x = f.tokens(&ak);
    f.env.warp(600);
    t22_transfer(&mut f, &a, &Pubkey::new_unique(), x);
    f.env.warp(3_600);
    let c = f.env.new_user(100);
    let ck = kp_pk(&c);
    ok(f.buy(&c, 10 * SOL));
    let y = f.tokens(&ck);
    assert!(y > x);
    t22_transfer(&mut f, &c, &ak, y);
    let tk = f.next_ticket(&ak);
    ok(f.sell(&a, y));
    let t = f.ticket(&tk);
    assert_eq!(t.tokens, x, "only the previously observed balance can carry credit (residual), not {y}");
}

// ═══════════════════════════════════════════════════════════════════════════
// LOW (R-L3) — router sell must use the canonical ATA
// ═══════════════════════════════════════════════════════════════════════════

/// Was: `swap_sell` accepted any token account of the user and capped the WHOLE position to
/// that account's balance, so selling 1 token from a side account wiped the matured credit
/// of the tokens in the ATA. Now `swap_sell` (like the curve sell and `swap_buy`) requires
/// the canonical ATA: the side-account sell is rejected and the ATA's tokens keep their
/// eligibility.
#[test]
fn regression_swap_sell_requires_canonical_ata() {
    let mut f = Flow::new();
    let whale = f.env.new_user(1_000);
    ok(f.buy(&whale, 200 * SOL));
    assert_eq!(f.coin_state().status, CoinStatus::Complete);
    ok(f.graduate());
    f.post_graduation_setup();

    let u = f.env.new_user(100);
    let uk = kp_pk(&u);
    ok(f.swap_buy(&u, 3 * SOL));
    let held = f.tokens(&uk);
    f.env.warp(600);
    let _ = f.keeper_sample();

    let side = Pubkey::new_unique();
    fl::put_token_account(&mut f.env, side, f.mint, uk, 0, fl::T22);
    let mut data = vec![12u8];
    data.extend_from_slice(&M.to_le_bytes());
    data.push(6);
    let tr = fl::raw_ix(
        fl::T22,
        vec![fl::w(fl::ata(&uk, &f.mint, &fl::T22)), fl::r(f.mint), fl::w(side), AccountMeta::new_readonly(uk, true)],
        data,
    );
    ok(f.env.send_as(&u, &[tr], &[&u]));

    // Router sell of that 1 token from `side`: rejected (Anchor ConstraintAssociated).
    let ata_u = addr(&fl::ata(&uk, &f.mint, &fl::T22));
    let mut i = f.swap_sell_ix(&uk, M);
    for m in i.accounts.iter_mut() {
        if m.pubkey == ata_u {
            m.pubkey = addr(&side);
        }
    }
    let res = f.env.send_as(&u, &[fl::cu_limit(1_400_000), i], &[&u]);
    let err = format!("{:?}", res.expect_err("side-account sell must fail").err);
    assert!(err.contains("Custom(2009)"), "{err}");
    let pos = f.position(&uk).unwrap();
    assert_eq!(pos.matured + pos.pending, held, "ATA eligibility intact");

    // The ATA's matured tokens sell with a ticket.
    let tk = f.next_ticket(&uk);
    ok(f.swap_sell(&u, f.tokens(&uk)));
    assert!(f.env.account(&tk).is_some_and(|a| a.lamports > 0), "10-min-held tokens get a ticket");
}
