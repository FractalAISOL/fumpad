// Claim / fee-split math (ports of rewards/logic.rs claim helpers and the v0.7 fee split).
import { BPS_DENOM } from "../constants.js";

/** Tokens owed for a ticket: tokens × claim_bps / 10_000, floor. */
export const claimAmount = (tokens: bigint, claimBps: number | bigint): bigint => (tokens * BigInt(claimBps)) / BPS_DENOM;
/** Per-claim cap: pool × max_claim_pool_bps / 10_000, floor. */
export const claimCap = (pool: bigint, maxClaimPoolBps: number | bigint): bigint => (pool * BigInt(maxClaimPoolBps)) / BPS_DENOM;
/** Payable from `pool` now: > 0, ≤ the per-claim cap, ≤ the pool. */
export const fits = (amount: bigint, pool: bigint, maxClaimPoolBps: number | bigint): boolean => amount > 0n && amount <= claimCap(pool, maxClaimPoolBps) && amount <= pool;

/**
 * v0.7 claim_fees split: platform and creator exact floors, rounding remainder → buyback. The first claim
 * after the launch window (`launchWindow`) sends 100% to buyback (D33).
 */
export function splitFees(claimed: bigint, split: { buybackBps: number; platformBps: number; creatorBps: number }, launchWindow: boolean) {
  if (launchWindow) return { buyback: claimed, platform: 0n, creator: 0n };
  const platform = (claimed * BigInt(split.platformBps)) / BPS_DENOM;
  const creator = (claimed * BigInt(split.creatorBps)) / BPS_DENOM;
  return { buyback: claimed - platform - creator, platform, creator };
}

/** Port of Coin::roll_attest_buckets + attest_fits (sliding-hour attestation cap, INTERFACE §5.3). bucketStart = unix ts of the bucket. */
export function attestRateAllows(a: { now: bigint; bucketStart: bigint; curTokens: bigint; prevTokens: bigint; totalSupply: bigint; bps: number; ticketTokens: bigint }): boolean {
  const H = 3_600n;
  const bucket = (a.now >= 0n ? a.now / H : (a.now - H + 1n) / H) * H;
  let cur = a.curTokens;
  let prev = a.prevTokens;
  let start = a.bucketStart;
  if (bucket !== start) {
    prev = bucket === start + H ? cur : 0n;
    cur = 0n;
    start = bucket;
  }
  let into = a.now - start;
  if (into < 0n) into = 0n;
  if (into > H) into = H;
  const weighted = (prev * (H - into)) / H;
  return weighted + cur + a.ticketTokens <= (a.totalSupply * BigInt(a.bps)) / BPS_DENOM;
}
