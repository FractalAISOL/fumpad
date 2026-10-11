export * from "./curve.js";
export * from "./fees.js";
export * from "./price.js";
export * from "./pumpswap.js";
export * from "./reference.js";
export * from "./rewards.js";

/** Observations::median_price_q64 — lower median of samples in (now − window, now]. */
export function medianPriceQ64(
  samples: { ts: bigint; priceQ64: bigint }[],
  now: bigint,
  windowSecs: bigint,
  minSamples: number,
): bigint | null {
  const cutoff = now - windowSecs;
  const prices = samples.filter((s) => s.ts > cutoff && s.ts <= now).map((s) => s.priceQ64);
  if (prices.length === 0 || prices.length < minSamples) return null;
  prices.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return prices[Math.floor((prices.length - 1) / 2)];
}
