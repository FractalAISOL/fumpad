/** Pure keeper policies (unit tested): queue walk planning, spend accounting. */
import { BPS_DENOM } from "@fumpad/sdk/v06";

/** The program's per-claim check (logic::fits): non-zero, ≤ cap of the CURRENT pool, ≤ pool. */
export const fitsPool = (amount: bigint, pool: bigint, maxClaimPoolBps: number) =>
  amount > 0n && amount * BPS_DENOM <= pool * BigInt(maxClaimPoolBps) && amount <= pool;

/**
 * H-4: simulate `process_queue`'s skip-ahead walk and return exactly the entries it will pay.
 * Lives in the SDK since v0.6 (`FumpadClient.buildProcessQueue` uses it too); re-exported here.
 */
export { planQueuePayments } from "@fumpad/sdk/v06";

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
