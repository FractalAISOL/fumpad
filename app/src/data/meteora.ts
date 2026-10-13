/**
 * Meteora pool math in display units (SOL, whole tokens), for quotes on screen (SPEC v0.7 §3).
 *
 * Both venues reduce to constant product on virtual reserves for a FUMPAD coin:
 *   - DBC (the bonding curve): a one-segment curve, constant liquidity between the start price and
 *     the migration price, is exactly x·y = k on virtual reserves (spike/meteora/REPORT.md §4).
 *     DBC never trades past the migration price: a buy that would overshoot reverts, so the router
 *     sends it as PartialFill and only the SOL that fits is spent.
 *   - DAMM v2 (after graduation): a full-range position, again x·y = k on (virtual) reserves.
 * The fee is collected in SOL on both (`collect_fee_mode` quote / `OnlyB`): taken from the input
 * on buys, from the output on sells. 1.25% (D32), of which Meteora keeps 20%. In the launch window
 * the DBC fee scheduler charges more (99% → 1.25% linearly over 8 slots, D33), buys and sells alike.
 *
 * Floats are fine for quotes: the transaction's bound is the shown quote minus slippage (M-9), and
 * the chain does the exact math. Nothing here builds a transaction.
 *
 * No React, no `@/` imports: unit-tested by `meteora.test.ts`.
 */

export interface FeeSchedule {
  /** Normal fee, bps (125 = 1.25%). */
  feeBps: number;
  /** Launch-window fee at slot offset 0, bps (9,900 = 99%). 0 or ≤ feeBps = no window. */
  snipeStartBps: number;
  /** Window length in slots (8 on mainnet). */
  snipeWindowSlots: number;
}

/**
 * The DBC linear fee scheduler (`FeeScheduler::get_base_fee_numerator`, linear mode): at slot
 * offset d < W the fee is start − d·(start − end)/W, from offset W on it is the normal fee.
 */
export function feeBpsAtSlot(s: FeeSchedule, slotOffset: number): number {
  const w = s.snipeWindowSlots;
  if (w <= 0 || s.snipeStartBps <= s.feeBps || slotOffset >= w) return s.feeBps;
  const d = Math.max(0, Math.floor(slotOffset));
  return s.snipeStartBps - (d * (s.snipeStartBps - s.feeBps)) / w;
}

export interface Reserves {
  /** SOL side incl. virtual. */
  sol: number;
  /** Token side incl. virtual. */
  tokens: number;
}

export interface SwapResult {
  /** Input actually used (≤ the amount asked; less only when a buy completes the curve). */
  amountIn: number;
  /** Output after the fee (tokens for buys, SOL for sells). */
  amountOut: number;
  /** Fee charged, SOL. */
  feeSol: number;
  /** Average execution price before the fee, SOL per token. */
  execPrice: number;
  /** Spot before and after, SOL per token. */
  spotBefore: number;
  spotAfter: number;
  /** The buy hit the curve's end and was partially filled (DBC PartialFill). */
  completesCurve: boolean;
}

const spot = (r: Reserves) => (r.tokens > 0 ? r.sol / r.tokens : 0);

/**
 * Buy with `solIn` (fee included). `tokensLeft` caps a DBC buy at the curve's end (PartialFill:
 * the input is reduced to what reaching the migration price costs, fee included); pass Infinity
 * for DAMM v2.
 */
export function quoteBuy(r: Reserves, solIn: number, feeBps: number, tokensLeft = Infinity): SwapResult {
  const s0 = spot(r);
  const fee = Math.max(0, Math.min(1, feeBps / 10_000));
  const amt = Math.max(0, solIn || 0);
  if (amt <= 0 || r.sol <= 0 || r.tokens <= 0 || fee >= 1)
    return { amountIn: 0, amountOut: 0, feeSol: 0, execPrice: s0, spotBefore: s0, spotAfter: s0, completesCurve: false };
  let net = amt * (1 - fee);
  let out = (r.tokens * net) / (r.sol + net);
  let used = amt;
  let completes = false;
  if (out >= tokensLeft) {
    // Exactly the tokens left: net SOL that reaches the migration price, grossed up by the fee.
    out = Math.max(0, tokensLeft);
    net = out >= r.tokens ? Infinity : (r.sol * out) / (r.tokens - out);
    used = Math.min(amt, net / (1 - fee));
    net = used * (1 - fee);
    completes = true;
  }
  const feeSol = used - net;
  const after = { sol: r.sol + net, tokens: r.tokens - out };
  return { amountIn: used, amountOut: out, feeSol, execPrice: out > 0 ? net / out : s0, spotBefore: s0, spotAfter: spot(after), completesCurve: completes };
}

/** Sell `tokensIn`: SOL out of the pool, then the fee off the output. */
export function quoteSell(r: Reserves, tokensIn: number, feeBps: number): SwapResult {
  const s0 = spot(r);
  const fee = Math.max(0, Math.min(1, feeBps / 10_000));
  const amt = Math.max(0, tokensIn || 0);
  if (amt <= 0 || r.sol <= 0 || r.tokens <= 0)
    return { amountIn: 0, amountOut: 0, feeSol: 0, execPrice: s0, spotBefore: s0, spotAfter: s0, completesCurve: false };
  const gross = (r.sol * amt) / (r.tokens + amt);
  const feeSol = gross * fee;
  const after = { sol: r.sol - gross, tokens: r.tokens + amt };
  return { amountIn: amt, amountOut: gross - feeSol, feeSol, execPrice: gross / amt, spotBefore: s0, spotAfter: spot(after), completesCurve: false };
}

export interface FeeSplit {
  /** Meteora's protocol share. */
  venue: number;
  /** FUMPAD's share, split 50 / 30 / 20 (D32). */
  pool: number;
  platform: number;
  creator: number;
}

/** Split a fee: Meteora keeps `venueShareBps`, FUMPAD's remainder splits by the three shares. */
export function splitFee(
  feeSol: number,
  p: { venueFeeShareBps: number; feePoolShareBps: number; feePlatformShareBps: number; feeCreatorShareBps: number },
): FeeSplit {
  const venue = (feeSol * p.venueFeeShareBps) / 10_000;
  const ours = feeSol - venue;
  return {
    venue,
    pool: (ours * p.feePoolShareBps) / 10_000,
    platform: (ours * p.feePlatformShareBps) / 10_000,
    creator: (ours * p.feeCreatorShareBps) / 10_000,
  };
}

/** DBC virtual reserves after `raisedSol` real SOL on a fresh curve (virtual x0, y0). */
export function curveReservesAt(x0: number, y0: number, raisedSol: number): Reserves {
  const sol = x0 + Math.max(0, raisedSol);
  return { sol, tokens: (x0 * y0) / sol };
}
