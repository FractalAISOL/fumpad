// PoC for audit finding S-1 (High), flipped after the fix: crawlMintHistory used to re-poll EVERY open token
// account on every run, so once a coin had more open token accounts than the per-coin RPC budget
// (ATTEST_COIN_RPC_BUDGET default 5,000, keeper/src/attest/run.ts) the crawl threw CrawlBudgetExceeded on every run
// and never returned a history (5,200 accounts: 8/8 ticks failed). These tests assert the attack now FAILS.
// Mock RPC only; no network.
import { describe, expect, it } from "vitest";

import type { ConfirmedTx, MeteoraRpc, SignatureInfo } from "@fumpad/meteora";

import { CrawlBudgetExceeded, crawlMintHistory, type MintCrawlState } from "../src/index.js";

const MINT = "Mint111111111111111111111111111111111111111";
const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const BUDGET = 5_000; // ATTEST_COIN_RPC_BUDGET default

/** Indexed fake RPC (fast for thousands of accounts). */
class FakeRpc {
  bySig = new Map<string, ConfirmedTx>();
  byAddr = new Map<string, SignatureInfo[]>(); // newest first
  calls = 0;
  add(t: ConfirmedTx) {
    const s = t.transaction.signatures[0];
    this.bySig.set(s, t);
    for (const k of (t.transaction.message as unknown as { accountKeys: string[] }).accountKeys) {
      const l = this.byAddr.get(k) ?? [];
      l.unshift({ signature: s, slot: t.slot, err: null, blockTime: t.blockTime ?? null } as SignatureInfo);
      this.byAddr.set(k, l);
    }
  }
  async getSlot() {
    this.calls++;
    return 1_000;
  }
  async getSignaturesForAddress(addr: string, o: { before?: string; until?: string; limit?: number }) {
    // yield to the event loop now and then so vitest's worker RPC isn't starved (a real RPC is I/O anyway)
    if (++this.calls % 250 === 0) await new Promise((r) => setImmediate(r));
    const all = this.byAddr.get(addr) ?? [];
    let i = o.before ? all.findIndex((s) => s.signature === o.before) + 1 : 0;
    const out: SignatureInfo[] = [];
    for (; i < all.length && out.length < (o.limit ?? 1000); i++) {
      if (all[i].signature === o.until) break;
      out.push(all[i]);
    }
    return out;
  }
  async getTransaction(s: string) {
    this.calls++;
    return this.bySig.get(s) ?? null;
  }
  async call(method: string, params: unknown[]) {
    this.calls++;
    if (method !== "getBlock") throw new Error(method);
    return { signatures: [...this.bySig.values()].filter((t) => t.slot === params[0]).map((t) => t.transaction.signatures[0]) };
  }
}

/** One tx (listing the mint) that creates `accs` token accounts, each left OPEN with a balance. */
function createTx(slot: number, accs: string[]): ConfirmedTx {
  const keys = ["Signer", ...accs, MINT];
  return {
    slot,
    blockTime: 1_700_000_000 + slot,
    transaction: { signatures: [`create${slot}`.padEnd(20, "x")], message: { accountKeys: keys, header: { numRequiredSignatures: 1 }, instructions: [] } },
    meta: {
      err: null,
      innerInstructions: [],
      preTokenBalances: [],
      postTokenBalances: accs.map((_, i) => ({ accountIndex: i + 1, mint: MINT, owner: `Owner${slot}_${i}`, programId: T22, uiTokenAmount: { amount: "1" } })),
    },
  } as unknown as ConfirmedTx;
}

function chain(openAccounts: number): FakeRpc {
  const rpc = new FakeRpc();
  const perTx = 900;
  for (let k = 0, slot = 10; k < openAccounts; k += perTx, slot++) {
    rpc.add(createTx(slot, Array.from({ length: Math.min(perTx, openAccounts - k) }, (_, i) => `Acc${k + i}`)));
  }
  return rpc;
}


/** A plain SPL `Transfer` between two existing accounts: lists the accounts, NOT the mint. */
function plainTransferTx(slot: number, from: { acc: string; owner: string; pre: bigint; post: bigint }, to: { acc: string; owner: string; pre: bigint; post: bigint }): ConfirmedTx {
  const keys = ["Signer", from.acc, to.acc];
  const bal = (i: number, b: typeof from, w: "pre" | "post") => ({ accountIndex: i, mint: MINT, owner: b.owner, programId: T22, uiTokenAmount: { amount: String(b[w]) } });
  return {
    slot,
    blockTime: 1_700_000_000 + slot,
    transaction: { signatures: [`plain${slot}`.padEnd(20, "x")], message: { accountKeys: keys, header: { numRequiredSignatures: 1 }, instructions: [] } },
    meta: { err: null, innerInstructions: [], preTokenBalances: [bal(1, from, "pre"), bal(2, to, "pre")], postTokenBalances: [bal(1, from, "post"), bal(2, to, "post")] },
  } as unknown as ConfirmedTx;
}

async function runTicks(openAccounts: number, ticks: number, rpc = chain(openAccounts)) {
  const state = new Map<string, MintCrawlState>();
  const txCache = new Map<string, ConfirmedTx>();
  const perTick: { outcome: string; calls: number; unswept?: number }[] = [];
  let completed = 0;
  for (let t = 0; t < ticks; t++) {
    const before = rpc.calls;
    try {
      const r = await crawlMintHistory(rpc as unknown as MeteoraRpc, MINT, { state, txCache, maxRpcCalls: BUDGET });
      completed++;
      perTick.push({ outcome: "ok", calls: rpc.calls - before, unswept: r.unswept });
    } catch (e) {
      expect(e).toBeInstanceOf(CrawlBudgetExceeded);
      perTick.push({ outcome: "CrawlBudgetExceeded", calls: rpc.calls - before });
    }
  }
  const st = state.get(MINT)!;
  const open = [...st.accounts.values()].filter((a) => a.open).length;
  return { completed, perTick, open, cursors: st.cursors.size, state, txCache, rpc };
}

/** Ticks a fresh coin needs to crawl `n` never-seen accounts once (one call each, `budget` per tick). */
const catchUpTicks = (n: number) => Math.ceil((n + 50) / BUDGET);

// FIXED (audit S-1): only accounts with new activity are crawled every run; dormant open accounts are re-polled in
// rotation with the budget that is left, never past it. A coin with more open accounts than the budget completes
// a crawl every tick once its first crawl has caught up (progress is kept across ticks).
describe("S-1 fixed: crawl budget vs open token accounts", () => {
  it("control: 4,900 open accounts -> every tick completes under the 5,000 budget", async () => {
    const r = await runTicks(4_900, 3);
    expect(r.completed).toBe(3);
    expect(r.perTick.every((p) => p.calls <= BUDGET)).toBe(true);
  }, 120_000);

  for (const n of [5_200, 20_000]) {
    it(`${n.toLocaleString("en-US")} open accounts -> catches up, then EVERY tick completes within the budget and the sweep covers every account`, async () => {
      const t0 = Date.now();
      const warm = catchUpTicks(n);
      const r = await runTicks(n, warm + 12);
      expect(r.open).toBe(n);
      expect(r.cursors).toBe(n + 1); // every account crawled to the end once, plus the mint
      // the attack (S-1): never completing. Now: at most the catch-up ticks exceed, then every tick completes
      expect(r.perTick.slice(warm).every((p) => p.outcome === "ok")).toBe(true);
      expect(r.perTick.every((p) => p.calls <= BUDGET + 1)).toBe(true);
      // steady state: within budget with a reserve, and the rotation reaches every dormant account
      const steady = r.perTick.slice(warm);
      expect(steady.every((p) => p.calls <= BUDGET * 0.9)).toBe(true);
      // the rotation reaches every dormant account: one sweep cycle (budget/2 per tick) after catching up, every
      // open account has been re-polled since the catch-up ended (tick i = run i + 1)
      const st = r.state.get(MINT)!;
      expect(Math.ceil(n / (BUDGET / 2))).toBeLessThanOrEqual(12);
      expect([...st.accounts.keys()].filter((a) => (st.polled.get(a) ?? 0) <= warm)).toEqual([]);
      console.log(`[S-1 fixed ${n} open]`, JSON.stringify({ completed: r.completed, perTick: r.perTick.slice(0, warm + 3), ms: Date.now() - t0 }));
      expect(Date.now() - t0).toBeLessThan(60_000); // the O(n²) rescan is gone (was 8-10 s CPU per failing tick)
    }, 120_000);
  }

  it("a plain Transfer between two dormant accounts is seen within one sweep cycle; a dormant wallet that trades is crawled in full at once", async () => {
    const n = 12_000;
    const rpc = chain(n);
    const r = await runTicks(n, catchUpTicks(n) + 1, rpc);
    expect(r.perTick.at(-1)!.outcome).toBe("ok");
    const st = r.state.get(MINT)!;
    const who = (a: string) => st.accounts.get(a)!.owner!;
    const seen = (sig: string) => st.sigs.has(sig.padEnd(20, "x"));
    const tick = async () => {
      const res = await crawlMintHistory(rpc as unknown as MeteoraRpc, MINT, { state: r.state, txCache: r.txCache, maxRpcCalls: BUDGET });
      expect(res.rpcCalls).toBeLessThanOrEqual(BUDGET);
    };
    // (a) plain transfer Acc7 → Acc11007: both dormant; the tx lists neither the mint nor an active account
    rpc.add(plainTransferTx(900, { acc: "Acc7", owner: who("Acc7"), pre: 1n, post: 0n }, { acc: "Acc11007", owner: who("Acc11007"), pre: 1n, post: 2n }));
    let ticks = 0;
    while (!seen("plain900")) {
      ticks++;
      await tick();
      expect(ticks).toBeLessThanOrEqual(Math.ceil(n / (BUDGET / 2)) + 1);
    }
    // (b) Acc5 → Acc3 by plain transfer (silent), then Acc3 moves tokens in a tx that lists the mint (a trade /
    //     TransferChecked): that dirties Acc3, so the silent transfer is found in the SAME run, not by the sweep.
    rpc.add(plainTransferTx(950, { acc: "Acc5", owner: who("Acc5"), pre: 1n, post: 0n }, { acc: "Acc3", owner: who("Acc3"), pre: 1n, post: 2n }));
    const trade = plainTransferTx(951, { acc: "Acc3", owner: who("Acc3"), pre: 2n, post: 1n }, { acc: "Acc4", owner: who("Acc4"), pre: 1n, post: 2n });
    (trade.transaction.message as unknown as { accountKeys: string[] }).accountKeys.push(MINT);
    trade.transaction.signatures[0] = "trade951".padEnd(20, "x");
    rpc.add(trade);
    await tick();
    expect(seen("trade951")).toBe(true);
    expect(seen("plain950")).toBe(true);
    expect(st.dirty.size).toBe(0);
  }, 120_000);
});
