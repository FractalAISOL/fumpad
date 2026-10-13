/**
 * ADAPTER (until @fumpad/sdk v0.7): DBC's exact buy math on a fresh pool (curve segment 0), for
 * the launch's first-buy check (M-1). Mirrors DBC 0.2.1 `swap` for quote → base with
 * `collect_fee_mode = quote`: the fee comes off the input (rounded up), then
 *   next_sqrt = sqrt + ⌊net · 2¹²⁸ / L⌋,   base_out = ⌊L · (next − sqrt) / (sqrt · next)⌋.
 * Cross-checked against the official SDK's quote on the spike's devnet config (see
 * `launch.test.ts`); callers still allow a few base units of rounding slack.
 *
 * No React, no `@/` imports.
 */
import { type DbcCurveStart, FEE_DENOMINATOR } from "./accounts";

const ZERO = BigInt(0);
const Q128 = BigInt(1) << BigInt(128);

export interface FreshBuy {
  feeLamports: bigint;
  tokensOut: bigint;
}

/** Base units a buy of `amountIn` lamports (fee included) gets as a fresh pool's first, min-fee swap. Null if it leaves segment 0. */
export function quoteFreshBuy(
  c: Pick<DbcCurveStart, "sqrtStartPrice" | "liquidity" | "segmentEndSqrtPrice">,
  amountIn: bigint,
  feeNumerator: bigint,
): FreshBuy | null {
  if (amountIn <= ZERO) return null;
  const fee = (amountIn * feeNumerator + FEE_DENOMINATOR - BigInt(1)) / FEE_DENOMINATOR;
  const net = amountIn - fee;
  if (net <= ZERO) return null;
  const next = c.sqrtStartPrice + (net * Q128) / c.liquidity;
  if (next > c.segmentEndSqrtPrice) return null;
  const out = (c.liquidity * (next - c.sqrtStartPrice)) / (c.sqrtStartPrice * next);
  return { feeLamports: fee, tokensOut: out };
}

/** `amount × (1 − bps/10⁴)`, rounded down (a minimum never rounds up). */
export function withSlippage(amount: bigint, bps: number): bigint {
  return (amount * BigInt(10_000 - bps)) / BigInt(10_000);
}
