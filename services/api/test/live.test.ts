import { describe, expect, it } from "vitest";

import type { CoinDetail, LiveMessage } from "../src/generated/app-types.js";
import { LiveHub } from "../src/live.js";

const coin = { mint: "M1", symbol: "AAA", price: 2 } as unknown as CoinDetail;

function hub(invalidated: unknown[][] = []) {
  return new LiveHub(
    "postgres://unused",
    {
      feed: async (id) => (id === "f1" ? ({ id: "f1", kind: "launch" } as never) : null),
      coin: async (mint, sig) => (mint === "M1" ? { coin, trades: sig ? [{ signature: sig } as never] : [], points: sig ? [{ t: 1000, p: 2 }] : [] } : null),
    },
    (mints, wallets) => invalidated.push([mints, wallets]),
    { warn: () => {} },
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
    const h = new LiveHub("x", { feed: async () => null, coin: async () => (calls++, null) }, () => {}, { warn: () => {} });
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
});
