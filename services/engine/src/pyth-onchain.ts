/**
 * PYTH_SOURCE=onchain — SOL/USD at a trade's block time from the on-chain write history of the Pyth
 * push-oracle (sponsored) SOL/USD account on Solana mainnet. Free: plain JSON-RPC reads, no Hermes key.
 *
 * What counts as a price (SPEC §5.4 "the Pyth SOL/USD update with the greatest publish_time ≤ block_time"):
 * the price messages actually WRITTEN to `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE`
 * (= PDA(push oracle, [shard 0u16 LE, SOL/USD feed id]); owner = Pyth Solana Receiver). A write is the
 * receiver's `post_update` instruction (discriminator sha256("global:post_update")[..8]) with that
 * account as `price_update_account` (#4) AND `write_authority` (#6), in a successful finalized tx:
 *  - only the push oracle can sign for its PDA, and it CPIs `post_update` only when the message is newer
 *    than the stored one (a stale push succeeds as a no-op WITHOUT verifying anything — which is why the
 *    push oracle's own instruction data is never trusted, only the receiver's write);
 *  - `post_update` verifies the merkle proof against a Wormhole-verified VAA (full verification), so the
 *    message is Pyth-signed, the same bytes Hermes serves for that publish_time.
 * Writes therefore have strictly increasing publish_time in landing order.
 *
 * Selection for a trade at block time T (deterministic, finalized data only):
 *   window  = writes whose landing block time ∈ [T − maxDelta − lookbackSlack, T + grace]
 *   pick    = the greatest publish_time ≤ T; ties (impossible on chain, defined anyway): lowest slot,
 *             then lowest price, lowest conf, lowest signature
 *   result  = null if none, or if T − publish_time > maxDelta (same contract as HermesPythSource)
 * The window is fixed by T alone, so every keeper (any RPC provider) evaluates the same set of finalized
 * transactions; it is answered only once T + grace is older than the RPC's finalized head by
 * `indexLagSecs` (else PriceNotReady: retry later, never "no price").
 *
 * Finding the writes cheaply: ~150k txs/day reference the price account (mostly protocols READING it) and
 * only ~1.7k write it. A write must list both the price account and the push oracle program, so the
 * candidates are getSignaturesForAddress(price account) ∩ getSignaturesForAddress(push oracle) (both
 * finalized, paged ≤1,000 per call) and only those (~2k/day) are fetched with getTransaction. The index is
 * a contiguous covered time range [lo, hi], grown upward from the finalized head and downward on demand,
 * bounded (`maxCandidates`), with decoded writes cached per signature.
 */
import { type ConfirmedTx, normalizeTx, type SignatureInfo } from "@fumpad/meteora";

import { PYTH_SOL_USD_FEED_ID, type PythSource } from "./pyth.js";
import type { PythPrice } from "./rules/usd.js";

export const PYTH_PUSH_ORACLE_PROGRAM_ID = "pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT";
export const PYTH_RECEIVER_PROGRAM = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
/** Sponsored SOL/USD PriceUpdateV2 account, shard 0 (same address on devnet, where it updates only every ~5 min). */
export const PYTH_SOL_USD_PUSH_ACCOUNT = "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE";
export const SOLANA_MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
/** sha256("global:post_update")[..8] (Anchor), verified against mainnet receiver CPIs. */
export const POST_UPDATE_DISCRIMINATOR = Uint8Array.from([0x85, 0x5f, 0xcf, 0xaf, 0x0b, 0x4f, 0x76, 0x2c]);
/** Pythnet PriceFeedMessage: u8 type (0) + feed id 32 + price i64 + conf u64 + expo i32 + publish_time i64 + prev i64 + ema i64 + ema conf u64 (big endian). */
const PRICE_FEED_MESSAGE_LEN = 85;

/** One price written to the account. */
export interface OnchainWrite extends PythPrice {
  signature: string;
  slot: number;
  /** Landing block time (unix seconds). */
  blockTime: number;
}

/** Thrown when the window a price needs isn't finalized/indexed yet: retry later (not "no price"). */
export class PriceNotReady extends Error {
  constructor(readonly blockTime: number, readonly needUntil: number, readonly finalUntil: number) {
    super(`pyth onchain: price for block time ${blockTime} needs finalized history until ${needUntil} (have ${finalUntil})`);
  }
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Parse the `post_update` instruction data's PriceFeedMessage, or null if it isn't one. */
export function parsePostUpdate(data: Uint8Array): (PythPrice & { feedId: string }) | null {
  if (data.length < 12) return null;
  for (let i = 0; i < 8; i++) if (data[i] !== POST_UPDATE_DISCRIMINATOR[i]) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const len = v.getUint32(8, true);
  if (len < PRICE_FEED_MESSAGE_LEN || 12 + len > data.length) return null;
  const m = 12;
  if (data[m] !== 0) return null; // not a PriceFeedMessage
  return {
    feedId: hex(data.subarray(m + 1, m + 33)),
    price: v.getBigInt64(m + 33, false),
    conf: v.getBigUint64(m + 41, false),
    expo: v.getInt32(m + 49, false),
    publishTime: Number(v.getBigInt64(m + 53, false)),
  };
}

/** Every price this (finalized) transaction wrote to `account` — [] for a failed tx or a reader. */
export function decodeOnchainWrites(tx: ConfirmedTx, account = PYTH_SOL_USD_PUSH_ACCOUNT, feedId = PYTH_SOL_USD_FEED_ID): OnchainWrite[] {
  if (!tx?.meta || (tx.meta.err !== null && tx.meta.err !== undefined)) return [];
  const n = normalizeTx(tx);
  if (n.blockTime === null) throw new Error(`pyth onchain: tx ${n.signature} has no block time`);
  const out: OnchainWrite[] = [];
  for (const ix of n.flat) {
    if (ix.programId !== PYTH_RECEIVER_PROGRAM || !ix.data) continue;
    if (ix.accounts[4] !== account || ix.accounts[6] !== account) continue;
    const p = parsePostUpdate(ix.data);
    if (!p || p.feedId !== feedId) continue;
    out.push({ price: p.price, conf: p.conf, expo: p.expo, publishTime: p.publishTime, signature: n.signature, slot: n.slot, blockTime: n.blockTime });
  }
  return out;
}

const better = (a: OnchainWrite, b: OnchainWrite) =>
  a.publishTime !== b.publishTime
    ? a.publishTime > b.publishTime
    : a.slot !== b.slot
      ? a.slot < b.slot
      : a.price !== b.price
        ? a.price < b.price
        : a.conf !== b.conf
          ? a.conf < b.conf
          : a.signature < b.signature;

/** Deterministic pick (order-independent): greatest publish_time ≤ blockTime among writes landing in [from, to]. */
export function selectOnchainWrite(writes: readonly OnchainWrite[], blockTime: number, from: number, to: number): OnchainWrite | null {
  let best: OnchainWrite | null = null;
  for (const w of writes) {
    if (w.blockTime < from || w.blockTime > to || w.publishTime > blockTime) continue;
    if (!best || better(w, best)) best = w;
  }
  return best;
}

/** The read-only RPC surface used (MeteoraRpc satisfies it). */
export interface OnchainRpc {
  call<T>(method: string, params: unknown[]): Promise<T>;
  getSignaturesForAddress(address: string, opts: { before?: string; limit?: number; commitment?: "confirmed" | "finalized" }): Promise<SignatureInfo[]>;
  getTransaction(signature: string, commitment?: "confirmed" | "finalized"): Promise<ConfirmedTx | null>;
  getSlot(commitment?: "confirmed" | "finalized"): Promise<number>;
}

export interface OnchainOptions {
  account?: string;
  feedId?: string;
  pushProgram?: string;
  /** Writes landing up to this long after the trade still count (landing lag: usually 0–1 s, 14 s seen). Default 30. */
  graceSecs?: number;
  /** Extra lookback below T − maxDelta (Solana vs Pythnet clock skew). Default 30. */
  lookbackSlackSecs?: number;
  /** Only history this much older than the finalized head is used (signature-index lag). Default 20. */
  indexLagSecs?: number;
  /** The finalized head is re-read at most this often. Default 15 s. */
  headTtlMs?: number;
  /** Candidate signatures kept (≈2k/day); oldest evicted. Default 100k. */
  maxCandidates?: number;
  /** getSignaturesForAddress page size. Default 1,000 (RPC max). */
  pageLimit?: number;
  /** Downward extension step (bounds transient memory). Default 1 h. */
  chunkSecs?: number;
  /** A gap above the covered range larger than this restarts the index from the head. Default 6 h. */
  maxUpGapSecs?: number;
  /** Refuse an RPC on another cluster (default: mainnet genesis); null disables (local tests). */
  expectGenesisHash?: string | null;
  nowMs?: () => number;
}

interface Cand {
  signature: string;
  slot: number;
  blockTime: number;
  writes?: OnchainWrite[];
}

interface Cursor {
  before?: string;
  carry: SignatureInfo[];
  done: boolean;
  lastTime: number;
}

const byTime = (x: Cand, y: Cand) => x.blockTime - y.blockTime || x.slot - y.slot || (x.signature < y.signature ? -1 : x.signature > y.signature ? 1 : 0);

const newCursor = (): Cursor => ({ carry: [], done: false, lastTime: Number.POSITIVE_INFINITY });

export interface OnchainStats {
  rpcCalls: number;
  sigPages: number;
  txFetched: number;
  headReads: number;
  resets: number;
  candidates: number;
  coveredFrom: number | null;
  coveredTo: number | null;
}

export class OnchainPythSource implements PythSource {
  private readonly account: string;
  private readonly feedId: string;
  private readonly program: string;
  private cands: Cand[] = []; // ascending (blockTime, slot, signature)
  private bySig = new Map<string, Cand>();
  /** Covered [lo, hi]: every candidate with lo ≤ blockTime ≤ hi is in `cands`. hi = null: not started. */
  private lo = 0;
  private hi: number | null = null;
  private down = { a: newCursor(), p: newCursor() };
  private head: { at: number; finalUntil: number } | null = null;
  private genesisOk = false;
  private lock: Promise<unknown> = Promise.resolve();
  readonly stats: OnchainStats = { rpcCalls: 0, sigPages: 0, txFetched: 0, headReads: 0, resets: 0, candidates: 0, coveredFrom: null, coveredTo: null };

  constructor(
    private readonly rpc: OnchainRpc,
    private readonly o: OnchainOptions = {},
  ) {
    this.account = o.account ?? PYTH_SOL_USD_PUSH_ACCOUNT;
    this.feedId = (o.feedId ?? PYTH_SOL_USD_FEED_ID).replace(/^0x/, "").toLowerCase();
    this.program = o.pushProgram ?? PYTH_PUSH_ORACLE_PROGRAM_ID;
  }

  private nowMs() {
    return this.o.nowMs ? this.o.nowMs() : Date.now();
  }

  /** The landing-time window a trade at `blockTime` reads. */
  window(blockTime: number, maxDeltaSecs: number): { from: number; to: number } {
    return { from: blockTime - maxDeltaSecs - (this.o.lookbackSlackSecs ?? 30), to: blockTime + (this.o.graceSecs ?? 30) };
  }

  async priceAt(blockTime: number, maxDeltaSecs: number): Promise<PythPrice | null> {
    const w = await this.writesFor(blockTime, maxDeltaSecs);
    const { from, to } = this.window(blockTime, maxDeltaSecs);
    const best = selectOnchainWrite(w, blockTime, from, to);
    if (!best || blockTime - best.publishTime > maxDeltaSecs) return null;
    return { price: best.price, conf: best.conf, expo: best.expo, publishTime: best.publishTime };
  }

  /** All writes landing in the trade's window (decoded, finalized). Serialized: safe under concurrent callers. */
  writesFor(blockTime: number, maxDeltaSecs: number): Promise<OnchainWrite[]> {
    const run = this.lock.then(async () => {
      const { from, to } = this.window(blockTime, maxDeltaSecs);
      await this.ensure(blockTime, from, to);
      const out: OnchainWrite[] = [];
      for (const c of this.range(from, to)) {
        if (!c.writes) c.writes = await this.decode(c);
        out.push(...c.writes);
      }
      return out;
    });
    this.lock = run.catch(() => undefined);
    return run;
  }

  private range(from: number, to: number): Cand[] {
    let i = 0;
    let j = this.cands.length;
    while (i < j) {
      const m = (i + j) >> 1;
      if (this.cands[m].blockTime < from) i = m + 1;
      else j = m;
    }
    const out: Cand[] = [];
    for (let k = i; k < this.cands.length && this.cands[k].blockTime <= to; k++) out.push(this.cands[k]);
    return out;
  }

  private async decode(c: Cand): Promise<OnchainWrite[]> {
    this.stats.rpcCalls++;
    this.stats.txFetched++;
    const tx = await this.rpc.getTransaction(c.signature, "finalized");
    if (!tx) throw new Error(`pyth onchain: finalized tx ${c.signature} not available from this RPC`);
    if (tx.slot !== c.slot || (tx.blockTime ?? null) !== c.blockTime) throw new Error(`pyth onchain: tx ${c.signature} slot/blockTime disagree with its signature listing`);
    return decodeOnchainWrites(tx, this.account, this.feedId);
  }

  /** Refuse an RPC on the wrong cluster (call at startup to fail fast; also done before the first read). */
  async verifyCluster(): Promise<void> {
    if (this.genesisOk) return;
    const want = this.o.expectGenesisHash === undefined ? SOLANA_MAINNET_GENESIS_HASH : this.o.expectGenesisHash;
    if (want !== null) {
      this.stats.rpcCalls++;
      const g = await this.rpc.call<string>("getGenesisHash", []);
      if (g !== want) throw new Error(`pyth onchain: PYTH_RPC_URL is not Solana mainnet (genesis ${g}); the price feed is read from mainnet on every cluster`);
    }
    this.genesisOk = true;
  }

  private async finalUntil(): Promise<number> {
    await this.verifyCluster();
    const now = this.nowMs();
    if (!this.head || now - this.head.at >= (this.o.headTtlMs ?? 15_000)) {
      this.stats.rpcCalls += 2;
      this.stats.headReads++;
      const slot = await this.rpc.getSlot("finalized");
      const t = await this.rpc.call<number | null>("getBlockTime", [slot]);
      if (typeof t !== "number") throw new Error(`pyth onchain: no block time for finalized slot ${slot}`);
      // every slot after `slot` has block time ≥ t (Solana clock is monotonic), so all txs with
      // block time < t are in slots ≤ `slot`; keep a margin for the signature index
      this.head = { at: now, finalUntil: t - 1 - (this.o.indexLagSecs ?? 20) };
    }
    return this.head.finalUntil;
  }

  private reset(top: number) {
    this.cands = [];
    this.bySig.clear();
    this.hi = top;
    this.lo = top + 1;
    this.down = { a: newCursor(), p: newCursor() };
    this.stats.resets++;
  }

  private async ensure(blockTime: number, from: number, to: number) {
    if (this.hi === null || to > this.hi) {
      const top = await this.finalUntil();
      if (top < to) throw new PriceNotReady(blockTime, to, top);
      if (this.hi === null || top - this.hi > (this.o.maxUpGapSecs ?? 6 * 3_600)) this.reset(top);
      else await this.extendUp(top);
    }
    while (from < this.lo) {
      const step = Math.max(from, this.lo - (this.o.chunkSecs ?? 3_600));
      const exhausted = await this.extendDown(step);
      if (exhausted) break;
    }
    this.evict(from, to);
    this.stats.candidates = this.cands.length;
    this.stats.coveredFrom = this.lo;
    this.stats.coveredTo = this.hi;
  }

  private async page(address: string, before: string | undefined): Promise<SignatureInfo[]> {
    this.stats.rpcCalls++;
    this.stats.sigPages++;
    const r = await this.rpc.getSignaturesForAddress(address, { limit: this.o.pageLimit ?? 1_000, commitment: "finalized", ...(before ? { before } : {}) });
    for (const s of r) if (typeof s.blockTime !== "number") throw new Error(`pyth onchain: signature ${s.signature} has no block time`);
    return r;
  }

  /**
   * Walk `address`'s signatures newest→oldest from `cur` and return those with block time in [lo, hi];
   * stops at the first one older than `lo` (kept in `cur.carry` for the next, lower range).
   */
  private async walk(address: string, cur: Cursor, lo: number, hi: number): Promise<SignatureInfo[]> {
    const out: SignatureInfo[] = [];
    for (;;) {
      while (cur.carry.length) {
        const s = cur.carry[0];
        const t = s.blockTime as number;
        if (t > cur.lastTime) throw new Error(`pyth onchain: ${address} signatures not in block-time order`);
        if (t < lo) return out;
        cur.lastTime = t;
        cur.carry.shift();
        if (t <= hi) out.push(s);
      }
      if (cur.done) return out;
      const pg = await this.page(address, cur.before);
      if (pg.length < (this.o.pageLimit ?? 1_000)) cur.done = true;
      if (pg.length) cur.before = pg[pg.length - 1].signature;
      cur.carry = pg;
    }
  }

  private intersect(a: SignatureInfo[], p: SignatureInfo[]): Cand[] {
    const ps = new Set(p.map((s) => s.signature));
    return a.filter((s) => ps.has(s.signature) && (s.err === null || s.err === undefined)).map((s) => ({ signature: s.signature, slot: s.slot, blockTime: s.blockTime as number }));
  }

  private insert(cs: Cand[]) {
    const fresh = cs.filter((c) => !this.bySig.has(c.signature)).sort(byTime);
    if (!fresh.length) return;
    for (const c of fresh) this.bySig.set(c.signature, c);
    const n = this.cands.length;
    if (!n || byTime(fresh[0], this.cands[n - 1]) > 0) this.cands.push(...fresh);
    else if (byTime(fresh[fresh.length - 1], this.cands[0]) < 0) this.cands = [...fresh, ...this.cands];
    else this.cands = [...this.cands, ...fresh].sort(byTime);
  }

  /**
   * Bound memory: drop whole seconds outside the window being answered — the oldest first (the covered
   * range then starts later), then the newest (it then ends earlier; the next upward extension re-walks it).
   */
  private evict(keepFrom: number, keepTo: number) {
    const max = this.o.maxCandidates ?? 100_000;
    if (this.cands.length > max) {
      const cut = Math.min(this.cands[this.cands.length - max].blockTime, keepFrom - 1);
      if (cut >= this.lo) {
        let k = 0;
        while (k < this.cands.length && this.cands[k].blockTime <= cut) this.bySig.delete(this.cands[k++].signature);
        this.cands = this.cands.slice(k);
        this.lo = cut + 1;
        this.down = { a: newCursor(), p: newCursor() }; // re-walk from the head next time (the covered part is skipped)
      }
    }
    if (this.cands.length > max && this.hi !== null) {
      const cut = Math.max(this.cands[max].blockTime, keepTo + 1);
      if (cut <= this.hi) {
        let k = this.cands.length;
        while (k > 0 && this.cands[k - 1].blockTime >= cut) this.bySig.delete(this.cands[--k].signature);
        this.cands = this.cands.slice(0, k);
        this.hi = cut - 1;
      }
    }
  }

  /** Cover (hi, top]: both lists from the head down to hi. */
  private async extendUp(top: number) {
    const hi = this.hi as number;
    const p = await this.walk(this.program, newCursor(), hi + 1, top);
    const a = await this.walk(this.account, newCursor(), hi + 1, top);
    this.insert(this.intersect(a, p));
    this.hi = top;
  }

  /** Cover [target, lo). Returns true when the history is exhausted (nothing older exists). */
  private async extendDown(target: number): Promise<boolean> {
    const p = await this.walk(this.program, this.down.p, target, this.lo - 1);
    const a = await this.walk(this.account, this.down.a, target, this.lo - 1);
    this.insert(this.intersect(a, p));
    const exhausted = this.down.a.done && !this.down.a.carry.length;
    this.lo = exhausted ? Number.NEGATIVE_INFINITY : Math.min(this.lo, target);
    return exhausted;
  }
}
