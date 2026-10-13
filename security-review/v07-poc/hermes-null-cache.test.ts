/**
 * PoC V7-M5: a transient Hermes 404 (e.g. the historical endpoint asked for a second it hasn't indexed yet)
 * is cached as "no price" forever (pyth.ts:58-61, and again in derive's long-lived priceCache), so the sell
 * gets `oracle_unavailable` from this keeper for the rest of the process's life. Keepers attest within
 * seconds of finalization, i.e. exactly when such gaps are likeliest; if 2 of 3 cache a null, the honest
 * sell is never attested. (Separately: which of the several updates sharing one publish_time second Hermes
 * returns is UNVERIFIED — a cross-keeper determinism risk, see report.)
 *
 * Run (from services/):  node --import tsx --test ../security-review/v07-poc/hermes-null-cache.test.ts
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { HermesPythSource, PYTH_SOL_USD_FEED_ID } from "../../services/engine/src/index.ts";

it("first answer 404, later 200: the source still says null", async () => {
  let calls = 0;
  const available = new Set<number>();
  const fetchImpl = (async (url: string) => {
    calls++;
    const t = Number(/price\/(\d+)/.exec(url)![1]);
    if (!available.has(t)) return new Response("not found", { status: 404 });
    return Response.json({ parsed: [{ id: PYTH_SOL_USD_FEED_ID, price: { price: "15000000000", conf: "1000000", expo: -8, publish_time: t } }] });
  }) as typeof fetch;
  const src = new HermesPythSource({ fetchImpl });
  const blockTime = 1_800_000_000;
  assert.equal(await src.priceAt(blockTime, 60), null); // Hermes not caught up yet
  for (let t = blockTime - 60; t <= blockTime; t++) available.add(t); // now it has the data
  const before = calls;
  assert.equal(await src.priceAt(blockTime, 60), null, "still null: 404s were cached");
  assert.equal(calls, before, "and Hermes is never asked again");
});
