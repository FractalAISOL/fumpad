// Port of math/curve.rs — constant product on virtual reserves, protocol-favoring rounding.
import { U64_MAX } from "../constants.js";
import { ceilDiv, priceQ64 } from "./price.js";

export interface CurveReserves {
  virtualSol: bigint;
  virtualToken: bigint;
  realSol: bigint;
  realToken: bigint;
}

export interface BuyQuote {
  solUsed: bigint;
  tokensOut: bigint;
  completes: boolean;
}

const ZERO_BUY: BuyQuote = { solUsed: 0n, tokensOut: 0n, completes: false };

/** Quote a buy of up to `solIn` lamports. null on an inconsistent curve. */
export function quoteBuy(r: CurveReserves, solIn: bigint): BuyQuote | null {
  if (r.virtualToken <= r.realToken || r.virtualSol === 0n) return null;
  if (solIn === 0n || r.realToken === 0n) return { ...ZERO_BUY };
  const x = r.virtualSol;
  const y = r.virtualToken;
  const raw = (y * solIn) / (x + solIn);
  if (raw < r.realToken) return { solUsed: solIn, tokensOut: raw, completes: false };
  const t = r.realToken;
  const cost = ceilDiv(x * t, y - t)!;
  return { solUsed: cost, tokensOut: t, completes: true };
}

/** Lamports out (before fee) for selling `tokensIn`; null if the curve can't pay. */
export function quoteSell(r: CurveReserves, tokensIn: bigint): bigint | null {
  if (tokensIn === 0n) return 0n;
  const out = (r.virtualSol * tokensIn) / (r.virtualToken + tokensIn);
  if (out > U64_MAX || out > r.realSol) return null;
  return out;
}

/** Exact lamports needed to buy `tokensOut`. */
export function solForTokens(r: CurveReserves, tokensOut: bigint): bigint | null {
  if (tokensOut > r.realToken) return null;
  const v = ceilDiv(r.virtualSol * tokensOut, r.virtualToken - tokensOut);
  return v === null || v > U64_MAX ? null : v;
}

export function applyBuy(r: CurveReserves, q: BuyQuote): CurveReserves {
  return {
    virtualSol: r.virtualSol + q.solUsed,
    realSol: r.realSol + q.solUsed,
    virtualToken: r.virtualToken - q.tokensOut,
    realToken: r.realToken - q.tokensOut,
  };
}

export function applySell(r: CurveReserves, tokensIn: bigint, solOut: bigint): CurveReserves {
  return {
    virtualSol: r.virtualSol - solOut,
    realSol: r.realSol - solOut,
    virtualToken: r.virtualToken + tokensIn,
    realToken: r.realToken + tokensIn,
  };
}

export const curveSpotQ64 = (r: CurveReserves) => priceQ64(r.virtualSol, r.virtualToken);

export function initialReserves(initialVirtualSol: bigint, initialVirtualToken: bigint, curveSupply: bigint): CurveReserves {
  return { virtualSol: initialVirtualSol, virtualToken: initialVirtualToken, realSol: 0n, realToken: curveSupply };
}

/** curve/mod.rs::inline_buyback — pool share of the fee buys from the curve. */
export function inlineBuyback(r: CurveReserves, poolLamports: bigint): { reserves: CurveReserves; quote: BuyQuote; unspent: bigint } {
  let q = quoteBuy(r, poolLamports)!;
  if (q.tokensOut === 0n) q = { ...ZERO_BUY };
  return { reserves: applyBuy(r, q), quote: q, unspent: poolLamports - q.solUsed };
}
