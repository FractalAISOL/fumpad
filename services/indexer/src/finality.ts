/**
 * Reorg safety. Ingestion runs at `confirmed` (≈ 400 ms behind the tip) for a live feed;
 * this job upgrades rows to `finalized` and rolls back any transaction that was confirmed
 * but is no longer known to the cluster (dropped fork), then rebuilds the affected mints
 * from events (replay.ts). Optimistic confirmation has never been rolled back on mainnet,
 * so the rollback path is a safety net, not a hot path.
 */
import type { Connection } from "@solana/web3.js";

import type { Params } from "@fumpad/sdk/v06";

import type { Db } from "./db.js";
import type { Logger } from "./log.js";
import { replayMint } from "./replay.js";

export interface FinalizerOpts {
  /** Only check rows older than this (they need ~13 s to finalize). */
  minAgeSecs: number;
  /** A row the cluster doesn't know is only rolled back once it is at least this old… */
  dropAfterSecs: number;
  /** …AND after this many consecutive checks found it unknown (M-4), AND getTransaction agrees. */
  dropMisses: number;
  /** Rows per getSignatureStatuses call (≤ 256). */
  batch: number;
  /** Batches per run: keyset pagination past the first page, so a stuck page can't hide newer rows. */
  maxBatches: number;
}

export const DEFAULT_FINALIZER_OPTS: FinalizerOpts = { minAgeSecs: 15, dropAfterSecs: 180, dropMisses: 3, batch: 200, maxBatches: 10 };

export class Finalizer {
  stats = { finalized: 0, rolledBack: 0, lastRunAt: 0, pendingMisses: 0, savedByCrossCheck: 0 };
  private readonly opts: FinalizerOpts;
  /** signature → consecutive runs it was unknown to the cluster (reset when seen again). */
  private misses = new Map<string, number>();

  constructor(private conn: Connection, private db: Db, private params: () => Params, private log: Logger, opts: Partial<FinalizerOpts> = {}) {
    this.opts = { ...DEFAULT_FINALIZER_OPTS, ...opts };
  }

  async runOnce(): Promise<{ finalized: number; rolledBack: number }> {
    let finalized = 0;
    let rolledBack = 0;
    let after: { slot: string; signature: string } | null = null;
    const seen = new Set<string>();
    for (let b = 0; b < this.opts.maxBatches; b++) {
      const rows: { signature: string; slot: string; age: number }[] = (
        await this.db.query<{ signature: string; slot: string; age: number }>(
          `SELECT signature, slot, EXTRACT(EPOCH FROM now() - processed_at)::int AS age FROM transactions
            WHERE commitment <> 'finalized' AND processed_at < now() - make_interval(secs => $1)
              AND ($3::bigint IS NULL OR (slot, signature) > ($3::bigint, $4::text))
            ORDER BY slot, signature LIMIT $2`,
          [this.opts.minAgeSecs, this.opts.batch, after?.slot ?? null, after?.signature ?? null],
        )
      ).rows;
      if (!rows.length) break;
      const st = (await this.conn.getSignatureStatuses(rows.map((r) => r.signature), { searchTransactionHistory: true })).value;
      const fin: string[] = [];
      const candidates: string[] = [];
      rows.forEach((r, i) => {
        seen.add(r.signature);
        const s = st[i];
        if (s && !s.err) {
          this.misses.delete(r.signature);
          if (s.confirmationStatus === "finalized") fin.push(r.signature);
          return;
        }
        // Unknown (or now reported failed): count it; one null from one RPC node is not a fork.
        const n = (this.misses.get(r.signature) ?? 0) + 1;
        this.misses.set(r.signature, n);
        if (n >= this.opts.dropMisses && r.age > this.opts.dropAfterSecs) candidates.push(r.signature);
      });
      if (fin.length) await this.db.query("UPDATE transactions SET commitment = 'finalized' WHERE signature = ANY($1)", [fin]);
      const dropped: string[] = [];
      for (const sig of candidates) {
        // Cross-check with a different RPC method before deleting anything.
        const tx = await this.conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => undefined);
        if (tx === null) dropped.push(sig);
        else if (tx) {
          this.misses.delete(sig);
          this.stats.savedByCrossCheck++;
        }
        // undefined = RPC error: decide on a later run.
      }
      if (dropped.length) {
        await this.rollback(dropped);
        for (const s of dropped) this.misses.delete(s);
      }
      finalized += fin.length;
      rolledBack += dropped.length;
      if (rows.length < this.opts.batch) break;
      after = { slot: rows[rows.length - 1].slot, signature: rows[rows.length - 1].signature };
    }
    // Forget rows that are no longer pending (finalized/deleted elsewhere).
    if (this.misses.size > 50_000) for (const k of this.misses.keys()) if (!seen.has(k)) this.misses.delete(k);
    this.stats.finalized += finalized;
    this.stats.rolledBack += rolledBack;
    this.stats.pendingMisses = this.misses.size;
    this.stats.lastRunAt = Date.now();
    return { finalized, rolledBack };
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
