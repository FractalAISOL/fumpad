/**
 * Meteora DBC + DAMM v2 trade indexing (feature flag METEORA_INDEXER_ENABLED; see config.ts).
 * Independent of the curve/PumpSwap pipeline: own tables (migration 008), own cursors, own RPC
 * client (version-1 transactions), own finalizer. The Indexer only schedules it and fans webhook
 * hints out to it.
 */
import { MeteoraRpc } from "@fumpad/meteora";

import type { Db } from "../db.js";
import type { Logger } from "../log.js";
import type { MeteoraIndexerConfig } from "./config.js";
import { MeteoraFinalizer } from "./finality.js";
import type { Commit } from "../ingest.js";
import { MeteoraIngestor } from "./ingest.js";
import { MeteoraSignatureSource } from "./source.js";

export * from "./config.js";
export * from "./finality.js";
export * from "./ingest.js";
export * from "./source.js";

export class MeteoraIndexer {
  readonly rpc: MeteoraRpc;
  readonly ingestor: MeteoraIngestor;
  readonly source: MeteoraSignatureSource;
  readonly finalizer: MeteoraFinalizer;

  constructor(cfg: MeteoraIndexerConfig, db: Db, log: Logger, opts: { rpcUrl: string; commitment: Commit; dropMisses?: number; dropAfterSecs?: number; rpc?: MeteoraRpc }) {
    const l = log.child({ component: "meteora" });
    this.rpc = opts.rpc ?? new MeteoraRpc(cfg.rpcUrl ?? opts.rpcUrl);
    this.ingestor = new MeteoraIngestor(db, cfg, l);
    this.source = new MeteoraSignatureSource(
      this.rpc,
      db,
      this.ingestor,
      { commitment: opts.commitment, pageSize: cfg.pageSize, backfillFromSlot: cfg.backfillFromSlot, reconcileDepth: cfg.reconcileDepth, dbcConfigs: cfg.dbcConfigs, mints: cfg.mints },
      l,
    );
    const fin: { dropMisses?: number; dropAfterSecs?: number } = {};
    if (opts.dropMisses !== undefined) fin.dropMisses = opts.dropMisses;
    if (opts.dropAfterSecs !== undefined) fin.dropAfterSecs = opts.dropAfterSecs;
    this.finalizer = new MeteoraFinalizer(this.rpc, db, l, fin, () => void this.ingestor.refreshPools(true));
  }

  async start() {
    await this.source.ensureCursors();
    await this.ingestor.refreshPools(true);
  }

  get stats() {
    return { ingest: this.ingestor.stats, source: this.source.stats, finalizer: this.finalizer.stats, pools: this.ingestor.watchedPools().size };
  }
}
