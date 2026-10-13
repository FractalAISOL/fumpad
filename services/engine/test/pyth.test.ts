// V7-M5: Hermes 404s aren't cached as "no price" for recent seconds; selection among updates is pinned
// and identical whatever order Hermes returns them in (cross-keeper determinism).
import { describe, expect, it } from "vitest";

import { DEFAULT_ENGINE_PARAMS, HermesPythSource, PYTH_SOL_USD_FEED_ID, type PythPrice, runEngineWithPrices, selectUpdate } from "../src/index.js";
import { A, coin, SOL, Tape } from "./helpers.js";

type U = { price: string; conf: string; expo: number; publish_time: number; slot?: number };
const body = (us: U[]) => Response.json({ parsed: us.map((u) => ({ id: PYTH_SOL_USD_FEED_ID, price: u, metadata: u.slot === undefined ? {} : { slot: u.slot } })) });

describe("HermesPythSource", () => {
  it("re-asks a recent 404 after the retry delay; caches successes", async () => {
    let now = 1_800_000_000;
    let calls = 0;
    const available = new Set<number>();
    const src = new HermesPythSource({
      now: () => now,
      fetchImpl: (async (url: string) => {
        calls++;
        const t = Number(/price\/(\d+)/.exec(url)![1]);
        return available.has(t) ? body([{ price: "15000000000", conf: "1", expo: -8, publish_time: t }]) : new Response("nf", { status: 404 });
      }) as typeof fetch,
    });
    const bt = now - 5;
    expect(await src.priceAt(bt, 2)).toBeNull();
    available.add(bt);
    expect(await src.priceAt(bt, 2)).toBeNull(); // within the retry delay: no new request
    now += 61;
    expect((await src.priceAt(bt, 2))?.publishTime).toBe(bt);
    const c = calls;
    expect((await src.priceAt(bt, 2))?.publishTime).toBe(bt);
    expect(calls).toBe(c); // success cached
  });

  it("a 404 for an old second is final", async () => {
    let calls = 0;
    const src = new HermesPythSource({ now: () => 1_800_000_000, fetchImpl: (async () => (calls++, new Response("nf", { status: 404 }))) as unknown as typeof fetch });
    await src.priceAt(1_700_000_000, 0);
    await src.priceAt(1_700_000_000, 0);
    expect(calls).toBe(1);
  });

  it("two keepers getting the same updates in different orders pick the same one", async () => {
    const t = 1_800_000_000;
    const ups: U[] = [
      { price: "15000000000", conf: "5", expo: -8, publish_time: t - 1, slot: 12 },
      { price: "15010000000", conf: "5", expo: -8, publish_time: t - 1, slot: 11 },
      { price: "14990000000", conf: "5", expo: -8, publish_time: t - 2, slot: 9 },
      { price: "16000000000", conf: "5", expo: -8, publish_time: t + 1, slot: 15 }, // after the block: never
    ];
    const mk = (order: U[]) => new HermesPythSource({ now: () => t + 10, fetchImpl: (async () => body(order)) as unknown as typeof fetch });
    const a = await mk(ups).priceAt(t, 60);
    const b = await mk([...ups].reverse()).priceAt(t, 60);
    expect(a).toEqual(b);
    expect(a).toEqual({ price: 15010000000n, conf: 5n, expo: -8, publishTime: t - 1 }); // greatest second, earliest slot
  });

  it("selectUpdate tie-breaks on slot, then price, then conf", () => {
    const u = (price: bigint, conf: bigint, slot: number | null) => ({ price, conf, expo: -8, publishTime: 10, slot });
    expect(selectUpdate([u(2n, 1n, null), u(3n, 1n, 5)], 10)!.price).toBe(3n);
    expect(selectUpdate([u(3n, 1n, 5), u(2n, 2n, 5)], 10)!.price).toBe(2n);
    expect(selectUpdate([u(2n, 2n, 5), u(2n, 1n, 5)], 10)!.conf).toBe(1n);
  });
});

describe("runEngineWithPrices never keeps a missing price in the shared cache (V7-M5)", () => {
  it("first tick: no price → no ticket; next tick the price exists → ticket", async () => {
    const t = new Tape();
    t.buy(A, SOL);
    t.wait(600).sell(A, SOL);
    const cache = new Map<number, PythPrice | null>();
    let up = false;
    const fetchPrice = async (x: number) => (up ? { price: 150_00000000n, conf: 0n, expo: -8, publishTime: x - 1 } : null);
    const o1 = await runEngineWithPrices(coin(), t.events, DEFAULT_ENGINE_PARAMS, fetchPrice, { cache });
    expect(o1.sells[0].reason).toBe("oracle_unavailable");
    expect(cache.size).toBe(0);
    up = true;
    const o2 = await runEngineWithPrices(coin(), t.events, DEFAULT_ENGINE_PARAMS, fetchPrice, { cache });
    expect(o2.sells[0].ticket).not.toBeNull();
  });
});
