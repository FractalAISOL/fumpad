/** M-9 / L-8 instant-trading limits and the shown-quote slippage bound. `npm test` */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair } from "@solana/web3.js";
import { minLamports, minOutFromQuote, minTokensBase, SLIPPAGE_BPS } from "./build";
import { dbcSwapAccounts, routerBuyIx } from "./v07/ix";
import { FIRST_TIME_RENT, instantDecision, LAUNCH_RENT, solLamports, worstCaseSpend } from "./limits";

const SOL = BigInt(1_000_000_000);
const limits = { maxSol: 1, sessionCapSol: 5 };

describe("instant limits", () => {
  it("counts first-time rent and fees against the per-trade limit", () => {
    // A 0.99 SOL buy fits the typed amount but not with rent and the priority-fee cap on top.
    const spend = worstCaseSpend("buy", solLamports(0.99));
    assert.ok(spend > solLamports(0.99) + FIRST_TIME_RENT);
    assert.deepEqual(instantDecision(spend, BigInt(0), limits), { ask: true, reason: "trade-limit" });
    assert.deepEqual(instantDecision(solLamports(0.5), BigInt(0), limits), { ask: false });
    assert.ok(worstCaseSpend("launch", BigInt(0)) >= LAUNCH_RENT);
  });

  it("asks for every trade once the session cap is reached (L-8)", () => {
    assert.deepEqual(instantDecision(solLamports(0.5), solLamports(4.6), limits), { ask: true, reason: "session-cap" });
    assert.deepEqual(instantDecision(solLamports(0.5), solLamports(4.5), limits), { ask: false });
    // At the cap even a sell (negative outflow) or a claim asks.
    assert.deepEqual(instantDecision(-solLamports(2), solLamports(5), limits), { ask: true, reason: "session-cap" });
    assert.deepEqual(instantDecision(BigInt(5_000), solLamports(6), limits), { ask: true, reason: "session-cap" });
    assert.deepEqual(instantDecision(-solLamports(2), BigInt(0), limits), { ask: false });
  });
});

describe("slippage from the shown quote (M-9)", () => {
  it("derives the minimum from the quote the user saw", () => {
    assert.equal(SLIPPAGE_BPS, 200);
    assert.equal(minOutFromQuote(1_000_000), 980_000);
  });

  it("never rounds a minimum up past the quote", () => {
    assert.equal(minTokensBase(1.0000004), BigInt(1_000_000));
    assert.equal(minTokensBase(2.5), BigInt(2_500_000));
    assert.equal(minLamports(0.0000000014), BigInt(1));
    assert.equal(minLamports(1), BigInt(1_000_000_000));
  });

  it("puts the shown quote's minimum into the router instruction, untouched (no SDK re-quote)", () => {
    const user = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const ix = routerBuyIx({ trader: user, mint, venue: "dbc", swapAccounts: dbcSwapAccounts({ trader: user, mint, config: mint, side: "buy" }), amountIn: SOL, minOut: BigInt(777) });
    assert.equal(ix.data.readBigUInt64LE(8), SOL);
    assert.equal(ix.data.readBigUInt64LE(16), BigInt(777));
    assert.equal(ix.data[24], 1); // PartialFill on the curve
  });
});
