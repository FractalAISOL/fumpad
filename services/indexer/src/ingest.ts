/**
 * Transaction ingestion (fumpad program transactions): decode → one DB transaction per chain transaction.
 * Trades of the coins' pools (any app) arrive through the Meteora pipeline (meteora/ingest.ts), which
 * writes into the same `transactions` / `events` tables and calls the same handlers.
 *
 * Idempotent by signature (`transactions` PK): a tx delivered by the webhook AND the poller (or re-scanned
 * by the reconciler) is applied once. A later delivery at a stronger commitment only upgrades the row.
 */
import { DBC_PROGRAM_ID, decodeFumpadEvents, topLevelInstructions, type TxLike } from "@fumpad/sdk";

import { type Db, NOTIFY_CHANNEL, withTx } from "./db.js";
import { applyEvents, eventMint, type IndexedEvent, jsonify, type TxCtx } from "./handlers.js";
import type { Logger } from "./log.js";
import type { Params } from "@fumpad/sdk";

export type Source = "rpc" | "webhook" | "backfill" | "reconcile";
export type Commit = "confirmed" | "finalized";

export interface IngestResult {
  signature: string;
  status: "applied" | "duplicate" | "upgraded";
  events: number;
  mints: string[];
}

export interface IngestorDeps {
  db: Db;
  log: Logger;
  params: () => Params;
  onTouched?: (mints: string[]) => void;
  onParamsChanged?: () => void;
}

const DBC_INIT_T22 = [169, 118, 51, 78, 145, 110, 220, 155];

/** name / symbol / uri of the DBC pool-init instruction for `mint` in this tx (the launch tx). */
export function launchMetadata(tx: TxLike, mint: string): { name: string; symbol: string; uri: string } | null {
  let ixs: ReturnType<typeof topLevelInstructions> = [];
  try {
    ixs = topLevelInstructions(tx);
  } catch {
    return null;
  }
  for (const ix of ixs) {
    if (ix.programId !== DBC_PROGRAM_ID.toBase58() || !DBC_INIT_T22.every((b, i) => ix.data[i] === b)) continue;
    const all = topLevelAccounts(tx, ix.accounts);
    if (all[3] !== mint) continue;
    const dv = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
    let o = 8;
    const str = () => {
      const n = dv.getUint32(o, true);
      const v = new TextDecoder().decode(ix.data.subarray(o + 4, o + 4 + n));
      o += 4 + n;
      return v;
    };
    try {
      return { name: str(), symbol: str(), uri: str() };
    } catch {
      return null;
    }
  }
  return null;
}

function topLevelAccounts(tx: TxLike, idx: number[]): string[] {
  const m = tx.transaction.message as Record<string, unknown>;
  const stat = ((m.staticAccountKeys ?? m.accountKeys) as unknown[]) ?? [];
  const toS = (k: unknown) => (typeof k === "string" ? k : k && typeof k === "object" && "pubkey" in k ? String((k as { pubkey: unknown }).pubkey) : String((k as { toBase58(): string }).toBase58()));
  const keys = stat.map(toS);
  const la = tx.meta?.loadedAddresses;
  if (la) keys.push(...la.writable.map(toS), ...la.readonly.map(toS));
  return idx.map((i) => keys[i]);
}

/** fumpad events of a tx as IndexedEvents (+ the launch metadata pseudo-event after CoinRegistered). */
export function indexedEvents(tx: TxLike): IndexedEvent[] {
  const out: IndexedEvent[] = [];
  for (const e of decodeFumpadEvents(tx)) {
    out.push({ name: e.name, program: "fumpad", index: e.index, data: e.data as Record<string, unknown>, raw: e.raw });
    if (e.name === "CoinRegistered") {
      const mint = String((e.data as { mint: { toBase58(): string } }).mint.toBase58());
      const meta = launchMetadata(tx, mint);
      if (meta) {
        const data = { mint, ...meta };
        out.push({ name: "CoinMetadata", program: "meta", index: 50_000 + e.index, data, raw: JSON.stringify(data) });
      }
    }
  }
  return out;
}

export class Ingestor {
  stats = { applied: 0, duplicates: 0, lastSlot: 0, lastAppliedAt: 0 };

  constructor(private d: IngestorDeps) {}

  async ingest(tx: TxLike, source: Source, commitment: Commit): Promise<IngestResult> {
    const signature = tx.transaction.signatures[0];
    const events = indexedEvents(tx);
    const touched = new Set<string>();
    const wallets = new Set<string>();
    const params = this.d.params();
    let paramsChanged = false;
    const res = await withTx(this.d.db, async (c) => {
      const ins = await c.query(
        `INSERT INTO transactions (signature, slot, block_time, commitment, source, kind, event_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (signature) DO NOTHING RETURNING seq`,
        [signature, tx.slot, tx.blockTime ?? null, commitment, source, events.length ? "fumpad" : "none", events.length],
      );
      if (!ins.rowCount) {
        // The Meteora pipeline may have created the row first (a routed trade): apply our events once.
        const have = await c.query<{ n: string }>("SELECT count(*) AS n FROM events WHERE signature = $1 AND program <> 'meteora'", [signature]);
        if (Number(have.rows[0].n) > 0 || !events.length) {
          if (commitment === "finalized") {
            const up = await c.query("UPDATE transactions SET commitment = 'finalized' WHERE signature = $1 AND commitment <> 'finalized'", [signature]);
            if (up.rowCount) return "upgraded" as const;
          }
          return "duplicate" as const;
        }
        await c.query("UPDATE transactions SET kind = 'fumpad', event_count = event_count + $2 WHERE signature = $1", [signature, events.length]);
      }
      await storeAndApply(c, { signature, slot: tx.slot, blockTime: tx.blockTime ?? null, params, touched, wallets }, events);
      return "applied" as const;
    });
    if (res === "applied") {
      this.stats.applied++;
      this.stats.lastAppliedAt = Date.now();
      if (events.length) this.d.log.debug({ signature, slot: tx.slot, source, events: events.map((e) => e.name) }, "ingested");
      if (touched.size) this.d.onTouched?.([...touched]);
      if (events.some((e) => e.program === "fumpad" && /^(Params|PauseSet|KeepersSet|OperatorsSet|Config|AdminAccepted|GlobalInitialized)/.test(e.name))) paramsChanged = true;
      if (paramsChanged) this.d.onParamsChanged?.();
    } else this.stats.duplicates++;
    this.stats.lastSlot = Math.max(this.stats.lastSlot, tx.slot);
    return { signature, status: res, events: events.length, mints: [...touched] };
  }
}

/** Store events (raw + decoded JSON) and apply them; notify the API of touched coins. */
export async function storeAndApply(
  c: import("pg").PoolClient,
  base: { signature: string; slot: number; blockTime: number | null; params: Params; touched: Set<string>; wallets: Set<string> },
  events: IndexedEvent[],
): Promise<TxCtx> {
  for (const e of events) {
    const mint = await eventMint(c, e);
    const ts = e.data.ts;
    await c.query("INSERT INTO events (signature, idx, program, name, mint, slot, ts, data, raw) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING", [
      base.signature,
      e.index,
      e.program,
      e.name,
      mint,
      base.slot,
      ts !== undefined && ts !== null ? String(ts) : (base.blockTime ?? null),
      JSON.stringify(jsonify(e.data)),
      e.raw,
    ]);
  }
  const ctx: TxCtx = { c, ...base };
  await applyEvents(ctx, events);
  if (base.touched.size)
    await c.query("SELECT pg_notify($1, $2)", [NOTIFY_CHANNEL, JSON.stringify({ type: "coins", mints: [...base.touched], wallets: [...base.wallets].slice(0, 50), sig: base.signature })]);
  return ctx;
}
