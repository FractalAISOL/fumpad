// Bit-exact port of the v0.6 hold / rebuy rules:
//   contracts/programs/fumpad/src/state/position.rs (settle, add, observed_balance)
//   contracts/programs/fumpad/src/instructions/rewards/logic.rs (cap_tracked, debit_sold, plan_sell,
//   observe_buy, plan_rebuy, claim_amount)
// u64 saturating arithmetic is reproduced with explicit clamps (values never exceed u64 in practice;
// `sat` keeps the Rust semantics if they ever did).
import { U64_MAX } from "./price.js";

const satAdd = (a: bigint, b: bigint) => (a + b > U64_MAX ? U64_MAX : a + b);
const satSub = (a: bigint, b: bigint) => (a > b ? a - b : 0n);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

/** The rule-relevant part of `Position` (wallet × mint). */
export interface HoldState {
  matured: bigint;
  pending: bigint;
  /** i64 */
  pendingSince: bigint;
  lastBalance: bigint;
  /** Open tickets (Open or Queued) the wallet holds on the coin. */
  openCount: number;
}

export const newHold = (): HoldState => ({ matured: 0n, pending: 0n, pendingSince: 0n, lastBalance: 0n, openCount: 0 });

/** Position::settle */
export function settle(p: HoldState, now: bigint, minHoldSecs: bigint): void {
  // now.saturating_sub(pending_since) on i64; the values are unix seconds, no overflow.
  if (p.pending > 0n && now - p.pendingSince >= minHoldSecs) {
    p.matured = satAdd(p.matured, p.pending);
    p.pending = 0n;
  }
}

/** Position::observed_balance */
export const observedBalance = (p: HoldState): bigint => max(p.lastBalance, satAdd(p.matured, p.pending));

/** Position::add */
export function add(p: HoldState, amount: bigint, now: bigint, minHoldSecs: bigint): void {
  settle(p, now, minHoldSecs);
  p.pending = satAdd(p.pending, amount);
  p.pendingSince = now;
}

/** logic::cap_tracked */
export function capTracked(p: HoldState, balance: bigint): void {
  const tracked = satAdd(p.matured, p.pending);
  if (tracked <= balance) return;
  let excess = tracked - balance;
  const fromMatured = min(excess, p.matured);
  p.matured -= fromMatured;
  excess -= fromMatured;
  p.pending = satSub(p.pending, excess);
}

/** logic::debit_sold */
export function debitSold(p: HoldState, sold: bigint): void {
  const m = min(sold, p.matured);
  p.matured -= m;
  const rest = sold - m;
  p.pending = satSub(p.pending, rest);
}

/** logic::NoTicket (subset decided by plan_sell). */
export type PlanSellRefusal = "creator" | "not_matured" | "too_many_open_tickets";

export interface HoldParams {
  minHoldSecs: bigint;
  maxOpenTickets: number;
}

/**
 * logic::plan_sell — always mutates (settle, cap, debit, last_balance) and returns the ticket
 * candidate size or why none.
 */
export function planSell(
  p: HoldState,
  params: HoldParams,
  isCreator: boolean,
  tokensSold: bigint,
  balanceBefore: bigint,
  now: bigint,
): { ok: true; tokens: bigint } | { ok: false; reason: PlanSellRefusal } {
  settle(p, now, params.minHoldSecs);
  const unseen = satSub(balanceBefore, observedBalance(p));
  capTracked(p, balanceBefore);
  const trackedSold = tokensSold - min(tokensSold, unseen);
  const ticketTokens = min(trackedSold, p.matured);
  debitSold(p, trackedSold);
  p.lastBalance = satSub(balanceBefore, tokensSold);
  if (isCreator) return { ok: false, reason: "creator" };
  if (ticketTokens === 0n) return { ok: false, reason: "not_matured" };
  if (p.openCount >= params.maxOpenTickets) return { ok: false, reason: "too_many_open_tickets" };
  return { ok: true, tokens: ticketTokens };
}

/** logic::observe_buy */
export function observeBuy(p: HoldState, params: HoldParams, bought: bigint, balanceBefore: bigint, now: bigint): void {
  settle(p, now, params.minHoldSecs);
  capTracked(p, balanceBefore);
  add(p, bought, now, params.minHoldSecs);
  p.lastBalance = satAdd(balanceBefore, bought);
}

export interface RebuyView {
  /** i64 */
  sellTs: bigint;
  /** Tie-break among equal sellTs: higher = newer (on-chain: Ticket.seq). */
  seq: bigint;
  tokens: bigint;
  active: boolean; // status Open | Queued
}

/** logic::plan_rebuy — newest first (sellTs, seq desc), only active tickets within the window. */
export function planRebuy(tickets: readonly RebuyView[], amount: bigint, now: bigint, windowSecs: bigint): bigint[] {
  const debits = tickets.map(() => 0n);
  const order: number[] = [];
  tickets.forEach((t, i) => {
    if (t.active && t.tokens > 0n && now >= t.sellTs && now - t.sellTs <= windowSecs) order.push(i);
  });
  // Stable insertion sort, descending by (sellTs, seq) — identical to the Rust loop.
  const less = (a: number, b: number) => {
    const x = tickets[a];
    const y = tickets[b];
    return x.sellTs < y.sellTs || (x.sellTs === y.sellTs && x.seq < y.seq);
  };
  for (let j = 1; j < order.length; j++) {
    let k = j;
    while (k > 0 && less(order[k - 1], order[k])) {
      [order[k - 1], order[k]] = [order[k], order[k - 1]];
      k--;
    }
  }
  let left = amount;
  for (const i of order) {
    if (left === 0n) break;
    const d = min(left, tickets[i].tokens);
    debits[i] = d;
    left -= d;
  }
  return debits;
}

/** logic::claim_amount */
export const claimAmount = (tokens: bigint, claimBps: bigint): bigint => (tokens * claimBps) / 10_000n;
