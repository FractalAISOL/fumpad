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
   * Extra addresses whose full finalized signature lists are part of the history (e.g. the fumpad Coin
   * PDA — attest/claim/close txs reference it — and attested ticket PDAs, for guardian voids).
   */
  extraAddresses?: readonly string[];
  /** Hard cap on fetched transactions (safety for huge coins). */
  maxTxs?: number;
  /**
   * Per-crawl RPC budget (V7-M6). When exceeded the crawl throws `CrawlBudgetExceeded`; everything
   * fetched so far is kept in `state` / `txCache`, so the next crawl continues where this one stopped.
   */
  maxRpcCalls?: number;
  onProgress?: (msg: string) => void;
}

/** Incremental crawl state of one mint (V7-M6). */
export interface MintCrawlState {
  /** Newest finalized signature already collected, per crawled address (getSignaturesForAddress `until`). */
  cursors: Map<string, string>;
  /** Every successful signature of the mint's history (≤ the last snapshot slot). */
  sigs: Map<string, SignatureInfo>;
  /** Token accounts of the mint → open (holds the mint after its latest tx) or closed. */
  accounts: Map<string, { open: boolean; slot: number }>;
  /** Signatures whose tx has been scanned for token accounts. */
  scanned: Set<string>;
}

export class CrawlBudgetExceeded extends Error {
  constructor(readonly mint: string, readonly calls: number) {
    super(`crawl budget of ${calls} RPC calls exceeded for ${mint}; continuing next run`);
  }
}

export const newMintCrawlState = (): MintCrawlState => ({ cursors: new Map(), sigs: new Map(), accounts: new Map(), scanned: new Set() });

const attachedState = new WeakMap<object, Map<string, MintCrawlState>>();

export interface CrawlResult {
  history: HistoryTx[];
  maxSlot: number;
  accounts: string[];
  /** RPC calls this crawl made. */
  rpcCalls: number;
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
 * Crawl (or continue crawling) a mint's finalized history. Incremental (V7-M6): each address is asked
 * only for signatures newer than its cursor, and token accounts that were CLOSED at their latest tx are
 * not asked at all — a closed account can only come back through an (Initialize | ATA create)
 * instruction, which lists the mint, so the mint's own crawl re-opens it.
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

  /** Scan new txs (slot order) for token accounts of the mint and whether each is open after its latest tx. */
  const scan = (sigs: string[]): void => {
    const list = sigs.filter((s) => !state.scanned.has(s)).map((s) => txs.get(s)!).sort((a, b) => a.slot - b.slot);
    for (const tx of list) {
      state.scanned.add(tx.transaction.signatures[0]);
      const keys = normalizeTx(tx).accountKeys;
      const post = new Set<string>();
      const seen = new Set<string>();
      for (const [which, bals] of [["pre", tx.meta?.preTokenBalances ?? []], ["post", tx.meta?.postTokenBalances ?? []]] as const) {
        for (const b of bals) {
          if (b.mint !== mint) continue;
          if (b.owner && (VAULT_AUTHORITIES.has(b.owner) || protocol.has(b.owner))) continue;
          const acc = keys[b.accountIndex];
          seen.add(acc);
          if (which === "post") post.add(acc);
        }
      }
      for (const acc of seen) {
        const prev = state.accounts.get(acc);
        // latest tx wins; within one slot (order unknown here) "open" wins, so we never skip a live account
        if (!prev || tx.slot > prev.slot) state.accounts.set(acc, { open: post.has(acc), slot: tx.slot });
        else if (tx.slot === prev.slot && post.has(acc)) prev.open = true;
      }
    }
  };

  // Every run: the mint, the extra addresses, open accounts and accounts never crawled to the end yet.
  const pending = (acc: string, a: { open: boolean }) => a.open || !state.cursors.has(acc);
  // Never-crawled accounts first, so a run cut short by the budget still makes progress.
  const known = [...state.accounts].filter(([acc, a]) => pending(acc, a)).map(([acc]) => acc);
  const queue = [mint, ...(opts.extraAddresses ?? []), ...known.filter((a) => !state.cursors.has(a)), ...known.filter((a) => state.cursors.has(a))];
  const queued = new Set(queue);
  const crawled = new Set<string>();
  while (queue.length) {
    const addr = queue.shift()!;
    if (crawled.has(addr)) continue;
    crawled.add(addr);
    const fresh = await newSignatures(addr);
    const ok = fresh.filter((s) => s.err === null || s.err === undefined);
    for (const s of ok) await fetchTx(s.signature);
    for (const s of ok) state.sigs.set(s.signature, s);
    // newest ≤ maxSlot, all fetched ("" = crawled, nothing yet: the next run asks from the start again)
    state.cursors.set(addr, fresh.length ? fresh[0].signature : state.cursors.get(addr) ?? "");
    scan(ok.map((s) => s.signature));
    // new accounts, and known ones re-opened by a tx found above (e.g. an ATA re-created): crawl them too
    for (const [acc, a] of state.accounts) {
      if (pending(acc, a) && !queued.has(acc)) {
        queued.add(acc);
        queue.push(acc);
      }
    }
    opts.onProgress?.(`crawled ${crawled.size}/${crawled.size + queue.length} addresses, ${state.sigs.size} txs`);
  }

  const list: ConfirmedTx[] = [];
  for (const [sig, s] of state.sigs) if (s.slot <= maxSlot) list.push(await fetchTx(sig));
  const index = opts.blockIndexCache ?? new Map<number, Map<string, number>>();
  const bySlot = new Map<number, string[]>();
  for (const tx of list) bySlot.set(tx.slot, [...(bySlot.get(tx.slot) ?? []), tx.transaction.signatures[0]]);
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
  return { history, maxSlot, accounts: [...state.accounts.keys()].sort(), rpcCalls: calls };
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
