/**
 * A coin's own fees (contracts INTERFACE §5.9): standard coins pay the protocol's fee (1.25%, FUMPAD's share split
 * pool / FUMPAD / creator); the one-off first-coin config pays 3% with FUMPAD's share split between the coin's reward
 * pool (buybacks) and a designated wallet. Every fee the coin page shows comes from here, so it is the coin's real
 * one. No React, no `@/` imports (unit-tested by `fees.test.ts`).
 */
import type { CoinDetail, ProtocolParams } from "./types";

export interface CoinFeeView {
  /** The fee a trade pays now, bps: the curve fee, or the DAMM v2 pool's after graduation. */
  feeBps: number;
  snipeStartBps: number;
  snipeWindowSlots: number;
  /** Meteora's protocol share of the fee, bps of the fee. */
  venueFeeShareBps: number;
  /** FUMPAD's share of each fee, split (shares in % of FUMPAD's share, summing to 100). */
  parts: { label: string; share: number }[];
  /** Wallet split (first-coin config) only. */
  wallet?: { address: string; poolPctOfVolume: number; walletPctOfVolume: number };
}

type Params = Pick<ProtocolParams, "feeBps" | "snipeStartBps" | "snipeWindowSlots" | "venueFeeShareBps" | "feePoolShareBps" | "feePlatformShareBps" | "feeCreatorShareBps">;

export function coinFeeView(params: Params, coin: Pick<CoinDetail, "status" | "fees">): CoinFeeView {
  const f = coin.fees;
  const graduated = coin.status === "graduated";
  const feeBps = f ? (graduated ? f.migratedFeeBps : f.feeBps) : params.feeBps;
  const base = { feeBps, snipeStartBps: f?.snipeStartBps ?? params.snipeStartBps, snipeWindowSlots: f?.snipeWindowSlots ?? params.snipeWindowSlots, venueFeeShareBps: params.venueFeeShareBps };
  if (f?.policy === "wallet_split" && f.wallet && f.walletShareBps) {
    const pool = f.poolShareBps ?? 0;
    const total = pool + f.walletShareBps;
    const poolShare = (pool / total) * 100;
    return {
      ...base,
      parts: [
        { label: "pool", share: poolShare },
        { label: "fee wallet", share: 100 - poolShare },
      ],
      wallet: { address: f.wallet, poolPctOfVolume: pool / 100, walletPctOfVolume: f.walletShareBps / 100 },
    };
  }
  return {
    ...base,
    parts: [
      { label: "pool", share: params.feePoolShareBps / 100 },
      { label: "FUMPAD", share: params.feePlatformShareBps / 100 },
      { label: "creator", share: params.feeCreatorShareBps / 100 },
    ],
  };
}

/** Solana's target slot time, seconds. */
const SLOT_SECS = 0.4;
/** Slack on top of the launch window when judging by the coin's age (clock skew, indexer lag). */
const WINDOW_AGE_SLACK_SECS = 15;

/**
 * APP-3: does a one-click buy have to stop and ask because of the launch-window fee? Yes when the buy's own quote says
 * it lands in the window at a fee above the coin's standard fee (`snipeTaxBps`, up to 99%), or — failing safe when a
 * quote carries no window info — when the coin is on its curve and younger than the window (+ slack). Returns what to
 * tell the user, or null for a normal buy.
 */
export function launchWindowGuard(
  quote: { snipeTaxBps?: number; snipeTaxSol?: number },
  coin: { status: string; createdAt: number },
  p: { feeBps: number; snipeStartBps: number; snipeWindowSlots: number },
  now: number,
): { bps: number; extraSol?: number; byAge: boolean } | null {
  if (quote.snipeTaxBps !== undefined && quote.snipeTaxBps > p.feeBps) return { bps: quote.snipeTaxBps, extraSol: quote.snipeTaxSol, byAge: false };
  if (quote.snipeTaxBps === undefined && coin.status === "curve") {
    const windowMs = (Math.max(1, p.snipeWindowSlots) * SLOT_SECS + WINDOW_AGE_SLACK_SECS) * 1000;
    if (now - coin.createdAt < windowMs) return { bps: p.snipeStartBps, byAge: true };
  }
  return null;
}
