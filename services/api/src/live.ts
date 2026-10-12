/**
 * Live updates: the indexer NOTIFYs `fumpad_live` inside its ingest transaction (so a
 * notification is only delivered for committed data); the API LISTENs on a dedicated
 * connection, invalidates its cache and fans messages out to WebSocket clients:
 *
 *   feed    one per new feed event (launch, fumble, cross, graduation, claim)
 *   coins   one per indexed transaction: the mints and wallets it touched
 *   coin    per touched mint: fresh CoinDetail + that transaction's trades + chart points
 *   params  Global.params changed
 *
 * Message types are the app's `LiveMessage` (app/src/data/types.ts).
 */
import pg from "pg";

import { NOTIFY_CHANNEL } from "@fumpad/indexer";

import type { CoinDetail, FeedEvent, LiveMessage, PricePoint, TradeRow } from "./generated/app-types.js";

export type { LiveMessage };

export interface LiveResolvers {
  feed: (id: string) => Promise<FeedEvent | null>;
  coin: (mint: string, sig?: string) => Promise<{ coin: CoinDetail; trades: TradeRow[]; points: PricePoint[] } | null>;
}

/** At most this many `coin` messages per notification (a tx rarely touches more than 2 mints). */
const MAX_COIN_MSGS = 8;

export class LiveHub {
  private client?: pg.Client;
  private subs = new Set<(m: LiveMessage) => void>();
  private stopped = false;
  /** Notifications are handled one at a time so clients see them in commit order. */
  private chain: Promise<void> = Promise.resolve();
  stats = { notifications: 0, reconnects: 0, coinMsgs: 0 };

  constructor(
    private url: string,
    private resolve: LiveResolvers,
    private onInvalidate: (mints?: string[], wallets?: string[]) => void,
    private log: { warn: (o: object, m: string) => void },
  ) {}

  async start(): Promise<void> {
    const c = new pg.Client({ connectionString: this.url, application_name: "fumpad-api-listen" });
    c.on("notification", (n) => {
      const payload = n.payload ?? "";
      this.chain = this.chain.then(() => this.handle(payload)).catch((e: Error) => this.log.warn({ err: e.message }, "live message failed"));
    });
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

  /** Exposed for tests. */
  async handle(payload: string) {
    this.stats.notifications++;
    let msg: { type: string; id?: string; mints?: string[]; wallets?: string[]; sig?: string };
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    if (msg.type === "coins") {
      const mints = msg.mints ?? [];
      const wallets = msg.wallets ?? [];
      this.onInvalidate(mints, wallets);
      this.emit({ type: "coins", mints, wallets });
      // Per-coin state is only worth a DB round trip when someone is listening.
      if (!this.subs.size) return;
      for (const mint of mints.slice(0, MAX_COIN_MSGS)) {
        const c = await this.resolve.coin(mint, msg.sig);
        if (!c) continue;
        this.stats.coinMsgs++;
        this.emit({ type: "coin", ...c });
      }
    } else if (msg.type === "params") {
      this.onInvalidate();
      this.emit({ type: "params" });
    } else if (msg.type === "feed" && msg.id) {
      this.onInvalidate(["feed", "stats"]);
      const ev = await this.resolve.feed(msg.id);
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
