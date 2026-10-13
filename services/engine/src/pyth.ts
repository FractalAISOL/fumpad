/**
 * SOL/USD price sources for the engine's $ minimum (SPEC §5.4: the update with the greatest
 * publish_time ≤ block_time; |Δ| ≤ 60 s else no ticket). All keepers and the watcher MUST use the same
 * source, or they will disagree and not reach 2-of-3.
 *
 * - HermesPythSource: Pyth Hermes historical API (`/v2/updates/price/{publish_time}`), as specified.
 *   UNVERIFIED: since 2026-10 Hermes answers 401 "unauthorized" to unauthenticated requests (checked
 *   2026-10-13 for /latest and historical, also benchmarks.pyth.network). The API-key header name is
 *   configurable (`apiKeyHeader`, default `x-api-key`) — UNVERIFIED until a key is provisioned.
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
}

export class HermesPythSource implements PythSource {
  private readonly cache = new Map<number, PythPrice | null>();
  constructor(private readonly o: HermesOptions = {}) {}

  private async at(t: number): Promise<PythPrice | null> {
    if (this.cache.has(t)) return this.cache.get(t)!;
    const base = this.o.baseUrl ?? "https://hermes.pyth.network";
    const feed = this.o.feedId ?? PYTH_SOL_USD_FEED_ID;
    const headers: Record<string, string> = {};
    if (this.o.apiKey) headers[this.o.apiKeyHeader ?? "x-api-key"] = this.o.apiKey;
    const res = await (this.o.fetchImpl ?? fetch)(`${base}/v2/updates/price/${t}?ids%5B%5D=${feed}&parsed=true`, {
      headers,
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
    });
    if (res.status === 404) {
      this.cache.set(t, null);
      return null;
    }
    if (!res.ok) throw new Error(`hermes ${t}: HTTP ${res.status}`); // never cached: transient
    const j = (await res.json()) as { parsed?: { id: string; price: { price: string; conf: string; expo: number; publish_time: number } }[] };
    const p = j.parsed?.find((x) => x.id.replace(/^0x/, "") === feed);
    const v = p ? { price: BigInt(p.price.price), conf: BigInt(p.price.conf), expo: p.price.expo, publishTime: p.price.publish_time } : null;
    this.cache.set(t, v);
    return v;
  }

  async priceAt(blockTime: number, maxDeltaSecs: number): Promise<PythPrice | null> {
    for (let t = blockTime; t >= blockTime - maxDeltaSecs; t--) {
      const p = await this.at(t);
      if (p && p.publishTime <= blockTime && blockTime - p.publishTime <= maxDeltaSecs) return p;
      if (p && p.publishTime <= blockTime) return p; // older than the window: the engine rejects it as stale
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
