/**
 * M-1 (security-review/REPORT.md): bind the API's prepared launch to what the user asked for.
 *
 * v0.7 (SPEC-v0.7 §2): the API reserves a `…fmbL` mint and returns
 *
 *   [CB] [wrap SOL] · DBC initialize_virtual_pool_with_token2022 · [ATA(coin) · DBC swap2 (the
 *   creator's top-level first buy, at the min fee)] · fumpad.register_coin · [close WSOL]
 *
 * (@fumpad/sdk `launchInstructions`)
 *
 * already signed as that mint; the user's wallet signs as creator and fee payer, silently when
 * Instant trading is on. `checkPreparedLaunch` (the allow-list's launch pattern: every account
 * re-derived from the wallet, the mint and the DBC config; signers; summed SOL) doesn't know what
 * the user typed, so a compromised API could still launch other metadata or size the first buy
 * differently. This module adds the binding:
 *
 *   - the mint is the reserved `…fmbL` mint and it actually signed (ed25519 over the message);
 *   - name, symbol and uri are exactly the form's values;
 *   - the first buy exists iff the user asked for one, spends exactly the amount typed, and its
 *     minimum out is what that amount buys as a fresh pool's first, min-fee swap on the
 *     transaction's own DBC config (read from chain, not from the API), within our slippage
 *     (quoted with the SDK's DBC math, the same function the API uses).
 *
 * The config: `register_coin` fails the whole transaction unless it is on FUMPAD's on-chain allow-list
 * (`Global.configs`), but the allow-list also holds the one-off first-coin config (3% fee, FUMPAD's share split with
 * a designated wallet, contracts INTERFACE §5.9). So the config's fee policy is read from chain (`readPolicy`): a
 * non-standard one is accepted only when the user chose the first-coin launch AND the API returned that config; and
 * the fee the user was shown must be the config's real fee (its scheduler floor, read from chain).
 *
 * No React, no `@/` imports: unit-tested by `launch.test.ts` with `npm test`.
 */
import type { PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { LaunchShape } from "./allowlist";
import { checkPreparedLaunch } from "./program";
import { type DbcPoolConfig, type DbcVirtualPool, quoteDbcBuy, withSlippage } from "@fumpad/sdk";

/** Slippage the app asks the API to apply to the creator's first buy (bps). */
export const LAUNCH_SLIPPAGE_BPS = 100;
/** Rounding slack between our DBC math and the API's (base units; 10 = 0.00001 tokens). */
const ROUNDING_SLACK = BigInt(10);

export interface FirstBuy {
  /** `swap2` amount_in: the user's budget, the fee included (DBC takes it from the input). */
  amountIn: bigint;
  tokensOut: bigint;
  /** Lowest `minimum_amount_out` we accept (the quote minus LAUNCH_SLIPPAGE_BPS). */
  minTokensOut: bigint;
}

/**
 * Base units a buy of `amountIn` lamports (fee included) gets as a fresh pool's first swap in the
 * launch transaction (DBC `enable_first_swap_with_min_fee`: the scheduler's floor, not the window's
 * 99%), from the curve's start price. Null when the curve can't fill it.
 */
export function quoteFirstBuy(cfg: DbcPoolConfig, amountIn: bigint): bigint | null {
  if (amountIn <= BigInt(0)) return null;
  const fresh = { sqrtPrice: cfg.sqrtStartPrice, activationPoint: BigInt(0), quoteReserve: BigInt(0) } as DbcVirtualPool;
  try {
    return quoteDbcBuy(cfg, fresh, amountIn, BigInt(0), { firstSwapMinFee: true }).amountOut;
  } catch {
    return null;
  }
}

/** What the creator's first buy must look like for a budget on a fresh pool of this config. */
export function expectedFirstBuy(cfg: DbcPoolConfig, budgetLamports: bigint, slippageBps = LAUNCH_SLIPPAGE_BPS): FirstBuy | null {
  const out = quoteFirstBuy(cfg, budgetLamports);
  if (out === null || out <= BigInt(0)) return null;
  return { amountIn: budgetLamports, tokensOut: out, minTokensOut: withSlippage(out, slippageBps) };
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
  /** `Params.launch_signer` read from chain (INTERFACE-v0.7 §8.1), when configured. */
  launchSigner?: string;
  /**
   * The first-coin config (base58) when the user chose the first-coin launch and the API prepared it: the only
   * non-standard config this launch may use. Unset: only a standard-policy config is accepted.
   */
  firstCoinConfig?: string;
  /** The trading fee (bps) the review step showed; the launch's config must have exactly this fee. */
  expectedFeeBps?: number;
}

/** A config's allow-list fee policy as read from chain (`Global.config_policies`); null = not allow-listed. */
export type ConfigPolicyReader = (config: PublicKey) => Promise<{ kind: number; wallet: string } | null>;

/** The config's normal trading fee, bps: its fee scheduler's floor (what the creator's first buy and every later trade pay). */
export const configFeeBps = (cfg: Pick<DbcPoolConfig, "baseFee">) => Number((cfg.baseFee.cliffFeeNumerator - cfg.baseFee.reductionFactor * BigInt(cfg.baseFee.numberOfPeriod)) / BigInt(100_000));

class LaunchRefused extends Error {
  constructor(why: string) {
    super(`Refusing to sign: ${why}.`);
    this.name = "LaunchRefused";
  }
}
const refuse = (why: string): never => {
  throw new LaunchRefused(why);
};

/**
 * Throws unless `tx` launches exactly the coin the user reviewed, with exactly the first buy
 * they asked for. `readCurve` reads the transaction's DBC config from chain (only called when
 * there is a first buy). Returns the decoded launch.
 */
export async function checkLaunchBinding(
  tx: VersionedTransaction,
  intent: LaunchIntent,
  readCurve: (config: PublicKey) => Promise<DbcPoolConfig>,
  readPolicy?: ConfigPolicyReader,
): Promise<LaunchShape> {
  // Shape, accounts, signers (the mint's signature verified), summed SOL ≤ the amount typed.
  const shape = checkPreparedLaunch(tx, intent.wallet, intent.mint, intent.suffix, intent.initialBuyLamports, intent.launchSigner);
  if (shape.name !== intent.name || shape.symbol !== intent.symbol || shape.uri !== intent.uri)
    refuse("the coin's name, symbol or metadata differ from what you entered");

  // The config's fee policy, from chain: a non-standard one (the first-coin config) only when the user chose it.
  if (readPolicy) {
    let pol: Awaited<ReturnType<ConfigPolicyReader>>;
    try {
      pol = await readPolicy(shape.config);
    } catch {
      return refuse("couldn't read FUMPAD's launch configs to check this launch");
    }
    if (!pol) refuse("it launches on a config that isn't on FUMPAD's allow-list");
    const special = pol!.kind !== 0;
    if (special && intent.firstCoinConfig !== shape.config.toBase58())
      refuse("it launches on the one-off first-coin config (3% fee, part of FUMPAD's share to a designated wallet), which you didn't choose");
    if (!special && intent.firstCoinConfig) refuse("it isn't the first-coin launch config you chose");
  } else if (intent.firstCoinConfig) refuse("couldn't check the first-coin launch config");
  if (intent.expectedFeeBps !== undefined) {
    let cfg: DbcPoolConfig;
    try {
      cfg = await readCurve(shape.config);
    } catch {
      return refuse("couldn't read the launch's curve to check its fee");
    }
    if (configFeeBps(cfg) !== intent.expectedFeeBps) refuse("the coin's trading fee differs from the one shown");
  }

  const wantBuy = intent.initialBuyLamports > BigInt(0);
  if (!wantBuy) {
    if (shape.firstBuy) refuse("it adds a buy you didn't ask for");
    return shape;
  }
  const buy = shape.firstBuy ?? refuse("your first buy is missing");
  if (buy.amountIn !== intent.initialBuyLamports) refuse("the first buy spends a different amount than you entered");
  let curve: DbcPoolConfig;
  try {
    curve = await readCurve(shape.config);
  } catch {
    return refuse("couldn't read the launch's curve to check your first buy");
  }
  // Without the min-fee exemption the creator's buy would pay the launch window's 99%.
  if (curve.enableFirstSwapWithMinFee !== 1) refuse("this launch would charge your first buy the snipe fee");
  const want = expectedFirstBuy(curve, intent.initialBuyLamports) ?? refuse("your first buy is too small");
  if (buy.minOut === BigInt(0) || buy.minOut + ROUNDING_SLACK < want.minTokensOut || buy.minOut > want.tokensOut + ROUNDING_SLACK)
    refuse("the first buy's minimum tokens don't match the quote");
  return shape;
}
