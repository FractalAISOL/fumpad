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
  /** Shared caches (keep across runs for incremental crawling). */
  txCache?: Map<string, ConfirmedTx>;
  blockIndexCache?: Map<number, Map<string, number>>;
  /** Hard cap on fetched transactions (safety for huge coins). */
  maxTxs?: number;
  onProgress?: (msg: string) => void;
}

export interface CrawlResult {
  history: HistoryTx[];
  maxSlot: number;
  accounts: string[];
}

async function allSignatures(rpc: MeteoraRpc, address: string, maxSlot: number): Promise<SignatureInfo[]> {
  const out: SignatureInfo[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await rpc.getSignaturesForAddress(address, { before, limit: 1000, commitment: "finalized" });
    for (const s of page) if (s.slot <= maxSlot) out.push(s);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  return out;
}

export async function getBlockSignatures(rpc: MeteoraRpc, slot: number): Promise<string[]> {
  const b = await rpc.call<{ signatures: string[] } | null>("getBlock", [
    slot,
    { encoding: "json", transactionDetails: "signatures", rewards: false, maxSupportedTransactionVersion: 1, commitment: "finalized" },
  ]);
  if (!b) throw new Error(`getBlock ${slot}: no block`);
  return b.signatures;
}

export async function crawlMintHistory(rpc: MeteoraRpc, mint: string, opts: CrawlOptions = {}): Promise<CrawlResult> {
  const maxSlot = opts.maxSlot ?? (await rpc.getSlot("finalized"));
  const protocol = opts.protocolOwners ?? new Set<string>();
  const txs = opts.txCache ?? new Map<string, ConfirmedTx>();
  const sigs = new Map<string, SignatureInfo>();
  const crawled = new Set<string>();
  const queue = [mint];
  const accounts = new Set<string>();
  const scanned = new Set<string>();
  while (queue.length) {
    const addr = queue.shift()!;
    if (crawled.has(addr)) continue;
    crawled.add(addr);
    for (const s of await allSignatures(rpc, addr, maxSlot)) if (s.err === null || s.err === undefined) sigs.set(s.signature, s);
    for (const [sig] of sigs) {
      if (txs.has(sig)) continue;
      if (opts.maxTxs && txs.size >= opts.maxTxs) throw new Error(`crawl: more than ${opts.maxTxs} txs for ${mint}`);
      const tx = await rpc.getTransaction(sig, "finalized");
      if (!tx) throw new Error(`getTransaction ${sig}: not found at finalized`);
      txs.set(sig, tx);
    }
    for (const [sig] of sigs) {
      if (scanned.has(sig)) continue;
      scanned.add(sig);
      const tx = txs.get(sig)!;
      const keys = normalizeTx(tx).accountKeys;
      for (const b of [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])]) {
        if (b.mint !== mint) continue;
        if (b.owner && (VAULT_AUTHORITIES.has(b.owner) || protocol.has(b.owner))) continue;
        const acc = keys[b.accountIndex];
        if (!accounts.has(acc)) {
          accounts.add(acc);
          queue.push(acc);
        }
      }
    }
    opts.onProgress?.(`crawled ${crawled.size}/${crawled.size + queue.length} addresses, ${sigs.size} txs`);
  }
  const list = [...sigs.keys()].map((s) => txs.get(s)!).filter((t) => !t.meta?.err);
  const index = opts.blockIndexCache ?? new Map<number, Map<string, number>>();
  for (const slot of slotsNeedingIndex(list)) {
    if (!index.has(slot)) {
      const m = new Map<string, number>();
      (await getBlockSignatures(rpc, slot)).forEach((s, i) => m.set(s, i));
      index.set(slot, m);
    }
  }
  const history: HistoryTx[] = list.map((tx) => {
    const m = index.get(tx.slot);
    const i = m ? m.get(tx.transaction.signatures[0]) : -1;
    if (i === undefined) throw new Error(`tx ${tx.transaction.signatures[0]} missing from block ${tx.slot}`);
    return { tx, txIndex: i };
  });
  history.sort((a, b) => a.tx.slot - b.tx.slot || a.txIndex - b.txIndex);
  return { history, maxSlot, accounts: [...accounts].sort() };
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
