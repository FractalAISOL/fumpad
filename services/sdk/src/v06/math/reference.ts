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

/** Kind of D10 touch point (reference.rs `Touch`). */
export type Touch = "curve" | "venue" | "keeper-sample" | "fallback-sample";

const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** Apply one touch point (ReferencePrice::touch). Returns the new state. */
export function touchReference(ref: ReferencePrice, now: bigint, preSpotQ64: bigint, postSpotQ64: bigint, kind: Touch): ReferencePrice {
  if (ref.updatedAt === 0n) return newReference(max(preSpotQ64, postSpotQ64), now);
  let dt = now - ref.updatedAt;
  if (dt < 0n) dt = 0n;
  const capped = min(dt, REFERENCE_MAX_UNCONFIRMED_SECS);
  let v: bigint;
  let w: bigint;
  if (kind === "curve") {
    v = ref.lastSpotQ64;
    w = min(dt, REFERENCE_WINDOW_SECS);
  } else if (kind === "keeper-sample") {
    // v0.3 V-opt: the keeper's OWN upward observation gets the full elapsed weight.
    v = max(ref.lastSpotQ64, preSpotQ64);
    const ownUpward = preSpotQ64 >= ref.lastSpotQ64 && v >= ref.avgQ64;
    w = ownUpward ? min(dt, REFERENCE_WINDOW_SECS) : capped;
  } else {
    v = max(ref.lastSpotQ64, preSpotQ64);
    w = capped;
  }
  const blended = blend(ref.avgQ64, v, w, REFERENCE_WINDOW_SECS);
  const updatedAt = max(ref.updatedAt, now);
  if (kind === "fallback-sample") {
    // v0.3 V-M2: permissionless samples are raise-only.
    return { avgQ64: max(ref.avgQ64, blended), lastSpotQ64: max(ref.lastSpotQ64, postSpotQ64), updatedAt };
  }
  return { avgQ64: blended, lastSpotQ64: postSpotQ64, updatedAt };
}

/** Curve (`exact`) or router touch — ReferencePrice::update. */
export function updateReference(ref: ReferencePrice, now: bigint, preSpotQ64: bigint, postSpotQ64: bigint, exact: boolean): ReferencePrice {
  return touchReference(ref, now, preSpotQ64, postSpotQ64, exact ? "curve" : "venue");
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
