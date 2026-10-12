//! Pure reward-eligibility logic (no account access), so every abuse rule can be
//! unit-tested in isolation. OWNER: rewards module.
//!
//! Position model (see `state/position.rs`): `matured` + `pending` = tokens FUMPAD knows
//! the wallet acquired through FUMPAD buys or `register_holdings`. The program cannot see
//! transfers or trades on other venues, so whenever the wallet's real balance is known
//! (sells, `register_holdings`) the tracked amount is capped to it. Tokens that left the
//! wallet outside FUMPAD are assumed to have been the *matured* ones (the strict reading).

use crate::{
    constants::BPS_DENOM,
    state::{Params, Position, TicketStatus},
};
use anchor_lang::prelude::Pubkey;

/// Cap `matured + pending` to the wallet's real `balance`, removing from `matured` first.
pub fn cap_tracked(pos: &mut Position, balance: u64) {
    let tracked = pos.matured.saturating_add(pos.pending);
    if tracked <= balance {
        return;
    }
    let mut excess = tracked - balance;
    let from_matured = excess.min(pos.matured);
    pos.matured -= from_matured;
    excess -= from_matured;
    pos.pending = pos.pending.saturating_sub(excess);
}

/// Debit `sold` tokens from the tracked buckets, matured first (the seller sells their
/// eligible tokens first, which is what makes the ticket). Untracked tokens absorb the rest.
pub fn debit_sold(pos: &mut Position, sold: u64) {
    let m = sold.min(pos.matured);
    pos.matured -= m;
    let rest = sold - m;
    pos.pending = pos.pending.saturating_sub(rest);
}

/// Why a sell did not get a ticket (informational; never an error).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoTicket {
    Creator,
    /// None of the sold tokens had been held for `min_hold_secs`.
    NotMatured,
    TooManyOpenTickets,
    BelowMinimumUsd,
    OracleUnavailable,
    ZeroPrice,
}

/// Settle, cap and debit the position for a sell, and return the ticket candidate size.
/// Always mutates the position (every tracked sold token is debited, `last_balance`
/// updated) — even when no ticket results. The USD check is done by the caller (needs the
/// oracle) on the returned amount.
///
/// R-L2: tokens that arrived since FUMPAD last observed the balance
/// (`balance_before − last_balance`, if positive) are untracked and are sold FIRST; only
/// the rest of the sale draws on the matured credit. Residual (documented, SPEC §5.3):
/// FUMPAD only sees the balance at its own touch points, so tokens that left unseen and
/// were replaced by at most as many fresh ones before the next touch are indistinguishable
/// from tokens that never moved.
pub fn plan_sell(
    pos: &mut Position,
    p: &Params,
    is_creator: bool,
    tokens_sold: u64,
    balance_before: u64,
    now: i64,
) -> Result<u64, NoTicket> {
    pos.settle(now, p.min_hold_secs);
    let unseen = balance_before.saturating_sub(pos.observed_balance());
    cap_tracked(pos, balance_before);
    let tracked_sold = tokens_sold - tokens_sold.min(unseen);
    let ticket_tokens = tracked_sold.min(pos.matured);
    debit_sold(pos, tracked_sold);
    pos.last_balance = balance_before.saturating_sub(tokens_sold);
    if is_creator {
        return Err(NoTicket::Creator);
    }
    if ticket_tokens == 0 {
        return Err(NoTicket::NotMatured);
    }
    if pos.open_count >= p.max_open_tickets {
        return Err(NoTicket::TooManyOpenTickets);
    }
    Ok(ticket_tokens)
}

/// A FUMPAD buy / `register_holdings` observation: cap what is tracked to the balance
/// seen before the new tokens (unseen outflows came out of `matured` first), add the new
/// tokens as pending, and record the balance after.
pub fn observe_buy(pos: &mut Position, p: &Params, bought: u64, balance_before: u64, now: i64) {
    pos.settle(now, p.min_hold_secs);
    cap_tracked(pos, balance_before);
    pos.add(bought, now, p.min_hold_secs);
    pos.last_balance = balance_before.saturating_add(bought);
}

// ── open-ticket list ─────────────────────────────────────────────────────────

pub fn push_open(pos: &mut Position, key: Pubkey) -> bool {
    if pos.open_tickets.contains(&key) {
        return false;
    }
    match pos.open_tickets.iter_mut().find(|k| **k == Pubkey::default()) {
        Some(slot) => {
            *slot = key;
            pos.open_count += 1;
            true
        }
        None => false,
    }
}

/// Idempotent: returns whether the key was present.
pub fn remove_open(pos: &mut Position, key: &Pubkey) -> bool {
    if *key == Pubkey::default() {
        return false;
    }
    match pos.open_tickets.iter_mut().find(|k| *k == key) {
        Some(slot) => {
            *slot = Pubkey::default();
            pos.open_count = pos.open_count.saturating_sub(1);
            true
        }
        None => false,
    }
}

/// True iff `keys` is exactly the set of the position's open tickets (no duplicates,
/// no extras, none missing).
pub fn open_set_matches(pos: &Position, keys: &[Pubkey]) -> bool {
    if keys.len() != pos.open_count as usize {
        return false;
    }
    let listed = pos.open_tickets.iter().filter(|k| **k != Pubkey::default()).count();
    if listed != keys.len() {
        return false;
    }
    for (i, k) in keys.iter().enumerate() {
        if *k == Pubkey::default() || !pos.open_tickets.contains(k) || keys[..i].contains(k) {
            return false;
        }
    }
    true
}

// ── rebuy rule ───────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RebuyView {
    pub sell_ts: i64,
    pub seq: u64,
    pub tokens: u64,
    pub status: TicketStatus,
}

/// Distribute `amount` rebought tokens over the tickets, newest sell first (ties: higher
/// seq first), only for Open/Queued tickets whose sell was within `window_secs` of `now`.
/// Returns the debit for each ticket (same order as the input).
pub fn plan_rebuy(tickets: &[RebuyView], amount: u64, now: i64, window_secs: i64) -> Vec<u64> {
    let mut debits = vec![0u64; tickets.len()];
    let mut order: Vec<usize> = (0..tickets.len())
        .filter(|&i| {
            let t = &tickets[i];
            matches!(t.status, TicketStatus::Open | TicketStatus::Queued)
                && t.tokens > 0
                && now >= t.sell_ts
                && now - t.sell_ts <= window_secs
        })
        .collect();
    // Newest first: (sell_ts, seq) descending. Stable insertion sort over ≤ MAX_OPEN_TICKETS
    // entries — same order as a stable `sort_by`, without std's ~15 KB driftsort in the binary.
    let key = |i: usize| (tickets[i].sell_ts, tickets[i].seq);
    for j in 1..order.len() {
        let mut k = j;
        while k > 0 && key(order[k - 1]) < key(order[k]) {
            order.swap(k - 1, k);
            k -= 1;
        }
    }
    let mut left = amount;
    for i in order {
        if left == 0 {
            break;
        }
        let d = left.min(tickets[i].tokens);
        debits[i] = d;
        left -= d;
    }
    debits
}

// ── claims ───────────────────────────────────────────────────────────────────

/// Tokens owed for a ticket: `tokens × claim_bps / 10_000`, rounded down.
pub fn claim_amount(tokens: u64, claim_bps: u16) -> u64 {
    ((tokens as u128) * claim_bps as u128 / BPS_DENOM as u128) as u64
}

/// Per-claim cap: `pool × max_claim_pool_bps / 10_000`, rounded down.
pub fn claim_cap(pool: u64, max_claim_pool_bps: u16) -> u64 {
    ((pool as u128) * max_claim_pool_bps as u128 / BPS_DENOM as u128) as u64
}

/// An amount is payable from `pool` iff it is non-zero, within the per-claim cap and
/// within the pool.
pub fn fits(amount: u64, pool: u64, max_claim_pool_bps: u16) -> bool {
    amount > 0 && amount <= claim_cap(pool, max_claim_pool_bps) && amount <= pool
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pos() -> Position {
        Position {
            bump: 0,
            wallet: Pubkey::new_unique(),
            mint: Pubkey::new_unique(),
            matured: 0,
            pending: 0,
            pending_since: 0,
            next_ticket_seq: 0,
            open_tickets: [Pubkey::default(); crate::constants::MAX_OPEN_TICKETS],
            open_count: 0,
            last_balance: 0,
            auto_claim_opt_out: 0,
            reserved: [0; 55],
        }
    }

    #[test]
    fn min_hold_ten_minutes() {
        let p = Params::default();
        let mut s = pos();
        s.add(1_000, 0, p.min_hold_secs);
        // 9:59 later: nothing matured → no ticket, and the sold tokens are still debited.
        assert_eq!(plan_sell(&mut s.clone(), &p, false, 1_000, 1_000, 599), Err(NoTicket::NotMatured));
        let mut s2 = s.clone();
        let _ = plan_sell(&mut s2, &p, false, 400, 1_000, 599);
        assert_eq!((s2.matured, s2.pending), (0, 600));
        // 10:00 later: matured.
        assert_eq!(plan_sell(&mut s.clone(), &p, false, 1_000, 1_000, 600), Ok(1_000));
    }

    #[test]
    fn new_buy_does_not_reset_matured_clock_but_restarts_pending() {
        let p = Params::default();
        let mut s = pos();
        s.add(1_000, 0, p.min_hold_secs);
        s.add(500, 700, p.min_hold_secs); // first 1_000 matured at 600 → settled here
        assert_eq!((s.matured, s.pending, s.pending_since), (1_000, 500, 700));
        // Selling 1_500 at t=800: only 1_000 qualify.
        assert_eq!(plan_sell(&mut s.clone(), &p, false, 1_500, 1_500, 800), Ok(1_000));
        // Adding to unmatured pending restarts its clock for all of it.
        s.add(100, 1_000, p.min_hold_secs);
        assert_eq!((s.pending, s.pending_since), (600, 1_000));
        s.settle(1_599, p.min_hold_secs);
        assert_eq!(s.pending, 600);
        s.settle(1_600, p.min_hold_secs);
        assert_eq!((s.matured, s.pending), (1_600, 0));
    }

    #[test]
    fn ticket_capped_by_sold_and_balance() {
        let p = Params::default();
        let mut s = pos();
        s.add(1_000, 0, p.min_hold_secs);
        // Sold less than matured.
        let mut a = s.clone();
        assert_eq!(plan_sell(&mut a, &p, false, 300, 1_000, 700), Ok(300));
        assert_eq!(a.matured, 700);
        // Wallet moved 800 out elsewhere: only 200 left → ticket ≤ 200 even if 500 sold
        // (the extra 300 sold came from untracked tokens).
        let mut b = s.clone();
        assert_eq!(plan_sell(&mut b, &p, false, 500, 200, 700), Ok(200));
        assert_eq!((b.matured, b.pending), (0, 0));
    }

    /// R-L2: tokens that arrived unseen since the last observation are sold first.
    #[test]
    fn unseen_arrivals_sold_first() {
        let p = Params::default();
        let mut s = pos();
        observe_buy(&mut s, &p, 1_000, 0, 0); // FUMPAD buy: observed 1_000
        assert_eq!((s.pending, s.last_balance), (1_000, 1_000));
        // 10 min later 400 fresh tokens arrive by transfer; selling 400 → all unseen → none.
        let mut a = s.clone();
        assert_eq!(plan_sell(&mut a, &p, false, 400, 1_400, 600), Err(NoTicket::NotMatured));
        assert_eq!((a.matured, a.last_balance), (1_000, 1_000), "matured credit kept for the held bag");
        // Selling everything: 400 unseen + 1_000 matured → ticket 1_000.
        let mut b = s.clone();
        assert_eq!(plan_sell(&mut b, &p, false, 1_400, 1_400, 600), Ok(1_000));
        assert_eq!((b.matured, b.pending, b.last_balance), (0, 0, 0));
        // Bag moved out unseen and replaced by MORE fresh tokens (1_500): only the 1_000
        // observed earlier can be matured (residual: ≤ the old credit, see SPEC §5.3).
        let mut c = s.clone();
        assert_eq!(plan_sell(&mut c, &p, false, 1_500, 1_500, 600), Ok(1_000));
        // A buy observes an unseen outflow: tracked capped before adding the new tokens.
        let mut d = s.clone();
        observe_buy(&mut d, &p, 50, 200, 700);
        assert_eq!((d.matured, d.pending, d.last_balance), (200, 50, 250));
        // Legacy position (last_balance 0): treated as observed = tracked.
        let mut e = pos();
        e.add(1_000, 0, p.min_hold_secs);
        assert_eq!(plan_sell(&mut e, &p, false, 1_000, 1_000, 600), Ok(1_000));
    }

    #[test]
    fn cap_removes_matured_first() {
        let mut s = pos();
        s.matured = 100;
        s.pending = 50;
        cap_tracked(&mut s, 120);
        assert_eq!((s.matured, s.pending), (70, 50));
        cap_tracked(&mut s, 10);
        assert_eq!((s.matured, s.pending), (0, 10));
        cap_tracked(&mut s, 1_000);
        assert_eq!((s.matured, s.pending), (0, 10));
    }

    #[test]
    fn creator_and_open_ticket_limit() {
        let p = Params::default();
        let mut s = pos();
        s.add(1_000, 0, p.min_hold_secs);
        let mut c = s.clone();
        assert_eq!(plan_sell(&mut c, &p, true, 500, 1_000, 700), Err(NoTicket::Creator));
        assert_eq!(c.matured, 500); // still debited
        for _ in 0..5 {
            assert!(push_open(&mut s, Pubkey::new_unique()));
        }
        assert_eq!(plan_sell(&mut s.clone(), &p, false, 500, 1_000, 700), Err(NoTicket::TooManyOpenTickets));
        assert!(!push_open(&mut s, Pubkey::new_unique()));
    }

    #[test]
    fn open_list_ops() {
        let mut s = pos();
        let (a, b, c) = (Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique());
        assert!(open_set_matches(&s, &[]));
        assert!(push_open(&mut s, a));
        assert!(!push_open(&mut s, a));
        assert!(push_open(&mut s, b));
        assert!(open_set_matches(&s, &[b, a]));
        assert!(!open_set_matches(&s, &[a]));
        assert!(!open_set_matches(&s, &[a, a]));
        assert!(!open_set_matches(&s, &[a, c]));
        assert!(!open_set_matches(&s, &[a, b, c]));
        assert!(remove_open(&mut s, &a));
        assert!(!remove_open(&mut s, &a));
        assert!(!remove_open(&mut s, &Pubkey::default()));
        assert!(open_set_matches(&s, &[b]));
        assert_eq!(s.open_count, 1);
        assert!(push_open(&mut s, c)); // reuses the freed slot
        assert_eq!(s.open_tickets[0], c);
    }

    #[test]
    fn rebuy_newest_first_within_window() {
        let w = 7 * 86_400;
        let t = |sell_ts, seq, tokens, status| RebuyView { sell_ts, seq, tokens, status };
        let tickets = [
            t(100, 0, 1_000, TicketStatus::Open),
            t(300, 2, 400, TicketStatus::Queued),
            t(200, 1, 500, TicketStatus::Open),
            t(300, 3, 50, TicketStatus::Claimed), // not active
            t(-w, 4, 9_999, TicketStatus::Open),  // outside the window at now=1
        ];
        // 600 rebought: newest (seq 2, 400) fully, then seq 1 gets 200.
        assert_eq!(plan_rebuy(&tickets, 600, 1_000, w), vec![0, 400, 200, 0, 0]);
        // Huge rebuy: everything in-window voided, excess ignored.
        assert_eq!(plan_rebuy(&tickets, 10_000, 1_000, w), vec![1_000, 400, 500, 0, 0]);
        // Window edge: exactly 7 days later still counts; one second later doesn't.
        assert_eq!(plan_rebuy(&[t(0, 0, 10, TicketStatus::Open)], 5, w, w), vec![5]);
        assert_eq!(plan_rebuy(&[t(0, 0, 10, TicketStatus::Open)], 5, w + 1, w), vec![0]);
        // Same sell_ts → higher seq is newer.
        let same = [t(5, 0, 10, TicketStatus::Open), t(5, 1, 10, TicketStatus::Open)];
        assert_eq!(plan_rebuy(&same, 15, 10, w), vec![5, 10]);
        // The insertion sort matches the reference stable `sort_by` (pseudo-random sets with
        // duplicate (sell_ts, seq) keys, 0..=8 tickets, every partial amount).
        let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
        for _ in 0..2_000 {
            let mut next = || {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                x
            };
            let n = (next() % 9) as usize;
            let ts: Vec<RebuyView> =
                (0..n).map(|_| t((next() % 4) as i64, next() % 3, 1 + next() % 50, TicketStatus::Open)).collect();
            let mut order: Vec<usize> = (0..n).collect();
            order.sort_by(|&a, &b| (ts[b].sell_ts, ts[b].seq).cmp(&(ts[a].sell_ts, ts[a].seq)));
            let total: u64 = ts.iter().map(|v| v.tokens).sum();
            let amount = next() % (total + 1);
            let mut want = vec![0u64; n];
            let mut left = amount;
            for i in order {
                let d = left.min(ts[i].tokens);
                want[i] = d;
                left -= d;
            }
            assert_eq!(plan_rebuy(&ts, amount, 10, w), want);
        }
    }

    #[test]
    fn claim_math() {
        assert_eq!(claim_amount(1_000_000, 1_000), 100_000);
        assert_eq!(claim_amount(9, 1_000), 0);
        assert_eq!(claim_amount(u64::MAX, 10_000), u64::MAX);
        assert_eq!(claim_cap(1_000, 1_000), 100);
        assert!(fits(100, 1_000, 1_000));
        assert!(!fits(101, 1_000, 1_000));
        assert!(!fits(0, 1_000, 1_000));
        assert!(!fits(1, 9, 1_000)); // cap 0
        assert!(fits(1_000, 1_000, 10_000));
    }
}
