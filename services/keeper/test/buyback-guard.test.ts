// L5 (off-chain part): the pre-graduation buyback guard uses a TWAP of the keeper's own last N spot
// observations (a single pushed sample no longer moves it) and buybacks run at randomized times.
import { describe, expect, it } from "vitest";

import { nextBuybackDelayMs, observeSpot, type SpotObservation, spotTwapQ64, withinBand } from "../src/keeper.js";

const P = 1n << 60n;

describe("pre-grad spot TWAP", () => {
  const ring = (vals: bigint[], spacing = 15n, t0 = 1_000n): SpotObservation[] => vals.map((q64, i) => ({ ts: t0 + BigInt(i) * spacing, q64 }));

  it("needs N observations and no gap", () => {
    expect(spotTwapQ64(ring([P, P, P]), 1_045n, 4, 60)).toBeNull();
    expect(spotTwapQ64(ring([P, P, P, P]), 1_060n, 4, 60)).toBe(P);
    expect(spotTwapQ64(ring([P, P, P, P]), 1_000n + 45n + 61n, 4, 60)).toBeNull(); // newest is stale
  });

  it("a spot pushed +3% just before the buyback barely moves the TWAP: the guard refuses it", () => {
    const obs = ring([P, P, P, P, P, P, P]);
    const pushed = (P * 103n) / 100n;
    const all = observeSpot(obs, { ts: 1_000n + 7n * 15n, q64: pushed }, 15, 8);
    const twap = spotTwapQ64(all, 1_000n + 7n * 15n + 1n, 8, 60)!;
    expect(withinBand(twap, P, 50)).toBe(true); // TWAP stays ≈ the honest price
    // a push to the edge of a 3% band around the old single sample is outside a 1% band around the TWAP
    expect(withinBand(pushed, twap, 100)).toBe(false);
  });

  it("observations are spaced and the ring is bounded", () => {
    let o: SpotObservation[] = [];
    for (let t = 0n; t < 300n; t += 5n) o = observeSpot(o, { ts: t, q64: P }, 15, 8);
    expect(o).toHaveLength(8);
    for (let i = 1; i < o.length; i++) expect(o[i].ts - o[i - 1].ts >= 15n).toBe(true);
  });
});

describe("randomized buyback timing", () => {
  it("interval × (1 + U[0, jitter))", () => {
    expect(nextBuybackDelayMs(60, 1, () => 0)).toBe(60_000);
    expect(nextBuybackDelayMs(60, 1, () => 0.999)).toBe(119_940);
    const seen = new Set(Array.from({ length: 50 }, () => nextBuybackDelayMs(60, 1)));
    expect(seen.size).toBeGreaterThan(10);
    for (const d of seen) expect(d >= 60_000 && d < 120_000).toBe(true);
  });
});
