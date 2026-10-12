/**
 * Live transaction builders: UI arguments (display units) → `@fumpad/sdk` instruction
 * lists. No React and no `@/` imports, so `scripts/simulate-devnet.ts` can build exactly
 * what the app builds and simulate it against the cluster in NEXT_PUBLIC_SOLANA_RPC.
 *
 * The SDK reads the chain for everything the program checks (coin status → curve vs
 * PumpSwap route, open tickets for the rebuy rule, next ticket seq, pool reserves,
 * buyback fee recipient) and recomputes the quote from on-chain state; the UI's own quote
 * (from the API) is for display only.
 */
import { type BuiltTx, FumpadClient } from "@fumpad/sdk";
import { type Connection, PublicKey } from "@solana/web3.js";
import { solToLamports, tokensToBase } from "../data/chain";

/** Matches the trade panel's `amountOut * 0.98`. */
export const SLIPPAGE_BPS = 200;

export function fumpadClient(connection: Connection, opts: { solUsdAccount?: string } = {}): FumpadClient {
  return new FumpadClient(connection, {
    commitment: "confirmed",
    solUsdAccount: opts.solUsdAccount ? new PublicKey(opts.solUsdAccount) : undefined,
  });
}

/** Curve `buy` or post-graduation `swap_buy`, with every open ticket for the rebuy rule. */
export function buildBuyTx(client: FumpadClient, wallet: PublicKey, a: { mint: string; solIn: number }): Promise<BuiltTx> {
  return client.buildBuy({ user: wallet, mint: new PublicKey(a.mint), budgetLamports: solToLamports(a.solIn), slippageBps: SLIPPAGE_BPS });
}

/** Curve `sell` or `swap_sell`; files a ticket when the program's $50 check passes. */
export function buildSellTx(client: FumpadClient, wallet: PublicKey, a: { mint: string; tokensIn: number }): Promise<BuiltTx> {
  return client.buildSell({ user: wallet, mint: new PublicKey(a.mint), tokensIn: tokensToBase(a.tokensIn), slippageBps: SLIPPAGE_BPS });
}

/** `claim` (pays now or queues), creating the owner's Token-2022 ATA first if needed. */
export function buildClaimTx(client: FumpadClient, wallet: PublicKey, a: { mint: string; ticket: string }): BuiltTx {
  return client.buildClaim({ owner: wallet, mint: new PublicKey(a.mint), ticket: new PublicKey(a.ticket) });
}

/** D17 `set_auto_claim` on one coin (needs the wallet's Position, i.e. it has traded). */
export function buildSetAutoClaimTx(client: FumpadClient, wallet: PublicKey, a: { mint: string; enabled: boolean }): BuiltTx {
  return client.buildSetAutoClaim({ wallet, mint: new PublicKey(a.mint), enabled: a.enabled });
}
