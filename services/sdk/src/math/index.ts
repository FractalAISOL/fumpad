import { COVERAGE_BUCKETS, MIN_COVERED_BUCKETS } from "../constants.js";

export * from "./curve.js";
export * from "./fees.js";
export * from "./price.js";
export * from "./pumpswap.js";
export * from "./reference.js";
export * from "./rewards.js";

/**
 * Observations::median_price_q64 (v0.3) — lower median of KEEPER samples in
 * (now − window, now], or null unless ≥ `minSamples` of them AND they cover ≥ 5 of the
 * window's 6 equal buckets. Fallback samples never count.
 */
export function medianPriceQ64(
  samples: { ts: bigint; priceQ64: bigint; fallback?: boolean }[],
  now: bigint,
  windowSecs: bigint,
  minSamples: number,
): bigint | null {
  const cutoff = now - windowSecs;
  let bucketSecs = windowSecs / COVERAGE_BUCKETS;
  if (bucketSecs < 1n) bucketSecs = 1n;
  let buckets = 0;
  const prices: bigint[] = [];
  for (const s of samples) {
    if (s.fallback || s.ts <= cutoff || s.ts > now) continue;
    prices.push(s.priceQ64);
    let b = (now - s.ts) / bucketSecs;
    if (b > COVERAGE_BUCKETS - 1n) b = COVERAGE_BUCKETS - 1n;
    buckets |= 1 << Number(b);
  }
  let covered = 0;
  for (let i = 0; i < Number(COVERAGE_BUCKETS); i++) if (buckets & (1 << i)) covered++;
  if (prices.length === 0 || prices.length < minSamples || covered < MIN_COVERED_BUCKETS) return null;
  prices.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return prices[Math.floor((prices.length - 1) / 2)];
}

/** Which of the 6 coverage buckets have keeper samples (bit i = bucket i, 0 = newest). */
export function coverageBuckets(samples: { ts: bigint; fallback?: boolean }[], now: bigint, windowSecs: bigint): number {
  const cutoff = now - windowSecs;
  let bucketSecs = windowSecs / COVERAGE_BUCKETS;
  if (bucketSecs < 1n) bucketSecs = 1n;
  let buckets = 0;
  for (const s of samples) {
    if (s.fallback || s.ts <= cutoff || s.ts > now) continue;
    let b = (now - s.ts) / bucketSecs;
    if (b > COVERAGE_BUCKETS - 1n) b = COVERAGE_BUCKETS - 1n;
    buckets |= 1 << Number(b);
  }
  return buckets;
}

