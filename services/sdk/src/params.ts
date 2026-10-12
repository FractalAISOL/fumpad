import { PYTH_SOL_USD_FEED_ID } from "./constants.js";

/** `state/global.rs::Params` with u64/i64 as bigint (u8/u16/u32 as number). */
export interface Params {
  totalSupply: bigint;
  rewardPoolSupply: bigint;
  curveSupply: bigint;
  lpSupply: bigint;
  initialVirtualSol: bigint;
  initialVirtualToken: bigint;
  graduationLamports: bigint;
  graduationFeeLamports: bigint;
  feeBps: number;
  feePoolShareBps: number;
  feePlatformShareBps: number;
  feeCreatorShareBps: number;
  triggerMultipleBps: number;
  claimBps: number;
  maxClaimPoolBps: number;
  minSellUsdCents: bigint;
  minHoldSecs: bigint;
  rebuyWindowSecs: bigint;
  claimWindowSecs: bigint;
  maxOpenTickets: number;
  oracleWindowSecs: bigint;
  oracleMinSpacingSecs: bigint;
  oracleMinSamples: number;
  keeperStaleSecs: bigint;
  buybackMaxDeviationBps: number;
  buybackMaxPoolBps: number;
  /** 32 bytes, hex. */
  solUsdFeedId: string;
  maxPriceAgeSecs: bigint;
  /** D19 (v0.5): curve buys within this many slots after launch pay the snipe tax (0 = off, ≤ 50). */
  snipeWindowSlots: number;
  /** D19: tax at the launch slot, bps (≤ 9900); schedule min(this, ⌈10_000·(W − d)/W⌉). */
  snipeStartBps: number;
}

/** `Params::default()` (constants.rs). */
export const DEFAULT_PARAMS: Params = {
  totalSupply: 1_000_000_000_000_000n,
  // D17 (v0.4): 8% reward pool; D20 (v0.5): 0.65 SOL graduation fee kept out of the LP,
  // curve re-derived for price continuity (contracts constants.rs, SPEC §3).
  rewardPoolSupply: 80_000_000_000_000n,
  curveSupply: 730_811_425_785_218n,
  lpSupply: 189_188_574_214_782n,
  initialVirtualSol: 30_000_000_000n,
  initialVirtualToken: 988_744_870_180_001n,
  graduationLamports: 85_000_000_000n,
  graduationFeeLamports: 650_000_000n,
  feeBps: 100,
  feePoolShareBps: 5_000,
  feePlatformShareBps: 3_000,
  feeCreatorShareBps: 2_000,
  triggerMultipleBps: 100_000,
  claimBps: 1_000,
  maxClaimPoolBps: 1_000,
  minSellUsdCents: 5_000n,
  minHoldSecs: 600n,
  rebuyWindowSecs: 7n * 86_400n,
  claimWindowSecs: 90n * 86_400n,
  maxOpenTickets: 5,
  oracleWindowSecs: 1_800n,
  oracleMinSpacingSecs: 10n,
  oracleMinSamples: 84,
  keeperStaleSecs: 600n,
  buybackMaxDeviationBps: 300,
  buybackMaxPoolBps: 50,
  solUsdFeedId: PYTH_SOL_USD_FEED_ID,
  maxPriceAgeSecs: 150n, // v0.6 M-4 (was 60)
  snipeWindowSlots: 4,
  snipeStartBps: 9_900,
};

/**
 * v0.6 (M-1 / L-2) `Params::is_valid` ranges (contracts constants.rs, inclusive). A queued or
 * initial params set outside them is refused on chain (`InvalidParams`).
 */
export const PARAM_BOUNDS = {
  triggerMultipleBps: [50_000, 500_000], // 5x–50x
  claimBps: [100, 2_500], // 1–25% of the ticket
  maxClaimPoolBps: [100, 2_500], // 1–25% of the pool per claim
  minSellUsdCents: [500n, 100_000n], // $5–$1,000
  minHoldSecs: [60n, 86_400n],
  rebuyWindowSecs: [86_400n, 30n * 86_400n],
  claimWindowSecs: [7n * 86_400n, 365n * 86_400n],
  maxOpenTickets: [1, 5],
  oracleWindowSecs: [600n, 7_200n],
  oracleMinSpacingSecs: [5n, 60n],
  keeperStaleSecs: [60n, 3_600n],
  buybackMaxDeviationBps: [10, 1_000],
  buybackMaxPoolBps: [1, 200],
  maxPriceAgeSecs: [30n, 300n],
} as const;
/** Coverage floor: ≥ one keeper sample per this many seconds of the oracle window. */
export const ORACLE_MIN_SAMPLE_EVERY_SECS = 60n;
/** D20 continuity / `graduation_lamports` tolerance, bps. */
export const CURVE_CONSISTENCY_TOLERANCE_BPS = 10n;

const inRange = <T extends number | bigint>(v: T, [lo, hi]: readonly [T, T]) => v >= lo && v <= hi;

/**
 * Mirror of `Params::curve_consistent`: graduation_lamports ≈ the raise the curve implies, raise >
 * graduation fee, and the LP opening price ≈ the curve's final price (within 10 bps).
 */
export function curveConsistent(p: Params): boolean {
  const close = (a: bigint, b: bigint) => (a > b ? a - b : b - a) * 10_000n <= b * CURVE_CONSISTENCY_TOLERANCE_BPS;
  const t1 = p.initialVirtualToken - p.curveSupply;
  if (t1 <= 0n || p.initialVirtualSol <= 0n) return false;
  const v1 = (p.initialVirtualSol * p.initialVirtualToken) / t1;
  const raise = v1 - p.initialVirtualSol;
  if (raise <= p.graduationFeeLamports || !close(p.graduationLamports, raise)) return false;
  return close((raise - p.graduationFeeLamports) * t1, v1 * p.lpSupply);
}

/** Mirror of `Params::is_valid` (initialize / queue / execute): D14 caps + v0.6 bounds + D20 continuity. */
export function paramsValid(p: Params): boolean {
  const fees =
    p.graduationFeeLamports <= 1_000_000_000n &&
    p.feeBps <= 200 &&
    p.feePoolShareBps + p.feePlatformShareBps + p.feeCreatorShareBps === 10_000;
  const supply =
    p.rewardPoolSupply + p.curveSupply + p.lpSupply === p.totalSupply &&
    p.rewardPoolSupply > 0n &&
    p.lpSupply > 0n &&
    p.curveSupply > 0n &&
    p.initialVirtualToken > p.curveSupply &&
    p.initialVirtualSol > 0n &&
    curveConsistent(p);
  const b = PARAM_BOUNDS;
  const rewards =
    inRange(p.triggerMultipleBps, b.triggerMultipleBps) &&
    inRange(p.claimBps, b.claimBps) &&
    inRange(p.maxClaimPoolBps, b.maxClaimPoolBps) &&
    inRange(p.minSellUsdCents, b.minSellUsdCents) &&
    inRange(p.minHoldSecs, b.minHoldSecs) &&
    inRange(p.rebuyWindowSecs, b.rebuyWindowSecs) &&
    inRange(p.claimWindowSecs, b.claimWindowSecs) &&
    inRange(p.maxOpenTickets, b.maxOpenTickets);
  const n = BigInt(p.oracleMinSamples);
  const oracle =
    inRange(p.oracleWindowSecs, b.oracleWindowSecs) &&
    inRange(p.oracleMinSpacingSecs, b.oracleMinSpacingSecs) &&
    n * ORACLE_MIN_SAMPLE_EVERY_SECS >= p.oracleWindowSecs &&
    n <= p.oracleWindowSecs / p.oracleMinSpacingSecs &&
    p.oracleMinSamples <= 256 &&
    inRange(p.keeperStaleSecs, b.keeperStaleSecs) &&
    p.keeperStaleSecs > p.oracleMinSpacingSecs &&
    inRange(p.buybackMaxDeviationBps, b.buybackMaxDeviationBps) &&
    inRange(p.buybackMaxPoolBps, b.buybackMaxPoolBps) &&
    p.buybackMaxDeviationBps + 100 + 2 * p.buybackMaxPoolBps < 10_000;
  const pyth = p.solUsdFeedId.toLowerCase() === PYTH_SOL_USD_FEED_ID && inRange(p.maxPriceAgeSecs, b.maxPriceAgeSecs);
  const snipe = p.snipeWindowSlots <= 50 && p.snipeStartBps <= 9_900;
  return fees && supply && rewards && oracle && pyth && snipe;
}
