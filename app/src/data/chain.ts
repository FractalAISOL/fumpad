/**
 * Conversions between raw on-chain units and the display units in `types.ts`.
 * The real indexer client uses these to map Anchor events (events.rs) into app types.
 */

export const TOKEN_DECIMALS = 6;
export const LAMPORTS_PER_SOL = 1_000_000_000;
const BASE_PER_TOKEN = 10 ** TOKEN_DECIMALS;
const Q64 = BigInt(1) << BigInt(64);

/**
 * Mainnet program defaults from `constants.rs` (v0.5). Only a fallback: views read the live
 * `Global.params` through `getParams()` (`useProtocolParams()`), and devnet runs its own scaled
 * curve. Keep in sync with contracts/CONTRACTS.md when the defaults change.
 */
export const PARAMS = {
  totalSupply: 1_000_000_000,
  rewardPoolSupply: 80_000_000,
  curveSupply: 730_811_425.785218,
  lpSupply: 189_188_574.214782,
  initialVirtualSol: 30,
  initialVirtualTokens: 988_744_870.180001,
  graduationSol: 85,
  feeBps: 100,
  feePoolShareBps: 5_000,
  feePlatformShareBps: 3_000,
  feeCreatorShareBps: 2_000,
  triggerMultiple: 10,
  claimBps: 1_000,
  maxClaimPoolBps: 1_000,
  minSellUsd: 50,
  minHoldSecs: 600,
  rebuyWindowSecs: 7 * 86_400,
  claimWindowSecs: 90 * 86_400,
  maxOpenTickets: 5,
  oracleWindowSecs: 1_800,
  oracleMinSamples: 84,
  snipeWindowSlots: 4,
  snipeStartBps: 9_900,
  graduationFeeSol: 0.65,
} as const;

/** A coin's graduation target in SOL: from the data source when it has one (devnet runs a scaled-down curve). */
export function graduationSolOf(c: { graduationSol?: number }): number {
  return c.graduationSol ?? PARAMS.graduationSol;
}

export function lamportsToSol(l: bigint | number): number {
  return Number(l) / LAMPORTS_PER_SOL;
}
export function solToLamports(s: number): bigint {
  return BigInt(Math.round(s * LAMPORTS_PER_SOL));
}
export function baseToTokens(b: bigint | number): number {
  return Number(b) / BASE_PER_TOKEN;
}
export function tokensToBase(t: number): bigint {
  return BigInt(Math.round(t * BASE_PER_TOKEN));
}

/** Q64.64 lamports-per-base-unit → SOL per whole token. */
export function q64ToSolPerToken(q: bigint): number {
  const whole = Number(q / Q64);
  const frac = Number(q % Q64) / Number(Q64);
  return ((whole + frac) * BASE_PER_TOKEN) / LAMPORTS_PER_SOL;
}

/** `TicketStatus` enum index (Anchor borsh order) → app status. */
export const TICKET_STATUS = ["open", "queued", "claimed", "expired", "voided"] as const;
/** `CoinStatus` enum index → app status. */
export const COIN_STATUS = ["curve", "complete", "graduated"] as const;

/* ── Curve math (constant product on virtual reserves, docs/SPEC.md §3) ───── */

export function curvePrice(virtualSol: number, virtualTokens: number): number {
  return virtualSol / virtualTokens;
}

/** Tokens out for `solIn` (after fee) on reserves (x, y). */
export function cpOut(reserveIn: number, reserveOut: number, amountIn: number): number {
  return (reserveOut * amountIn) / (reserveIn + amountIn);
}

/** Real SOL raised → spot price on the default curve. */
export function curvePriceAt(raisedSol: number): number {
  const vs = PARAMS.initialVirtualSol + raisedSol;
  const k = PARAMS.initialVirtualSol * PARAMS.initialVirtualTokens;
  return (vs * vs) / k;
}
