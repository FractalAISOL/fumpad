/**
 * Small in-process TTL cache with request coalescing. Every API instance holds its own;
 * the indexer's NOTIFY clears it so writes show up immediately, and TTLs bound staleness
 * if a notification is missed. (Swap for Redis if you run many API replicas.)
 *
 * Audit S-7 / L-4: one bounded LRU per namespace (the key's first `:` segment, i.e. per route family; `chain:<kind>`
 * for ChainReader keys), so a
 * caller cycling through attacker-chosen keys (random wallets, mints) only churns its own namespace and can't
 * flush the hot coin lists, stats or other routes' entries. Failures are cached briefly too (negative caching,
 * `negativeTtlMs`): a key whose load keeps failing (RPC error, bad account) is not re-fetched on every request.
 */
type Entry = { at: number; ttl: number; v: Promise<unknown>; segs: string[] };

export interface TtlCacheOpts {
  /** Entries per namespace unless overridden (default 2,000). */
  perNamespace?: number;
  /** Per-namespace overrides, e.g. `{ portfolio: 1_000 }`. */
  namespaces?: Record<string, number>;
  /** How long a failed load is remembered (ms, default 2 s; capped by the entry's own TTL). */
  negativeTtlMs?: number;
}

export class TtlCache {
  private ns = new Map<string, Map<string, Entry>>();
  hits = 0;
  misses = 0;
  private perNs: number;
  private overrides: Record<string, number>;
  private negTtl: number;

  /** `opts` as a number = the per-namespace cap (older signature). */
  constructor(opts: number | TtlCacheOpts = {}) {
    const o = typeof opts === "number" ? { perNamespace: opts } : opts;
    this.perNs = o.perNamespace ?? 2_000;
    this.overrides = o.namespaces ?? {};
    this.negTtl = o.negativeTtlMs ?? 2_000;
  }

  /** Entries across all namespaces. */
  get size(): number {
    let n = 0;
    for (const m of this.ns.values()) n += m.size;
    return n;
  }

  private bucket(key: string): { m: Map<string, Entry>; cap: number } {
    const segs = key.split(":", 2);
    // `chain:<kind>:…` (ChainReader) splits one level deeper: chain:global / chain:solusd never share with chain:coin.
    const name = segs[0] === "chain" && segs.length > 1 ? `chain:${segs[1]}` : segs[0];
    let m = this.ns.get(name);
    if (!m) {
      m = new Map();
      this.ns.set(name, m);
    }
    return { m, cap: this.overrides[name] ?? this.perNs };
  }

  get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const { m, cap } = this.bucket(key);
    const e = m.get(key);
    const now = Date.now();
    if (e && now - e.at < e.ttl) {
      this.hits++;
      // LRU: most recently used goes to the back.
      m.delete(key);
      m.set(key, e);
      return e.v as Promise<T>;
    }
    this.misses++;
    if (e) m.delete(key);
    const v = load();
    const entry: Entry = { at: now, ttl: ttlMs, v, segs: key.split(":") };
    m.set(key, entry);
    // Negative caching: keep the rejection for a short while instead of retrying the load on every request.
    v.catch(() => {
      if (m.get(key) === entry) entry.ttl = Math.min(ttlMs, this.negTtl);
    });
    while (m.size > cap) {
      const oldest = m.keys().next().value;
      if (oldest === undefined) break;
      m.delete(oldest);
    }
    return v;
  }

  /**
   * Drop keys with any `:`-separated segment equal to one of `parts` (a part containing `:`
   * matches as a substring), or everything. Keys are
   * `kind:id:…` (ids are base58 / symbols, never containing `:`), so this matches what a
   * substring test did, in O(keys) instead of O(keys × parts) per notification.
   */
  invalidate(parts?: string[]) {
    if (!parts) return this.ns.clear();
    const set = new Set(parts.filter((p) => !p.includes(":")));
    const multi = parts.filter((p) => p.includes(":")); // e.g. "coin:<mint>": substring, as before
    for (const m of this.ns.values()) for (const [k, e] of m) if (e.segs.some((p) => set.has(p)) || multi.some((p) => k.includes(p))) m.delete(k);
  }
}
