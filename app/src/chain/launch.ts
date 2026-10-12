/**
 * M-1 (security-review/REPORT.md): bind the API's prepared launch to what the user asked for.
 *
 * The API reserves a `…fmbL` mint and returns `[compute budget…] create_coin [buy]` already
 * signed as that mint; the user's wallet signs as creator and fee payer, silently when Instant
 * trading is on. `checkPreparedLaunch` (shape, fee payer, signers) and the allow-list (programs,
 * summed sol_in) don't tie the pieces together, so a compromised API could launch the user's
 * coin and spend their "first buy" on another coin with no slippage bound
 * (`security-review/app-poc/launch-buy-redirect.test.ts`). This module adds the binding:
 *
 *   - create_coin's mint is the reserved mint, its creator the wallet;
 *   - name, symbol and uri are exactly the form's values;
 *   - the first buy exists iff the user asked for one, targets that same mint, and its
 *     sol_in / min_tokens_out are what the curve gives for the user's amount at a fresh coin
 *     (Global.params, no snipe tax for the creator's bundled buy), within our slippage;
 *   - the mint actually signed (ed25519 over the message; `allowlist.ts`).
 *
 * No React, no `@/` imports: unit-tested by `launch.test.ts` with `npm test`.
 */
import { type FeeParams, inspectLaunchTx, type LaunchTxInfo, quoteCurveBuy, withSlippage } from "@fumpad/sdk";
import { ComputeBudgetProgram, type PublicKey, type VersionedTransaction } from "@solana/web3.js";
import { verifySignature } from "./allowlist";
import { checkPreparedLaunch } from "./program";

/** Slippage the app asks the API to apply to the creator's first buy (bps). */
export const LAUNCH_SLIPPAGE_BPS = 100;

/** The Global.params fields the first-buy quote needs (the SDK's `Params` satisfies it). */
export interface LaunchCurveParams extends FeeParams {
  initialVirtualSol: bigint;
  initialVirtualToken: bigint;
  curveSupply: bigint;
}

export interface FirstBuy {
  /** `buy(sol_in)`: the user's budget minus the 1% fee (charged on top by the program). */
  solIn: bigint;
  tokensOut: bigint;
  /** Lowest `min_tokens_out` we accept (the quote minus LAUNCH_SLIPPAGE_BPS). */
  minTokensOut: bigint;
}

/** What the creator's bundled buy must look like for a budget, exactly as `FumpadClient.buildLaunch` builds it. */
export function expectedFirstBuy(p: LaunchCurveParams, budgetLamports: bigint, slippageBps = LAUNCH_SLIPPAGE_BPS): FirstBuy | null {
  if (budgetLamports <= BigInt(0)) return null;
  const q = quoteCurveBuy({ virtualSol: p.initialVirtualSol, virtualToken: p.initialVirtualToken, realSol: BigInt(0), realToken: p.curveSupply }, p, budgetLamports, 0);
  if (!q || q.tokensOut <= BigInt(0)) return null;
  return { solIn: q.solIn, tokensOut: q.tokensOut, minTokensOut: withSlippage(q.tokensOut, slippageBps) };
}

export interface LaunchIntent {
  wallet: PublicKey;
  /** The reserved mint the API advertised (and showed on the review step). */
  mint: string;
  suffix: string;
  name: string;
  symbol: string;
  uri: string;
  /** The first buy the user typed, lamports (fee included); 0 = none. */
  initialBuyLamports: bigint;
  /** Global.params from the chain; required when there is a first buy. */
  params?: LaunchCurveParams;
}

class LaunchRefused extends Error {
  constructor(why: string) {
    super(`Refusing to sign: ${why}.`);
    this.name = "LaunchRefused";
  }
}
const refuse = (why: string): never => {
  throw new LaunchRefused(why);
};

/** `min_tokens_out` of the bundled buy (`buy(sol_in u64, min_tokens_out u64)` after the 8-byte discriminator). */
function firstBuyMinOut(tx: VersionedTransaction): bigint {
  const m = tx.message;
  const keys = m.staticAccountKeys;
  const fumpad = m.compiledInstructions.filter((ix) => !keys[ix.programIdIndex].equals(ComputeBudgetProgram.programId));
  const d = fumpad[1]?.data;
  if (!d || d.length < 24) refuse("malformed first buy");
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(16, true);
}

/**
 * Throws unless `tx` launches exactly the coin the user reviewed, with exactly the first buy
 * they asked for. Returns the decoded launch for logging / display.
 */
export function checkLaunchBinding(tx: VersionedTransaction, intent: LaunchIntent): LaunchTxInfo {
  checkPreparedLaunch(tx, intent.wallet, intent.mint, intent.suffix);
  let info: LaunchTxInfo;
  try {
    info = inspectLaunchTx(tx);
  } catch (e) {
    return refuse(e instanceof Error ? e.message : "it isn't a FUMPAD launch");
  }
  const wallet = intent.wallet.toBase58();
  if (info.feePayer !== wallet || info.creator !== wallet) refuse("the coin's creator isn't your wallet");
  if (info.mint !== intent.mint) refuse("it launches a different mint than the one you reviewed");
  if (info.name !== intent.name || info.symbol !== intent.symbol || info.uri !== intent.uri) refuse("the coin's name, symbol or metadata differ from what you entered");
  const slot = tx.message.staticAccountKeys.findIndex((k) => k.toBase58() === intent.mint);
  if (!info.signed.includes(intent.mint) || slot < 1 || !verifySignature(tx.signatures[slot], tx.message.serialize(), tx.message.staticAccountKeys[slot]))
    refuse("the reserved mint's signature doesn't match the transaction");

  const wantBuy = intent.initialBuyLamports > BigInt(0);
  if (!wantBuy) {
    if (info.buySolIn !== undefined) refuse("it adds a buy you didn't ask for");
    return info;
  }
  if (info.buySolIn === undefined) refuse("your first buy is missing");
  if (!intent.params) return refuse("couldn't read the launch parameters to check your first buy");
  const want = expectedFirstBuy(intent.params, intent.initialBuyLamports);
  if (!want) return refuse("your first buy is too small");
  // inspectLaunchTx already checked the buy is the creator's, on this mint.
  if (info.buySolIn !== want.solIn || info.buySolIn > intent.initialBuyLamports) refuse("the first buy spends a different amount than you entered");
  const minOut = firstBuyMinOut(tx);
  if (minOut === BigInt(0) || minOut < want.minTokensOut || minOut > want.tokensOut) refuse("the first buy's minimum tokens don't match the quote");
  return info;
}
