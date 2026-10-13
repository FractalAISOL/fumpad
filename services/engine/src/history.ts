/**
 * Raw finalized transactions of one coin → engine events (pure).
 *
 * Per successful tx:
 *  - swaps on the coin's DBC pool / graduated DAMM v2 pool from `parseMeteoraTrades` (base = the mint);
 *  - the DAMM v2 pool the DBC pool migrated into (`parsePoolFacts`, with its opening sqrt price);
 *  - transfers: per owner, net balance change of the mint (pre/postTokenBalances) minus what that
 *    owner's our-pool swaps explain. Pool vault owners (DBC / DAMM v2 pool authorities) and protocol
 *    owners are not wallets and produce no transfers. Third-party pools' trades therefore arrive as
 *    transfers (an acquisition there = a rebuy; a sale there never makes a ticket).
 *  - parser issues on our pools (fail closed: the engine marks the coin inconsistent from there on).
 */
import {
  DAMM_V2_POOL_AUTHORITY,
  DBC_POOL_AUTHORITY,
  type ConfirmedTx,
  normalizeTx,
  ownerDeltas,
  parseMeteoraTrades,
  parsePoolFacts,
} from "@fumpad/meteora";

import type { CoinFacts, EngineEvent, OrderKey } from "./types.js";
import { TRANSFER_IX_KEY } from "./types.js";

export interface HistoryTx {
  tx: ConfirmedTx;
  /** Index of the tx in its block; -1 if it is the only tx of the coin's history in its slot. */
  txIndex: number;
}

export interface HistoryOptions {
  /** Owners that are not wallets (reward pool PDA, buyback PDA, fee claimer, escrow authority, …). */
  protocolOwners?: ReadonlySet<string>;
  /** Owners whose outflow in a tx marks that tx's inflows as FUMPAD payouts (claims / escrow withdrawals). */
  payoutOwners?: ReadonlySet<string>;
  /** fumpad program id: swaps whose immediate CPI parent is it are `routed`. */
  routerProgramId?: string;
  /** Extra events from a tx (e.g. FUMPAD ticket lifecycle), given the tx's base order key. */
  extraEvents?: (tx: ConfirmedTx, base: { slot: number; txIndex: number; signature: string; blockTime: number }) => EngineEvent[];
}

export const VAULT_AUTHORITIES: ReadonlySet<string> = new Set([DBC_POOL_AUTHORITY, DAMM_V2_POOL_AUTHORITY]);

export function buildEvents(coin: CoinFacts, history: readonly HistoryTx[], opts: HistoryOptions = {}): EngineEvent[] {
  const protocol = opts.protocolOwners ?? new Set<string>();
  const payoutOwners = opts.payoutOwners ?? new Set<string>();
  const baseMints = new Set([coin.mint]);
  const out: EngineEvent[] = [];
  let dammPool = coin.dammPool ?? null;
  // Process in chain order so the DAMM pool is known before its first swap.
  const ordered = [...history].sort((a, b) => a.tx.slot - b.tx.slot || a.txIndex - b.txIndex);
  for (const { tx, txIndex } of ordered) {
    if (!tx.meta || tx.meta.err) continue; // failed txs change nothing
    const signature = tx.transaction.signatures[0];
    const blockTime = tx.blockTime ?? null;
    if (blockTime === null) throw new Error(`tx ${signature} has no blockTime`);
    const k = (phase: OrderKey["phase"], ixKey: number): OrderKey => ({ slot: tx.slot, txIndex, phase, ixKey });

    const facts = parsePoolFacts(tx);
    for (const m of facts.migrations) {
      if (m.dbcPool !== coin.dbcPool || m.baseMint !== coin.mint) continue;
      if (!dammPool) dammPool = m.dammPool;
      out.push({ kind: "pool_init", key: k(2, 0), signature, blockTime, pool: m.dammPool, sqrtPrice: m.sqrtPrice });
    }

    const ours = (pool: string | undefined | null) => !!pool && (pool === coin.dbcPool || pool === dammPool);
    const parsed = parseMeteoraTrades(tx, { baseMints });
    const attributed = new Map<string, bigint>();
    for (const t of parsed.trades) {
      if (!ours(t.pool) || t.baseMint !== coin.mint) continue;
      out.push({
        kind: "swap",
        key: k(2, t.ixKey),
        signature,
        blockTime,
        venue: t.venue,
        pool: t.pool,
        side: t.side,
        trader: t.trader,
        traderSource: t.traderSource,
        baseAmount: t.baseAmount,
        quoteGross: t.quoteGross,
        quoteMint: t.quoteMint,
        nextSqrtPrice: t.nextSqrtPrice,
        routed: !!opts.routerProgramId && t.outerPrograms[t.outerPrograms.length - 1] === opts.routerProgramId,
      });
      if (t.trader) attributed.set(t.trader, (attributed.get(t.trader) ?? 0n) + (t.side === "buy" ? t.baseAmount : -t.baseAmount));
    }
    const norm = normalizeTx(tx);
    const touchesOurs = norm.accountKeys.some((a) => ours(a));
    for (const is of parsed.issues) {
      if (ours(is.pool) || (!is.pool && touchesOurs)) out.push({ kind: "parse_issue", key: k(2, is.ixKey ?? 0), signature, blockTime, code: is.code, message: is.message });
    }

    const deltas = ownerDeltas(norm, coin.mint);
    const owners = new Set<string>([...deltas.keys(), ...attributed.keys()]);
    let payout = false;
    for (const o of payoutOwners) if ((deltas.get(o) ?? 0n) < 0n) payout = true;
    for (const owner of [...owners].sort()) {
      if (VAULT_AUTHORITIES.has(owner) || protocol.has(owner)) continue;
      const residual = (deltas.get(owner) ?? 0n) - (attributed.get(owner) ?? 0n);
      if (residual === 0n) continue;
      out.push({ kind: "transfer", key: k(residual < 0n ? 3 : 0, TRANSFER_IX_KEY), signature, blockTime, owner, delta: residual, payout: residual > 0n && payout });
    }
    if (opts.extraEvents) out.push(...opts.extraEvents(tx, { slot: tx.slot, txIndex, signature, blockTime }));
  }
  return out;
}

/**
 * Tx indices for ordering: only slots holding ≥ 2 of the coin's txs need the block's order. Returns
 * the set of slots to look up with getBlock.
 */
export function slotsNeedingIndex(txs: readonly { slot: number }[]): number[] {
  const n = new Map<number, number>();
  for (const t of txs) n.set(t.slot, (n.get(t.slot) ?? 0) + 1);
  return [...n].filter(([, c]) => c > 1).map(([s]) => s).sort((a, b) => a - b);
}
