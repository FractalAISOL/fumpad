/** A Map with a size bound: `get`/`set` refresh an entry, the least recently used one is evicted (V7-M6). */
export class LruMap<K, V> extends Map<K, V> {
  constructor(readonly max: number) {
    super();
  }
  override get(k: K): V | undefined {
    if (!super.has(k)) return undefined;
    const v = super.get(k) as V;
    super.delete(k);
    super.set(k, v);
    return v;
  }
  override set(k: K, v: V): this {
    super.delete(k);
    super.set(k, v);
    // `max` is undefined while Map's constructor runs
    while (this.max !== undefined && this.size > this.max) super.delete(super.keys().next().value as K);
    return this;
  }
}
