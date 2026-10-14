// PYTH_SOURCE=onchain (src/pyth-onchain.ts):
//  - golden: a recorded 20-minute MAINNET slice (engine/scripts/record-pyth-onchain.ts, read-only): the
//    signature lists of the SOL/USD push account + the push-oracle program and the candidate txs. Replays
//    must equal what two independent providers (Helius mainnet, public api.mainnet-beta) answered live,
//    whatever the page size / query order / cache state; the last write equals the account's data; every
//    write equals the Hermes update with the same publish_time (recorded with the API key).
//  - synthetic edge cases: equal publish_time, no write in the window (outage), stale, landing grace, ties,
//    forged no-op pushes / failed txs / foreign accounts or feeds, not-yet-final windows, bounded memory.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import bs58 from "bs58";
import { describe, expect, it } from "vitest";

import type { ConfirmedTx, SignatureInfo } from "@fumpad/meteora";

import {
  decodeOnchainWrites,
  OnchainPythSource,
  type OnchainRpc,
  POST_UPDATE_DISCRIMINATOR,
  PriceNotReady,
  PYTH_PUSH_ORACLE_PROGRAM_ID,
  PYTH_RECEIVER_PROGRAM,
  PYTH_SOL_USD_FEED_ID,
  PYTH_SOL_USD_PUSH_ACCOUNT,
  type PythPrice,
  selectOnchainWrite,
  SOLANA_MAINNET_GENESIS_HASH,
  validateAt,
} from "../src/index.js";

type Sig = Pick<SignatureInfo, "signature" | "slot" | "err" | "blockTime">;

/** Serves recorded/synthetic finalized data with real paging semantics (newest first, `before`, `limit`). */
class FakeRpc implements OnchainRpc {
  calls: Record<string, number> = {};
  constructor(
    private readonly lists: Record<string, Sig[]>,
    private readonly txs: Record<string, ConfirmedTx>,
    public head: { slot: number; blockTime: number },
    private readonly genesis = SOLANA_MAINNET_GENESIS_HASH,
  ) {
    for (const k of Object.keys(lists)) lists[k] = [...lists[k]].sort((a, b) => b.slot - a.slot); // stable: keeps in-slot order
  }
  private count(m: string) {
    this.calls[m] = (this.calls[m] ?? 0) + 1;
  }
  get total() {
    return Object.values(this.calls).reduce((a, b) => a + b, 0);
  }
  async call<T>(method: string, params: unknown[]): Promise<T> {
    this.count(method);
    if (method === "getGenesisHash") return this.genesis as T;
    if (method === "getBlockTime") {
      if (params[0] !== this.head.slot) throw new Error("fake: block time only for the head");
      return this.head.blockTime as T;
    }
    throw new Error(`fake: ${method}`);
  }
  async getSignaturesForAddress(address: string, o: { before?: string; limit?: number }): Promise<SignatureInfo[]> {
    this.count("getSignaturesForAddress");
    const l = (this.lists[address] ?? []).filter((s) => s.slot <= this.head.slot);
    let i = 0;
    if (o.before) {
      i = l.findIndex((s) => s.signature === o.before) + 1;
      if (i === 0) return [];
    }
    return l.slice(i, i + (o.limit ?? 1_000)).map((s) => ({ ...s, confirmationStatus: "finalized" }));
  }
  async getTransaction(sig: string): Promise<ConfirmedTx | null> {
    this.count("getTransaction");
    const t = this.txs[sig];
    return t && t.slot <= this.head.slot ? structuredClone(t) : null;
  }
  async getSlot(): Promise<number> {
    this.count("getSlot");
    return this.head.slot;
  }
}

const ser = (x: PythPrice | null) => (x ? { price: x.price.toString(), conf: x.conf.toString(), expo: x.expo, publishTime: x.publishTime } : null);

// ---------------------------------------------------------------- golden (recorded mainnet)

interface Golden {
  head: { slot: number; blockTime: number };
  lists: { account: Sig[]; program: Sig[] };
  txs: Record<string, ConfirmedTx>;
  accountState: { slot: number; owner: string; data: string };
  maxDeltaSecs: number;
  samples: { t: number; a: ReturnType<typeof ser>; b: ReturnType<typeof ser>; windowA: string[]; windowB: string[] }[];
  hermes: { publishTime: number; anyEqual: boolean | null; selectedEqual: boolean | null }[];
}
const G: Golden = JSON.parse(gunzipSync(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/pyth-onchain.mainnet.json.gz"))).toString());
const goldenRpc = () => new FakeRpc({ [PYTH_SOL_USD_PUSH_ACCOUNT]: G.lists.account, [PYTH_PUSH_ORACLE_PROGRAM_ID]: G.lists.program }, G.txs, G.head);
const allWrites = () => Object.values(G.txs).flatMap((t) => decodeOnchainWrites(t)).sort((a, b) => a.slot - b.slot);

describe("pyth onchain — golden mainnet slice", () => {
  it("the recording is non-trivial and both live providers agreed on every sample", () => {
    expect(G.samples.length).toBeGreaterThan(50);
    expect(allWrites().length).toBeGreaterThan(15);
    for (const s of G.samples) {
      expect(s.b).toEqual(s.a);
      expect(s.windowB).toEqual(s.windowA);
    }
  });

  it("block time never decreases with the slot in the recorded listings (the index's coverage relies on it)", () => {
    for (const l of [G.lists.account, G.lists.program]) {
      const bySlot = [...l].sort((x, y) => x.slot - y.slot);
      for (let i = 1; i < bySlot.length; i++) expect(bySlot[i].blockTime as number).toBeGreaterThanOrEqual(bySlot[i - 1].blockTime as number);
    }
  });

  it("replays equal the live answers for any page size and query order (fresh and warm caches)", async () => {
    for (const pageLimit of [1_000, 50, 7]) {
      for (const order of ["asc", "desc", "shuffled"] as const) {
        const ts = G.samples.map((s) => s.t);
        if (order === "desc") ts.reverse();
        if (order === "shuffled") ts.sort((x, y) => ((x * 2_654_435_761) % 97) - ((y * 2_654_435_761) % 97) || x - y);
        const src = new OnchainPythSource(goldenRpc(), { pageLimit, chunkSecs: 300 });
        for (const t of ts) {
          const s = G.samples.find((x) => x.t === t)!;
          expect(ser(await src.priceAt(t, G.maxDeltaSecs)), `t=${t} page=${pageLimit} ${order}`).toEqual(s.a);
          expect((await src.writesFor(t, G.maxDeltaSecs)).map((w) => w.signature).sort()).toEqual(s.windowA);
        }
      }
    }
  });

  it("decodes exactly the account's writes: strictly increasing publish_time, last one = the account data", () => {
    const w = allWrites();
    for (let i = 1; i < w.length; i++) expect(w[i].publishTime).toBeGreaterThan(w[i - 1].publishTime);
    for (const x of w) {
      expect(x.expo).toBe(-8);
      expect(x.publishTime - x.blockTime).toBeLessThanOrEqual(2); // Pyth → Solana landing lag (seconds)
      expect(x.blockTime - x.publishTime).toBeLessThanOrEqual(30); // within the grace (one 14 s lag in this slice)
    }
    // PriceUpdateV2: disc 8, write_authority 32, verification level (1 = Full), PriceFeedMessage (LE), posted_slot
    expect(G.accountState.owner).toBe(PYTH_RECEIVER_PROGRAM);
    const d = Uint8Array.from(Buffer.from(G.accountState.data, "base64"));
    expect(d[40]).toBe(1);
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const m = 41;
    const state = { price: v.getBigInt64(m + 32, true), conf: v.getBigUint64(m + 40, true), expo: v.getInt32(m + 48, true), publishTime: Number(v.getBigInt64(m + 52, true)) };
    expect(Buffer.from(d.subarray(m, m + 32)).toString("hex")).toBe(PYTH_SOL_USD_FEED_ID);
    const last = w.filter((x) => x.slot <= G.accountState.slot).at(-1)!;
    expect({ price: last.price, conf: last.conf, expo: last.expo, publishTime: last.publishTime }).toEqual(state);
  });

  it("candidates (account ∩ push program, successful) are all writers; readers and failed txs never fetched", async () => {
    const rpc = goldenRpc();
    const src = new OnchainPythSource(rpc);
    for (const s of G.samples) await src.priceAt(s.t, G.maxDeltaSecs);
    for (const t of Object.values(G.txs)) expect(decodeOnchainWrites(t).length).toBe(1);
    expect(rpc.calls.getTransaction).toBeLessThanOrEqual(Object.keys(G.txs).length);
    expect(G.lists.account.length).toBeGreaterThan(50 * Object.keys(G.txs).length); // ≥50 readers per write
    const before = rpc.total;
    for (const s of G.samples) await src.priceAt(s.t, G.maxDeltaSecs);
    expect(rpc.total).toBe(before); // warm: no RPC at all
  });

  it("every on-chain write equals the Hermes update with the same publish_time (recorded)", () => {
    expect(G.hermes.length).toBe(allWrites().length);
    for (const h of G.hermes) {
      expect(h.anyEqual, `publish_time ${h.publishTime}`).toBe(true);
      expect(h.selectedEqual).toBe(true);
    }
  });
});

// ---------------------------------------------------------------- synthetic

const PAYER = "4p16wya1Vw2u9w22oah4yXQgySb6eWKRRLMsEXCreish";
const VAA = "7MSgBHqVTjUTdJrRQPZaxeVRhDggGGhGtkj9Qk1Ay8AJ";
const CONFIG = "DaWUKXCyXsnzcvLUyeJRWou8KTn7XtadgTsdhJ6RHS7b";
const TREASURY = "8hQfT7SVhkCrzUSgBq6u2wYEt1sH3xmofZ5ss3YaydZW";
const SYS = "11111111111111111111111111111111";
const OTHER = "5CKzb9j4ChgLUt8Gfm5CNGLN6khXKiqMbnGAW4cgXgxK";
const READER_PROG = "proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u";

function postUpdateData(o: { pt: number; price: bigint; conf?: bigint; expo?: number; feed?: string; type?: number }): Uint8Array {
  const msg = new Uint8Array(85);
  const v = new DataView(msg.buffer);
  msg[0] = o.type ?? 0;
  msg.set(Buffer.from(o.feed ?? PYTH_SOL_USD_FEED_ID, "hex"), 1);
  v.setBigInt64(33, o.price, false);
  v.setBigUint64(41, o.conf ?? 1_000n, false);
  v.setInt32(49, o.expo ?? -8, false);
  v.setBigInt64(53, BigInt(o.pt), false);
  v.setBigInt64(61, BigInt(o.pt - 1), false);
  const out = new Uint8Array(8 + 4 + 85 + 4 + 20 + 1);
  out.set(POST_UPDATE_DISCRIMINATOR, 0);
  new DataView(out.buffer).setUint32(8, 85, true);
  out.set(msg, 12);
  new DataView(out.buffer).setUint32(97, 1, true);
  return out;
}

interface W {
  sig: string;
  slot: number;
  bt: number;
  pt: number;
  price?: bigint;
  conf?: bigint;
  feed?: string;
  failed?: boolean;
  /** push-oracle no-op: no receiver CPI (stale push; nothing verified) */
  noop?: boolean;
  /** receiver writes another account / with another authority */
  target?: string;
  authority?: string;
}

function writeTx(w: W): ConfirmedTx {
  const keys = [PAYER, PYTH_SOL_USD_PUSH_ACCOUNT, OTHER, VAA, TREASURY, PYTH_PUSH_ORACLE_PROGRAM_ID, CONFIG, PYTH_RECEIVER_PROGRAM, SYS];
  const k = (a: string) => keys.indexOf(a);
  const data = postUpdateData({ pt: w.pt, price: w.price ?? 150_00000000n, conf: w.conf, feed: w.feed });
  const target = w.target ?? PYTH_SOL_USD_PUSH_ACCOUNT;
  const inner = { programIdIndex: k(PYTH_RECEIVER_PROGRAM), accounts: [k(PAYER), k(VAA), k(CONFIG), k(TREASURY), k(target), k(SYS), k(w.authority ?? target)], data: bs58.encode(data), stackHeight: 2 };
  return {
    slot: w.slot,
    blockTime: w.bt,
    version: 0,
    transaction: {
      signatures: [w.sig],
      message: {
        header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 4 },
        accountKeys: keys,
        instructions: [{ programIdIndex: k(PYTH_PUSH_ORACLE_PROGRAM_ID), accounts: [k(PAYER), k(PYTH_RECEIVER_PROGRAM), k(VAA), k(CONFIG), k(TREASURY), k(target), k(SYS)], data: bs58.encode(Uint8Array.from([0x1c, 0x09, 0x5d, 0x96, 0x56, 0x99, 0xbc, 0x73, ...data.subarray(8)])), stackHeight: null }],
      },
    },
    meta: { err: w.failed ? { InstructionError: [0, { Custom: 1 }] } : null, fee: 5000, innerInstructions: w.noop ? [] : [{ index: 0, instructions: [inner] }], loadedAddresses: { writable: [], readonly: [] }, preBalances: [], postBalances: [] },
  };
}

function readerTx(sig: string, slot: number, bt: number): ConfirmedTx {
  return {
    slot,
    blockTime: bt,
    version: 0,
    transaction: { signatures: [sig], message: { header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 2 }, accountKeys: [PAYER, PYTH_SOL_USD_PUSH_ACCOUNT, READER_PROG], instructions: [{ programIdIndex: 2, accounts: [0, 1], data: "1" }] } },
    meta: { err: null, fee: 5000, innerInstructions: [], loadedAddresses: { writable: [], readonly: [] }, preBalances: [], postBalances: [] },
  };
}

const T0 = 1_800_000_000;
/** slot ≈ 2.5 per second */
const slotAt = (t: number) => Math.floor((t - T0) * 2.5) + 1_000;

/** A synthetic chain: writes + one reader per second (never fetched), head far ahead. */
function chain(writes: W[], o: { headTime?: number; readers?: boolean; genesis?: string } = {}) {
  const lists: Record<string, Sig[]> = { [PYTH_SOL_USD_PUSH_ACCOUNT]: [], [PYTH_PUSH_ORACLE_PROGRAM_ID]: [] };
  const txs: Record<string, ConfirmedTx> = {};
  for (const w of writes) {
    txs[w.sig] = writeTx(w);
    const s: Sig = { signature: w.sig, slot: w.slot, blockTime: w.bt, err: w.failed ? { InstructionError: [0, { Custom: 1 }] } : null };
    lists[PYTH_SOL_USD_PUSH_ACCOUNT].push(s);
    lists[PYTH_PUSH_ORACLE_PROGRAM_ID].push(s);
  }
  if (o.readers !== false)
    for (let t = T0 - 400; t <= T0 + 400; t++) {
      const sig = `reader${t}`;
      txs[sig] = readerTx(sig, slotAt(t) + 1, t);
      lists[PYTH_SOL_USD_PUSH_ACCOUNT].push({ signature: sig, slot: slotAt(t) + 1, blockTime: t, err: null });
    }
  const headTime = o.headTime ?? T0 + 1_000;
  return new FakeRpc(lists, txs, { slot: slotAt(headTime) + 2, blockTime: headTime }, o.genesis);
}

const w = (sig: string, bt: number, pt: number, extra: Partial<W> = {}): W => ({ sig, slot: slotAt(bt), bt, pt, ...extra });
const usd = (n: number) => BigInt(Math.round(n * 1e8));
const at = async (rpc: FakeRpc, t: number, delta = 60, opts = {}) => new OnchainPythSource(rpc, opts).priceAt(t, delta);

describe("pyth onchain — selection edge cases", () => {
  it("publish_time exactly equal to the block time is taken (≤); one second later is not", async () => {
    const rpc = chain([w("a", T0 - 50, T0 - 50, { price: usd(140) }), w("b", T0, T0, { price: usd(150) }), w("c", T0 + 1, T0 + 1, { price: usd(160) })]);
    expect((await at(rpc, T0))?.price).toBe(usd(150));
    expect((await at(rpc, T0 - 1))?.price).toBe(usd(140));
    expect((await at(rpc, T0 + 1))?.price).toBe(usd(160));
  });

  it("no write in the window (outage gap) → null; a write exactly max-age old still counts, one second more doesn't", async () => {
    const rpc = chain([w("old", T0 - 200, T0 - 200), w("new", T0 + 100, T0 + 100)]);
    expect(await at(rpc, T0)).toBeNull();
    const r2 = chain([w("x", T0 - 60, T0 - 60, { price: usd(151) })]);
    expect((await at(r2, T0))?.publishTime).toBe(T0 - 60);
    expect(await at(r2, T0 + 1)).toBeNull(); // 61 s old: stale → no price (engine: "missing")
    expect(validateAt(await at(r2, T0), T0, 60).ok).toBe(true);
  });

  it("a price published before the trade but landing after it counts within the grace (30 s), not beyond", async () => {
    const base = [w("prev", T0 - 40, T0 - 40, { price: usd(100) })];
    expect((await at(chain([...base, w("late", T0 + 30, T0 - 1, { price: usd(200) })]), T0))?.price).toBe(usd(200));
    expect((await at(chain([...base, w("late", T0 + 31, T0 - 1, { price: usd(200) })]), T0))?.price).toBe(usd(100));
  });

  it("ties on publish_time: lowest slot, then lowest price, conf, signature — whatever the listing order", async () => {
    const a = w("tieA", T0 - 10, T0 - 10, { price: usd(150), slot: slotAt(T0 - 10) + 1 });
    const b = w("tieB", T0 - 10, T0 - 10, { price: usd(149), slot: slotAt(T0 - 10) });
    const c = w("tieC", T0 - 10, T0 - 10, { price: usd(148), slot: slotAt(T0 - 10) + 1 });
    for (const order of [[a, b, c], [c, b, a], [b, a, c]]) expect((await at(chain(order), T0))?.price).toBe(usd(149));
    const ws = [a, c].map((x) => decodeOnchainWrites(writeTx(x))[0]);
    expect(selectOnchainWrite(ws, T0, T0 - 100, T0 + 15)?.price).toBe(usd(148));
    expect(selectOnchainWrite([...ws].reverse(), T0, T0 - 100, T0 + 15)?.price).toBe(usd(148));
  });

  it("ignores forged no-op pushes, failed txs, other accounts / authorities / feeds / message types", async () => {
    const good = w("good", T0 - 30, T0 - 30, { price: usd(150) });
    const bad: W[] = [
      w("noop", T0 - 5, T0 - 5, { price: usd(1), noop: true }), // the push oracle didn't verify it: never trusted
      w("failed", T0 - 4, T0 - 4, { price: usd(2), failed: true }),
      w("otheracct", T0 - 3, T0 - 3, { price: usd(3), target: OTHER }),
      w("otherauth", T0 - 2, T0 - 2, { price: usd(4), authority: OTHER }),
      w("otherfeed", T0 - 1, T0 - 1, { price: usd(5), feed: "c2289a6a43d2ce91c6f55caec370f4acc38a2ed477f58813334c6d03749ff2a4" }),
    ];
    const rpc = chain([good, ...bad]);
    expect((await at(rpc, T0))?.price).toBe(usd(150));
    for (const b of bad) expect(decodeOnchainWrites(writeTx(b))).toEqual([]);
    expect(rpc.calls.getTransaction).toBe(5); // the failed one is filtered from the signature listing
  });

  it("a window that isn't final + indexed yet throws PriceNotReady (never 'no price'), then answers", async () => {
    const rpc = chain([w("x", T0 - 5, T0 - 5)], { headTime: T0 + 45 });
    let now = 0;
    const src = new OnchainPythSource(rpc, { nowMs: () => now });
    await expect(src.priceAt(T0, 60)).rejects.toBeInstanceOf(PriceNotReady); // needs head ≥ T0 + 30 + 20 + 1
    rpc.head = { slot: slotAt(T0 + 51) + 2, blockTime: T0 + 51 };
    await expect(src.priceAt(T0, 60)).rejects.toBeInstanceOf(PriceNotReady); // head cached (15 s)
    now += 15_000;
    expect((await src.priceAt(T0, 60))?.publishTime).toBe(T0 - 5);
  });

  it("the covered range grows upward with the head without re-reading old history", async () => {
    const ws = [0, 50, 100, 150, 200, 250].map((d) => w(`u${d}`, T0 + d, T0 + d, { price: usd(100 + d) }));
    const rpc = chain(ws, { headTime: T0 + 115 });
    let now = 0;
    const src = new OnchainPythSource(rpc, { nowMs: () => now });
    expect((await src.priceAt(T0 + 60, 60))?.price).toBe(usd(150));
    for (const [h, t, p] of [[T0 + 215, T0 + 160, 250], [T0 + 315, T0 + 260, 350]]) {
      rpc.head = { slot: slotAt(h) + 2, blockTime: h };
      now += 15_000;
      expect((await src.priceAt(t, 60))?.price).toBe(usd(p));
    }
    expect(rpc.calls.getTransaction).toBe(6);
    expect(src.stats.resets).toBe(1);
  });

  it("a finalized tx the RPC can't return is an error (retry), not a missing price", async () => {
    const rpc = chain([w("x", T0 - 5, T0 - 5)]);
    (rpc as unknown as { txs: Record<string, ConfirmedTx> }).txs.x = undefined as unknown as ConfirmedTx;
    await expect(at(rpc, T0)).rejects.toThrow(/not available/);
  });

  it("refuses a non-mainnet RPC unless disabled", async () => {
    const rpc = chain([w("x", T0 - 5, T0 - 5)], { genesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" });
    await expect(at(rpc, T0)).rejects.toThrow(/not Solana mainnet/);
    expect((await at(rpc, T0, 60, { expectGenesisHash: null }))?.publishTime).toBe(T0 - 5);
  });

  it("bounded memory: a small candidate cap answers exactly like an unbounded index", async () => {
    const ws = Array.from({ length: 40 }, (_, i) => w(`m${i}`, T0 - 390 + i * 20, T0 - 390 + i * 20, { price: usd(100 + i) }));
    const ts = [T0 + 300, T0 - 380, T0, T0 - 200, T0 + 395, T0 - 100, T0 + 50];
    const big = new OnchainPythSource(chain(ws));
    const small = new OnchainPythSource(chain(ws), { maxCandidates: 4, chunkSecs: 60 });
    for (const t of ts) {
      expect(ser(await small.priceAt(t, 60))).toEqual(ser(await big.priceAt(t, 60)));
      expect(small.stats.candidates).toBeLessThanOrEqual(4 + 6); // cap + one window
    }
  });

  it("concurrent callers get the same answers as sequential ones", async () => {
    const ws = Array.from({ length: 30 }, (_, i) => w(`c${i}`, T0 - 300 + i * 25, T0 - 301 + i * 25, { price: usd(120 + i) }));
    const ts = Array.from({ length: 40 }, (_, i) => T0 - 250 + i * 13);
    const seq = new OnchainPythSource(chain(ws));
    const want: unknown[] = [];
    for (const t of ts) want.push(ser(await seq.priceAt(t, 60)));
    const par = new OnchainPythSource(chain(ws));
    expect((await Promise.all(ts.map((t) => par.priceAt(t, 60)))).map(ser)).toEqual(want);
  });
});
