// FUMPAD D17-like curve expressed as a DBC config (SDK curve builders). No network access.
import BN from "bn.js";
import Decimal from "decimal.js";
import {
  buildCurve,
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  MigrationOption,
  MigrationFeeOption,
  MigratedCollectFeeMode,
  TokenType,
  TokenDecimal,
  TokenAuthorityOption,
  DammV2DynamicFeeMode,
  getPriceFromSqrtPrice,
  getBaseTokenForSwap,
  type ConfigParameters,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

export type CurveVariant = {
  raiseSol: number; // migration quote threshold (SOL)
  supply: number; // tokens (UI)
  rewardPool: number; // tokens (UI) -> leftover
  lpPct: number; // % of supply deposited into DAMM v2 at migration
  snipeSlots: number; // anti-snipe periods (1 slot each)
};

// D17 with F = 0 (no graduation fee in DBC; its migration fee is a % of the raise instead):
// virtual 30 SOL, raise 85 SOL -> curve 729.655M, LP 190.345M, reward 80M (see SPEC.md §3 "v0.4 (F = 0)").
export const D17_LP_PCT = (190_344_827.586207 / 1_000_000_000) * 100;

export const MAINNET_D17: CurveVariant = { raiseSol: 85, supply: 1e9, rewardPool: 80e6, lpPct: D17_LP_PCT, snipeSlots: 8 };
export const DEVNET_D17: CurveVariant = { raiseSol: 0.85, supply: 1e9, rewardPool: 80e6, lpPct: D17_LP_PCT, snipeSlots: 8 };

export function buildFumpadConfig(v: CurveVariant): ConfigParameters {
  return buildCurve({
    token: {
      tokenType: TokenType.Token2022,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: 9,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: v.supply,
      leftover: v.rewardPool,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: {
          startingFeeBps: 9900,
          endingFeeBps: 125,
          numberOfPeriod: v.snipeSlots,
          totalDuration: v.snipeSlots, // activationType = Slot -> 1 slot per period
        },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 0, // all non-protocol fee -> partner (our PDA); we route 20% to the creator ourselves
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: true,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.Customizable,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
      migratedPoolFee: {
        collectFeeMode: MigratedCollectFeeMode.QuoteToken, // -> DAMM v2 OnlyB (fees in SOL)
        dynamicFee: DammV2DynamicFeeMode.Disabled,
        poolFeeBps: 125,
      },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 100,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 0,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Slot,
    percentageSupplyOnMigration: v.lpPct,
    migrationQuoteThreshold: v.raiseSol,
  });
}

export function describe(cfg: ConfigParameters) {
  const curve = cfg.curve.map((c) => ({ sqrtPrice: c.sqrtPrice.toString(), liquidity: c.liquidity.toString() }));
  const startPrice = getPriceFromSqrtPrice(cfg.sqrtStartPrice, 6, 9); // SOL per token (UI)
  const pts = cfg.curve.map((c) => getPriceFromSqrtPrice(c.sqrtPrice, 6, 9).toString());
  const swapBase = getBaseTokenForSwap(cfg.sqrtStartPrice, cfg.curve[0].sqrtPrice, cfg.curve);
  return {
    sqrtStartPrice: cfg.sqrtStartPrice.toString(),
    startPriceSolPerToken: startPrice.toString(),
    startMcSol: startPrice.mul(1e9).toString(),
    curve,
    curvePointPricesSolPerToken: pts,
    migrationQuoteThreshold: cfg.migrationQuoteThreshold.toString(),
    tokenSupply: { pre: cfg.tokenSupply?.preMigrationTokenSupply.toString(), post: cfg.tokenSupply?.postMigrationTokenSupply.toString() },
    baseOnFirstSegment: swapBase.toString(),
    baseFee: {
      cliffFeeNumerator: cfg.poolFees.baseFee.cliffFeeNumerator.toString(),
      firstFactor: cfg.poolFees.baseFee.firstFactor,
      secondFactor: cfg.poolFees.baseFee.secondFactor.toString(),
      thirdFactor: cfg.poolFees.baseFee.thirdFactor.toString(),
      baseFeeMode: cfg.poolFees.baseFee.baseFeeMode,
    },
  };
}

if (process.argv[1]?.endsWith("curve.ts")) {
  Decimal.set({ precision: 50 });
  for (const [name, v] of [["mainnet", MAINNET_D17], ["devnet", DEVNET_D17]] as const) {
    const cfg = buildFumpadConfig(v);
    console.log(name, JSON.stringify(describe(cfg), null, 2));
  }
}
