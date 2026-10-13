// Bit-exact port of contracts/programs/fumpad/src/math/reference.rs (D10 reference + D12 ticket price).
// Comments there explain the threat model; only the arithmetic is reproduced here.
import { BPS_DENOM, mulDivCeil, U128_MAX } from "./price.js";

export const REFERENCE_WINDOW_SECS = 600n;
export const REFERENCE_MAX_UNCONFIRMED_SECS = 150n;
/** constants.rs MAX_SELF_IMPACT_DISCOUNT_BPS (D12 cap). */
export const MAX_SELF_IMPACT_DISCOUNT_BPS = 1_000n;

export interface ReferencePrice {
  avgQ64: bigint;
  lastSpotQ64: bigint;
  /** i64 unix seconds; 0 = never initialized. */
  updatedAt: bigint;
}

export type Touch = "curve" | "venue" | "keeper_sample" | "fallback_sample";

export const newReference = (spotQ64: bigint, now: bigint): ReferencePrice => ({ avgQ64: spotQ64, lastSpotQ64: spotQ64, updatedAt: now });
export const defaultReference = (): ReferencePrice => ({ avgQ64: 0n, lastSpotQ64: 0n, updatedAt: 0n });

const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** blend(avg, v, w, window): avg + (v − avg)·w/window, move floored. */
export function blend(avg: bigint, v: bigint, w: bigint, window: bigint): bigint {
  const ww = min(w, window);
  const d = window;
  const part = (diff: bigint) => (diff / d) * ww + ((diff % d) * ww) / d;
  return v >= avg ? avg + part(v - avg) : avg - part(avg - v);
}

/** ReferencePrice::touch. Returns the new state (input not mutated). */
export function touch(r: ReferencePrice, now: bigint, preSpotQ64: bigint, postSpotQ64: bigint, kind: Touch): ReferencePrice {
  if (r.updatedAt === 0n) return newReference(max(preSpotQ64, postSpotQ64), now);
  // dt = now.saturating_sub(updated_at).max(0) as u64
  let dt = now - r.updatedAt;
  if (dt < 0n) dt = 0n;
  const capped = min(dt, REFERENCE_MAX_UNCONFIRMED_SECS);
  let v: bigint;
  let w: bigint;
  switch (kind) {
    case "curve":
      v = r.lastSpotQ64;
      w = min(dt, REFERENCE_WINDOW_SECS);
      break;
    case "venue":
    case "fallback_sample":
      v = max(r.lastSpotQ64, preSpotQ64);
      w = capped;
      break;
    case "keeper_sample": {
      v = max(r.lastSpotQ64, preSpotQ64);
      const ownUpward = preSpotQ64 >= r.lastSpotQ64 && v >= r.avgQ64;
      w = ownUpward ? min(dt, REFERENCE_WINDOW_SECS) : capped;
      break;
    }
  }
  const blended = blend(r.avgQ64, v, w, REFERENCE_WINDOW_SECS);
  const updatedAt = max(r.updatedAt, now);
  if (kind === "fallback_sample") return { avgQ64: max(r.avgQ64, blended), lastSpotQ64: max(r.lastSpotQ64, postSpotQ64), updatedAt };
  return { avgQ64: blended, lastSpotQ64: postSpotQ64, updatedAt };
}

/** ticket_price_q64 (D12): max(execution, max(⌈ref·exec/pre⌉, ⌈ref·0.9⌉)); pre == 0 → ref. Saturating. */
export function ticketPriceQ64(executionQ64: bigint, referenceQ64: bigint, preTradeSpotQ64: bigint): bigint {
  let floor: bigint;
  if (preTradeSpotQ64 === 0n) floor = referenceQ64;
  else {
    const fair = mulDivCeil(referenceQ64, executionQ64, preTradeSpotQ64) ?? U128_MAX;
    const capped = mulDivCeil(referenceQ64, BPS_DENOM - MAX_SELF_IMPACT_DISCOUNT_BPS, BPS_DENOM) ?? U128_MAX;
    floor = max(fair, capped);
  }
  return max(executionQ64, floor);
}
