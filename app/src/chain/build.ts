/**
 * Live transaction builders: UI arguments (display units) → v0.7 instruction lists. No React and
 * no `@/` imports, so `scripts/simulate-devnet.ts` can build exactly what the app builds and
 * simulate it against the cluster in NEXT_PUBLIC_SOLANA_RPC.
 *
 * ADAPTER: the client is `./v07/client.ts` until @fumpad/sdk v0.7 ships; swapping it in means
 * replacing `fumpadClient` and the `BuiltTx` type here (the builders' arguments stay).
 *
 * The client reads the coin's status and pools from chain and routes through the FUMPAD router
 * (DBC `swap2` on the curve, PartialFill so a buy that completes it doesn't revert; DAMM v2
 * `swap2` after graduation). The slippage bound is never a fresh re-quote (M-9): it is the quote
 * the user saw, minus SLIPPAGE_BPS, so a price that moved against them before signing fails on
 * chain instead of filling at the new price.
 */
import { type Connection, PublicKey } from "@solana/web3.js";
import { baseToTokens, solToLamports, tokensToBase } from "../data/chain";
import { type BuiltTx, FumpadClientV07 } from "./v07/client";

export type { BuiltTx };

/** Slippage applied to the quote the user saw (bps). The UI and the builders share it. */
export const SLIPPAGE_BPS = 200;

/** `amountOut` of the shown quote → the minimum the user accepts, in display units. */
export function minOutFromQuote(amountOut: number, slippageBps = SLIPPAGE_BPS): number {
  return (amountOut * (10_000 - slippageBps)) / 10_000;
}

/** Display tokens → base units, rounded down (a minimum must never round up past the quote). */
export const minTokensBase = (t: number) => {
  const b = tokensToBase(t);
  return baseToTokens(b) > t ? b - BigInt(1) : b;
};
/** Display SOL → lamports, rounded down. */
export const minLamports = (s: number) => {
  const l = solToLamports(s);
  return Number(l) / 1e9 > s ? l - BigInt(1) : l;
};

export type FumpadClient = FumpadClientV07;
export function fumpadClient(connection: Connection): FumpadClient {
  return new FumpadClientV07(connection, { commitment: "confirmed" });
}

/** Router buy for `solIn` (fee included); `minTokensOut` is the shown quote after slippage (display tokens). */
export function buildBuyTx(client: FumpadClient, wallet: PublicKey, a: { mint: string; solIn: number; minTokensOut: number }): Promise<BuiltTx> {
  return client.buildBuy({ user: wallet, mint: new PublicKey(a.mint), lamportsIn: solToLamports(a.solIn), minTokensOut: minTokensBase(a.minTokensOut) });
}

/** Router sell. Any qualifying sell becomes a ticket by keeper attestation afterwards (no ticket work in the transaction). */
export function buildSellTx(client: FumpadClient, wallet: PublicKey, a: { mint: string; tokensIn: number; minSolOut: number }): Promise<BuiltTx> {
  return client.buildSell({ user: wallet, mint: new PublicKey(a.mint), tokensIn: tokensToBase(a.tokensIn), minLamportsOut: minLamports(a.minSolOut) });
}

/** `claim` (pays now or queues), creating the owner's Token-2022 account first if needed. */
export function buildClaimTx(client: FumpadClient, wallet: PublicKey, a: { mint: string; ticket: string }): BuiltTx {
  return client.buildClaim({ owner: wallet, mint: new PublicKey(a.mint), ticket: new PublicKey(a.ticket) });
}

/** D17 `set_auto_claim` on one coin (needs the wallet's Position, i.e. it has a ticket there). */
export function buildSetAutoClaimTx(client: FumpadClient, wallet: PublicKey, a: { mint: string; enabled: boolean }): BuiltTx {
  return client.buildSetAutoClaim({ wallet, mint: new PublicKey(a.mint), enabled: a.enabled });
}

/** `withdraw_creator_fees`: the coin's unclaimed creator fees to the creator (signer must be Coin.creator). */
export function buildWithdrawCreatorFeesTx(client: FumpadClient, wallet: PublicKey, a: { mint: string }): BuiltTx {
  return client.buildWithdrawCreatorFees({ creator: wallet, mint: new PublicKey(a.mint) });
}

/** D16 `withdraw_escrow`: an escrowed payout to the owner's own token account. */
export function buildWithdrawEscrowTx(client: FumpadClient, wallet: PublicKey, a: { mint: string; ticket: string }): Promise<BuiltTx> {
  return client.buildWithdrawEscrow({ owner: wallet, mint: new PublicKey(a.mint), ticket: new PublicKey(a.ticket) });
}
