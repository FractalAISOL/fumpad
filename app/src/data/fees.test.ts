import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { coinFeeView } from "./fees";

const params = { feeBps: 125, snipeStartBps: 9_900, snipeWindowSlots: 8, venueFeeShareBps: 2_000, feePoolShareBps: 5_000, feePlatformShareBps: 3_000, feeCreatorShareBps: 2_000 };

describe("coinFeeView (the coin's real fee, INTERFACE §5.9)", () => {
  it("standard coin: the protocol fee and the 50/30/20 split (also when the API predates `fees`)", () => {
    for (const fees of [undefined, { feeBps: 125, migratedFeeBps: 125, snipeStartBps: 9_900, snipeWindowSlots: 8, policy: "standard" as const }]) {
      const v = coinFeeView(params, { status: "curve", fees });
      assert.equal(v.feeBps, 125);
      assert.deepEqual(v.parts.map((p) => p.share), [50, 30, 20]);
      assert.equal(v.wallet, undefined);
    }
  });
  it("first-coin config: 3% on the curve and on DAMM v2, 99% → 3% over 25 slots, FUMPAD's 2.4% split 1.0 pool / 1.4 wallet", () => {
    const fees = { feeBps: 300, migratedFeeBps: 300, snipeStartBps: 9_900, snipeWindowSlots: 25, policy: "wallet_split" as const, poolShareBps: 100, walletShareBps: 140, wallet: "7eXGbgwMg8dArQVcvfuYKE2nkt7vn97HdMvmDfvSjFa3" };
    const v = coinFeeView(params, { status: "curve", fees });
    assert.equal(v.feeBps, 300);
    assert.equal(v.snipeWindowSlots, 25);
    assert.deepEqual(v.parts.map((p) => p.label), ["pool", "fee wallet"]);
    assert.ok(Math.abs(v.parts[0].share - 100 / 2.4) < 1e-9 && Math.abs(v.parts[1].share - 140 / 2.4) < 1e-9);
    assert.deepEqual(v.wallet, { address: fees.wallet, poolPctOfVolume: 1, walletPctOfVolume: 1.4 });
    assert.equal(coinFeeView(params, { status: "graduated", fees: { ...fees, migratedFeeBps: 250 } }).feeBps, 250);
  });
});
