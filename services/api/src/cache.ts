/**
 * Small in-process TTL cache with request coalescing. Every API instance holds its own;
 * the indexer's NOTIFY clears it so writes show up immediately, and TTLs bound staleness
 * if a notification is missed. (Swap for Redis if you run many API replicas.)
 */
export class TtlCache {
  private m = new Map<string, { at: number; ttl: number; v: Promise<unknown> }>();
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
    this.m.set(key, { at: now, ttl: ttlMs, v });
    v.catch(() => this.m.delete(key));
    if (this.m.size > this.maxEntries) {
      const first = this.m.keys().next().value;
      if (first !== undefined) this.m.delete(first);
    }
    return v;
  }

  /** Drop keys containing any of `parts` (or everything). */
  invalidate(parts?: string[]) {
    if (!parts) return this.m.clear();
    for (const k of this.m.keys()) if (parts.some((p) => k.includes(p))) this.m.delete(k);
  }
}
