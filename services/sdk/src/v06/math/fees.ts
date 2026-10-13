// Port of math/fees.rs.
import { BPS_DENOM } from "../constants.js";

export interface FeeParams {
  feeBps: number;
  feePoolShareBps: number;
  feePlatformShareBps: number;
  feeCreatorShareBps: number;
}

export interface FeeSplit {
  total: bigint;
  pool: bigint;
  platform: bigint;
  /** Rounding remainder goes to the creator so the parts sum to `total`. */
  creator: bigint;
}

/** Fee on a SOL amount, rounded up, split per params. */
export function computeFee(solAmount: bigint, p: FeeParams): FeeSplit {
  const total = (solAmount * BigInt(p.feeBps) + BPS_DENOM - 1n) / BPS_DENOM;
  const pool = (total * BigInt(p.feePoolShareBps)) / BPS_DENOM;
  const platform = (total * BigInt(p.feePlatformShareBps)) / BPS_DENOM;
  return { total, pool, platform, creator: total - pool - platform };
}

/**
 * Largest `solIn` such that `solIn + fee(solIn) ≤ budget` (buys charge the fee on top).
 * Lets a UI accept "spend X SOL total" and still build an exact `buy(sol_in)`.
 */
export function solInForBudget(budget: bigint, p: FeeParams): bigint {
  if (budget <= 0n) return 0n;
  let s = (budget * BPS_DENOM) / (BPS_DENOM + BigInt(p.feeBps));
  while (s > 0n && s + computeFee(s, p).total > budget) s -= 1n;
  while (s + 1n + computeFee(s + 1n, p).total <= budget) s += 1n;
  return s;
}

// ── D19 snipe tax (v0.5) ─────────────────────────────────────────────────────

/** `Coin.snipe` (D19): launch slot + schedule snapshotted at create_coin. */
export interface SnipeConfig {
  launchSlot: bigint;
  windowSlots: number;
  startBps: number;
}

/**
 * Tax rate (bps) for a curve buy landing in `slot`: min(startBps, ⌈10_000·(W − d)/W⌉) at
 * offset d = slot − launchSlot < W, else 0. Defaults: 99 / 75 / 50 / 25 % for d = 0..3.
 * The creator's buy bundled with create_coin is exempt (`isCreatorLaunchBuy`).
 */
export function snipeTaxBps(cfg: SnipeConfig, slot: bigint): number {
  const w = BigInt(cfg.windowSlots);
  if (slot < cfg.launchSlot || w === 0n) return 0;
  const d = slot - cfg.launchSlot;
  if (d >= w) return 0;
  const ramp = ((w - d) * BPS_DENOM + w - 1n) / w;
  return Number(ramp < BigInt(cfg.startBps) ? ramp : BigInt(cfg.startBps));
}

/** Part of `solIn` offered to the curve at tax `bps`: ⌊solIn·(10_000 − bps)/10_000⌋. */
export function snipeCurveOffer(solIn: bigint, bps: number): bigint {
  return (solIn * (BPS_DENOM - BigInt(bps))) / BPS_DENOM;
}

/** Tax on a buy whose curve part was `solUsed`: ⌈solUsed·bps/(10_000 − bps)⌉ (bps of curve + tax). */
export function snipeTax(solUsed: bigint, bps: number): bigint {
  if (bps === 0) return 0n;
  const keep = BPS_DENOM - BigInt(bps);
  if (keep <= 0n) throw new Error("snipe bps must be < 10000");
  return (solUsed * BigInt(bps) + keep - 1n) / keep;
}

/**
 * D19 exemption: the creator's buy that is the coin's first trade, in the launch slot
 * (i.e. bundled with create_coin).
 */
export function isCreatorLaunchBuy(a: { user: string; creator: string; slot: bigint; launchSlot: bigint; tradeCount: bigint }): boolean {
  return a.user === a.creator && a.slot === a.launchSlot && a.tradeCount === 0n;
}
