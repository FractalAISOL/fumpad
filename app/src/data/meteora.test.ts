/**
 * Meteora quote math (display units).
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PARAMS } from "./chain";
import { curveReservesAt, feeBpsAtSlot, quoteBuy, quoteSell, splitFee } from "./meteora";

const close = (a: number, b: number, rel = 1e-9) => assert.ok(Math.abs(a - b) <= rel * Math.max(1, Math.abs(b)), `${a} ≉ ${b}`);

describe("feeBpsAtSlot (DBC linear scheduler, D33)", () => {
  it("runs 99% → 1.25% over 8 slots, as measured on devnet (spike §5)", () => {
    const at = (d: number) => feeBpsAtSlot(PARAMS, d);
    assert.equal(at(0), 9_900);
    close(at(7), 1_346.875); // 13.47%: the devnet probe at offset 7
    assert.equal(at(8), 125);
    assert.equal(at(100), 125);
    for (let d = 1; d < 8; d++) assert.ok(at(d) < at(d - 1));
  });
  it("is the normal fee when the window is off", () => {
    assert.equal(feeBpsAtSlot({ feeBps: 125, snipeStartBps: 0, snipeWindowSlots: 8 }, 0), 125);
    assert.equal(feeBpsAtSlot({ feeBps: 125, snipeStartBps: 9_900, snipeWindowSlots: 0 }, 0), 125);
  });
});

describe("quoteBuy / quoteSell", () => {
  const fresh = curveReservesAt(PARAMS.initialVirtualSol, PARAMS.initialVirtualTokens, 0);

  it("starts the curve at MC ≈ 30.39 SOL and ends it at the 85 SOL raise with the curve supply sold", () => {
    close((fresh.sol / fresh.tokens) * PARAMS.totalSupply, 30.389, 1e-4);
    const end = curveReservesAt(PARAMS.initialVirtualSol, PARAMS.initialVirtualTokens, PARAMS.graduationSol);
    close(fresh.tokens - end.tokens, PARAMS.curveSupply, 1e-9);
  });

  it("takes the fee from the input on buys", () => {
    const q = quoteBuy(fresh, 1, 125);
    close(q.feeSol, 0.0125);
    close(q.amountOut, (fresh.tokens * 0.9875) / (fresh.sol + 0.9875));
    assert.equal(q.completesCurve, false);
    assert.equal(q.amountIn, 1);
  });

  it("partially fills a buy that would pass the curve's end (PartialFill)", () => {
    const left = 1_000_000;
    const q = quoteBuy(fresh, 50, 125, left);
    assert.equal(q.completesCurve, true);
    assert.equal(q.amountOut, left);
    assert.ok(q.amountIn < 50);
    // The used input buys exactly what is left.
    const back = quoteBuy(fresh, q.amountIn, 125);
    close(back.amountOut, left, 1e-9);
  });

  it("takes the fee from the output on sells", () => {
    const q = quoteSell(fresh, 1_000_000, 125);
    const gross = (fresh.sol * 1_000_000) / (fresh.tokens + 1_000_000);
    close(q.feeSol, gross * 0.0125);
    close(q.amountOut, gross * 0.9875);
  });

  it("splits a fee: Meteora 20%, then 50/30/20 of FUMPAD's share", () => {
    const sp = splitFee(1.25, PARAMS);
    close(sp.venue, 0.25);
    close(sp.pool, 0.5);
    close(sp.platform, 0.3);
    close(sp.creator, 0.2);
  });
});
