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
