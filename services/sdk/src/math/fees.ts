// Port of math/fees.rs.
import { BPS_DENOM } from "../constants.js";

export interface FeeParams {
  feeBps: number;
  feePoolShareBps: number;
  feePlatformShareBps: number;
  feeCreatorShareBps: number;
}

export interface FeeSplit {
  total: bigint;
  pool: bigint;
  platform: bigint;
  /** Rounding remainder goes to the creator so the parts sum to `total`. */
  creator: bigint;
}

/** Fee on a SOL amount, rounded up, split per params. */
export function computeFee(solAmount: bigint, p: FeeParams): FeeSplit {
  const total = (solAmount * BigInt(p.feeBps) + BPS_DENOM - 1n) / BPS_DENOM;
  const pool = (total * BigInt(p.feePoolShareBps)) / BPS_DENOM;
  const platform = (total * BigInt(p.feePlatformShareBps)) / BPS_DENOM;
  return { total, pool, platform, creator: total - pool - platform };
}

/**
 * Largest `solIn` such that `solIn + fee(solIn) ≤ budget` (buys charge the fee on top).
 * Lets a UI accept "spend X SOL total" and still build an exact `buy(sol_in)`.
 */
export function solInForBudget(budget: bigint, p: FeeParams): bigint {
  if (budget <= 0n) return 0n;
  let s = (budget * BPS_DENOM) / (BPS_DENOM + BigInt(p.feeBps));
  while (s > 0n && s + computeFee(s, p).total > budget) s -= 1n;
  while (s + 1n + computeFee(s + 1n, p).total <= budget) s += 1n;
  return s;
}
