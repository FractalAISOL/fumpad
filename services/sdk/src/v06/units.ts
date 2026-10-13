/**
 * Raw ↔ display conversions — identical to app/src/data/chain.ts so the API's numbers
 * match what the app computes locally. Never round-trip transaction amounts through these.
 */
import { BASE_PER_TOKEN, LAMPORTS_PER_SOL, Q64 } from "./constants.js";

export const lamportsToSol = (l: bigint | number): number => Number(l) / Number(LAMPORTS_PER_SOL);
export const solToLamports = (s: number): bigint => BigInt(Math.round(s * Number(LAMPORTS_PER_SOL)));
export const baseToTokens = (b: bigint | number): number => Number(b) / Number(BASE_PER_TOKEN);
export const tokensToBase = (t: number): bigint => BigInt(Math.round(t * Number(BASE_PER_TOKEN)));

/** Q64.64 lamports-per-base-unit → SOL per whole token. */
export function q64ToSolPerToken(q: bigint): number {
  const whole = Number(q / Q64);
  const frac = Number(q % Q64) / Number(Q64);
  return ((whole + frac) * Number(BASE_PER_TOKEN)) / Number(LAMPORTS_PER_SOL);
}
/** SOL per whole token → Q64.64 lamports per base unit (approximate; display → math only). */
export function solPerTokenToQ64(p: number): bigint {
  const lamportsPerBase = (p * Number(LAMPORTS_PER_SOL)) / Number(BASE_PER_TOKEN);
  const whole = Math.floor(lamportsPerBase);
  const frac = lamportsPerBase - whole;
  return BigInt(whole) * Q64 + BigInt(Math.floor(frac * 2 ** 53)) * (Q64 >> 53n);
}

/** Apply slippage: floor(x × (10_000 − bps) / 10_000). */
export const withSlippage = (x: bigint, bps: number): bigint => (x * BigInt(10_000 - bps)) / 10_000n;
