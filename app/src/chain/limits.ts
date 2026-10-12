/**
 * What a transaction really costs the wallet, and when Instant trading must ask first.
 *
 * M-9 (security-review/REPORT.md): the per-trade limit used to compare only the amount typed,
 * so the 1% fee (on launches) and first-time account rent (token account, Position, a new
 * coin's accounts) went through silently on top. The limit now applies to the wallet's actual
 * outflow: simulated from the built transaction when the RPC answers, else a worst case.
 *
 * L-8: Instant trading also has a session cap (default 5 SOL): once the instant outflow in this
 * browser session reaches it, every trade asks on screen, whatever its size.
 *
 * No React, no `@/` imports: unit-tested by `limits.test.ts` with `npm test`.
 */
import type { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { MAX_PRIORITY_FEE_LAMPORTS } from "./allowlist";

const LAMPORTS = 1_000_000_000;
const big = (n: number) => BigInt(n);

/** Rent for `bytes` of account data: (128 + bytes) × 3480 × 2 lamports (Solana's exemption formula). */
export const rentFor = (bytes: number) => big((128 + bytes) * 6960);
/** The wallet's Token-2022 ATA (165 + account type + ImmutableOwner TLV, with room for transfer-fee state). */
export const ATA_RENT = rentFor(182);
/** FUMPAD Position PDA (8 + Position::INIT_SPACE 322). */
export const POSITION_RENT = rentFor(330);
/** First buy of a coin: the program creates both (init_if_needed). */
export const FIRST_TIME_RENT = ATA_RENT + POSITION_RENT;
/**
 * A launch: Token-2022 mint with metadata (≤ ~700 B), Coin, two vaults, plus the creator's ATA and
 * Position for the first buy. Rounded up; only used when simulation isn't available.
 */
export const LAUNCH_RENT = big(30_000_000);
const BASE_FEE = big(5_000);

/** Worst-case outflow for an action when the transaction can't be simulated. */
export function worstCaseSpend(kind: "buy" | "launch" | "other", amountLamports: bigint): bigint {
  const rent = kind === "launch" ? LAUNCH_RENT : kind === "buy" ? FIRST_TIME_RENT : POSITION_RENT;
  return (amountLamports > big(0) ? amountLamports : big(0)) + rent + MAX_PRIORITY_FEE_LAMPORTS + BASE_FEE * big(2);
}

/**
 * Lamports `wallet` loses if `tx` lands: buy amounts, the FUMPAD fee, account rent and network
 * fees, from a simulation of the exact message. Sells come out ≤ 0 (they pay the wallet).
 * Returns null if the RPC can't simulate it (the caller falls back to `worstCaseSpend`).
 */
export async function simulateSpend(connection: Connection, tx: VersionedTransaction, wallet: PublicKey): Promise<bigint | null> {
  try {
    const [pre, sim] = await Promise.all([
      connection.getBalance(wallet, "confirmed"),
      connection.simulateTransaction(tx, {
        sigVerify: false,
        replaceRecentBlockhash: false,
        commitment: "confirmed",
        accounts: { encoding: "base64", addresses: [wallet.toBase58()] },
      }),
    ]);
    const post = sim.value.accounts?.[0]?.lamports;
    if (sim.value.err || typeof post !== "number") return null;
    // Network fee, in case the simulation's post-balance leaves it out (over-counting is the safe side).
    const fee = BASE_FEE * big(tx.message.header.numRequiredSignatures);
    return big(pre) - big(post) + fee;
  } catch {
    return null;
  }
}

export interface InstantLimits {
  /** Per-trade: above this the trade asks first (SOL). */
  maxSol: number;
  /** Per session: once instant spending reaches this, every trade asks (SOL). */
  sessionCapSol: number;
}

export type InstantDecision = { ask: false } | { ask: true; reason: "trade-limit" | "session-cap" };

/** Sign silently, or ask on screen first? `spend` and `sessionSpent` in lamports. */
export function instantDecision(spend: bigint, sessionSpent: bigint, l: InstantLimits): InstantDecision {
  const cap = solLamports(l.sessionCapSol);
  if (sessionSpent >= cap || sessionSpent + (spend > big(0) ? spend : big(0)) > cap) return { ask: true, reason: "session-cap" };
  if (spend > solLamports(l.maxSol)) return { ask: true, reason: "trade-limit" };
  return { ask: false };
}

export function solLamports(sol: number): bigint {
  return big(Math.round(sol * LAMPORTS));
}
export function lamportsSol(l: bigint): number {
  return Number(l) / LAMPORTS;
}
