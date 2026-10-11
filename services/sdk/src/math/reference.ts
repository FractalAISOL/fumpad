// Port of math/reference.rs — D10 reference price + D12 ticket price.
import {
  BPS_DENOM,
  MAX_SELF_IMPACT_DISCOUNT_BPS,
  REFERENCE_MAX_UNCONFIRMED_SECS,
  REFERENCE_WINDOW_SECS,
  U128_MAX,
} from "../constants.js";
import { mulDivCeil } from "./price.js";

export interface ReferencePrice {
  avgQ64: bigint;
  lastSpotQ64: bigint;
  /** unix seconds; 0 = never initialized */
  updatedAt: bigint;
}

export const newReference = (spotQ64: bigint, now: bigint): ReferencePrice => ({
  avgQ64: spotQ64,
  lastSpotQ64: spotQ64,
  updatedAt: now,
});

function blend(avg: bigint, v: bigint, w: bigint, window: bigint): bigint {
  const ww = w < window ? w : window;
  const part = (diff: bigint) => (diff / window) * ww + ((diff % window) * ww) / window;
  return v >= avg ? avg + part(v - avg) : avg - part(avg - v);
}

/** Apply one touch point (`exact` = curve trade). Returns the new state. */
export function updateReference(
  ref: ReferencePrice,
  now: bigint,
  preSpotQ64: bigint,
  postSpotQ64: bigint,
  exact: boolean,
): ReferencePrice {
  if (ref.updatedAt === 0n) {
    const s = preSpotQ64 > postSpotQ64 ? preSpotQ64 : postSpotQ64;
    return newReference(s, now);
  }
  let dt = now - ref.updatedAt;
  if (dt < 0n) dt = 0n;
  let v: bigint;
  let w: bigint;
  if (exact) {
    v = ref.lastSpotQ64;
    w = dt < REFERENCE_WINDOW_SECS ? dt : REFERENCE_WINDOW_SECS;
  } else {
    v = ref.lastSpotQ64 > preSpotQ64 ? ref.lastSpotQ64 : preSpotQ64;
    w = dt < REFERENCE_MAX_UNCONFIRMED_SECS ? dt : REFERENCE_MAX_UNCONFIRMED_SECS;
  }
  return {
    avgQ64: blend(ref.avgQ64, v, w, REFERENCE_WINDOW_SECS),
    lastSpotQ64: postSpotQ64,
    updatedAt: ref.updatedAt > now ? ref.updatedAt : now,
  };
}

/** D12: max(execution, max(⌈ref × exec ÷ preSpot⌉, ⌈ref × 0.9⌉)); preSpot 0 → ref. */
export function ticketPriceQ64(executionQ64: bigint, referenceQ64: bigint, preTradeSpotQ64: bigint): bigint {
  let floor: bigint;
  if (preTradeSpotQ64 === 0n) {
    floor = referenceQ64;
  } else {
    const fair = mulDivCeil(referenceQ64, executionQ64, preTradeSpotQ64) ?? U128_MAX;
    const capped = mulDivCeil(referenceQ64, BPS_DENOM - MAX_SELF_IMPACT_DISCOUNT_BPS, BPS_DENOM) ?? U128_MAX;
    floor = fair > capped ? fair : capped;
  }
  return executionQ64 > floor ? executionQ64 : floor;
}
