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

/**
 * Port of the v0.7 rate cap (INTERFACE §5.3, REVIEW-v0.7 M-1: a leaky bucket that DEFERS, never rejects):
 * `cap = max(1, supply × bps / 10,000)` tokens per hour; `cursor = max(attest_cursor, now) + ⌈tokens × 3600 /
 * cap⌉`; the ticket is effective (claimable / voidable window start) at `max(now, cursor − 3600)`.
 */
export function attestEffectiveAt(a: { now: bigint; attestCursor: bigint; totalSupply: bigint; bps: number; ticketTokens: bigint }): { effectiveAt: bigint; cursor: bigint } {
  const H = 3_600n;
  let cap = (a.totalSupply * BigInt(a.bps)) / BPS_DENOM;
  if (cap < 1n) cap = 1n;
  const start = a.attestCursor > a.now ? a.attestCursor : a.now;
  const cursor = start + (a.ticketTokens * H + cap - 1n) / cap;
  const eff = cursor - H;
  return { effectiveAt: eff > a.now ? eff : a.now, cursor };
}
