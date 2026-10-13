/**
 * PumpSwap quote approximation (constant product on effective reserves, fees on the
 * quote side). Used for UI quotes and slippage bounds only — the router measures real
 * balance deltas on-chain, and min-out protects the user. PumpSwap's own rounding may
 * differ by a few base units.
 */
import { BPS_DENOM } from "../constants.js";
import { priceQ64 } from "./price.js";

export interface PoolReserves {
  /** Base-vault balance. */
  base: bigint;
  /** Effective quote = quote-vault balance + Pool.virtual_quote_reserves. */
  quote: bigint;
}

export const poolSpotQ64 = (r: PoolReserves) => (r.quote > 0n ? priceQ64(r.quote, r.base) : null);

/** `buy_exact_quote_in`: spend `quoteIn` incl. fees → base out. */
export function pumpBuyExactQuoteIn(r: PoolReserves, quoteIn: bigint, feeBps: bigint): { baseOut: bigint; venueFee: bigint; quoteToPool: bigint } {
  // quoteIn = net + ceil(net·fee/1e4)  ⇒  net = floor(quoteIn·1e4 / (1e4 + fee))
  const net = (quoteIn * BPS_DENOM) / (BPS_DENOM + feeBps);
  const baseOut = r.quote + net === 0n ? 0n : (r.base * net) / (r.quote + net);
  return { baseOut, venueFee: quoteIn - net, quoteToPool: net };
}

/** `sell`: base in → quote out after fees. */
export function pumpSell(r: PoolReserves, baseIn: bigint, feeBps: bigint): { quoteOut: bigint; grossQuote: bigint; venueFee: bigint } {
  const gross = r.base + baseIn === 0n ? 0n : (r.quote * baseIn) / (r.base + baseIn);
  const venueFee = (gross * feeBps + BPS_DENOM - 1n) / BPS_DENOM;
  return { quoteOut: gross - venueFee, grossQuote: gross, venueFee };
}
