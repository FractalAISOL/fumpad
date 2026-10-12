/** The indexer process: sources → ingestor → Postgres, plus finalizer, chain sync, derive jobs and /health. */
import { createServer, type Server } from "node:http";

import { Connection } from "@solana/web3.js";

import { DEFAULT_PARAMS, type Params } from "@fumpad/sdk";

import { ChainSync } from "./chainSync.js";
import type { IndexerConfig } from "./config.js";
import { createPool, type Db, migrate, setMeta } from "./db.js";
import { Deriver } from "./derive.js";
import { Finalizer } from "./finality.js";
import { Ingestor } from "./ingest.js";
import { createLogger, type Logger } from "./log.js";
import { loadParams } from "./params.js";
import { heliusWebhookHandler, subscribeLogs } from "./sources/push.js";
import { RpcSource } from "./sources/rpc.js";
import { heartbeatKey, serviceInfo } from "./version.js";

export class Indexer {
  readonly db: Db;
  readonly conn: Connection;
  readonly log: Logger;
  readonly ingestor: Ingestor;
  readonly rpc: RpcSource;
  readonly finalizer: Finalizer;
  readonly chainSync: ChainSync;
  readonly deriver: Deriver;
  private params: Params = DEFAULT_PARAMS;
  private timers: NodeJS.Timeout[] = [];
  private server?: Server;
  private unsubscribe?: () => void;
  private stopped = false;
  private startedAt = Date.now();

  constructor(readonly cfg: IndexerConfig, log?: Logger) {
    this.log = log ?? createLogger("indexer", cfg.logLevel);
    this.db = createPool(cfg.databaseUrl);
    this.conn = new Connection(cfg.rpcUrl, { commitment: cfg.commitment, wsEndpoint: cfg.wsUrl, disableRetryOnRateLimit: false });
    this.chainSync = new ChainSync(this.conn, this.db, this.log, { debounceMs: 500, fetchMetadata: cfg.fetchMetadata });
    this.ingestor = new Ingestor({
      db: this.db,
      conn: this.conn,
      log: this.log,
      params: () => this.params,
      onTouched: (m) => this.chainSync.enqueue(m),
      onParamsChanged: () => void this.reloadParams(),
    });
    this.rpc = new RpcSource(this.conn, this.db, this.ingestor, { commitment: cfg.commitment, pageSize: cfg.pageSize, backfillFromSlot: cfg.backfillFromSlot, reconcileDepth: cfg.reconcileDepth }, this.log);
    this.finalizer = new Finalizer(this.conn, this.db, () => this.params, this.log);
    this.deriver = new Deriver(this.conn, this.db, this.log, { fundingLookupsPerCycle: cfg.fundingLookupsPerCycle, claimWindowSecs: () => this.params.claimWindowSecs });
  }

  async reloadParams() {
    this.params = (await loadParams(this.conn, this.db)).params;
  }

  async start(): Promise<void> {
    await migrate(this.db, (m) => this.log.info(m));
    await this.reloadParams();
    await this.rpc.ensureCursors();
    this.log.info({ rpc: this.cfg.rpcUrl.replace(/api-key=[^&]+/, "api-key=***"), commitment: this.cfg.commitment }, "indexer starting");

    const loop = (name: string, ms: number, fn: () => Promise<unknown>, firstDelay = 0) => {
      const tick = async () => {
        if (this.stopped) return;
        try {
          await fn();
        } catch (e) {
          this.log.warn({ job: name, err: String(e) }, "job failed");
        }
        if (!this.stopped) this.timers.push(setTimeout(tick, ms));
      };
      this.timers.push(setTimeout(tick, firstDelay));
    };
    loop("poll", this.cfg.pollIntervalMs, () => this.rpc.pollOnce());
    loop("reconcile", this.cfg.reconcileIntervalMs, () => this.rpc.reconcile(), this.cfg.reconcileIntervalMs);
    loop("finalize", this.cfg.finalizeIntervalMs, () => this.finalizer.runOnce());
    loop("derive", this.cfg.deriveIntervalMs, () => this.deriver.runOnce());
    loop("params", 60_000, () => this.reloadParams());
    loop("heartbeat", 15_000, () => this.heartbeat());
    if (this.cfg.wsUrl) this.unsubscribe = subscribeLogs(this.conn, () => this.rpc.poke(), this.log);

    if (this.cfg.healthPort || this.cfg.webhookPort) {
      const webhook = heliusWebhookHandler(this.ingestor, this.log, this.cfg.webhookSecret);
      this.server = createServer((req, res) => {
        if (req.method === "POST" && req.url?.startsWith("/helius")) return void webhook(req, res);
        if (req.url?.startsWith("/health")) {
          void this.health().then((h) => res.writeHead(h.ok ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify(h)));
          return;
        }
        res.writeHead(404).end();
      });
      await new Promise<void>((r) => this.server!.listen(this.cfg.healthPort ?? this.cfg.webhookPort, r));
    }
  }

  /** Liveness + version into `meta` for the API's /v1/status (no extra network hop between services). */
  async heartbeat() {
    const h = await this.health();
    await setMeta(this.db, heartbeatKey("indexer"), {
      ...h.version,
      at: Date.now(),
      ok: h.ok,
      tipSlot: h.tipSlot || null,
      lastIngestedSlot: h.lastIngestedSlot,
      msSinceLastPoll: h.msSinceLastPoll,
    });
  }

  async health() {
    let tip = 0;
    try {
      tip = await this.conn.getSlot(this.cfg.commitment);
    } catch {
      /* rpc down */
    }
    const last = this.ingestor.stats.lastSlot;
    const sincePoll = Date.now() - this.rpc.stats.lastPollAt;
    const ok = tip > 0 && sincePoll < Math.max(60_000, this.cfg.pollIntervalMs * 10);
    return {
      ok,
      version: serviceInfo("indexer"),
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      tipSlot: tip,
      lastIngestedSlot: last,
      msSinceLastPoll: sincePoll,
      ingest: this.ingestor.stats,
      rpc: this.rpc.stats,
      finalizer: this.finalizer.stats,
      chainSync: this.chainSync.stats,
      derive: this.deriver.stats,
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.unsubscribe?.();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    await this.chainSync.flush().catch(() => {});
    await this.db.end();
  }
}
