// V7-M6: the crawl is incremental (cursors), skips closed token accounts, re-opens them when the mint
// shows them again, respects an RPC budget (resuming next run) and keeps byte-identical histories.
import { describe, expect, it } from "vitest";

import type { ConfirmedTx, MeteoraRpc, SignatureInfo } from "@fumpad/meteora";

import { CrawlBudgetExceeded, crawlMintHistory, LruMap, type MintCrawlState } from "../src/index.js";

const MINT = "Mint111111111111111111111111111111111111111";
const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
let n = 0;
const sig = () => `sig${++n}`.padEnd(20, "x");

/** Minimal tx: keys = signer + token accounts (+ the mint when `listsMint`), token balances per account. */
function tx(slot: number, bals: { acc: string; owner: string; pre: bigint | null; post: bigint | null }[], listsMint = false): ConfirmedTx {
  const keys = ["Signer", ...bals.map((b) => b.acc), ...(listsMint ? [MINT] : [])];
  const tb = (w: "pre" | "post") =>
    bals.flatMap((b, i) => (b[w] === null ? [] : [{ accountIndex: i + 1, mint: MINT, owner: b.owner, programId: T22, uiTokenAmount: { amount: String(b[w]) } }]));
  return {
    slot,
    blockTime: 1_700_000_000 + slot,
    transaction: { signatures: [sig()], message: { accountKeys: keys, header: { numRequiredSignatures: 1 }, instructions: [] } },
    meta: { err: null, innerInstructions: [], preTokenBalances: tb("pre"), postTokenBalances: tb("post") },
  } as unknown as ConfirmedTx;
}

class FakeRpc {
  txs: ConfirmedTx[] = [];
  sigCalls = new Map<string, number>();
  calls = 0;
  finalized = 1_000;
  async getSlot() {
    this.calls++;
    return this.finalized;
  }
  async getSignaturesForAddress(addr: string, o: { before?: string; until?: string; limit?: number }): Promise<SignatureInfo[]> {
    this.calls++;
    this.sigCalls.set(addr, (this.sigCalls.get(addr) ?? 0) + 1);
    const all = this.txs
      .filter((t) => t.slot <= this.finalized && (t.transaction.message as { accountKeys: string[] }).accountKeys.includes(addr))
      .sort((a, b) => b.slot - a.slot)
      .map((t) => ({ signature: t.transaction.signatures[0], slot: t.slot, err: null, blockTime: t.blockTime ?? null }));
    let i = o.before ? all.findIndex((s) => s.signature === o.before) + 1 : 0;
    const out: SignatureInfo[] = [];
    for (; i < all.length && out.length < (o.limit ?? 1000); i++) {
      if (all[i].signature === o.until) break;
      out.push(all[i] as SignatureInfo);
    }
    return out;
  }
  async getTransaction(s: string) {
    this.calls++;
    return this.txs.find((t) => t.transaction.signatures[0] === s) ?? null;
  }
  async call(method: string, params: unknown[]) {
    this.calls++;
    if (method !== "getBlock") throw new Error(method);
    return { signatures: this.txs.filter((t) => t.slot === params[0]).map((t) => t.transaction.signatures[0]) };
  }
}
const asRpc = (r: FakeRpc) => r as unknown as MeteoraRpc;
const sigsOf = (h: { tx: ConfirmedTx }[]) => h.map((x) => x.tx.transaction.signatures[0]);

describe("incremental mint crawl (V7-M6)", () => {
  it("a closed dust account is crawled once, then never again; open accounts cost one cursor call", async () => {
    const rpc = new FakeRpc();
    rpc.txs.push(tx(10, [{ acc: "Holder", owner: "W", pre: null, post: 1_000n }], true));
    // spray: 50 fresh accounts get 1 unit each (created → lists the mint), then all closed
    const dust = Array.from({ length: 50 }, (_, i) => `Dust${i}`);
    rpc.txs.push(tx(20, dust.map((acc) => ({ acc, owner: "Evil", pre: null, post: 1n })), true));
    rpc.txs.push(tx(21, dust.map((acc) => ({ acc, owner: "Evil", pre: 1n, post: null }))));
    const caches = { txCache: new Map<string, ConfirmedTx>(), blockIndexCache: new Map() };
    const first = await crawlMintHistory(asRpc(rpc), MINT, caches);
    expect(first.history).toHaveLength(3);
    rpc.sigCalls.clear();
    const before = rpc.calls;
    const second = await crawlMintHistory(asRpc(rpc), MINT, caches); // next tick, nothing new on chain
    expect(sigsOf(second.history)).toEqual(sigsOf(first.history));
    expect([...rpc.sigCalls.keys()].sort()).toEqual(["Holder", MINT].sort()); // no dust account asked again
    expect(rpc.calls - before).toBe(3); // getSlot + 2 cursor calls
  });

  it("new activity is picked up through the cursors; a re-created (re-opened) account is crawled again", async () => {
    const rpc = new FakeRpc();
    rpc.txs.push(tx(10, [{ acc: "Ata", owner: "W", pre: null, post: 5n }], true));
    rpc.txs.push(tx(11, [{ acc: "Ata", owner: "W", pre: 5n, post: null }])); // closed
    const st = new Map<string, MintCrawlState>();
    await crawlMintHistory(asRpc(rpc), MINT, { state: st });
    expect(st.get(MINT)!.accounts.get("Ata")!.open).toBe(false);
    rpc.finalized = 2_000;
    rpc.txs.push(tx(1_500, [{ acc: "Ata", owner: "W", pre: null, post: 7n }], true)); // ATA re-created (lists the mint)
    rpc.txs.push(tx(1_600, [{ acc: "Ata", owner: "W", pre: 7n, post: 3n }, { acc: "Other", owner: "V", pre: 0n, post: 4n }])); // plain Transfer
    const h = await crawlMintHistory(asRpc(rpc), MINT, { state: st });
    expect(h.history.map((x) => x.tx.slot)).toEqual([10, 11, 1_500, 1_600]);
  });

  it("an RPC budget stops the crawl; the next run resumes and ends with the same history as one full crawl", async () => {
    const mk = () => {
      n = 0;
      const rpc = new FakeRpc();
      for (let i = 0; i < 60; i++) rpc.txs.push(tx(10 + i, [{ acc: `A${i}`, owner: `W${i}`, pre: null, post: 1n }], true));
      return rpc;
    };
    const full = await crawlMintHistory(asRpc(mk()), MINT, {});
    const rpc = mk();
    const st = new Map<string, MintCrawlState>();
    const txCache = new Map<string, ConfirmedTx>();
    let runs = 0;
    let res;
    for (;;) {
      runs++;
      try {
        res = await crawlMintHistory(asRpc(rpc), MINT, { state: st, txCache, maxRpcCalls: 70 });
        break;
      } catch (e) {
        expect(e).toBeInstanceOf(CrawlBudgetExceeded);
      }
      expect(runs).toBeLessThan(20);
    }
    expect(runs).toBeGreaterThan(1);
    expect(sigsOf(res.history)).toEqual(sigsOf(full.history));
  });

  it("snapshot bound: signatures above maxSlot are left for the next run (cursor stays below them)", async () => {
    const rpc = new FakeRpc();
    rpc.txs.push(tx(10, [{ acc: "H", owner: "W", pre: null, post: 1n }], true));
    rpc.txs.push(tx(900, [{ acc: "H", owner: "W", pre: 1n, post: 2n }]));
    const st = new Map<string, MintCrawlState>();
    expect((await crawlMintHistory(asRpc(rpc), MINT, { state: st, maxSlot: 500 })).history).toHaveLength(1);
    expect((await crawlMintHistory(asRpc(rpc), MINT, { state: st, maxSlot: 1_000 })).history).toHaveLength(2);
  });

  it("block indices: only this coin's signatures are cached per slot", async () => {
    const rpc = new FakeRpc();
    const a = tx(10, [{ acc: "H", owner: "W", pre: null, post: 1n }], true);
    const b = tx(10, [{ acc: "H", owner: "W", pre: 1n, post: 2n }]);
    const noise = tx(10, []);
    rpc.txs.push(noise, a, b);
    const blockIndexCache = new Map<number, Map<string, number>>();
    const h = await crawlMintHistory(asRpc(rpc), MINT, { blockIndexCache });
    expect(h.history.map((x) => x.txIndex)).toEqual([1, 2]);
    expect([...blockIndexCache.get(10)!.keys()].sort()).toEqual(sigsOf(h.history).sort());
  });
});

describe("LruMap", () => {
  it("evicts the least recently used entry", () => {
    const m = new LruMap<string, number>(2);
    m.set("a", 1).set("b", 2);
    m.get("a");
    m.set("c", 3);
    expect([...m.keys()]).toEqual(["a", "c"]);
  });
});
