/**
 * Reorg safety. Ingestion runs at `confirmed` (≈ 400 ms behind the tip) for a live feed;
 * this job upgrades rows to `finalized` and rolls back any transaction that was confirmed
 * but is no longer known to the cluster (dropped fork), then rebuilds the affected mints
 * from events (replay.ts). Optimistic confirmation has never been rolled back on mainnet,
 * so the rollback path is a safety net, not a hot path.
 */
import type { Connection } from "@solana/web3.js";

import type { Params } from "@fumpad/sdk";

import type { Db } from "./db.js";
import type { Logger } from "./log.js";
import { replayMint } from "./replay.js";

export interface FinalizerOpts {
  /** Only check rows older than this (they need ~13 s to finalize). */
  minAgeSecs: number;
  /** A row the cluster doesn't know after this long is treated as dropped. */
  dropAfterSecs: number;
  batch: number;
}

export class Finalizer {
  stats = { finalized: 0, rolledBack: 0, lastRunAt: 0 };

  constructor(private conn: Connection, private db: Db, private params: () => Params, private log: Logger, private opts: FinalizerOpts = { minAgeSecs: 15, dropAfterSecs: 180, batch: 200 }) {}

  async runOnce(): Promise<{ finalized: number; rolledBack: number }> {
    const rows = await this.db.query<{ signature: string; age: number }>(
      `SELECT signature, EXTRACT(EPOCH FROM now() - processed_at)::int AS age FROM transactions
        WHERE commitment <> 'finalized' AND processed_at < now() - make_interval(secs => $1)
        ORDER BY slot LIMIT $2`,
      [this.opts.minAgeSecs, this.opts.batch],
    );
    if (!rows.rows.length) return { finalized: 0, rolledBack: 0 };
    const sigs = rows.rows.map((r) => r.signature);
    const st = (await this.conn.getSignatureStatuses(sigs, { searchTransactionHistory: true })).value;
    const fin: string[] = [];
    const dropped: string[] = [];
    rows.rows.forEach((r, i) => {
      const s = st[i];
      if (s?.confirmationStatus === "finalized" && !s.err) fin.push(r.signature);
      else if ((!s || s.err) && r.age > this.opts.dropAfterSecs) dropped.push(r.signature);
    });
    if (fin.length) await this.db.query("UPDATE transactions SET commitment = 'finalized' WHERE signature = ANY($1)", [fin]);
    if (dropped.length) await this.rollback(dropped);
    this.stats.finalized += fin.length;
    this.stats.rolledBack += dropped.length;
    this.stats.lastRunAt = Date.now();
    return { finalized: fin.length, rolledBack: dropped.length };
  }

  /** Delete transactions (cascades to events + event tables) and rebuild their mints. */
  async rollback(signatures: string[]): Promise<void> {
    const mints = await this.db.query<{ mint: string }>("SELECT DISTINCT mint FROM events WHERE signature = ANY($1) AND mint IS NOT NULL", [signatures]);
    const ext = await this.db.query<{ mint: string }>("SELECT DISTINCT mint FROM external_trades WHERE signature = ANY($1)", [signatures]);
    await this.db.query("DELETE FROM transactions WHERE signature = ANY($1)", [signatures]);
    const all = new Set([...mints.rows.map((r) => r.mint), ...ext.rows.map((r) => r.mint)]);
    for (const m of all) await replayMint(this.db, m, this.params());
    this.log.warn({ signatures, mints: [...all] }, "rolled back dropped transactions");
  }
}
