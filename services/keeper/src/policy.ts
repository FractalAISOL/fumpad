/** Pure keeper policies (unit tested): queue walk planning, spend accounting. */
import { BPS_DENOM, MAX_QUEUE_ENTRIES_PER_TX, type QueueEntry } from "@fumpad/sdk";

/** The program's per-claim check (logic::fits): non-zero, ≤ cap of the CURRENT pool, ≤ pool. */
export const fitsPool = (amount: bigint, pool: bigint, maxClaimPoolBps: number) =>
  amount > 0n && amount * BPS_DENOM <= pool * BigInt(maxClaimPoolBps) && amount <= pool;

/**
 * H-4: simulate `process_queue`'s skip-ahead walk (process_queue.rs) and return exactly the
 * entries it will pay, in queue order, up to the per-tx limit. The program pays an entry
 * that fits the current (shrinking) pool, skips one that doesn't, and HALTS at a fitting
 * entry that has no account quadruple — so passing quadruples for the first 13 entries
 * (the old behaviour) paid nothing whenever those didn't fit, however many later entries
 * did. Passing exactly the planned entries means every quadruple is consumed and every
 * planned entry is paid (an entry the program finds voided/smaller only pays less; a halt
 * can then only happen AFTER the planned payments).
 */
export function planQueuePayments(
  entries: Pick<QueueEntry, "ticket" | "owner" | "amount">[],
  pool: bigint,
  maxClaimPoolBps: number,
  maxPayments = MAX_QUEUE_ENTRIES_PER_TX,
): { pay: Pick<QueueEntry, "ticket" | "owner" | "amount">[]; poolAfter: bigint } {
  const pay: Pick<QueueEntry, "ticket" | "owner" | "amount">[] = [];
  let p = pool;
  for (const e of entries) {
    if (pay.length >= Math.min(maxPayments, MAX_QUEUE_ENTRIES_PER_TX)) break;
    if (!fitsPool(e.amount, p, maxClaimPoolBps)) continue; // skipped by the program too
    pay.push(e);
    p -= e.amount;
  }
  return { pay, poolAfter: p };
}

/** M-7: keeper spend for the current UTC day, measured from balance decreases (deposits don't count). */
export interface SpendState {
  day: string;
  lamports: string;
  lastBalance: string | null;
}

export const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

export function trackSpend(s: SpendState | null, balance: bigint, now = Date.now()): SpendState {
  const day = utcDay(now);
  const cur = s && s.day === day ? s : { day, lamports: "0", lastBalance: s?.lastBalance ?? null };
  const prev = cur.lastBalance === null ? null : BigInt(cur.lastBalance);
  const spent = prev !== null && balance < prev ? prev - balance : 0n;
  return { day, lamports: (BigInt(cur.lamports) + spent).toString(), lastBalance: balance.toString() };
}
