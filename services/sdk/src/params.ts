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
  maxPriceAgeSecs: 60n,
  snipeWindowSlots: 4,
  snipeStartBps: 9_900,
};

/** Mirror of `Params::is_valid` (initialize / queue / execute), incl. the D14 caps. */
export function paramsValid(p: Params): boolean {
  return (
    p.graduationFeeLamports <= 1_000_000_000n &&
    p.feeBps <= 200 &&
    p.feePoolShareBps + p.feePlatformShareBps + p.feeCreatorShareBps === 10_000 &&
    p.feeBps < 10_000 &&
    p.rewardPoolSupply + p.curveSupply + p.lpSupply === p.totalSupply &&
    p.initialVirtualToken > p.curveSupply &&
    p.initialVirtualSol > 0n &&
    p.graduationLamports > p.graduationFeeLamports &&
    p.triggerMultipleBps > 10_000 &&
    p.claimBps <= 10_000 &&
    p.maxClaimPoolBps <= 10_000 &&
    p.maxOpenTickets <= 5 &&
    p.oracleMinSpacingSecs > 0n &&
    p.oracleWindowSecs > p.oracleMinSpacingSecs &&
    p.oracleMinSamples <= 256 &&
    p.snipeWindowSlots <= 50 &&
    p.snipeStartBps <= 9_900
  );
}
