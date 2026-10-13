/**
 * PoC V7-M5: a transient Hermes 404 was cached as "no price" forever (in HermesPythSource and again in
 * derive's long-lived priceCache), so an honest sell could stay `oracle_unavailable` for the process's life.
 * STATUS: FIXED in e01899c — this file now asserts the attack FAILS.
 *
 * Fix (engine/src/pyth.ts, engine.ts runEngineWithPrices):
 *  - only successful responses are cached; a 404 for a recent second is asked again after 60 s (final
 *    only once the second is > 1 h old); runEngineWithPrices never puts a missing price in the shared cache;
 *  - pinned selection among Hermes updates: greatest publish_time ≤ block time, then the earliest Pythnet
 *    slot, then lowest price, then lowest conf — identical whatever order Hermes returns them in.
 *
 * Run (from services/):  node --import tsx --test ../security-review/v07-poc/hermes-null-cache.test.ts
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { HermesPythSource, PYTH_SOL_USD_FEED_ID } from "../../services/engine/src/index.ts";

it("first answer 404, later 200: the source returns the price once Hermes has it", async () => {
  let calls = 0;
  let now = 1_800_000_010;
  const available = new Set<number>();
  const fetchImpl = (async (url: string) => {
    calls++;
    const t = Number(/price\/(\d+)/.exec(url)![1]);
    if (!available.has(t)) return new Response("not found", { status: 404 });
    return Response.json({ parsed: [{ id: PYTH_SOL_USD_FEED_ID, price: { price: "15000000000", conf: "1000000", expo: -8, publish_time: t } }] });
  }) as typeof fetch;
  const src = new HermesPythSource({ fetchImpl, now: () => now });
  const blockTime = 1_800_000_000;
  assert.equal(await src.priceAt(blockTime, 60), null); // Hermes not caught up yet
  for (let t = blockTime - 60; t <= blockTime; t++) available.add(t); // now it has the data
  now += 61;
  const before = calls;
  const p = await src.priceAt(blockTime, 60);
  assert.equal(p?.publishTime, blockTime, "the price is found");
  assert.ok(calls > before, "Hermes was asked again");
});
