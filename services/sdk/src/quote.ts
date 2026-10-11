/**
 * Trade quotes in raw units, mirroring the program step by step (curve: exact; PumpSwap:
 * constant-product approximation, see math/pumpswap.ts).
 */
import type { CoinAccount, PositionAccount } from "./accounts.js";
import { BPS_DENOM, PUMPSWAP_DEFAULT_FEE_BPS } from "./constants.js";
import {
  applySell,
  computeFee,
  type CurveReserves,
  curveSpotQ64,
  evaluateSell,
  type FeeSplit,
  inlineBuyback,
  type NoTicket,
  planRebuy,
  type PoolReserves,
  poolSpotQ64,
  priceQ64,
  pumpBuyExactQuoteIn,
  pumpSell,
  quoteBuy,
  quoteSell,
  solInForBudget,
  updateReference,
} from "./math/index.js";
import type { Params } from "./params.js";

export const reservesOf = (c: CoinAccount): CurveReserves => ({
  virtualSol: c.virtualSolReserves,
  virtualToken: c.virtualTokenReserves,
  realSol: c.realSolReserves,
  realToken: c.realTokenReserves,
});

export interface BuyQuoteRaw {
  venue: "curve" | "pumpswap";
  /** `sol_in` argument to pass (curve: SOL offered to the curve; router: SOL wrapped). */
  solIn: bigint;
  /** What the user pays in total (solUsed + FUMPAD fee). */
  totalCost: bigint;
  /** SOL actually crossing the venue (curve: may be < solIn on the completing buy). */
  solUsed: bigint;
  tokensOut: bigint;
  fee: FeeSplit;
  venueFee: bigint;
  spotBeforeQ64: bigint;
  execPriceQ64: bigint;
  /** (exec / spot − 1) in bps. */
  priceImpactBps: number;
  partialFill: boolean;
  poolTokensBought: bigint;
}

export interface SellQuoteRaw {
  venue: "curve" | "pumpswap";
  tokensIn: bigint;
  /** SOL out of the venue before FUMPAD's fee (= Trade.sol_amount). */
  gross: bigint;
  fee: FeeSplit;
  net: bigint;
  venueFee: bigint;
  spotBeforeQ64: bigint;
  spotAfterQ64: bigint;
  execPriceQ64: bigint;
  priceImpactBps: number;
}

function impactBps(exec: bigint, spot: bigint): number {
  if (spot === 0n) return 0;
  return Number(((exec - spot) * BPS_DENOM * 100n) / spot) / 100;
}

/** Curve buy for a total budget (fee on top), exactly as `buy` computes it. */
export function quoteCurveBuy(r: CurveReserves, p: Params, budgetLamports: bigint): BuyQuoteRaw | null {
  const solIn = solInForBudget(budgetLamports, p);
  const spot = curveSpotQ64(r) ?? 0n;
  const q = quoteBuy(r, solIn);
  if (!q) return null;
  const fee = computeFee(q.solUsed, p);
  const after = { ...r, virtualSol: r.virtualSol + q.solUsed, realSol: r.realSol + q.solUsed, virtualToken: r.virtualToken - q.tokensOut, realToken: r.realToken - q.tokensOut };
  const bb = inlineBuyback(after, fee.pool);
  const exec = q.tokensOut > 0n ? (priceQ64(q.solUsed, q.tokensOut) ?? 0n) : spot;
  return {
    venue: "curve",
    solIn,
    totalCost: q.solUsed + fee.total,
    solUsed: q.solUsed,
    tokensOut: q.tokensOut,
    fee,
    venueFee: 0n,
    spotBeforeQ64: spot,
    execPriceQ64: exec,
    priceImpactBps: impactBps(exec, spot),
    partialFill: q.completes,
    poolTokensBought: bb.quote.tokensOut,
  };
}

/** Curve sell, as `sell` computes it (incl. the inline buyback's effect on spot). */
export function quoteCurveSell(r: CurveReserves, p: Params, tokensIn: bigint): SellQuoteRaw | null {
  const spot = curveSpotQ64(r) ?? 0n;
  const gross = quoteSell(r, tokensIn);
  if (gross === null) return null;
  const fee = computeFee(gross, p);
  const after = inlineBuyback(applySell(r, tokensIn, gross), fee.pool).reserves;
  const exec = tokensIn > 0n ? (priceQ64(gross, tokensIn) ?? 0n) : spot;
  return {
    venue: "curve",
    tokensIn,
    gross,
    fee,
    net: gross > fee.total ? gross - fee.total : 0n,
    venueFee: 0n,
    spotBeforeQ64: spot,
    spotAfterQ64: curveSpotQ64(after) ?? 0n,
    execPriceQ64: exec,
    priceImpactBps: impactBps(exec, spot),
  };
}

/** Router buy: the router wraps exactly `solIn`, PumpSwap spends ≤ it incl. its fees, FUMPAD's fee on top. */
export function quoteSwapBuy(pool: PoolReserves, p: Params, budgetLamports: bigint, venueFeeBps = PUMPSWAP_DEFAULT_FEE_BPS): BuyQuoteRaw {
  const solIn = solInForBudget(budgetLamports, p);
  const spot = poolSpotQ64(pool) ?? 0n;
  const v = pumpBuyExactQuoteIn(pool, solIn, venueFeeBps);
  const fee = computeFee(solIn, p);
  const exec = v.baseOut > 0n ? (priceQ64(solIn, v.baseOut) ?? 0n) : spot;
  return {
    venue: "pumpswap",
    solIn,
    totalCost: solIn + fee.total,
    solUsed: solIn,
    tokensOut: v.baseOut,
    fee,
    venueFee: v.venueFee,
    spotBeforeQ64: spot,
    execPriceQ64: exec,
    priceImpactBps: impactBps(exec, spot),
    partialFill: false,
    poolTokensBought: 0n,
  };
}

export function quoteSwapSell(pool: PoolReserves, p: Params, tokensIn: bigint, venueFeeBps = PUMPSWAP_DEFAULT_FEE_BPS): SellQuoteRaw {
  const spot = poolSpotQ64(pool) ?? 0n;
  const v = pumpSell(pool, tokensIn, venueFeeBps);
  const gross = v.quoteOut; // what lands in the user's WSOL (after PumpSwap's fee)
  const fee = computeFee(gross, p);
  const exec = tokensIn > 0n ? (priceQ64(gross, tokensIn) ?? 0n) : spot;
  // LP part of the fee stays in the pool; protocol part is excluded from effective reserves.
  const after: PoolReserves = { base: pool.base + tokensIn, quote: pool.quote - v.grossQuote + (v.venueFee * 5n) / 6n };
  return {
    venue: "pumpswap",
    tokensIn,
    gross,
    fee,
    net: gross > fee.total ? gross - fee.total : 0n,
    venueFee: v.venueFee,
    spotBeforeQ64: spot,
    spotAfterQ64: poolSpotQ64(after) ?? 0n,
    execPriceQ64: exec,
    priceImpactBps: impactBps(exec, spot),
  };
}

export interface TicketPreviewRaw {
  files: boolean;
  reason?: NoTicket;
  tokens: bigint;
  usdCents: bigint | null;
  execPriceQ64: bigint;
  floorPriceQ64: bigint;
  ticketPriceQ64: bigint;
  referenceAfterQ64: bigint;
  triggerPriceQ64: bigint;
  claimTokens: bigint;
  openTickets: number;
}

/** What `on_sell` would decide for this sell (D10/D12 floor, maturity, $50, creator, ≤5 open). */
export function previewTicket(args: {
  coin: CoinAccount;
  params: Params;
  position: PositionAccount | null;
  wallet: string;
  balanceBefore: bigint;
  quote: SellQuoteRaw;
  now: bigint;
  solUsd: { price: bigint; exponent: number } | null;
}): TicketPreviewRaw {
  const { coin, params: p, quote: q } = args;
  const ref = updateReference(coin.reference, args.now, q.spotBeforeQ64, q.spotAfterQ64, q.venue === "curve");
  const pos = args.position ?? { matured: 0n, pending: 0n, pendingSince: 0n, openCount: 0 };
  const ev = evaluateSell({
    position: { matured: pos.matured, pending: pos.pending, pendingSince: pos.pendingSince, openCount: pos.openCount },
    params: p,
    isCreator: coin.creator.toBase58() === args.wallet,
    tokensSold: q.tokensIn,
    grossLamportsOut: q.gross,
    balanceBefore: args.balanceBefore,
    referencePriceQ64: ref.avgQ64,
    preTradeSpotQ64: q.spotBeforeQ64,
    now: args.now,
    solUsd: args.solUsd,
  });
  const exec = ev.executionQ64 ?? 0n;
  const ticketPrice = ("sellPriceQ64" in ev && ev.sellPriceQ64) || exec;
  const floor = q.spotBeforeQ64 > 0n ? (ref.avgQ64 * exec) / q.spotBeforeQ64 : ref.avgQ64;
  const tokens = "reason" in ev ? ev.tokens : ev.tokens;
  return {
    files: !("reason" in ev),
    reason: "reason" in ev ? ev.reason : undefined,
    tokens,
    usdCents: "reason" in ev ? ev.usdCents : ev.sellUsdCents,
    execPriceQ64: exec,
    floorPriceQ64: floor,
    ticketPriceQ64: ticketPrice,
    referenceAfterQ64: ref.avgQ64,
    triggerPriceQ64: (ticketPrice * BigInt(p.triggerMultipleBps)) / BPS_DENOM,
    claimTokens: (tokens * BigInt(p.claimBps)) / BPS_DENOM,
    openTickets: pos.openCount,
  };
}

/** Rebuy-rule preview for a buy of `tokensOut` (newest ticket first, 7-day window). */
export function previewRebuy(
  tickets: { id: string; sellTs: bigint; seq: bigint; tokens: bigint; status: string }[],
  tokensOut: bigint,
  now: bigint,
  windowSecs: bigint,
): { id: string; debit: bigint }[] {
  const d = planRebuy(tickets, tokensOut, now, windowSecs);
  return tickets.map((t, i) => ({ id: t.id, debit: d[i] })).filter((x) => x.debit > 0n);
}
