/**
 * Live updates: the indexer NOTIFYs `fumpad_live` inside its ingest transaction (so a
 * notification is only delivered for committed data); the API LISTENs on a dedicated
 * connection, invalidates its cache and fans messages out to WebSocket clients:
 *
 *   feed    one per new feed event (launch, fumble, cross, graduation, claim)
 *   coins   the mints and wallets indexed transactions touched (coalesced per window)
 *   coin    per touched mint and window: fresh CoinDetail + the window's trades + chart points
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
  /** Fresh detail for `mint` plus the trades/chart points of the given transactions on it. */
  coin: (mint: string, sigs?: string[]) => Promise<{ coin: CoinDetail; trades: TradeRow[]; points: PricePoint[] } | null>;
}

export interface LiveOptions {
  /**
   * Coalescing window for `coins` notifications (ms). Every notification still invalidates
   * the cache at once; clients get ONE `coins` message (union of mints/wallets) and ONE `coin`
   * message per touched mint per window, carrying all of that window's trades. 0 = per
   * notification (tests).
   */
  coalesceMs?: number;
  /** `coin` messages resolved in parallel per flush. */
  concurrency?: number;
  /** Mints resolved per flush; the rest of a huge burst only get the `coins` message (clients refetch). */
  maxCoinsPerFlush?: number;
}

/** A subscriber gets the message and its JSON (serialized once per message, not per client). */
export type LiveListener = (m: LiveMessage, json: string) => void;

const MAX_WALLETS_PER_MSG = 200;

export class LiveHub {
  private client?: pg.Client;
  private subs = new Set<LiveListener>();
  private stopped = false;
  /** Notifications and flushes run one at a time so clients see them in commit order. */
  private chain: Promise<void> = Promise.resolve();
  private pending = new Map<string, string[]>();
  private pendingWallets = new Set<string>();
  private timer?: NodeJS.Timeout;
  private readonly coalesceMs: number;
  private readonly concurrency: number;
  private readonly maxCoins: number;
  stats = { notifications: 0, reconnects: 0, coinMsgs: 0, flushes: 0, lastFlushMs: 0, maxFlushMs: 0, droppedCoins: 0 };

  constructor(
    private url: string,
    private resolve: LiveResolvers,
    private onInvalidate: (mints?: string[], wallets?: string[]) => void,
    private log: { warn: (o: object, m: string) => void },
    opts: LiveOptions = {},
  ) {
    this.coalesceMs = opts.coalesceMs ?? 250;
    this.concurrency = Math.max(1, opts.concurrency ?? 6);
    this.maxCoins = opts.maxCoinsPerFlush ?? 100;
  }

  async start(): Promise<void> {
    const c = new pg.Client({ connectionString: this.url, application_name: "fumpad-api-listen" });
    c.on("notification", (n) => {
      const payload = n.payload ?? "";
      this.enqueue(() => this.handle(payload));
    });
    c.on("error", (e) => {
      this.log.warn({ err: String(e) }, "LISTEN connection error; reconnecting");
      void this.reconnect();
    });
    await c.connect();
    await c.query(`LISTEN ${NOTIFY_CHANNEL}`);
    this.client = c;
  }

  private enqueue(fn: () => Promise<void>) {
    this.chain = this.chain.then(fn).catch((e: Error) => this.log.warn({ err: e.message }, "live message failed"));
  }

  private async reconnect() {
    if (this.stopped) return;
    this.stats.reconnects++;
    await this.client?.end().catch(() => {});
    setTimeout(() => void this.start().catch(() => this.reconnect()), 1_000);
    this.onInvalidate();
  }

  /** Exposed for tests. With `coalesceMs: 0` the coin messages are sent before this resolves. */
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
      for (const m of mints) {
        const sigs = this.pending.get(m) ?? [];
        if (msg.sig && !sigs.includes(msg.sig)) sigs.push(msg.sig);
        this.pending.set(m, sigs);
      }
      for (const w of wallets) this.pendingWallets.add(w);
      if (this.coalesceMs <= 0) return this.flush();
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.enqueue(() => this.flush());
        }, this.coalesceMs);
        this.timer.unref?.();
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

  /** One `coins` message for the window, then one `coin` message per touched mint. */
  async flush() {
    if (!this.pending.size && !this.pendingWallets.size) return;
    const t0 = Date.now();
    const batch = [...this.pending];
    const wallets = [...this.pendingWallets].slice(0, MAX_WALLETS_PER_MSG);
    this.pending = new Map();
    this.pendingWallets = new Set();
    this.stats.flushes++;
    this.emit({ type: "coins", mints: batch.map(([m]) => m), wallets });
    // Per-coin state is only worth a DB round trip when someone is listening.
    if (this.subs.size) {
      const todo = batch.slice(0, this.maxCoins);
      this.stats.droppedCoins += batch.length - todo.length;
      const out: (Awaited<ReturnType<LiveResolvers["coin"]>> | undefined)[] = new Array(todo.length);
      let next = 0;
      const worker = async () => {
        while (next < todo.length) {
          const i = next++;
          const [mint, sigs] = todo[i];
          out[i] = await this.resolve.coin(mint, sigs.length ? sigs : undefined).catch((e: Error) => {
            this.log.warn({ mint, err: e.message }, "live coin failed");
            return null;
          });
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, todo.length) }, worker));
      for (const c of out) {
        if (!c) continue;
        this.stats.coinMsgs++;
        this.emit({ type: "coin", ...c });
      }
    }
    this.stats.lastFlushMs = Date.now() - t0;
    this.stats.maxFlushMs = Math.max(this.stats.maxFlushMs, this.stats.lastFlushMs);
  }

  private emit(m: LiveMessage) {
    if (!this.subs.size) return;
    const json = JSON.stringify(m);
    for (const s of this.subs) s(m, json);
  }

  subscribe(fn: LiveListener): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  get subscribers() {
    return this.subs.size;
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.client?.end().catch(() => {});
  }
}
