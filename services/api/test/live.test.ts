import { describe, expect, it } from "vitest";

import type { CoinDetail, LiveMessage } from "../src/generated/app-types.js";
import { LiveHub } from "../src/live.js";

const coin = { mint: "M1", symbol: "AAA", price: 2 } as unknown as CoinDetail;

function hub(invalidated: unknown[][] = []) {
  return new LiveHub(
    "postgres://unused",
    {
      feed: async (id) => (id === "f1" ? ({ id: "f1", kind: "launch" } as never) : null),
      coin: async (mint, sigs) => (mint === "M1" ? { coin, trades: (sigs ?? []).map((signature) => ({ signature }) as never), points: sigs ? [{ t: 1000, p: 2 }] : [] } : null),
    },
    (mints, wallets) => invalidated.push([mints, wallets]),
    { warn: () => {} },
    { coalesceMs: 0 },
  );
}

describe("LiveHub", () => {
  it("fans a coins notification out as coins + one coin message per resolvable mint", async () => {
    const inv: unknown[][] = [];
    const h = hub(inv);
    const got: LiveMessage[] = [];
    h.subscribe((m) => got.push(m));
    await h.handle(JSON.stringify({ type: "coins", mints: ["M1", "M2"], wallets: ["W1"], sig: "S1" }));
    expect(inv[0]).toEqual([["M1", "M2"], ["W1"]]);
    expect(got[0]).toEqual({ type: "coins", mints: ["M1", "M2"], wallets: ["W1"] });
    expect(got).toHaveLength(2);
    expect(got[1]).toMatchObject({ type: "coin", coin: { mint: "M1" }, trades: [{ signature: "S1" }], points: [{ t: 1000, p: 2 }] });
  });

  it("skips per-coin lookups without subscribers and accepts old payloads without wallets/sig", async () => {
    let calls = 0;
    const h = new LiveHub("x", { feed: async () => null, coin: async () => (calls++, null) }, () => {}, { warn: () => {} }, { coalesceMs: 0 });
    await h.handle(JSON.stringify({ type: "coins", mints: ["M1"] }));
    expect(calls).toBe(0);
    const got: LiveMessage[] = [];
    h.subscribe((m) => got.push(m));
    await h.handle(JSON.stringify({ type: "coins", mints: ["M1"] }));
    expect(got).toEqual([{ type: "coins", mints: ["M1"], wallets: [] }]);
  });

  it("resolves feed ids and forwards params", async () => {
    const h = hub();
    const got: LiveMessage[] = [];
    h.subscribe((m) => got.push(m));
    await h.handle(JSON.stringify({ type: "feed", id: "f1" }));
    await h.handle(JSON.stringify({ type: "feed", id: "nope" }));
    await h.handle(JSON.stringify({ type: "params" }));
    expect(got.map((m) => m.type)).toEqual(["feed", "params"]);
  });

  it("coalesces a burst: invalidates per notification, one coins + one coin message per mint per window", async () => {
    const inv: unknown[][] = [];
    const calls: [string, string[] | undefined][] = [];
    const h = new LiveHub(
      "x",
      {
        feed: async () => null,
        coin: async (mint, sigs) => (calls.push([mint, sigs]), { coin: { mint } as never, trades: (sigs ?? []).map((signature) => ({ signature }) as never), points: [] }),
      },
      (mints, wallets) => inv.push([mints, wallets]),
      { warn: () => {} },
      { coalesceMs: 30 },
    );
    const got: { m: LiveMessage; json: string }[] = [];
    h.subscribe((m, json) => got.push({ m, json }));
    for (let i = 0; i < 20; i++) await h.handle(JSON.stringify({ type: "coins", mints: [i % 2 ? "A" : "B"], wallets: [`W${i % 3}`], sig: `S${i}` }));
    expect(inv).toHaveLength(20); // REST cache is never stale
    expect(got).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 80));
    expect(got.map((g) => g.m.type)).toEqual(["coins", "coin", "coin"]);
    expect(got[0].m).toEqual({ type: "coins", mints: ["B", "A"], wallets: ["W0", "W1", "W2"] });
    expect(calls).toEqual([
      ["B", ["S0", "S2", "S4", "S6", "S8", "S10", "S12", "S14", "S16", "S18"]],
      ["A", ["S1", "S3", "S5", "S7", "S9", "S11", "S13", "S15", "S17", "S19"]],
    ]);
    expect(JSON.parse(got[1].json)).toEqual(got[1].m); // serialized once, shared by every client
    expect(h.stats.flushes).toBe(1);
    await h.stop();
  });

  it("caps coin lookups per flush and keeps going when one fails", async () => {
    const h = new LiveHub(
      "x",
      { feed: async () => null, coin: async (mint) => (mint === "bad" ? Promise.reject(new Error("boom")) : { coin: { mint } as never, trades: [], points: [] }) },
      () => {},
      { warn: () => {} },
      { coalesceMs: 0, maxCoinsPerFlush: 2 },
    );
    const got: LiveMessage[] = [];
    h.subscribe((m) => got.push(m));
    await h.handle(JSON.stringify({ type: "coins", mints: ["bad", "ok", "skipped"], sig: "S" }));
    expect(got.map((m) => m.type)).toEqual(["coins", "coin"]);
    expect(h.stats.droppedCoins).toBe(1);
  });
});
