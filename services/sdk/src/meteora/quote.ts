/**
 * Exact swap quotes for Meteora DBC 0.2.1 (multi-segment curve, fee scheduler, PartialFill at the migration
 * price) and DAMM v2 0.2.4 (single full-range concentrated position), ported from the programs' sources
 * (dynamic-bonding-curve curve.rs + state/virtual_pool.rs + state/config.rs; cp-amm
 * liquidity_handler/concentrated_liquidity.rs + state/fee.rs). Fees: FUMPAD pools collect in quote (DBC
 * `collect_fee_mode` 0, DAMM `OnlyB`): buys pay on the input, sells on the output. No referral, no dynamic fee.
 * Pure bigint; no web3 dependency.
 */
import type { DammPool, DbcPoolConfig, DbcVirtualPool } from "./accounts.js";

export const FEE_DENOMINATOR = 1_000_000_000n;
export const MAX_FEE_NUMERATOR = 990_000_000n;
export const DBC_PROTOCOL_FEE_PERCENT = 20n;
const U64_MAX = (1n << 64n) - 1n;

const divCeil = (a: bigint, b: bigint) => (a + b - 1n) / b;
const mulDiv = (a: bigint, b: bigint, d: bigint, up: boolean) => (up ? divCeil(a * b, d) : (a * b) / d);

/** Δbase = L·(√b − √a)/(√a·√b) */
export const deltaBase = (lower: bigint, upper: bigint, liquidity: bigint, up: boolean) => mulDiv(liquidity, upper - lower, lower * upper, up);
/** Δquote = L·(√b − √a) / 2^128 */
export const deltaQuote = (lower: bigint, upper: bigint, liquidity: bigint, up: boolean) => {
  const p = liquidity * (upper - lower);
  return up ? divCeil(p, 1n << 128n) : p >> 128n;
};
/** Next √P from a base input (rounding up): √P·L / (L + Δx·√P). */
export function nextSqrtFromBaseIn(sqrt: bigint, liquidity: bigint, amount: bigint): bigint {
  if (amount === 0n) return sqrt;
  return mulDiv(liquidity, sqrt, liquidity + amount * sqrt, true);
}
/** Next √P from a quote input (rounding down): √P + (Δy << 128) / L. */
export const nextSqrtFromQuoteIn = (sqrt: bigint, liquidity: bigint, amount: bigint) => sqrt + (amount << 128n) / liquidity;

export interface SwapQuote {
  /** Input incl. fees (what leaves the trader). For PartialFill buys: only what is used. */
  amountIn: bigint;
  /** Input reaching the curve (after an input fee). */
  amountInAfterFee: bigint;
  /** What the trader receives (after an output fee). */
  amountOut: bigint;
  /** Total fee (trading + protocol). */
  fee: bigint;
  /** Partner/LP share (FUMPAD's 80%). */
  tradingFee: bigint;
  /** Meteora's protocol share (20%). */
  protocolFee: bigint;
  feeNumerator: bigint;
  nextSqrtPrice: bigint;
  /** PartialFill: the buy stops at the migration price; `amountIn` < the requested input. */
  partialFill: boolean;
  /** The curve completes with this buy. */
  completesCurve: boolean;
}

function feeOn(amount: bigint, numerator: bigint, protocolPercent: bigint) {
  const fee = mulDiv(amount, numerator, FEE_DENOMINATOR, true);
  const protocol = (fee * protocolPercent) / 100n;
  return { net: amount - fee, fee, trading: fee - protocol, protocol };
}

/** DBC base fee numerator at `slot` (fee scheduler; `firstSwapMinFee` = the launch tx's first swap). */
export function dbcFeeNumerator(cfg: Pick<DbcPoolConfig, "baseFee">, pool: Pick<DbcVirtualPool, "activationPoint">, slot: bigint, firstSwapMinFee = false): bigint {
  const b = cfg.baseFee;
  const byPeriod = (period: bigint) => {
    const p = period < BigInt(b.numberOfPeriod) ? period : BigInt(b.numberOfPeriod);
    if (b.baseFeeMode === 0) return b.cliffFeeNumerator - b.reductionFactor * p;
    // exponential: cliff × (1 − r/1e4)^p (DBC get_fee_in_period, BASIS_POINT_MAX = 10_000) — not used by FUMPAD configs
    let f = b.cliffFeeNumerator;
    for (let i = 0n; i < p; i++) f = (f * (10_000n - b.reductionFactor)) / 10_000n;
    return f;
  };
  let num: bigint;
  if (firstSwapMinFee) num = byPeriod(BigInt(b.numberOfPeriod));
  else if (b.periodFrequency === 0n) num = b.cliffFeeNumerator;
  else num = byPeriod((slot > pool.activationPoint ? slot - pool.activationPoint : 0n) / b.periodFrequency);
  return num > MAX_FEE_NUMERATOR ? MAX_FEE_NUMERATOR : num;
}

/** DBC buy (quote in). mode: 0 ExactIn (throws when the curve can't fill it), 1 PartialFill. */
export function quoteDbcBuy(cfg: DbcPoolConfig, pool: DbcVirtualPool, lamportsIn: bigint, slot: bigint, opts: { partialFill?: boolean; firstSwapMinFee?: boolean } = {}): SwapQuote {
  const num = dbcFeeNumerator(cfg, pool, slot, opts.firstSwapMinFee);
  const f = feeOn(lamportsIn, num, DBC_PROTOCOL_FEE_PERCENT);
  let current = pool.sqrtPrice;
  let left = f.net;
  let out = 0n;
  const stop = cfg.migrationSqrtPrice;
  for (const seg of cfg.curve) {
    if (seg.sqrtPrice === 0n || seg.liquidity === 0n) break;
    const ref = stop < seg.sqrtPrice ? stop : seg.sqrtPrice;
    if (ref <= current) continue;
    const maxIn = deltaQuote(current, ref, seg.liquidity, true);
    if (left < maxIn) {
      const next = nextSqrtFromQuoteIn(current, seg.liquidity, left);
      out += deltaBase(current, next, seg.liquidity, false);
      current = next;
      left = 0n;
      break;
    }
    out += deltaBase(current, ref, seg.liquidity, false);
    current = ref;
    left -= maxIn;
    if (ref === stop) break;
  }
  if (left !== 0n && !opts.partialFill) throw new Error("DBC: buy overshoots the migration price (use PartialFill)");
  let amountIn = lamportsIn;
  let fee = f.fee;
  let trading = f.trading;
  let protocol = f.protocol;
  let afterFee = f.net;
  if (left !== 0n) {
    afterFee = f.net - left;
    amountIn = mulDiv(afterFee, FEE_DENOMINATOR, FEE_DENOMINATOR - num, true);
    fee = amountIn - afterFee;
    protocol = (fee * DBC_PROTOCOL_FEE_PERCENT) / 100n;
    trading = fee - protocol;
  }
  if (out > U64_MAX) throw new Error("DBC: output overflow");
  return { amountIn, amountInAfterFee: afterFee, amountOut: out, fee, tradingFee: trading, protocolFee: protocol, feeNumerator: num, nextSqrtPrice: current, partialFill: left !== 0n, completesCurve: current >= stop };
}

/** DBC sell (base in). */
export function quoteDbcSell(cfg: DbcPoolConfig, pool: DbcVirtualPool, tokensIn: bigint, slot: bigint): SwapQuote {
  const num = dbcFeeNumerator(cfg, pool, slot);
  let current = pool.sqrtPrice;
  let left = tokensIn;
  let gross = 0n;
  const curve = cfg.curve;
  for (let i = curve.length - 2; i >= 0; i--) {
    if (curve[i].sqrtPrice === 0n || curve[i].liquidity === 0n) continue;
    if (curve[i].sqrtPrice < current) {
      const L = curve[i + 1].liquidity;
      const maxIn = deltaBase(curve[i].sqrtPrice, current, L, true);
      if (left < maxIn) {
        const next = nextSqrtFromBaseIn(current, L, left);
        gross += deltaQuote(next, current, L, false);
        current = next;
        left = 0n;
        break;
      }
      gross += deltaQuote(curve[i].sqrtPrice, current, L, false);
      current = curve[i].sqrtPrice;
      left -= maxIn;
    }
  }
  if (left !== 0n) {
    const L = curve[0].liquidity;
    let next = nextSqrtFromBaseIn(current, L, left);
    if (next < cfg.sqrtStartPrice) {
      next = cfg.sqrtStartPrice;
      left -= deltaBase(next, current, L, true);
    } else left = 0n;
    gross += deltaQuote(next, current, L, false);
    current = next;
  }
  if (left !== 0n) throw new Error("DBC: the curve can't absorb this sell");
  const f = feeOn(gross, num, DBC_PROTOCOL_FEE_PERCENT);
  return { amountIn: tokensIn, amountInAfterFee: tokensIn, amountOut: f.net, fee: f.fee, tradingFee: f.trading, protocolFee: f.protocol, feeNumerator: num, nextSqrtPrice: current, partialFill: false, completesCurve: false };
}

/** DAMM v2 buy (quote B in, OnlyB: fee on input). */
export function quoteDammBuy(pool: DammPool, lamportsIn: bigint): SwapQuote {
  const num = pool.cliffFeeNumerator;
  const f = feeOn(lamportsIn, num, BigInt(pool.protocolFeePercent));
  const next = nextSqrtFromQuoteIn(pool.sqrtPrice, pool.liquidity, f.net);
  if (next > pool.sqrtMaxPrice) throw new Error("DAMM v2: price range violation");
  const out = deltaBase(pool.sqrtPrice, next, pool.liquidity, false);
  return { amountIn: lamportsIn, amountInAfterFee: f.net, amountOut: out, fee: f.fee, tradingFee: f.trading, protocolFee: f.protocol, feeNumerator: num, nextSqrtPrice: next, partialFill: false, completesCurve: false };
}

/** DAMM v2 sell (base A in, OnlyB: fee on the quote output). */
export function quoteDammSell(pool: DammPool, tokensIn: bigint): SwapQuote {
  const num = pool.cliffFeeNumerator;
  const next = nextSqrtFromBaseIn(pool.sqrtPrice, pool.liquidity, tokensIn);
  if (next < pool.sqrtMinPrice) throw new Error("DAMM v2: price range violation");
  const gross = deltaQuote(next, pool.sqrtPrice, pool.liquidity, false);
  const f = feeOn(gross, num, BigInt(pool.protocolFeePercent));
  return { amountIn: tokensIn, amountInAfterFee: tokensIn, amountOut: f.net, fee: f.fee, tradingFee: f.trading, protocolFee: f.protocol, feeNumerator: num, nextSqrtPrice: next, partialFill: false, completesCurve: false };
}

/** Constant-product virtual reserves of a liquidity segment at √P: quote = L·√P >> 128, base = L / √P. */
export function virtualReserves(sqrtPrice: bigint, liquidity: bigint): { quote: bigint; base: bigint } {
  return { quote: (liquidity * sqrtPrice) >> 128n, base: sqrtPrice === 0n ? 0n : liquidity / sqrtPrice };
}

/** Segment liquidity of the DBC curve at the current √P. */
export function dbcLiquidityAt(cfg: Pick<DbcPoolConfig, "curve">, sqrtPrice: bigint): bigint {
  for (const seg of cfg.curve) if (sqrtPrice < seg.sqrtPrice) return seg.liquidity;
  return cfg.curve.length ? cfg.curve[cfg.curve.length - 1].liquidity : 0n;
}

/** Quote still needed to complete the curve (DBC migration_quote_threshold − quote_reserve). */
export const dbcQuoteToComplete = (cfg: Pick<DbcPoolConfig, "migrationQuoteThreshold">, pool: Pick<DbcVirtualPool, "quoteReserve">): bigint =>
  cfg.migrationQuoteThreshold > pool.quoteReserve ? cfg.migrationQuoteThreshold - pool.quoteReserve : 0n;
