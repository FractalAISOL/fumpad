// Port of contracts/programs/fumpad/src/math/price.rs (bigint; u128 semantics checked).
import { BPS_DENOM, Q64, U128_MAX, U64_MAX } from "../constants.js";

export const ceilDiv = (a: bigint, b: bigint): bigint | null => (b === 0n ? null : (a + b - 1n) / b);

/** Price in lamports per base unit, Q64.64. null if tokens == 0. */
export function priceQ64(lamports: bigint, tokens: bigint): bigint | null {
  if (tokens === 0n) return null;
  const v = (lamports << 64n) / tokens;
  return v > U128_MAX ? null : v;
}

/** current × 10_000 ≥ reference × multiple_bps (exact; JS bigints are unbounded). */
export function meetsMultiple(currentQ64: bigint, referenceQ64: bigint, multipleBps: bigint | number): boolean {
  return currentQ64 * BPS_DENOM >= referenceQ64 * BigInt(multipleBps);
}

/** ⌈a × b ÷ d⌉; null if d == 0 or the quotient exceeds u128. */
export function mulDivCeil(a: bigint, b: bigint, d: bigint): bigint | null {
  if (d === 0n) return null;
  const p = a * b;
  const q = p / d + (p % d !== 0n ? 1n : 0n);
  return q > U128_MAX ? null : q;
}

/** Lamports value of `tokens` at `priceQ64`, rounded down; null if > u64. */
export function lamportsFor(tokens: bigint, priceQ64v: bigint): bigint | null {
  const v = (tokens * priceQ64v) / Q64;
  return v > U64_MAX ? null : v;
}
