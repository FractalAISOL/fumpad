// Bit-exact port of contracts/programs/fumpad/src/math/price.rs (u128/u64 semantics on bigint).
export const Q64 = 1n << 64n;
export const U64_MAX = (1n << 64n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;
export const BPS_DENOM = 10_000n;

/** price_q64: lamports per base unit, Q64.64. null if tokens == 0 (or out of range). */
export function priceQ64(lamports: bigint, tokens: bigint): bigint | null {
  if (lamports < 0n || lamports > U64_MAX || tokens < 0n || tokens > U64_MAX) return null;
  if (tokens === 0n) return null;
  return (lamports << 64n) / tokens; // < 2^128 since lamports < 2^64
}

/**
 * mul_div_ceil: ⌈a × b ÷ d⌉ with a 256-bit intermediate. null if d == 0 or the quotient > u128::MAX
 * (Rust: `hi >= d` → None, or the final +1 overflows).
 */
export function mulDivCeil(a: bigint, b: bigint, d: bigint): bigint | null {
  if (d === 0n) return null;
  const p = a * b;
  const q = p / d + (p % d !== 0n ? 1n : 0n);
  return q > U128_MAX ? null : q;
}

/** meets_multiple: current × 10_000 ≥ reference × multiple_bps (exact). */
export function meetsMultiple(currentQ64: bigint, referenceQ64: bigint, multipleBps: bigint): boolean {
  return currentQ64 * BPS_DENOM >= referenceQ64 * multipleBps;
}

/** lamports_for: tokens × price_q64 / 2^64, rounded down; null if > u64. */
export function lamportsFor(tokens: bigint, priceQ64v: bigint): bigint | null {
  const v = (tokens * priceQ64v) / Q64;
  return v > U64_MAX ? null : v;
}

/** Meteora Q64.64 sqrt price → Q64.64 price (quote raw units per base raw unit), floor; null if > u128. */
export function spotFromSqrtQ64(sqrtPrice: bigint): bigint | null {
  const v = (sqrtPrice * sqrtPrice) >> 64n;
  return v > U128_MAX ? null : v;
}
