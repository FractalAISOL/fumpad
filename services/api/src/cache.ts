/**
 * Small in-process TTL cache with request coalescing. Every API instance holds its own;
 * the indexer's NOTIFY clears it so writes show up immediately, and TTLs bound staleness
 * if a notification is missed. (Swap for Redis if you run many API replicas.)
 */
export class TtlCache {
  private m = new Map<string, { at: number; ttl: number; v: Promise<unknown>; segs: string[] }>();
  hits = 0;
  misses = 0;

  constructor(private maxEntries = 5_000) {}

  get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const e = this.m.get(key);
    const now = Date.now();
    if (e && now - e.at < e.ttl) {
      this.hits++;
      return e.v as Promise<T>;
    }
    this.misses++;
    const v = load();
    this.m.set(key, { at: now, ttl: ttlMs, v, segs: key.split(":") });
    v.catch(() => this.m.delete(key));
    if (this.m.size > this.maxEntries) {
      const first = this.m.keys().next().value;
      if (first !== undefined) this.m.delete(first);
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
    if (!parts) return this.m.clear();
    const set = new Set(parts.filter((p) => !p.includes(":")));
    const multi = parts.filter((p) => p.includes(":")); // e.g. "coin:<mint>": substring, as before
    for (const [k, e] of this.m) if (e.segs.some((p) => set.has(p)) || multi.some((p) => k.includes(p))) this.m.delete(k);
  }
}
