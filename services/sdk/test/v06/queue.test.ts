/**
 * Services review H-4 for the SDK (security-review/services-poc/process-queue-stall.test.ts):
 * `FumpadClient.buildProcessQueue` used to pass quadruples for the FIRST 13 queue entries, so
 * 13 non-fitting head entries made every later fitting entry unreachable (the program's walk
 * halts at a fitting entry without a quadruple). It now plans with the program's own walk.
 */
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import type { ClaimQueueAccount, QueueEntry } from "../../src/v06/accounts.js";
import { FumpadClient } from "../../src/v06/client.js";
import { MAX_QUEUE_ENTRIES_PER_TX } from "../../src/v06/constants.js";
import { planQueuePayments } from "../../src/v06/math/rewards.js";

const BPS = 10_000n;
const k = () => Keypair.generate().publicKey;
const entry = (amount: bigint, i: number): QueueEntry => ({ ticket: k(), owner: k(), amount, sellTs: BigInt(i) });

/** The program's walk (process_queue.rs): skip non-fitting, halt at fitting-without-quadruple. */
function programWalk(entries: QueueEntry[], quads: string[], pool: bigint, bps: bigint): number {
  let paid = 0;
  let r = 0;
  let p = pool;
  for (const e of entries) {
    const loaded = r < quads.length && quads[r] === e.ticket.toBase58();
    if (loaded) r++;
    const fits = e.amount > 0n && e.amount * BPS <= p * bps && e.amount <= p;
    if (!fits) continue;
    if (!loaded) break;
    paid++;
    p -= e.amount;
  }
  return paid;
}

function clientWith(queue: ClaimQueueAccount) {
  const c = new FumpadClient({} as never);
  (c as unknown as { claimQueue: () => Promise<ClaimQueueAccount> }).claimQueue = async () => queue;
  return c;
}

describe("process_queue planning (H-4 in the SDK)", () => {
  const pool = 1_000_000n;
  const bps = 1_000;
  const cap = (pool * BigInt(bps)) / BPS;

  it("regression: 13 non-fitting head entries no longer hide the payable entry behind them", async () => {
    const big = Array.from({ length: 13 }, (_, i) => entry(cap + 1n + BigInt(i), i));
    const small = entry(cap / 2n, 100);
    const queue = { mint: k(), len: 14, totalOwed: 0n, entries: [...big, small] } as ClaimQueueAccount;
    const b = await clientWith(queue).buildProcessQueue({ cranker: k(), mint: queue.mint, pool, maxClaimPoolBps: bps });
    expect(b).not.toBeNull();
    expect(b!.entries.map((e) => e.ticket.toBase58())).toEqual([small.ticket.toBase58()]);
    const keys = new Set(b!.instructions.at(-1)!.keys.map((m) => m.pubkey.toBase58()));
    expect(big.some((e) => keys.has(e.ticket.toBase58()))).toBe(false);
    expect(b!.owners.map((o) => o.toBase58())).toEqual([small.owner.toBase58()]);
    expect(programWalk(queue.entries, b!.entries.map((e) => e.ticket.toBase58()), pool, BigInt(bps))).toBe(1);
  });

  it("nothing payable → null (no zero-pay transaction); shrinking pool and the 13 cap respected", async () => {
    const none = { mint: k(), len: 2, totalOwed: 0n, entries: [entry(cap + 1n, 0), entry(0n, 1)] } as ClaimQueueAccount;
    expect(await clientWith(none).buildProcessQueue({ cranker: k(), mint: none.mint, pool, maxClaimPoolBps: bps })).toBeNull();
    // Each payment shrinks the pool (and the cap with it): the planner follows the program.
    const many = Array.from({ length: 30 }, (_, i) => entry(cap / 4n, i));
    const { pay, poolAfter } = planQueuePayments(many, pool, bps);
    expect(pay.length).toBe(MAX_QUEUE_ENTRIES_PER_TX);
    expect(programWalk(many, pay.map((e) => e.ticket.toBase58()), pool, BigInt(bps))).toBe(pay.length);
    expect(poolAfter).toBe(pool - (cap / 4n) * BigInt(pay.length));
    const tight = planQueuePayments([entry(cap, 0), entry(cap, 1)], pool, bps);
    expect(tight.pay.length).toBe(1); // after the first, `cap` exceeds 10% of the smaller pool
    expect(planQueuePayments(many, pool, bps, 3).pay.length).toBe(3);
  });
});
