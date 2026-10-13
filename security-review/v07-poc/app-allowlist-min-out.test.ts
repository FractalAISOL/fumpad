/**
 * PoC V7-M3 (app): the silent-signing allow-list never bounds the router's `min_out`.
 *
 * allowlist.ts vetRouterTrade checks data length, swap mode and amount_in > 0 (and buys ≤ the typed SOL),
 * but not bytes 16..24 (`min_out`). The app computes min_out from `GET /v1/quote` (data/api.ts:259 ->
 * TradePanel.tsx:109 minOutFromQuote(quote.amountOut)), i.e. from the API. A compromised/malicious API
 * returns a low `amountOut` (or 0) and the embedded wallet silently signs a buy/sell with no effective
 * slippage bound; whoever controls the API (or anyone watching for such txs) sandwiches it for up to the
 * whole trade value. The allow-list's stated purpose is to stop exactly "a builder or API gone wrong".
 *
 * Run (from app/):  node --import tsx --test ../security-review/v07-poc/app-allowlist-min-out.test.ts
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { Keypair, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

import { vetFumpadTx } from "../../app/src/chain/allowlist";
import { coinAta, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT, wsolAta } from "../../app/src/chain/v07/ids";
import { computeBudgetIxs, createAtaIdempotentIx, dbcSwapAccounts, routerBuyIx, routerSellIx, unwrapSolIx, wrapSolIxs } from "../../app/src/chain/v07/ix";

const wallet = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const config = Keypair.generate().publicKey;
const SOL = BigInt(1_000_000_000);
const tx = (ixs: ReturnType<typeof routerSellIx>[]) =>
  new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: "11111111111111111111111111111111", instructions: ixs }).compileToV0Message());

it("sell of the whole bag with min_out = 0 is signed silently", () => {
  const sell = routerSellIx({ trader: wallet, mint, venue: "dbc", swapAccounts: dbcSwapAccounts({ trader: wallet, mint, config, side: "sell" }), amountIn: BigInt(50_000_000) * BigInt(1_000_000), minOut: BigInt(0) });
  const t = tx([...computeBudgetIxs(200_000), createAtaIdempotentIx(wallet, wallet, WSOL_MINT, TOKEN_PROGRAM_ID, wsolAta(wallet)), sell, unwrapSolIx(wallet)]);
  assert.doesNotThrow(() => vetFumpadTx(t, wallet, { action: "sell", mint: mint.toBase58() }));
});

it("5 SOL buy with min_out = 0 is signed silently (only amount_in is bounded)", () => {
  const lamports = BigInt(5) * SOL;
  const buy = routerBuyIx({ trader: wallet, mint, venue: "dbc", swapAccounts: dbcSwapAccounts({ trader: wallet, mint, config, side: "buy" }), amountIn: lamports, minOut: BigInt(0) });
  const t = tx([...computeBudgetIxs(200_000), createAtaIdempotentIx(wallet, wallet, mint, TOKEN_2022_PROGRAM_ID, coinAta(wallet, mint)), ...wrapSolIxs(wallet, lamports), buy, unwrapSolIx(wallet)]);
  assert.doesNotThrow(() => vetFumpadTx(t, wallet, { action: "buy", mint: mint.toBase58(), maxSolInLamports: lamports }));
});
