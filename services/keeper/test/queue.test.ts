/**
 * H-4 regression (was security-review/services-poc/process-queue-stall.test.ts) and M-7
 * keeper spend controls.
 *
 * The PoC: 13 head entries too large for the pool made the keeper pass quadruples for
 * exactly those 13, so the program's walk halted at the first fitting entry behind them —
 * a zero-pay tx every 30 s (plus keeper-paid ATAs for the 13 head owners, farmable).
 * Now the keeper plans with the program's own walk and passes only entries that pay.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { MAX_QUEUE_ENTRIES_PER_TX, type QueueEntry } from "@fumpad/sdk/v06";

import { fitsPool, planQueuePayments, trackSpend, utcDay } from "../src/policy.js";
import { capPriority, computeUnitLimit } from "../src/sender.js";
import { ComputeBudgetProgram, TransactionInstruction } from "@solana/web3.js";

const BPS = 10_000n;

/** process_queue.rs walk: quadruples for `loaded` tickets (in queue order) → tickets paid. */
function programWalk(entries: QueueEntry[], loaded: PublicKey[], pool: bigint, bps: number, maxEntries: number): { paid: string[]; consumedAll: boolean } {
  let r = 0;
  let p = pool;
  let halted = false;
  const paid: string[] = [];
  for (const e of entries) {
    const isLoaded = r < loaded.length && loaded[r].equals(e.ticket);
    if (isLoaded) r++;
    if (!halted && paid.length < maxEntries && fitsPool(e.amount, p, bps)) {
      if (!isLoaded) halted = true;
      else {
        paid.push(e.ticket.toBase58());
        p -= e.amount;
      }
    }
  }
  return { paid, consumedAll: r === loaded.length };
}

const entry = (amount: bigint, sellTs = 0n): QueueEntry => ({ ticket: Keypair.generate().publicKey, owner: Keypair.generate().publicKey, amount, sellTs }) as QueueEntry;

describe("H-4 process_queue planning", () => {
  const pool = 1_000_000n;
  const bps = 1_000; // per-claim cap 10% of the pool
  const cap = (pool * BigInt(bps)) / BPS;

  it("PoC scenario: 13 non-fitting head entries no longer block the fitting entry behind them", () => {
    const big = Array.from({ length: 13 }, (_, i) => entry(cap + 1n + BigInt(i), BigInt(i)));
    const small = entry(cap / 2n, 100n);
    const queue = [...big, small];
    // Old behaviour (first 13 entries) → the program halts at `small`, pays nothing.
    expect(programWalk(queue, big.map((e) => e.ticket), pool, bps, 13).paid).toEqual([]);
    // New plan.
    const plan = planQueuePayments(queue, pool, bps);
    expect(plan.pay.map((e) => e.ticket.toBase58())).toEqual([small.ticket.toBase58()]);
    const walk = programWalk(queue, plan.pay.map((e) => e.ticket), pool, bps, plan.pay.length);
    expect(walk.paid).toEqual([small.ticket.toBase58()]);
    expect(walk.consumedAll).toBe(true); // the program's `r == rem.len()` check passes
  });

  it("matches the program on random queues: every planned entry is paid, nothing payable is skipped", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed / 2 ** 31);
    for (let t = 0; t < 300; t++) {
      const pl = BigInt(Math.floor(rnd() * 2_000_000));
      const q = Array.from({ length: Math.floor(rnd() * 40) }, (_, i) => entry(BigInt(Math.floor(rnd() * 300_000)), BigInt(i)));
      const plan = planQueuePayments(q, pl, bps);
      const walk = programWalk(q, plan.pay.map((e) => e.ticket), pl, bps, plan.pay.length);
      expect(walk.consumedAll).toBe(true);
      expect(walk.paid).toEqual(plan.pay.map((e) => e.ticket.toBase58()));
      expect(plan.pay.length).toBeLessThanOrEqual(MAX_QUEUE_ENTRIES_PER_TX);
      // Maximal: with the plan's remaining pool, any entry not planned before the tx limit doesn't fit.
      if (plan.pay.length < MAX_QUEUE_ENTRIES_PER_TX) {
        let p = pl;
        const planned = new Set(plan.pay.map((e) => e.ticket.toBase58()));
        for (const e of q) {
          if (planned.has(e.ticket.toBase58())) p -= e.amount;
          else expect(fitsPool(e.amount, p, bps)).toBe(false);
        }
      }
    }
  });

  it("respects the 13-entry tx limit and the shrinking pool", () => {
    const q = Array.from({ length: 30 }, () => entry(1_000n));
    expect(planQueuePayments(q, 10_000_000n, bps).pay).toHaveLength(13);
    // Pool 20k, cap 10%: 2k, then 1.9k… — each payment shrinks what the next may take.
    const shrink = planQueuePayments([entry(2_000n), entry(1_900n), entry(1_800n)], 20_000n, bps);
    expect(shrink.pay.map((e) => e.amount)).toEqual([2_000n, 1_800n]);
    expect(planQueuePayments([entry(0n)], 1_000n, bps).pay).toEqual([]);
  });
});

describe("M-7 spend controls", () => {
  it("daily spend counts balance decreases only, resets at 00:00 UTC", () => {
    const t0 = Date.UTC(2026, 9, 12, 10);
    let s = trackSpend(null, 1_000n, t0);
    s = trackSpend(s, 900n, t0 + 1);
    s = trackSpend(s, 2_000n, t0 + 2); // deposit
    s = trackSpend(s, 1_950n, t0 + 3);
    expect(s.lamports).toBe("150");
    expect(s.day).toBe(utcDay(t0));
    const next = trackSpend(s, 1_900n, Date.UTC(2026, 9, 13, 0, 1));
    expect(next.lamports).toBe("50");
  });

  it("priority fee is capped per transaction", () => {
    const ixs: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.alloc(0) })];
    expect(computeUnitLimit(ixs)).toBe(400_000);
    expect(computeUnitLimit(ixs.slice(1))).toBe(200_000);
    // 2,000,000 µL × 400k CU = 0.8 SOL… capped to 200,000 lamports → 500,000 µL/CU.
    expect(capPriority(2_000_000, 400_000, 200_000)).toBe(500_000);
    expect(capPriority(1_000, 400_000, 200_000)).toBe(1_000);
  });
});
