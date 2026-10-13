/**
 * PoC V7-M3 (app): the silent-signing allow-list never bounded the router's `min_out`.
 *
 * The app took min_out from `GET /v1/quote` (data/api.ts -> TradePanel.tsx minOutFromQuote(quote.amountOut)),
 * i.e. from the API: a compromised API returning a low `amountOut` (or 0) made the embedded wallet silently
 * sign a buy/sell with no effective slippage bound (sandwichable for up to the whole trade value).
 *
 * FIXED (asserted below): `SilentPolicy` now carries the trade's exact `amountIn` and a `minOut` floor that
 * the app computes from its OWN quote of the pool accounts over its RPC (`app/src/chain/build.ts`
 * prepareBuy / prepareSell: quote × (1 − MAX_SLIPPAGE_BPS), refusing a lower shown minimum before
 * anything is built), and the allow-list refuses a router instruction whose min_out is below that floor,
 * whose amount differs, or a trade policy without the bounds.
 *
 * Run (from app/, deps resolved from app/node_modules):  node --import tsx --test ../security-review/v07-poc/app-allowlist-min-out.test.ts
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { Keypair, type TransactionInstruction, TransactionMessage, VersionedTransaction } from "../../app/node_modules/@solana/web3.js/lib/index.cjs.js";
import { computeBudgetIxs, createAtaIdempotentIx, routerBuyIx, routerSellIx, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unwrapSolIx, WSOL_MINT, wrapSolIxs } from "../../app/node_modules/@fumpad/sdk/dist/index.js";

import { SilentSignRefused, vetFumpadTx } from "../../app/src/chain/allowlist";

const wallet = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const config = Keypair.generate().publicKey;
const SOL = BigInt(1_000_000_000);
const coin = { mint, dbcConfig: config };
const tx = (ixs: TransactionInstruction[]) =>
  new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: "11111111111111111111111111111111", instructions: ixs }).compileToV0Message());
const refused = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof SilentSignRefused);
/** What the app's own quote of the trade allows at worst (any positive floor). */
const FLOOR = BigInt(1_000_000);

it("sell of the whole bag with min_out = 0 is refused", () => {
  const amountIn = BigInt(50_000_000) * BigInt(1_000_000);
  const sell = routerSellIx({ trader: wallet, coin, venue: "dbc", amountIn, minOut: BigInt(0) });
  const t = tx([...computeBudgetIxs(200_000), createAtaIdempotentIx(wallet, wallet, WSOL_MINT, TOKEN_PROGRAM_ID), sell, unwrapSolIx(wallet)]);
  // The old policy shape (no bounds) and the new one (the app's floor) both refuse it.
  refused(() => vetFumpadTx(t, wallet, { action: "sell", mint: mint.toBase58() }));
  refused(() => vetFumpadTx(t, wallet, { action: "sell", mint: mint.toBase58(), amountIn, minOut: FLOOR }));
});

it("5 SOL buy with min_out = 0 is refused (amount_in and min_out are both bounded)", () => {
  const lamports = BigInt(5) * SOL;
  const buy = routerBuyIx({ trader: wallet, coin, venue: "dbc", amountIn: lamports, minOut: BigInt(0), mode: 1 });
  const t = tx([...computeBudgetIxs(200_000), createAtaIdempotentIx(wallet, wallet, mint, TOKEN_2022_PROGRAM_ID), ...wrapSolIxs(wallet, lamports), buy, unwrapSolIx(wallet)]);
  refused(() => vetFumpadTx(t, wallet, { action: "buy", mint: mint.toBase58(), maxSolInLamports: lamports }));
  refused(() => vetFumpadTx(t, wallet, { action: "buy", mint: mint.toBase58(), maxSolInLamports: lamports, amountIn: lamports, minOut: FLOOR }));
  // The same buy with a real minimum passes: the bound is what's enforced, not trading itself.
  const ok = routerBuyIx({ trader: wallet, coin, venue: "dbc", amountIn: lamports, minOut: FLOOR, mode: 1 });
  vetFumpadTx(
    tx([...computeBudgetIxs(200_000), createAtaIdempotentIx(wallet, wallet, mint, TOKEN_2022_PROGRAM_ID), ...wrapSolIxs(wallet, lamports), ok, unwrapSolIx(wallet)]),
    wallet,
    { action: "buy", mint: mint.toBase58(), maxSolInLamports: lamports, amountIn: lamports, minOut: FLOOR },
  );
});
