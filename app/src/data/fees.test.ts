import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { coinFeeView, launchWindowGuard } from "./fees";

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

describe("launchWindowGuard (APP-3: quick-buy never pays the launch-window fee silently)", () => {
  const NOW = 1_800_000_000_000;
  const old = { status: "curve", createdAt: NOW - 3_600_000 };
  it("asks when the quote is in the window above the standard fee (up to 99%)", () => {
    assert.deepEqual(launchWindowGuard({ snipeTaxBps: 9_900, snipeTaxSol: 0.098 }, old, params, NOW), { bps: 9_900, extraSol: 0.098, byAge: false });
    assert.deepEqual(launchWindowGuard({ snipeTaxBps: 126 }, old, params, NOW), { bps: 126, extraSol: undefined, byAge: false });
  });
  it("doesn't ask for the standard fee, or for an old coin whose quote has no window", () => {
    assert.equal(launchWindowGuard({}, old, params, NOW), null);
    assert.equal(launchWindowGuard({ snipeTaxBps: 125 }, old, params, NOW), null);
    assert.equal(launchWindowGuard({}, { status: "graduated", createdAt: NOW - 1_000 }, params, NOW), null);
  });
  it("fails safe: a coin seconds old on its curve asks even when the quote says nothing about the window", () => {
    assert.deepEqual(launchWindowGuard({}, { status: "curve", createdAt: NOW - 2_000 }, params, NOW), { bps: 9_900, byAge: true });
    // 8 slots × 0.4 s + 15 s of slack
    assert.notEqual(launchWindowGuard({}, { status: "curve", createdAt: NOW - 18_000 }, params, NOW), null);
    assert.equal(launchWindowGuard({}, { status: "curve", createdAt: NOW - 18_300 }, params, NOW), null);
  });
});
