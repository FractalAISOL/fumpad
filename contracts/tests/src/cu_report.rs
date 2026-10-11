//! v0.3 compute-unit report: worst-case CU of the heavy instructions, each asserted to fit
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
    let mut rows: Vec<(&str, u64)> = vec![];

    // ── claim ────────────────────────────────────────────────────────────────
    let mut w = World::new();
    let u = w.user(0);
    let t = w.add_ticket(&u.key, 1_000 * M, base_price(), w.now() - DAY);
    let i = w.claim_ix(&u.key, t, u.ata);
    rows.push(("claim (paid now)", cu(w.env.send(&[fl::cu_limit(1_400_000), i], &[&u.kp]))));
    // Worst case: 255 older entries scanned, owner count, insert at the end of the queue.
    let mut w = World::new();
    let from = w.now() - 80 * DAY;
    fill_queue(&mut w, CLAIM_QUEUE_CAPACITY - 1, from);
    let u = w.user(0);
    let t = w.add_ticket(&u.key, 1_000 * M, base_price(), w.now() - DAY);
    let i = w.claim_ix(&u.key, t, u.ata);
    rows.push(("claim (queued, 255 ahead)", cu(w.env.send(&[fl::cu_limit(1_400_000), i], &[&u.kp]))));
    // Insert at the FRONT of a 255-entry queue (shifts every entry).
    let mut w = World::new();
    let from = w.now() - DAY;
    fill_queue(&mut w, CLAIM_QUEUE_CAPACITY - 1, from);
    w.set_pool(1);
    let u = w.user(0);
    let t = w.add_ticket(&u.key, 1_000 * M, base_price(), w.now() - 80 * DAY);
    let i = w.claim_ix(&u.key, t, u.ata);
    rows.push(("claim (queued at front, 255 shifted)", cu(w.env.send(&[fl::cu_limit(1_400_000), i], &[&u.kp]))));

    // ── process_queue: full queue (256), 13 entries per tx — the most a transaction can
    //    carry under the 64-account-lock limit (11 fixed + 13 × 4 = 63) — direct
    //    payouts, and all-escrow (the heaviest path) ──
    for (memo, label) in [(false, "process_queue (256 queued, 13 paid)"), (true, "process_queue (256 queued, 13 escrowed)")] {
        let mut w = World::new();
        let real = full_queue(&mut w, 13, memo);
        let i = w.process_ix(13, &real);
        rows.push((label, cu(w.env.send(&[fl::cu_limit(1_400_000), i], &[]))));
        assert_eq!(w.queue_state().len as usize, CLAIM_QUEUE_CAPACITY - 13);
    }
    // ── graduate, router, samples on a real coin ────────────────────────────
    let mut f = Flow::new();
    let whale = f.env.new_user(10_000);
    cu(f.buy(&whale, 200 * SOL));
    rows.push(("graduate", cu(f.graduate())));
    f.post_graduation_setup();
    let u = f.env.new_user(1_000);
    let uk = kp_pk(&u);
    rows.push(("swap_buy (no open tickets)", cu(f.swap_buy(&u, 20 * SOL))));
    f.keeper_samples(45, 15);
    let held = f.tokens(&uk);
    rows.push(("swap_sell (creates ticket)", cu(f.swap_sell(&u, held / 6))));
    for _ in 0..4 {
        cu(f.swap_sell(&u, held / 6));
    }
    assert_eq!(f.open_tickets(&uk).len(), 5);
    rows.push(("swap_buy (5 open tickets, rebuy)", cu(f.swap_buy(&u, 5 * SOL))));
    f.env.warp(15);
    let k = f.env.keeper.insecure_clone();
    let i = f.sample_ix(&kp_pk(&k));
    rows.push(("record_samples (1 coin)", cu(f.env.send_as(&k, &[i], &[&k]))));

    println!("\n| instruction | CU |\n|---|---|");
    for (name, c) in &rows {
        println!("| {name} | {c} |");
        assert!(*c < LIMIT, "{name} exceeds the 1.4M limit");
    }
}
