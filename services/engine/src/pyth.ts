/**
 * SOL/USD price sources for the engine's $ minimum (SPEC §5.4: the update with the greatest
 * publish_time ≤ block_time; |Δ| ≤ 60 s else no ticket). All keepers and the watcher MUST use the same
 * source, or they will disagree and not reach 2-of-3.
 *
 * - HermesPythSource: Pyth Hermes historical API (`/v2/updates/price/{publish_time}`), as specified.
 *   Since 2026-10 Hermes answers 401 "unauthorized" to unauthenticated requests. The key is sent as
 *   `Authorization: Bearer <key>` (verified 2026-10-13 with the provisioned key on the historical endpoint:
 *   Bearer → 200, `x-api-key` → 401, none → 401). `apiKeyHeader` overrides the header name for other
 *   providers (the value is then the raw key).
 *   The endpoint's exact semantics (first update at/after the timestamp) are UNVERIFIED as well, so the
 *   source walks back second by second until it gets an update with publish_time ≤ block_time.
 * - StaticPythSource: a fixed table (tests, local e2e, replays of recorded prices).
 */
import type { PythPrice } from "./rules/usd.js";

export const PYTH_SOL_USD_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

export interface PythSource {
  /** Greatest-publish_time ≤ blockTime update within `maxDeltaSecs`, or null if none. */
  priceAt(blockTime: number, maxDeltaSecs: number): Promise<PythPrice | null>;
}

export interface HermesOptions {
  baseUrl?: string;
  apiKey?: string;
  apiKeyHeader?: string;
  feedId?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Unix seconds (tests). */
  now?: () => number;
  /** A 404 for a recent second is re-asked after this long (Hermes may not have indexed it yet). Default 60 s. */
  notFoundRetrySecs?: number;
  /** A 404 for a second older than this is final (cached for good). Default 3,600 s. */
  notFoundFinalAfterSecs?: number;
  /** Max cached seconds (LRU). Default 50,000. */
  maxCacheEntries?: number;
}

/** One parsed Hermes update (metadata.slot orders updates that share a publish_time). */
export interface HermesUpdate extends PythPrice {
  slot: number | null;
}

/**
 * Deterministic choice among Hermes updates (V7-M5): the greatest publish_time ≤ block time; among
 * updates sharing that second, the EARLIEST (lowest Pythnet slot; updates without a slot last), then
 * lowest price, then lowest conf. Every keeper applies the same rule to whatever order Hermes returns.
 */
export function selectUpdate(updates: readonly HermesUpdate[], blockTime: number): HermesUpdate | null {
  let best: HermesUpdate | null = null;
  const slotKey = (u: HermesUpdate) => (u.slot === null ? Number.MAX_SAFE_INTEGER : u.slot);
  for (const u of updates) {
    if (u.publishTime > blockTime) continue;
    if (
      !best ||
      u.publishTime > best.publishTime ||
      (u.publishTime === best.publishTime &&
        (slotKey(u) < slotKey(best) || (slotKey(u) === slotKey(best) && (u.price < best.price || (u.price === best.price && u.conf < best.conf)))))
    )
      best = u;
  }
  return best;
}

export class HermesPythSource implements PythSource {
  /** Successful responses (kept, LRU-bounded) and 404s (`until` = when to ask again; Infinity = final). */
  private readonly cache = new Map<number, { updates: HermesUpdate[]; until: number }>();
  constructor(private readonly o: HermesOptions = {}) {}

  private now() {
    return this.o.now ? this.o.now() : Math.floor(Date.now() / 1000);
  }

  private remember(t: number, v: { updates: HermesUpdate[]; until: number }) {
    this.cache.delete(t);
    this.cache.set(t, v);
    const max = this.o.maxCacheEntries ?? 50_000;
    while (this.cache.size > max) this.cache.delete(this.cache.keys().next().value!);
  }

  private async at(t: number): Promise<HermesUpdate[]> {
    const hit = this.cache.get(t);
    if (hit && hit.until > this.now()) return hit.updates;
    const base = this.o.baseUrl ?? "https://hermes.pyth.network";
    const feed = this.o.feedId ?? PYTH_SOL_USD_FEED_ID;
    const headers: Record<string, string> = {};
    if (this.o.apiKey) {
      if (this.o.apiKeyHeader && this.o.apiKeyHeader.toLowerCase() !== "authorization") headers[this.o.apiKeyHeader] = this.o.apiKey;
      else headers.Authorization = `Bearer ${this.o.apiKey}`;
    }
    const res = await (this.o.fetchImpl ?? fetch)(`${base}/v2/updates/price/${t}?ids%5B%5D=${feed}&parsed=true`, {
      headers,
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
    });
    if (res.status === 404) {
      // V7-M5: a 404 is only "not indexed yet" for recent seconds: ask again later; final once old.
      const old = this.now() - t > (this.o.notFoundFinalAfterSecs ?? 3_600);
      this.remember(t, { updates: [], until: old ? Number.POSITIVE_INFINITY : this.now() + (this.o.notFoundRetrySecs ?? 60) });
      return [];
    }
    if (!res.ok) throw new Error(`hermes ${t}: HTTP ${res.status}`); // never cached: transient
    const j = (await res.json()) as {
      parsed?: { id: string; price: { price: string; conf: string; expo: number; publish_time: number }; metadata?: { slot?: number } }[];
    };
    const updates = (j.parsed ?? [])
      .filter((x) => x.id.replace(/^0x/, "") === feed)
      .map((p) => ({ price: BigInt(p.price.price), conf: BigInt(p.price.conf), expo: p.price.expo, publishTime: p.price.publish_time, slot: typeof p.metadata?.slot === "number" ? p.metadata.slot : null }));
    if (updates.length) this.remember(t, { updates, until: Number.POSITIVE_INFINITY });
    return updates;
  }

  async priceAt(blockTime: number, maxDeltaSecs: number): Promise<PythPrice | null> {
    for (let t = blockTime; t >= blockTime - maxDeltaSecs; t--) {
      const u = selectUpdate(await this.at(t), blockTime);
      // the first second (walking back) with an update ≤ block time holds the greatest one; if it's older
      // than the window the engine rejects it as stale
      if (u) return { price: u.price, conf: u.conf, expo: u.expo, publishTime: u.publishTime };
    }
    return null;
  }
}

/** Deterministic table source: the entry with the greatest publishTime ≤ blockTime. */
export class StaticPythSource implements PythSource {
  private readonly sorted: PythPrice[];
  constructor(prices: readonly PythPrice[]) {
    this.sorted = [...prices].sort((a, b) => a.publishTime - b.publishTime);
  }
  async priceAt(blockTime: number): Promise<PythPrice | null> {
    return this.lookup(blockTime);
  }
  lookup(blockTime: number): PythPrice | null {
    let best: PythPrice | null = null;
    for (const p of this.sorted) {
      if (p.publishTime > blockTime) break;
      best = p;
    }
    return best;
  }
}

/** A constant price published `lagSecs` before every block (tests / local chains without Pyth). */
export function constantPythSource(price: PythPrice["price"], conf: bigint, expo: number, lagSecs = 1): PythSource & { lookup(t: number): PythPrice } {
  return {
    lookup: (t: number) => ({ price, conf, expo, publishTime: t - lagSecs }),
    async priceAt(t: number) {
      return { price, conf, expo, publishTime: t - lagSecs };
    },
  };
}
