/**
 * Reorg safety for `meteora_transactions`, same policy as finality.ts (M-4): rows ingested at
 * `confirmed` are upgraded to `finalized`; a row is rolled back only when the cluster didn't know it
 * on `dropMisses` consecutive status checks, it is older than `dropAfterSecs`, AND `getTransaction`
 * (v1-capable, through MeteoraRpc) also returns nothing. Rolling back deletes the transaction (trades
 * and issues cascade) and any pool/cursor it registered.
 */
import type { MeteoraRpc } from "@fumpad/meteora";

import type { Db } from "../db.js";
import { DEFAULT_FINALIZER_OPTS, type FinalizerOpts } from "../finality.js";
import type { Logger } from "../log.js";

export class MeteoraFinalizer {
  stats = { finalized: 0, rolledBack: 0, lastRunAt: 0, pendingMisses: 0, savedByCrossCheck: 0 };
  private readonly opts: FinalizerOpts;
  private misses = new Map<string, number>();

  constructor(private rpc: MeteoraRpc, private db: Db, private log: Logger, opts: Partial<FinalizerOpts> = {}, private onRolledBack?: () => void) {
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
          `SELECT signature, slot, EXTRACT(EPOCH FROM now() - processed_at)::int AS age FROM meteora_transactions
            WHERE commitment <> 'finalized' AND processed_at < now() - make_interval(secs => $1)
              AND ($3::bigint IS NULL OR (slot, signature) > ($3::bigint, $4::text))
            ORDER BY slot, signature LIMIT $2`,
          [this.opts.minAgeSecs, this.opts.batch, after?.slot ?? null, after?.signature ?? null],
        )
      ).rows;
      if (!rows.length) break;
      const st = await this.rpc.getSignatureStatuses(rows.map((r) => r.signature));
      const fin: string[] = [];
      const candidates: string[] = [];
      rows.forEach((r, i) => {
        seen.add(r.signature);
        const s = st[i];
        // A failed tx is stored too (status 'failed', no trades): known to the cluster either way.
        if (s) {
          this.misses.delete(r.signature);
          if (s.confirmationStatus === "finalized") fin.push(r.signature);
          return;
        }
        const n = (this.misses.get(r.signature) ?? 0) + 1;
        this.misses.set(r.signature, n);
        if (n >= this.opts.dropMisses && r.age > this.opts.dropAfterSecs) candidates.push(r.signature);
      });
      if (fin.length) await this.db.query("UPDATE meteora_transactions SET commitment = 'finalized' WHERE signature = ANY($1)", [fin]);
      const dropped: string[] = [];
      for (const sig of candidates) {
        let tx: unknown;
        try {
          tx = await this.rpc.getTransaction(sig, "confirmed");
        } catch {
          continue; // RPC error: decide on a later run
        }
        if (tx === null) dropped.push(sig);
        else {
          this.misses.delete(sig);
          this.stats.savedByCrossCheck++;
        }
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
    if (this.misses.size > 50_000) for (const k of this.misses.keys()) if (!seen.has(k)) this.misses.delete(k);
    this.stats.finalized += finalized;
    this.stats.rolledBack += rolledBack;
    this.stats.pendingMisses = this.misses.size;
    this.stats.lastRunAt = Date.now();
    return { finalized, rolledBack };
  }

  async rollback(signatures: string[]): Promise<void> {
    const pools = await this.db.query<{ pool: string }>("DELETE FROM meteora_pools WHERE created_sig = ANY($1) RETURNING pool", [signatures]);
    if (pools.rows.length) await this.db.query("DELETE FROM meteora_cursors WHERE kind = 'pool' AND address = ANY($1)", [pools.rows.map((r) => r.pool)]);
    await this.db.query("DELETE FROM meteora_transactions WHERE signature = ANY($1)", [signatures]);
    this.log.warn({ signatures, pools: pools.rows.map((r) => r.pool) }, "meteora: rolled back dropped transactions");
    this.onRolledBack?.();
  }
}
