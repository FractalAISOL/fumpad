/**
 * Live transaction builders: UI arguments (display units) → `@fumpad/sdk` instruction
 * lists. No React and no `@/` imports, so `scripts/simulate-devnet.ts` can build exactly
 * what the app builds and simulate it against the cluster in NEXT_PUBLIC_SOLANA_RPC.
 *
 * The SDK reads the chain for everything the program checks (coin status → curve vs
 * PumpSwap route, open tickets for the rebuy rule, next ticket seq, pool reserves,
 * buyback fee recipient) and routes and sizes the instruction from on-chain state. The
 * slippage bound is NOT the SDK's fresh re-quote (M-9): it comes from the quote the user
 * saw, minus SLIPPAGE_BPS, so a price that moved against them before signing fails on chain
 * instead of filling at the new price.
 */
import { type BuiltTx, FumpadClient } from "@fumpad/sdk";
import { type Connection, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { baseToTokens, solToLamports, tokensToBase } from "../data/chain";
import { FUMPAD_USER_IXS } from "./allowlist";
import { FUMPAD_PROGRAM_ID } from "./program";

/** Slippage applied to the quote the user saw (bps). The UI and the builders share it. */
export const SLIPPAGE_BPS = 200;

/** `amountOut` of the shown quote → the minimum the user accepts, in display units. */
export function minOutFromQuote(amountOut: number, slippageBps = SLIPPAGE_BPS): number {
  return (amountOut * (10_000 - slippageBps)) / 10_000;
}

const TRADE_IXS = { buy: ["buy", "swap_buy"], sell: ["sell", "swap_sell"] } as const;

/**
 * Replace the slippage bound (`min_tokens_out` / `min_sol_out`, the second u64 after the
 * discriminator in all four trade instructions) with `minOut`. Exactly one trade instruction
 * must be present.
 */
export function bindMinOut(built: BuiltTx, side: "buy" | "sell", minOut: bigint): BuiltTx {
  if (minOut <= BigInt(0)) throw new Error("The quote is too small to trade.");
  let n = 0;
  const instructions = built.instructions.map((ix: TransactionInstruction) => {
    if (!ix.programId.equals(FUMPAD_PROGRAM_ID)) return ix;
    const isTrade = TRADE_IXS[side].some((name) => FUMPAD_USER_IXS[name].every((b, i) => ix.data[i] === b));
    if (!isTrade) return ix;
    if (ix.data.length < 24) throw new Error("Malformed trade instruction.");
    n++;
    const data = Buffer.from(ix.data);
    data.writeBigUInt64LE(minOut, 16);
    return { ...ix, data } as TransactionInstruction;
  });
  if (n !== 1) throw new Error("Unexpected trade transaction.");
  return { ...built, instructions };
}

/** Display tokens → base units, rounded down (a minimum must never round up past the quote). */
const minTokensBase = (t: number) => {
  const b = tokensToBase(t);
  return baseToTokens(b) > t ? b - BigInt(1) : b;
};
/** Display SOL → lamports, rounded down. */
const minLamports = (s: number) => {
  const l = solToLamports(s);
  return Number(l) / 1e9 > s ? l - BigInt(1) : l;
};

export function fumpadClient(connection: Connection, opts: { solUsdAccount?: string } = {}): FumpadClient {
  return new FumpadClient(connection, {
    commitment: "confirmed",
    solUsdAccount: opts.solUsdAccount ? new PublicKey(opts.solUsdAccount) : undefined,
  });
}

/**
 * Curve `buy` or post-graduation `swap_buy`, with every open ticket for the rebuy rule.
 * `minTokensOut` is the shown quote after slippage (display tokens); the app always passes it.
 * Without it (devnet scripts, no UI quote) the SDK's own quote − SLIPPAGE_BPS stands.
 */
export async function buildBuyTx(client: FumpadClient, wallet: PublicKey, a: { mint: string; solIn: number; minTokensOut?: number }): Promise<BuiltTx> {
  const built = await client.buildBuy({ user: wallet, mint: new PublicKey(a.mint), budgetLamports: solToLamports(a.solIn), slippageBps: SLIPPAGE_BPS });
  return a.minTokensOut === undefined ? built : bindMinOut(built, "buy", minTokensBase(a.minTokensOut));
}

/** Curve `sell` or `swap_sell`; files a ticket when the program's $50 check passes. `minSolOut`: the shown quote after slippage. */
export async function buildSellTx(client: FumpadClient, wallet: PublicKey, a: { mint: string; tokensIn: number; minSolOut?: number }): Promise<BuiltTx> {
  const built = await client.buildSell({ user: wallet, mint: new PublicKey(a.mint), tokensIn: tokensToBase(a.tokensIn), slippageBps: SLIPPAGE_BPS });
  return a.minSolOut === undefined ? built : bindMinOut(built, "sell", minLamports(a.minSolOut));
}

/** `claim` (pays now or queues), creating the owner's Token-2022 ATA first if needed. */
export function buildClaimTx(client: FumpadClient, wallet: PublicKey, a: { mint: string; ticket: string }): BuiltTx {
  return client.buildClaim({ owner: wallet, mint: new PublicKey(a.mint), ticket: new PublicKey(a.ticket) });
}

/** D17 `set_auto_claim` on one coin (needs the wallet's Position, i.e. it has traded). */
export function buildSetAutoClaimTx(client: FumpadClient, wallet: PublicKey, a: { mint: string; enabled: boolean }): BuiltTx {
  return client.buildSetAutoClaim({ wallet, mint: new PublicKey(a.mint), enabled: a.enabled });
}

/** `withdraw_creator_fees`: the coin's unclaimed creator fees to the creator (signer must be Coin.creator). */
export function buildWithdrawCreatorFeesTx(client: FumpadClient, wallet: PublicKey, a: { mint: string }): BuiltTx {
  return client.buildWithdrawCreatorFees({ creator: wallet, mint: new PublicKey(a.mint) });
}
