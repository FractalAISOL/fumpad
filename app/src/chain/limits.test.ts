/** M-9 / L-8 instant-trading limits and the shown-quote slippage bound. `npm test` */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buyIx, computeBudgetIxs, sellIx, swapBuyIx, fumpadCoder } from "@fumpad/sdk";
import { Keypair } from "@solana/web3.js";
import { bindMinOut, minOutFromQuote, SLIPPAGE_BPS } from "./build";
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
  const user = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const decode = (data: Buffer) => fumpadCoder().instruction.decode(data) as { name: string; data: Record<string, { toString(): string }> };

  it("derives the minimum from the quote the user saw", () => {
    assert.equal(SLIPPAGE_BPS, 200);
    assert.equal(minOutFromQuote(1_000_000), 980_000);
  });

  it("overwrites the SDK's re-quoted bound on buy, swap_buy and sell", () => {
    const fresh = { instructions: [...computeBudgetIxs(200_000), buyIx({ user, mint, solIn: SOL, minTokensOut: BigInt(123), openTickets: [] })] };
    const bound = bindMinOut(fresh, "buy", BigInt(777));
    const ix = decode(bound.instructions[bound.instructions.length - 1].data);
    assert.equal(ix.name, "buy");
    assert.equal(ix.data.min_tokens_out.toString(), "777");
    assert.equal(ix.data.sol_in.toString(), SOL.toString());
    // The input isn't mutated.
    assert.equal(decode(fresh.instructions[fresh.instructions.length - 1].data).data.min_tokens_out.toString(), "123");

    const swap = bindMinOut({ instructions: [swapBuyIx({ user, mint, solIn: SOL, minTokensOut: BigInt(1), openTickets: [], buybackFeeRecipient: user })] }, "buy", BigInt(42));
    assert.equal(decode(swap.instructions[0].data).data.min_tokens_out.toString(), "42");

    const sell = bindMinOut({ instructions: [sellIx({ user, mint, tokensIn: BigInt(5), minSolOut: BigInt(1), nextTicketSeq: BigInt(0) })] }, "sell", BigInt(9_000));
    assert.equal(decode(sell.instructions[0].data).data.min_sol_out.toString(), "9000");
  });

  it("refuses a zero bound or an unexpected shape", () => {
    const one = { instructions: [buyIx({ user, mint, solIn: SOL, minTokensOut: BigInt(1), openTickets: [] })] };
    assert.throws(() => bindMinOut(one, "buy", BigInt(0)), /too small/);
    assert.throws(() => bindMinOut(one, "sell", BigInt(1)), /Unexpected/);
    assert.throws(() => bindMinOut({ instructions: [...one.instructions, ...one.instructions] }, "buy", BigInt(1)), /Unexpected/);
  });
});
