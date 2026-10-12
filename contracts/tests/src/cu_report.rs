//! v0.4 (D17: queue capacity 1024, `claim_for`) compute-unit report: worst-case CU of the heavy instructions, each asserted to fit
//! the 1.4M per-transaction limit. Run with `--nocapture` to print the table
//! (`cargo test -p tests cu_report -- --nocapture`). The 10-coin `record_samples` batch is
//! measured in `venue_tests::compute_units_and_batch_size`.

use anchor_lang::prelude::Pubkey;
use fumpad::{
    math::price::price_q64,
    state::{QueueEntry, TicketStatus},
    CLAIM_QUEUE_CAPACITY,
};
use litesvm::types::TransactionResult;

use crate::flow::{self as fl, Flow};
use crate::rewards_tests::World;
use crate::*;

const DAY: i64 = 86_400;
const M: u64 = 1_000_000;
const LIMIT: u64 = 1_400_000;
/// D17: every path must stay well clear of the limit (redesign if one gets above this).
const COMFORT: u64 = 1_000_000;

fn cu(r: TransactionResult) -> u64 {
    match r {
        Ok(m) => m.compute_units_consumed,
        Err(e) => panic!("tx failed: {:?}\n{:#?}", e.err, e.meta.logs),
    }
}

fn base_price() -> u128 {
    price_q64(1_000, M).unwrap()
}

/// `n` real Queued entries (oldest), owners with refusing ATAs if `memo`, then the queue
/// topped up to capacity with non-fitting filler entries (scanned, never paid).
fn full_queue(w: &mut World, n: usize, memo: bool) -> Vec<(Pubkey, Pubkey)> {
    let now = w.now();
    w.set_pool(1);
    let mut real = vec![];
    let mut users = vec![];
    for i in 0..n {
        if i % 2 == 0 {
            users.push(w.user(0));
        }
        let u = users.last().unwrap();
        let t = w.add_ticket(&u.key, 1_000 * M, base_price(), now - 10 * DAY + i as i64);
        let i = w.claim_ix(&u.key, t, u.ata);
        let kp = u.kp.insecure_clone();
        cu(w.env.send(&[i], &[&kp]));
        assert_eq!(w.ticket(&t).status, TicketStatus::Queued);
        real.push((t, u.key));
    }
    if memo {
        for u in &users {
            w.set_balance(u, 0, true);
        }
    }
    fill_queue(w, CLAIM_QUEUE_CAPACITY, now - DAY);
    w.set_pool(50_000_000 * M);
    real
}

/// Top the queue up to `len` entries with huge (never fitting) filler, sell_ts ≥ `from`.
fn fill_queue(w: &mut World, len: usize, from: i64) {
    let mut q = w.queue_state();
    let mut i = 0;
    while (q.len as usize) < len {
        let e = QueueEntry { ticket: Pubkey::new_unique(), owner: Pubkey::new_unique(), amount: u64::MAX / 4_096, sell_ts: from + i };
        let k = q.len as usize;
        q.entries[k] = e;
        q.len += 1;
        q.total_owed = q.total_owed.saturating_add(e.amount);
        i += 1;
    }
    w.write_queue(&q);
}

#[test]
fn cu_report() {
    let mut rows: Vec<(String, u64)> = vec![];
    let cap = CLAIM_QUEUE_CAPACITY;
    let budget = |w: &mut World, i, signers: &[&solana_keypair::Keypair]| {
        cu(w.env.send(&[fl::cu_limit(1_400_000), i], signers))
    };

    // ── init_claim_queue: all CLAIM_QUEUE_INIT_CALLS (9) calls in one transaction ──
    let mut w = World::bare(fumpad::state::CoinStatus::Graduated);
    let i = w.init_queue_ix(&kp_pk(&w.env.payer));
    let mut ixs = vec![fl::cu_limit(1_400_000)];
    ixs.extend(std::iter::repeat_n(i, fumpad::CLAIM_QUEUE_INIT_CALLS));
    rows.push((format!("init_claim_queue × {} (one tx, total)", fumpad::CLAIM_QUEUE_INIT_CALLS), cu(w.env.send(&ixs, &[]))));
    assert_eq!(w.queue_state().mint, w.mint);

    // ── claim / claim_for ────────────────────────────────────────────────────
    let mut w = World::new();
    let u = w.user(0);
    let t = w.add_ticket(&u.key, 1_000 * M, base_price(), w.now() - DAY);
    let i = w.claim_ix(&u.key, t, u.ata);
    rows.push(("claim (paid now, empty queue)".into(), budget(&mut w, i, &[&u.kp])));
    // Paid now behind a FULL queue of older non-fitting entries (has_older_fitting scans all).
    let mut w = World::new();
    let from = w.now() - 80 * DAY;
    fill_queue(&mut w, cap, from);
    let u = w.user(0);
    let t = w.add_ticket(&u.key, 1_000 * M, base_price(), w.now() - DAY);
    let i = w.claim_ix(&u.key, t, u.ata);
    rows.push((format!("claim (paid now, {cap} older entries scanned)"), budget(&mut w, i, &[&u.kp])));
    // Queued at the end: cap−1 older entries scanned, owner count, append.
    let mut w = World::new();
    let from = w.now() - 80 * DAY;
    fill_queue(&mut w, cap - 1, from);
    let u = w.user(0);
    let t = w.add_ticket(&u.key, 1_000 * M, base_price(), w.now() - DAY);
    let i = w.claim_ix(&u.key, t, u.ata);
    rows.push((format!("claim (queued at end, {} ahead → full)", cap - 1), budget(&mut w, i, &[&u.kp])));
    // Queued at the FRONT of a cap−1 queue (shifts every entry; the queue is then full).
    let mut w = World::new();
    let from = w.now() - DAY;
    fill_queue(&mut w, cap - 1, from);
    w.set_pool(1);
    let u = w.user(0);
    let t = w.add_ticket(&u.key, 1_000 * M, base_price(), w.now() - 80 * DAY);
    let i = w.claim_ix(&u.key, t, u.ata);
    rows.push((format!("claim (queued at front, {} shifted → full)", cap - 1), budget(&mut w, i, &[&u.kp])));
    assert_eq!(w.queue_state().len as usize, cap);
    // claim_for (keeper): same scans plus the ATA address derivation / destination check.
    for (front, label) in [(false, "paid now"), (true, "queued at front")] {
        let mut w = World::new();
        let from = w.now() - if front { DAY } else { 80 * DAY };
        fill_queue(&mut w, cap - 1, from);
        if front {
            w.set_pool(1);
        }
        let u = w.user(0);
        let t = w.add_ticket(&u.key, 1_000 * M, base_price(), w.now() - if front { 80 * DAY } else { DAY });
        let k = w.env.keeper.insecure_clone();
        let i = w.claim_for_ix(&kp_pk(&k), t);
        rows.push((format!("claim_for ({label}, {} in queue)", cap - 1), budget(&mut w, i, &[&k])));
    }
    // claim_for paid into a new escrow (memo-required ATA), behind a full queue.
    let mut w = World::new();
    let from = w.now() - 80 * DAY;
    fill_queue(&mut w, cap, from);
    let u = w.user(0);
    w.set_balance(&u, 0, true);
    let t = w.add_ticket(&u.key, 1_000 * M, base_price(), w.now() - DAY);
    let k = w.env.keeper.insecure_clone();
    let i = w.claim_for_ix(&kp_pk(&k), t);
    rows.push((format!("claim_for (escrowed, {cap} older scanned)"), budget(&mut w, i, &[&k])));

    // ── process_queue on a FULL queue. 13 entries per tx is the most a legacy
    //    transaction can carry under the 64-account-lock limit (11 fixed + 13 × 4 = 63). ──
    for n in [0usize, 1, 13] {
        for memo in [false, true] {
            if n == 0 && memo {
                continue;
            }
            let mut w = World::new();
            let real = full_queue(&mut w, n, memo);
            let i = w.process_ix(13, &real);
            let what = if n == 0 { "walk only".to_string() } else if memo { format!("{n} escrowed") } else { format!("{n} paid") };
            rows.push((format!("process_queue ({cap} queued, {what})"), budget(&mut w, i, &[])));
            assert_eq!(w.queue_state().len as usize, cap - n);
        }
    }
    // 13 entries whose tickets were voided/closed (dropped, nothing paid).
    let mut w = World::new();
    let real = full_queue(&mut w, 13, false);
    for (t, _) in &real {
        let mut tk = w.ticket(t);
        tk.status = TicketStatus::Voided;
        tk.claim_amount = 0;
        w.write_ticket(t, &tk);
    }
    let i = w.process_ix(13, &real);
    rows.push((format!("process_queue ({cap} queued, 13 voided dropped)"), budget(&mut w, i, &[])));

    // ── rebuy voiding the FRONT entry of a full queue (register_holdings; buy / swap_buy
    //    share the same hook) and close_ticket scanning a full queue ──
    let mut w = World::new();
    let from = w.now() - DAY;
    fill_queue(&mut w, cap - 1, from);
    w.set_pool(1);
    let u = w.user(0);
    let t = w.add_ticket(&u.key, 1_000 * M, base_price(), w.now() - 2 * DAY);
    let i = w.claim_ix(&u.key, t, u.ata);
    cu(w.env.send(&[i], &[&u.kp]));
    assert_eq!((w.queue_state().len as usize, w.queue_state().entries[0].ticket), (cap, t));
    w.set_balance(&u, 10_000 * M, false);
    let i = w.register_ix(&u, &[t]);
    let kp = u.kp.insecure_clone();
    rows.push((format!("register_holdings (rebuy voids front of {cap} queue)"), budget(&mut w, i, &[&kp])));
    assert_eq!(w.ticket(&t).status, TicketStatus::Voided);
    assert_eq!(w.queue_state().len as usize, cap - 1);
    let from = w.now() - DAY / 2;
    fill_queue(&mut w, cap, from);
    let i = w.close_ix(&u.key, t, true);
    rows.push((format!("close_ticket (voided, {cap} queue scanned)"), budget(&mut w, i, &[&kp])));

    // ── graduate, router, samples on a real coin ────────────────────────────
    let mut f = Flow::new();
    let b = f.env.new_user(100);
    let bk = kp_pk(&b);
    rows.push(("buy (first: creates ATA + position)".into(), cu(f.buy(&b, SOL))));
    rows.push(("buy (existing ATA + position)".into(), cu(f.buy(&b, SOL + 1))));
    let held = f.tokens(&bk);
    rows.push(("sell (creates ticket)".into(), cu(f.sell(&b, held / 2))));
    let whale = f.env.new_user(10_000);
    cu(f.buy(&whale, 200 * SOL));
    rows.push(("graduate".into(), cu(f.graduate())));
    f.post_graduation_setup();
    let u = f.env.new_user(1_000);
    let uk = kp_pk(&u);
    rows.push(("swap_buy (no open tickets)".into(), cu(f.swap_buy(&u, 20 * SOL))));
    f.keeper_samples(45, 15);
    let held = f.tokens(&uk);
    rows.push(("swap_sell (creates ticket)".into(), cu(f.swap_sell(&u, held / 6))));
    for _ in 0..4 {
        cu(f.swap_sell(&u, held / 6));
    }
    assert_eq!(f.open_tickets(&uk).len(), 5);
    rows.push(("swap_buy (5 open tickets, rebuy)".into(), cu(f.swap_buy(&u, 5 * SOL))));
    f.env.warp(15);
    let k = f.env.keeper.insecure_clone();
    let i = f.sample_ix(&kp_pk(&k));
    rows.push(("record_samples (1 coin)".into(), cu(f.env.send_as(&k, &[i], &[&k]))));

    println!("\n| instruction | CU |\n|---|---|");
    for (name, c) in &rows {
        println!("| {name} | {c} |");
        assert!(*c < LIMIT, "{name} exceeds the 1.4M limit");
        assert!(*c < COMFORT, "{name} is above 1M CU: too close to the limit");
    }
}
