/**
 * Complete, finalized history of one mint from a keeper's OWN RPC (read-only).
 *
 * Completeness argument: every instruction that changes a token account's balance lists that token
 * account, so `getSignaturesForAddress(account)` over every token account of the mint covers every
 * balance change; every token account of the mint is created by an instruction that lists the mint
 * (InitializeAccount*, ATA create), so crawling the mint's signatures discovers every account. We crawl
 * the mint, collect its token accounts from token-balance metadata, crawl those, and repeat until no
 * new account appears. Pool vaults (owned by the DBC / DAMM v2 pool authorities) are not crawled: every
 * swap / migration / leftover instruction lists the mint itself.
 *
 * Bounded cost (audit S-1): only accounts with NEW activity are crawled every run (see `crawlMintHistory`);
 * the others are re-polled in rotation with the budget that is left, so a coin with tens of thousands of
 * open token accounts still completes a crawl every run.
 *
 * Ordering: tx index in block from `getBlock(transactionDetails: "signatures")`, only for slots that
 * hold ≥ 2 of the coin's txs. Everything is fetched at `finalized` and bounded by a snapshot slot.
 */
import { type ConfirmedTx, DBC_PROGRAM_ID, type MeteoraRpc, normalizeTx, parsePoolFacts, type SignatureInfo } from "@fumpad/meteora";

import { type HistoryTx, slotsNeedingIndex, VAULT_AUTHORITIES } from "./history.js";
import type { CoinFacts } from "./types.js";

export interface CrawlOptions {
  /** Ignore everything after this slot (snapshot). Default: the finalized slot at crawl start. */
  maxSlot?: number;
  /** Not crawled (protocol PDAs' token accounts). */
  protocolOwners?: ReadonlySet<string>;
  /** Shared caches (keep across runs for incremental crawling). Bound them (LruMap): evicted txs are re-fetched. */
  txCache?: Map<string, ConfirmedTx>;
  blockIndexCache?: Map<number, Map<string, number>>;
  /**
   * Per-mint incremental crawl state (cursors, known signatures, token accounts). Keep across runs; when
   * omitted it is attached to `txCache` (so callers that keep their txCache crawl incrementally too).
   */
  state?: Map<string, MintCrawlState>;
  /**
   * Extra addresses whose full finalized signature lists are part of the history, crawled EVERY run (e.g. the
   * fumpad Coin PDA — attest/claim/close/void txs reference it).
   */
  extraAddresses?: readonly string[];
  /**
   * Extra addresses crawled in the sweep rotation only (before dormant token accounts), e.g. attested ticket
   * PDAs: belt and braces for txs that list only the ticket (every ticket lifecycle instruction also lists the
   * Coin PDA, which is an `extraAddresses` entry).
   */
  sweepAddresses?: readonly string[];
  /** Owners whose dormant accounts are swept first (e.g. wallets holding live tickets: rebuys show up sooner). */
  priorityOwners?: ReadonlySet<string>;
  /**
   * Max RPC calls the sweep of dormant accounts may use per run (default: half of `maxRpcCalls`; all of them
   * when there is no budget). The sweep never pushes a run past `maxRpcCalls` minus a 10% reserve.
   */
  sweepRpcCalls?: number;
  /** Hard cap on fetched transactions (safety for huge coins). */
  maxTxs?: number;
  /**
   * Per-crawl RPC budget (V7-M6). When exceeded the crawl throws `CrawlBudgetExceeded`; everything
   * fetched so far is kept in `state` / `txCache`, so the next crawl continues where this one stopped.
   * Only REQUIRED work (new activity) can exceed it; the dormant-account sweep stops short of it.
   */
  maxRpcCalls?: number;
  onProgress?: (msg: string) => void;
}

/** Incremental crawl state of one mint (V7-M6, S-1). */
export interface MintCrawlState {
  /** Newest finalized signature already collected, per crawled address (getSignaturesForAddress `until`). */
  cursors: Map<string, string>;
  /** Every successful signature of the mint's history (≤ the last snapshot slot). */
  sigs: Map<string, SignatureInfo>;
  /** Token accounts of the mint → open (holds the mint after its latest tx) or closed, and the latest owner seen. */
  accounts: Map<string, { open: boolean; slot: number; owner?: string | null }>;
  /** Signatures whose tx has been scanned for token accounts. */
  scanned: Set<string>;
  /** Accounts that must be crawled before the next crawl completes (new activity seen; S-1). */
  dirty: Set<string>;
  /** Owner → its token accounts of the mint. */
  owners: Map<string, Set<string>>;
  /** Address → run number of its last completed poll (sweep rotation). */
  polled: Map<string, number>;
  /** Runs started on this mint. */
  run: number;
}

export class CrawlBudgetExceeded extends Error {
  constructor(readonly mint: string, readonly calls: number) {
    super(`crawl budget of ${calls} RPC calls exceeded for ${mint}; continuing next run`);
  }
}

export const newMintCrawlState = (): MintCrawlState => ({
  cursors: new Map(),
  sigs: new Map(),
  accounts: new Map(),
  scanned: new Set(),
  dirty: new Set(),
  owners: new Map(),
  polled: new Map(),
  run: 0,
});

const attachedState = new WeakMap<object, Map<string, MintCrawlState>>();

/** Sweep rotation: `sweepAddresses` and `priorityOwners`' accounts are re-polled as if last polled this many runs earlier. */
export const PRIORITY_LEAD_RUNS = 3;

export interface CrawlResult {
  history: HistoryTx[];
  maxSlot: number;
  accounts: string[];
  /** RPC calls this crawl made. */
  rpcCalls: number;
  /** Dormant open accounts this run did NOT re-poll (sweep rotation; 0 = every open account is current). */
  unswept: number;
}

export async function getBlockSignatures(rpc: MeteoraRpc, slot: number): Promise<string[]> {
  const b = await rpc.call<{ signatures: string[] } | null>("getBlock", [
    slot,
    { encoding: "json", transactionDetails: "signatures", rewards: false, maxSupportedTransactionVersion: 1, commitment: "finalized" },
  ]);
  if (!b) throw new Error(`getBlock ${slot}: no block`);
  return b.signatures;
}

/**
 * Crawl (or continue crawling) a mint's finalized history. Incremental (V7-M6) and bounded (audit S-1):
 *
 *  1. Required every run: the mint, `extraAddresses`, accounts never crawled to the end, and DIRTY accounts —
 *     every account that appears in a newly found tx, plus every open account of its owner. Each address is
 *     asked only for signatures newer than its cursor; the new txs dirty the accounts they touch,
 *     transitively, within the same run. So a wallet with any activity seen (a swap, a TransferChecked or ATA
 *     create — those list the mint — or a plain Transfer seen from either side) has ALL its token accounts
 *     crawled up to the snapshot before the history is returned: its sells and rebuys are derived from its
 *     complete history.
 *  2. Sweep: open accounts with no activity seen ("dormant") are re-polled in rotation — `sweepAddresses` and
 *     `priorityOwners`' accounts first, then least recently polled — with what is left of the budget, never
 *     past it. A plain `Transfer` between two dormant accounts (the only balance change that lists neither the
 *     mint nor an account with activity) is seen within one sweep cycle, and before either wallet can trade on
 *     the coin's pools (that dirties the wallet first).
 *
 * Without a budget the sweep covers every open account every run (the pre-S-1 behaviour). Token accounts that
 * were CLOSED at their latest tx are never swept: a closed account can only come back through an
 * (Initialize | ATA create) instruction, which lists the mint, so the mint's own crawl re-opens it.
 *
 * Cost: O(new txs + polled addresses) per run (the pre-S-1 code rescanned every account after every address).
 */
export async function crawlMintHistory(rpc: MeteoraRpc, mint: string, opts: CrawlOptions = {}): Promise<CrawlResult> {
  let calls = 0;
  const budget = opts.maxRpcCalls ?? Number.POSITIVE_INFINITY;
  const spend = () => {
    if (++calls > budget) throw new CrawlBudgetExceeded(mint, budget);
  };
  spend();
  const maxSlot = opts.maxSlot ?? (await rpc.getSlot("finalized"));
  const protocol = opts.protocolOwners ?? new Set<string>();
  const txs = opts.txCache ?? new Map<string, ConfirmedTx>();
  let states = opts.state;
  if (!states) {
    states = attachedState.get(txs) ?? new Map();
    attachedState.set(txs, states);
  }
  let st = states.get(mint);
  if (!st) {
    st = newMintCrawlState();
    states.set(mint, st);
  }
  const state = st;
  // states persisted by an older version of this module
  state.dirty ??= new Set();
  state.owners ??= new Map();
  state.polled ??= new Map();
  state.run = (state.run ?? 0) + 1;
  const run = state.run;

  const fetchTx = async (sig: string): Promise<ConfirmedTx> => {
    let tx = txs.get(sig);
    if (tx) return tx;
    if (opts.maxTxs && state.sigs.size > opts.maxTxs) throw new Error(`crawl: more than ${opts.maxTxs} txs for ${mint}`);
    spend();
    tx = (await rpc.getTransaction(sig, "finalized")) ?? undefined;
    if (!tx) throw new Error(`getTransaction ${sig}: not found at finalized`);
    txs.set(sig, tx);
    return tx;
  };

  /** New signatures of `address` since its cursor (≤ maxSlot); advances the cursor only when complete. */
  const newSignatures = async (address: string): Promise<SignatureInfo[]> => {
    const until = state.cursors.get(address) || undefined;
    const out: SignatureInfo[] = [];
    let before: string | undefined;
    for (;;) {
      spend();
      const page = await rpc.getSignaturesForAddress(address, { before, until, limit: 1000, commitment: "finalized" });
      for (const s of page) if (s.slot <= maxSlot) out.push(s);
      if (page.length < 1000) break;
      before = page[page.length - 1].signature;
    }
    return out; // newest first
  };

  /**
   * Scan new txs (slot order) for token accounts of the mint, whether each is open after its latest tx and
   * its owner. Returns every account of the mint the txs touch.
   */
  const scan = (sigs: string[]): Set<string> => {
    const touched = new Set<string>();
    const list = sigs.filter((s) => !state.scanned.has(s)).map((s) => txs.get(s)!).sort((a, b) => a.slot - b.slot);
    for (const tx of list) {
      state.scanned.add(tx.transaction.signatures[0]);
      const keys = normalizeTx(tx).accountKeys;
      const post = new Set<string>();
      const seen = new Map<string, string | null>(); // account → owner (post wins)
      for (const [which, bals] of [["pre", tx.meta?.preTokenBalances ?? []], ["post", tx.meta?.postTokenBalances ?? []]] as const) {
        for (const b of bals) {
          if (b.mint !== mint) continue;
          if (b.owner && (VAULT_AUTHORITIES.has(b.owner) || protocol.has(b.owner))) continue;
          const acc = keys[b.accountIndex];
          seen.set(acc, b.owner ?? seen.get(acc) ?? null);
          if (which === "post") post.add(acc);
        }
      }
      for (const [acc, owner] of seen) {
        touched.add(acc);
        const prev = state.accounts.get(acc);
        // latest tx wins; within one slot (order unknown here) "open" wins, so we never skip a live account
        if (!prev || tx.slot > prev.slot) state.accounts.set(acc, { open: post.has(acc), slot: tx.slot, owner: owner ?? prev?.owner ?? null });
        else if (tx.slot === prev.slot && post.has(acc)) prev.open = true;
        if (owner) {
          const s = state.owners.get(owner) ?? new Set<string>();
          s.add(acc);
          state.owners.set(owner, s);
        }
      }
    }
    return touched;
  };

  const queue: string[] = [];
  let head = 0;
  const queued = new Set<string>();
  const crawled = new Set<string>();
  const enqueue = (a: string) => {
    if (queued.has(a) || crawled.has(a)) return;
    queued.add(a);
    queue.push(a);
  };
  /** New activity on `acc`: it and every open account of its owner must be crawled before this run completes. */
  const markDirty = (acc: string) => {
    const a = state.accounts.get(acc);
    const group = a?.owner ? state.owners.get(a.owner) ?? new Set([acc]) : new Set([acc]);
    for (const x of group) {
      if (crawled.has(x)) continue;
      if (x !== acc && !state.accounts.get(x)?.open) continue;
      state.dirty.add(x);
      enqueue(x);
    }
  };

  const crawlAddress = async (addr: string): Promise<void> => {
    crawled.add(addr);
    const fresh = await newSignatures(addr);
    const ok = fresh.filter((s) => s.err === null || s.err === undefined);
    for (const s of ok) await fetchTx(s.signature);
    for (const s of ok) state.sigs.set(s.signature, s);
    // newest ≤ maxSlot, all fetched ("" = crawled, nothing yet: the next run asks from the start again)
    state.cursors.set(addr, fresh.length ? fresh[0].signature : state.cursors.get(addr) ?? "");
    state.dirty.delete(addr);
    state.polled.set(addr, run);
    for (const acc of scan(ok.map((s) => s.signature))) markDirty(acc);
  };
  const drain = async () => {
    while (head < queue.length) {
      const addr = queue[head++];
      if (crawled.has(addr)) continue;
      await crawlAddress(addr);
      opts.onProgress?.(`crawled ${crawled.size}/${crawled.size + queue.length - head} addresses, ${state.sigs.size} txs`);
    }
  };

  // 1. Required: the mint, the extra addresses, never-crawled accounts (first, so a run cut short by the budget
  //    still makes progress), then accounts left dirty by an earlier run.
  enqueue(mint);
  for (const a of opts.extraAddresses ?? []) enqueue(a);
  for (const acc of state.accounts.keys()) if (!state.cursors.has(acc)) enqueue(acc);
  for (const acc of state.dirty) enqueue(acc);
  await drain();

  // 2. Sweep dormant open accounts (rotation), within the budget.
  const limited = Number.isFinite(budget);
  const reserve = limited ? Math.max(2, Math.ceil(budget / 10)) : 0;
  const sweepCap = opts.sweepRpcCalls ?? (limited ? Math.floor(budget / 2) : Number.POSITIVE_INFINITY);
  const sweepStart = calls;
  const prio = opts.priorityOwners ?? new Set<string>();
  const sweepExtra = (opts.sweepAddresses ?? []).filter((a) => !crawled.has(a));
  // Rotation by last poll; priority entries count as polled PRIORITY_LEAD_RUNS runs earlier (swept more often,
  // never starving the rest).
  const dormant: { a: string; p: number; key: number }[] = [];
  for (const a of sweepExtra) dormant.push({ a, p: 0, key: (state.polled.get(a) ?? 0) - PRIORITY_LEAD_RUNS });
  for (const [acc, x] of state.accounts) {
    if (!x.open || crawled.has(acc)) continue;
    const p = x.owner && prio.has(x.owner) ? 1 : 2;
    dormant.push({ a: acc, p, key: (state.polled.get(acc) ?? 0) - (p < 2 ? PRIORITY_LEAD_RUNS : 0) });
  }
  dormant.sort((x, y) => x.key - y.key || x.p - y.p || (x.a < y.a ? -1 : x.a > y.a ? 1 : 0));
  let unswept = 0;
  for (let i = 0; i < dormant.length; i++) {
    const { a } = dormant[i];
    if (crawled.has(a)) continue;
    if (calls - sweepStart >= sweepCap || calls + reserve >= budget) {
      for (let j = i; j < dormant.length; j++) if (!crawled.has(dormant[j].a)) unswept++;
      break;
    }
    enqueue(a);
    await drain(); // new activity found by the sweep is required work (it dirties accounts)
  }

  const list: ConfirmedTx[] = [];
  for (const [sig, s] of state.sigs) if (s.slot <= maxSlot) list.push(await fetchTx(sig));
  const index = opts.blockIndexCache ?? new Map<number, Map<string, number>>();
  const bySlot = new Map<number, string[]>();
  for (const tx of list) {
    const l = bySlot.get(tx.slot);
    if (l) l.push(tx.transaction.signatures[0]);
    else bySlot.set(tx.slot, [tx.transaction.signatures[0]]);
  }
  for (const slot of slotsNeedingIndex(list)) {
    const need = bySlot.get(slot)!;
    const have = index.get(slot);
    if (have && need.every((s) => have.has(s))) continue;
    spend();
    const all = await getBlockSignatures(rpc, slot);
    // keep only this coin's txs of the slot (a block holds thousands of signatures)
    const m = new Map<string, number>(have ?? []);
    const wanted = new Set(need);
    all.forEach((s, i) => wanted.has(s) && m.set(s, i));
    index.set(slot, m);
  }
  const history: HistoryTx[] = list.map((tx) => {
    const m = index.get(tx.slot);
    const i = bySlot.get(tx.slot)!.length > 1 ? m?.get(tx.transaction.signatures[0]) : -1;
    if (i === undefined) throw new Error(`tx ${tx.transaction.signatures[0]} missing from block ${tx.slot}`);
    return { tx, txIndex: i };
  });
  history.sort((a, b) => a.tx.slot - b.tx.slot || a.txIndex - b.txIndex);
  return { history, maxSlot, accounts: [...state.accounts.keys()].sort(), rpcCalls: calls, unswept };
}


/** DBC PoolConfig.sqrt_start_price: u128 LE at data offset 392 (incl. the 8-byte discriminator; DBC 0.2.1 layout, size 1048). */
export const DBC_CONFIG_SQRT_START_PRICE_OFFSET = 392;
export const DBC_CONFIG_SIZE = 1048;

export function readU128LE(b: Uint8Array, off: number): bigint {
  let v = 0n;
  for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i]);
  return v;
}

export function decodeConfigSqrtStartPrice(data: Uint8Array): bigint {
  if (data.length < DBC_CONFIG_SIZE) throw new Error(`DBC config is ${data.length} bytes`);
  return readU128LE(data, DBC_CONFIG_SQRT_START_PRICE_OFFSET);
}

export const b64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * Coin facts from chain data: the pool-creation tx (DBC EvtInitializePool for the mint, found among the
 * mint's oldest signatures) + the config's sqrt_start_price. `history` = the crawled history.
 */
export async function deriveCoinFacts(rpc: MeteoraRpc, mint: string, history: readonly HistoryTx[]): Promise<CoinFacts> {
  for (const { tx } of history) {
    if (tx.meta?.err) continue;
    const f = parsePoolFacts(tx);
    const p = f.dbcPools.find((x) => x.baseMint === mint);
    if (!p) continue;
    const acc = await rpc.call<{ value: { data: [string, string]; owner: string } | null }>("getAccountInfo", [p.config, { encoding: "base64", commitment: "finalized" }]);
    if (!acc.value || acc.value.owner !== DBC_PROGRAM_ID) throw new Error(`config ${p.config} not found / not DBC-owned`);
    const migration = history.map((h) => parsePoolFacts(h.tx).migrations.find((m) => m.dbcPool === p.pool)).find(Boolean);
    return {
      mint,
      creator: p.creator,
      dbcPool: p.pool,
      config: p.config,
      startSqrtPrice: decodeConfigSqrtStartPrice(b64(acc.value.data[0])),
      launchBlockTime: tx.blockTime ?? 0,
      launchSlot: tx.slot,
      dammPool: migration?.dammPool ?? null,
    };
  }
  throw new Error(`no DBC pool creation for ${mint} in its history`);
}
