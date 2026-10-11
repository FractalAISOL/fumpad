//! Pre-audit review of the rewards module: each `bug_*` test demonstrates behaviour that
//! contradicts SPEC §5.3 / concept §07 and PASSES while the bug exists (flip the final
//! assertions once fixed).
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
// HIGH — memo-refusing queue entries: never paid, never expire, still "fit"
// ═══════════════════════════════════════════════════════════════════════════

/// process_queue skips an entry whose ATA requires memos (so it "can't block the queue"),
/// but the entry stays forever (D5) and still counts as an OLDER FITTING entry in
/// `claim`'s `has_older_fitting`. One such entry forces every newer claim into the queue
/// even when the pool is huge; an attacker then parks ~256 cheap, legitimately-owed
/// claims behind it (52 wallets × ≤5 tickets), all memo-refusing, and the queue is full
/// forever: every honest claim on the coin reverts with QueueFull until its ticket expires.
/// The attacker loses nothing — turning memos off later gets each entry paid in full,
/// from a pool nobody else could draw down in the meantime.
#[test]
fn bug_memo_refusing_entries_block_instant_claims_and_fill_queue_forever() {
    let mut w = World::new(); // graduated, 50M-token pool, median at 10x of base_price()
    let now = w.now();

    // 1) The anchor entry: one attacker claim gets queued (here: pool momentarily low —
    //    in practice also: claim > 10% of the pool and the pool later grows from
    //    buybacks/skims, or a rebuy shrinking a queued entry until it fits).
    let a0 = w.user(0);
    let t0 = w.add_ticket(&a0.key, 1_000 * M, base_price(), now - 3 * DAY); // owes 100 tokens
    w.set_pool(1);
    ok(w.claim(&a0, t0));
    w.set_pool(POOL);
    w.set_balance(&a0, 0, true); // owner-only: Token-2022 reallocate + enable_required_transfer_memos

    // The crank skips it (no halt) and keeps it — the pool could pay it 50_000 times over.
    ok(w.process(10, &[(t0, a0.key)]));
    assert_eq!(w.queue_state().len, 1);
    assert_eq!(w.ticket(&t0).status, TicketStatus::Queued);

    // 2) An honest, newer, small claim on a 50M pool is NOT paid instantly.
    let h = w.user(0);
    let th = w.add_ticket(&h.key, 1_000 * M, base_price(), now - DAY);
    ok(w.claim(&h, th));
    assert_eq!(w.ticket(&th).status, TicketStatus::Queued, "forced into the queue by a refusing entry");
    ok(w.process(10, &[(t0, a0.key), (th, h.key)]));
    assert_eq!(w.ticket(&th).status, TicketStatus::Claimed);
    assert_eq!(w.queue_state().len, 1, "the refusing entry stays");

    // 3) Attacker fills the queue: 51 more wallets × 5 tickets (spec limits respected),
    //    each sold after t0 → each claim is forced into the queue behind t0.
    let mut attackers: Vec<(Keypair, Pubkey, Pubkey)> = vec![];
    for i in 0..51i64 {
        let u = w.user(0);
        for j in 0..5i64 {
            let t = w.add_ticket(&u.key, 1_000 * M, base_price(), now - 2 * DAY + i * 5 + j);
            ok(w.claim(&u, t));
            assert_eq!(w.ticket(&t).status, TicketStatus::Queued);
            attackers.push((u.kp.insecure_clone(), u.key, t));
        }
        w.set_balance(&u, 0, true);
    }
    let q = w.queue_state();
    assert_eq!(q.len as usize, fumpad::CLAIM_QUEUE_CAPACITY);
    assert_eq!(q.total_owed, 256 * 100 * M, "0.05% of the pool in total");

    // A full crank pass (in chunks, queue order) frees nothing.
    let mut order: Vec<(Pubkey, Pubkey)> = vec![(t0, a0.key)];
    order.extend(attackers.iter().map(|(_, o, t)| (*t, *o)));
    for chunk in order.chunks(10) {
        ok(w.process(10, chunk));
    }
    assert_eq!(w.queue_state().len as usize, fumpad::CLAIM_QUEUE_CAPACITY);

    // 4) Honest claimant, 10x met, claim = 0.0002% of the pool: QueueFull.
    let h2 = w.user(0);
    let t2 = w.add_ticket(&h2.key, 1_000 * M, base_price(), now - DAY / 2);
    assert_fumpad_err(w.claim(&h2, t2), FumpadError::QueueFull);
    assert_eq!(w.ticket(&t2).status, TicketStatus::Open);
    // ...and it simply expires 90 days later (anyone may close it), while the attacker's
    // queued entries never expire.
    w.env.warp(90 * DAY);
    assert_fumpad_err(w.claim(&h2, t2), FumpadError::TicketExpired);

    // 5) Attacker cashes out whenever they like.
    w.set_balance(&a0, 0, false);
    ok(w.process(10, &[(t0, a0.key)]));
    assert_eq!(token_amount(&w.env, &a0.ata), 100 * M);
}

// ═══════════════════════════════════════════════════════════════════════════
// LOW — stale queue amount after a rebuy debit lets newer claims jump ahead
// ═══════════════════════════════════════════════════════════════════════════

/// `apply_rebuy` lowers a queued ticket's `claim_amount`, but its queue entry keeps the old
/// (larger) amount until a crank re-syncs it. Both ordering guards read the stale entry:
/// - `claim`'s `has_older_fitting` sees "doesn't fit" → a newer claim pays instantly;
/// - `process_queue` only halts for a triple-less entry that fits by its STALE amount, so a
///   crank that omits the older entry's triple pays newer entries ahead of it.
/// D4/§5.3: "processed in sell-time order … a crank can't reorder it".
#[test]
fn bug_stale_queue_amount_after_rebuy_lets_newer_claims_jump_ahead() {
    let mut w = World::new();
    let now = w.now();
    w.set_pool(1_000 * M); // cap 100
    let a = w.user(0);
    let ta = w.add_ticket(&a.key, 2_000 * M, base_price(), now - 3 * DAY); // owes 200 > cap
    ok(w.claim(&a, ta));
    assert_eq!(w.ticket(&ta).status, TicketStatus::Queued);

    // A rebuys 1_400 within 7 days → ticket 600 tokens, owes 60 (fits the cap of 100).
    w.set_balance(&a, 1_400 * M, false);
    ok(w.register(&a, &[ta]));
    let tk = w.ticket(&ta);
    assert_eq!((tk.status, tk.claim_amount), (TicketStatus::Queued, 60 * M));
    assert_eq!(w.queue_state().entries[0].amount, 200 * M, "queue entry is stale");

    // (1) claim path: newer B (owes 100, fits) is paid instantly although older A fits.
    let b = w.user(0);
    let tb = w.add_ticket(&b.key, 1_000 * M, base_price(), now - 2 * DAY);
    ok(w.claim(&b, tb));
    assert_eq!(w.ticket(&tb).status, TicketStatus::Claimed, "B jumped ahead of fitting A");
    assert_eq!(w.ticket(&ta).status, TicketStatus::Queued);

    // (2) crank path: newer C gets queued (owes 95 > cap 90), pool refills to 1_000.
    let c = w.user(0);
    let tc = w.add_ticket(&c.key, 950 * M, base_price(), now - DAY);
    ok(w.claim(&c, tc));
    assert_eq!(w.ticket(&tc).status, TicketStatus::Queued);
    w.set_pool(1_000 * M);
    // A crank passing only C's triple: A (really owes 60, fits) is silently passed over.
    ok(w.process(10, &[(tc, c.key)]));
    assert_eq!(w.ticket(&tc).status, TicketStatus::Claimed, "C paid ahead of fitting A");
    assert_eq!(w.ticket(&ta).status, TicketStatus::Queued);
    assert_eq!(token_amount(&w.env, &a.ata), 1_400 * M, "A got nothing");
}

// ═══════════════════════════════════════════════════════════════════════════
// LOW — matured eligibility is a credit not tied to the tokens (10-min hold bypass)
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

/// `matured` is only ever capped by the balance FUMPAD sees at a sell / register. Tokens
/// that leave the wallet by transfer (or a sell on another venue) leave the credit behind,
/// and any tokens that arrive later — bought seconds ago, by anyone — inherit it. Here a
/// FUMPAD buy by wallet C is handed to A and dumped through FUMPAD in the same second, and
/// A gets a ticket: SPEC §5.3 rule 3 / concept §07 "minimum hold … stops buy-then-dump
/// farming". The same credit can be copied to more wallets by passing one bag around
/// (each `register_holdings` + 10 min), since none of them is ever capped down.
#[test]
fn bug_matured_credit_outlives_tokens_and_backs_instant_dump() {
    let mut f = Flow::new();
    let a = f.env.new_user(100);
    let ak = kp_pk(&a);
    ok(f.buy(&a, 2 * SOL));
    let x = f.tokens(&ak);
    f.env.warp(600);
    // A moves the matured bag out (FUMPAD can't see it).
    let cold = Pubkey::new_unique();
    t22_transfer(&mut f, &a, &cold, x);
    assert_eq!(f.tokens(&ak), 0);
    assert_eq!(f.position(&ak).unwrap().pending, x, "credit still tracked");
    f.env.warp(3_600);

    // An hour later: C buys through FUMPAD, hands the tokens to A, A sells at once.
    let c = f.env.new_user(100);
    let ck = kp_pk(&c);
    ok(f.buy(&c, 2 * SOL));
    let bought_at = f.now();
    let y = f.tokens(&ck);
    t22_transfer(&mut f, &c, &ak, y);
    let tk = f.next_ticket(&ak);
    ok(f.sell(&a, y));
    let t = f.ticket(&tk);
    assert_eq!(t.sell_ts, bought_at, "tokens held for 0 seconds");
    assert_eq!(t.tokens, y.min(x));
    assert!(t.tokens > 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// LOW — router sell from a non-ATA account wipes eligibility of the ATA's tokens
// ═══════════════════════════════════════════════════════════════════════════

/// `swap_sell` accepts any token account of the user, and `on_sell` caps the WHOLE
/// position to that one account's balance (`cap_tracked(balance_before)`). Selling a few
/// tokens from a secondary account deletes the matured credit of tokens still sitting in
/// the ATA (which `register_holdings` measures), so a later qualifying sell from the ATA
/// gets no ticket, and re-registering counts as a rebuy.
#[test]
fn bug_swap_sell_from_secondary_account_wipes_ata_eligibility() {
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
    let _ = f.keeper_sample(); // keep the reference fresh (not required)

    // Secondary Token-2022 account owned by u, holding 1 token.
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

    // Router sell of that 1 token from `side` (same instruction, user_token_account swapped).
    let ata_u = addr(&fl::ata(&uk, &f.mint, &fl::T22));
    let mut i = f.swap_sell_ix(&uk, M);
    for m in i.accounts.iter_mut() {
        if m.pubkey == ata_u {
            m.pubkey = addr(&side);
        }
    }
    ok(f.env.send_as(&u, &[fl::cu_limit(1_400_000), i], &[&u]));
    let pos = f.position(&uk).unwrap();
    assert_eq!(pos.matured + pos.pending, 0, "credit for {} tokens still in the ATA wiped", held - M);
    assert_eq!(f.tokens(&uk), held - M);

    // A normal, otherwise qualifying sell of the ATA's matured tokens: no ticket.
    let tk = f.next_ticket(&uk);
    ok(f.swap_sell(&u, f.tokens(&uk)));
    assert!(f.env.account(&tk).map_or(true, |a| a.lamports == 0), "no ticket for 10-min-held tokens");

    // Control: the same buy → 10 min → sell from the ATA, without the side sell, qualifies.
    let v = f.env.new_user(100);
    let vk = kp_pk(&v);
    ok(f.swap_buy(&v, 3 * SOL));
    f.env.warp(600);
    let tk = f.next_ticket(&vk);
    ok(f.swap_sell(&v, f.tokens(&vk)));
    assert!(f.env.account(&tk).is_some_and(|a| a.lamports > 0), "control sell gets a ticket");
}
