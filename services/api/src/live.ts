/**
 * Live updates: the indexer NOTIFYs `fumpad_live` inside its ingest transaction (so a
 * notification is only delivered for committed data); the API LISTENs on a dedicated
 * connection, invalidates its cache and fans feed events out to WebSocket clients.
 */
import pg from "pg";

import { NOTIFY_CHANNEL } from "@fumpad/indexer";

import type { FeedEvent } from "./generated/app-types.js";

export type LiveMessage = { type: "feed"; event: FeedEvent } | { type: "coins"; mints: string[] } | { type: "params" };

export class LiveHub {
  private client?: pg.Client;
  private subs = new Set<(m: LiveMessage) => void>();
  private stopped = false;
  stats = { notifications: 0, reconnects: 0 };

  constructor(
    private url: string,
    private resolveFeed: (id: string) => Promise<FeedEvent | null>,
    private onInvalidate: (mints?: string[]) => void,
    private log: { warn: (o: object, m: string) => void },
  ) {}

  async start(): Promise<void> {
    const c = new pg.Client({ connectionString: this.url, application_name: "fumpad-api-listen" });
    c.on("notification", (n) => void this.handle(n.payload ?? ""));
    c.on("error", (e) => {
      this.log.warn({ err: String(e) }, "LISTEN connection error; reconnecting");
      void this.reconnect();
    });
    await c.connect();
    await c.query(`LISTEN ${NOTIFY_CHANNEL}`);
    this.client = c;
  }

  private async reconnect() {
    if (this.stopped) return;
    this.stats.reconnects++;
    await this.client?.end().catch(() => {});
    setTimeout(() => void this.start().catch(() => this.reconnect()), 1_000);
    this.onInvalidate();
  }

  private async handle(payload: string) {
    this.stats.notifications++;
    let msg: { type: string; id?: string; mints?: string[] };
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    if (msg.type === "coins") {
      this.onInvalidate(msg.mints);
      this.emit({ type: "coins", mints: msg.mints ?? [] });
    } else if (msg.type === "params") {
      this.onInvalidate();
      this.emit({ type: "params" });
    } else if (msg.type === "feed" && msg.id) {
      this.onInvalidate(["feed", "stats"]);
      const ev = await this.resolveFeed(msg.id);
      if (ev) this.emit({ type: "feed", event: ev });
    }
  }

  private emit(m: LiveMessage) {
    for (const s of this.subs) s(m);
  }

  subscribe(fn: (m: LiveMessage) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  get subscribers() {
    return this.subs.size;
  }

  async stop() {
    this.stopped = true;
    await this.client?.end().catch(() => {});
  }
}
