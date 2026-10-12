/**
 * Transaction ingestion: decode → one DB transaction per chain transaction.
 *
 * Idempotent by signature (`transactions` PK): a tx delivered by the webhook AND the
 * poller (or re-scanned by the reconciler) is applied once. A later delivery at a
 * stronger commitment only upgrades the row.
 */
import type { Connection } from "@solana/web3.js";

import {
  accountKeys,
  decodeTransactionEvents,
  FUMPAD_PROGRAM_ID,
  type FumpadEvent,
  type Params,
  tokenDeltas,
  txInvokes,
  type TxLike,
  WSOL_MINT,
} from "@fumpad/sdk";

import { type Db, NOTIFY_CHANNEL, withTx } from "./db.js";
import { applyEvents, eventMint, jsonify, type TxCtx } from "./handlers.js";
import type { Logger } from "./log.js";

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
  conn: Connection;
  log: Logger;
  params: () => Params;
  /** Called after commit with the mints whose state changed. */
  onTouched?: (mints: string[]) => void;
  /** Called after commit when a params event was applied. */
  onParamsChanged?: () => void;
}

export class Ingestor {
  /** pool address → mint, for recognising PumpSwap trades that bypass FUMPAD. */
  private pools = new Map<string, string>();
  private poolsLoadedAt = 0;
  stats = { applied: 0, duplicates: 0, external: 0, lastSlot: 0, lastAppliedAt: 0 };

  constructor(private d: IngestorDeps) {}

  async refreshPools(force = false) {
    if (!force && Date.now() - this.poolsLoadedAt < 10_000) return;
    const r = await this.d.db.query<{ amm_pool: string; mint: string }>("SELECT amm_pool, mint FROM coins WHERE amm_pool IS NOT NULL");
    this.pools = new Map(r.rows.map((x) => [x.amm_pool, x.mint]));
    this.poolsLoadedAt = Date.now();
  }
  watchedPools(): Map<string, string> {
    return this.pools;
  }

  async ingest(tx: TxLike, source: Source, commitment: Commit): Promise<IngestResult> {
    const signature = tx.transaction.signatures[0];
    const events: FumpadEvent[] = decodeTransactionEvents(tx);
    await this.refreshPools();
    // External PumpSwap trades on FUMPAD pools (no FUMPAD instruction in the tx).
    const external: { mint: string; wallet: string; base: bigint; quote: bigint }[] = [];
    if (!tx.meta?.err && !txInvokes(tx, FUMPAD_PROGRAM_ID)) {
      const keys = new Set(accountKeys(tx));
      for (const [pool, mint] of this.pools) {
        if (!keys.has(pool)) continue;
        const base = tokenDeltas(tx, mint);
        const quote = tokenDeltas(tx, WSOL_MINT.toBase58());
        for (const [wallet, delta] of base) {
          if (wallet === pool) continue;
          external.push({ mint, wallet, base: delta, quote: quote.get(wallet) ?? 0n });
        }
      }
    }
    const kind = events.length ? "fumpad" : external.length ? "external" : "none";
    const touched = new Set<string>();
    const wallets = new Set<string>();
    const params = this.d.params();
    let paramsChanged = false;

    const res = await withTx(this.d.db, async (c) => {
      const ins = await c.query(
        `INSERT INTO transactions (signature, slot, block_time, commitment, source, kind, event_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (signature) DO NOTHING RETURNING seq`,
        [signature, tx.slot, tx.blockTime ?? null, commitment, source, kind, events.length],
      );
      if (!ins.rowCount) {
        if (commitment === "finalized") {
          const up = await c.query("UPDATE transactions SET commitment = 'finalized' WHERE signature = $1 AND commitment <> 'finalized'", [signature]);
          if (up.rowCount) return "upgraded" as const;
        }
        return "duplicate" as const;
      }
      for (const e of events) {
        const mint = await eventMint(c, e);
        const ts = (e.data as { ts?: bigint }).ts;
        await c.query(
          "INSERT INTO events (signature, idx, program, name, mint, slot, ts, data, raw) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING",
          [signature, e.index, e.program, e.name, mint, tx.slot, ts !== undefined ? ts.toString() : tx.blockTime ?? null, JSON.stringify(jsonify(e.data)), e.raw],
        );
      }
      const ctx: TxCtx = { c, signature, slot: tx.slot, blockTime: tx.blockTime ?? null, params, touched, wallets };
      await applyEvents(ctx, events);
      if (ctx.paramsChanged) paramsChanged = true;
      for (const x of external) {
        await c.query(
          `INSERT INTO external_trades (signature, mint, wallet, base_delta, quote_delta, slot, ts) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
          [signature, x.mint, x.wallet, x.base.toString(), x.quote.toString(), tx.slot, tx.blockTime ?? null],
        );
        if (x.base > 0n) await flagRebuyElsewhere(c, x.wallet, x.mint, x.base, tx.blockTime ?? Math.floor(Date.now() / 1000), signature, params);
        touched.add(x.mint);
        wallets.add(x.wallet);
      }
      // `sig` lets the API attach this transaction's trades/samples to its live `coin` messages.
      if (touched.size)
        await c.query("SELECT pg_notify($1, $2)", [NOTIFY_CHANNEL, JSON.stringify({ type: "coins", mints: [...touched], wallets: [...wallets].slice(0, 50), sig: signature })]);
      return "applied" as const;
    });

    if (res === "applied") {
      this.stats.applied++;
      this.stats.external += external.length;
      this.stats.lastAppliedAt = Date.now();
      if (events.length) this.d.log.debug({ signature, slot: tx.slot, source, events: events.map((e) => e.name) }, "ingested");
      if (touched.size) this.d.onTouched?.([...touched]);
      if (paramsChanged) this.d.onParamsChanged?.();
    } else this.stats.duplicates++;
    this.stats.lastSlot = Math.max(this.stats.lastSlot, tx.slot);
    if (events.some((e) => e.name === "Graduated")) await this.refreshPools(true);
    return { signature, status: res, events: events.length, mints: [...touched] };
  }
}

/**
 * Off-chain flag (SPEC §7): a wallet that sold through FUMPAD (ticket) and rebought the
 * same coin directly on PumpSwap inside the rebuy window dodged the on-chain rebuy rule.
 * Shown publicly and excluded from leaderboards; claims are never blocked.
 */
async function flagRebuyElsewhere(
  c: import("pg").PoolClient,
  wallet: string,
  mint: string,
  tokens: bigint,
  ts: number,
  signature: string,
  p: Params,
) {
  const t = await c.query<{ ticket: string; sell_ts: string }>(
    "SELECT ticket, sell_ts FROM tickets WHERE owner = $1 AND mint = $2 AND sell_ts <= $3 AND sell_ts >= $4 ORDER BY sell_ts DESC LIMIT 1",
    [wallet, mint, ts, ts - Number(p.rebuyWindowSecs)],
  );
  if (!t.rows[0]) return;
  await c.query(
    `INSERT INTO wallet_flags (wallet, reason, mint, detail, ts) VALUES ($1, 'rebuy_elsewhere', $2, $3, $4)
     ON CONFLICT (wallet, reason, mint) DO UPDATE SET detail = EXCLUDED.detail, ts = EXCLUDED.ts`,
    [wallet, mint, JSON.stringify({ signature, tokens: tokens.toString(), ticket: t.rows[0].ticket }), ts],
  );
}
