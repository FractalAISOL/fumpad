/**
 * FUMPAD DBC config (SPEC v0.7 §2; D30–D36): `create_config` parameters with the exact-8% curves derived
 * by the contracts (contracts/tests/src/meteora.rs `config_tests::derive_exact_curves`), and the borsh
 * encoding of DBC 0.2.1 `ConfigParameters` (field order of process_create_config.rs).
 */
import { type Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";

import { DBC_EVENT_AUTHORITY, DBC_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOTAL_SUPPLY_BASE, WSOL_MINT } from "../constants.js";
import { feeClaimerPda, rewardPoolPda } from "../pda.js";
import { DBC_IX } from "./instructions.js";

export interface DbcCurvePointParam {
  sqrtPrice: bigint;
  liquidity: bigint;
}

export interface DbcConfigParameters {
  baseFee: { cliffFeeNumerator: bigint; firstFactor: number; secondFactor: bigint; thirdFactor: bigint; baseFeeMode: number };
  collectFeeMode: number;
  migrationOption: number;
  activationType: number;
  tokenType: number;
  tokenDecimal: number;
  partnerLiquidityPercentage: number;
  partnerPermanentLockedLiquidityPercentage: number;
  creatorLiquidityPercentage: number;
  creatorPermanentLockedLiquidityPercentage: number;
  migrationQuoteThreshold: bigint;
  sqrtStartPrice: bigint;
  migrationFeeOption: number;
  tokenSupply: { pre: bigint; post: bigint } | null;
  creatorTradingFeePercentage: number;
  tokenUpdateAuthority: number;
  migrationFeePercentage: number;
  creatorMigrationFeePercentage: number;
  migratedCollectFeeMode: number;
  migratedDynamicFee: number;
  migratedPoolFeeBps: number;
  poolCreationFee: bigint;
  migratedPoolBaseFeeMode: number;
  enableFirstSwapWithMinFee: boolean;
  compoundingFeeBps: number;
  curve: DbcCurvePointParam[];
}

/** D33: 99% → 1.25% linear over 8 periods of 1 slot. */
export const SNIPE_CLIFF_FEE_NUMERATOR = 990_000_000n;
export const SNIPE_REDUCTION = 122_187_500n;
export const SNIPE_PERIODS = 8;
/**
 * First-coin "launch config" (user decision 2026-10-14; SPEC Clarification 29): 99% → 3% linear over 25 periods of
 * 1 slot (≈ 10 s; (990,000,000 − 30,000,000) / 25 exact), then 3% on the curve; migrated DAMM v2 fee 3% (`OnlyB`).
 * Curve / supply / leftover / locks identical to the standard config. Allow-listed with a wallet-split fee policy.
 */
export const FIRST_COIN_PERIODS = 25;
export const FIRST_COIN_REDUCTION = 38_400_000n;
export const FIRST_COIN_FEE_BPS = 300;
/** D34: DBC's migration fee is an integer percentage → 1% of the raise to the partner. */
export const MIGRATION_FEE_PERCENTAGE = 1;
export const MAX_SQRT_PRICE = 79_226_673_521_066_979_257_578_248_091n;

/** (sqrt_start, sqrt_end, liquidity, buffer_liquidity) — contracts/tests/src/meteora.rs. */
export const FUMPAD_CURVES = {
  mainnet: { threshold: 85_000_000_000n, curve: [101585640748934272n, 389412012282537600n, 100491279145714397187999104294912n, 11682360368476127917215055872000n] },
  devnet: { threshold: 850_000_000n, curve: [10158564074893426n, 38941201228253744n, 10049127684724736583391138941440n, 1168236036847612369509040521216n] },
} as const;

export function fumpadConfigParams(network: keyof typeof FUMPAD_CURVES): DbcConfigParameters {
  const { threshold, curve } = FUMPAD_CURVES[network];
  const [s0, s1, l, lb] = curve;
  return {
    baseFee: { cliffFeeNumerator: SNIPE_CLIFF_FEE_NUMERATOR, firstFactor: SNIPE_PERIODS, secondFactor: 1n, thirdFactor: SNIPE_REDUCTION, baseFeeMode: 0 },
    collectFeeMode: 0,
    migrationOption: 1,
    activationType: 0,
    tokenType: 1,
    tokenDecimal: 6,
    partnerLiquidityPercentage: 0,
    partnerPermanentLockedLiquidityPercentage: 100,
    creatorLiquidityPercentage: 0,
    creatorPermanentLockedLiquidityPercentage: 0,
    migrationQuoteThreshold: threshold,
    sqrtStartPrice: s0,
    migrationFeeOption: 6,
    tokenSupply: { pre: TOTAL_SUPPLY_BASE, post: TOTAL_SUPPLY_BASE },
    creatorTradingFeePercentage: 0,
    tokenUpdateAuthority: 1,
    migrationFeePercentage: MIGRATION_FEE_PERCENTAGE,
    creatorMigrationFeePercentage: 0,
    migratedCollectFeeMode: 0,
    migratedDynamicFee: 0,
    migratedPoolFeeBps: 125,
    poolCreationFee: 0n,
    migratedPoolBaseFeeMode: 0,
    enableFirstSwapWithMinFee: true,
    compoundingFeeBps: 0,
    curve: [
      { sqrtPrice: s1, liquidity: l },
      { sqrtPrice: MAX_SQRT_PRICE, liquidity: lb },
    ],
  };
}

/** The first-coin config: `fumpadConfigParams` with the 99% → 3% / 25-slot scheduler and a 3% DAMM v2 fee. */
export function firstCoinConfigParams(network: keyof typeof FUMPAD_CURVES): DbcConfigParameters {
  const p = fumpadConfigParams(network);
  return { ...p, baseFee: { ...p.baseFee, firstFactor: FIRST_COIN_PERIODS, thirdFactor: FIRST_COIN_REDUCTION }, migratedPoolFeeBps: FIRST_COIN_FEE_BPS };
}

class B {
  private readonly parts: number[] = [];
  u8(x: number) {
    this.parts.push(x & 0xff);
    return this;
  }
  bool(x: boolean) {
    return this.u8(x ? 1 : 0);
  }
  le(x: bigint, bytes: number) {
    let v = BigInt.asUintN(bytes * 8, x);
    for (let i = 0; i < bytes; i++) {
      this.parts.push(Number(v & 0xffn));
      v >>= 8n;
    }
    return this;
  }
  u16 = (x: number) => this.le(BigInt(x), 2);
  u32 = (x: number) => this.le(BigInt(x), 4);
  u64 = (x: bigint) => this.le(x, 8);
  u128 = (x: bigint) => this.le(x, 16);
  bytes(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

/** borsh(ConfigParameters) for DBC 0.2.1 (dynamic fee None, no vesting, market-cap scheduler zeroed). */
export function encodeDbcConfigParameters(p: DbcConfigParameters): Uint8Array {
  const b = new B();
  b.u64(p.baseFee.cliffFeeNumerator).u16(p.baseFee.firstFactor).u64(p.baseFee.secondFactor).u64(p.baseFee.thirdFactor).u8(p.baseFee.baseFeeMode);
  b.u8(0); // dynamic_fee: None
  b.u8(p.collectFeeMode).u8(p.migrationOption).u8(p.activationType).u8(p.tokenType).u8(p.tokenDecimal);
  b.u8(p.partnerLiquidityPercentage).u8(p.partnerPermanentLockedLiquidityPercentage).u8(p.creatorLiquidityPercentage).u8(p.creatorPermanentLockedLiquidityPercentage);
  b.u64(p.migrationQuoteThreshold).u128(p.sqrtStartPrice);
  for (let i = 0; i < 5; i++) b.u64(0n); // locked_vesting (all zero)
  b.u8(p.migrationFeeOption);
  if (p.tokenSupply) b.u8(1).u64(p.tokenSupply.pre).u64(p.tokenSupply.post);
  else b.u8(0);
  b.u8(p.creatorTradingFeePercentage).u8(p.tokenUpdateAuthority).u8(p.migrationFeePercentage).u8(p.creatorMigrationFeePercentage);
  b.u8(p.migratedCollectFeeMode).u8(p.migratedDynamicFee).u16(p.migratedPoolFeeBps).u64(p.poolCreationFee);
  for (let k = 0; k < 2; k++) b.u8(0).u16(0).u16(0).u32(0).u32(0); // partner / creator liquidity vesting info
  b.u8(p.migratedPoolBaseFeeMode);
  b.u16(0).u16(0).u32(0).u64(0n); // migrated_pool_market_cap_fee_scheduler_params
  b.bool(p.enableFirstSwapWithMinFee).u16(p.compoundingFeeBps).u8(0).u8(0); // padding [u8; 2]
  b.u32(p.curve.length);
  for (const c of p.curve) b.u128(c.sqrtPrice).u128(c.liquidity);
  return b.bytes();
}

/** DBC `create_config` with fee_claimer = PDA["fee_claimer"], leftover_receiver = PDA["reward_pool"]. `config` = fresh keypair (signs). */
export function dbcCreateConfigIx(a: { config: PublicKey | Keypair; payer: PublicKey; params: DbcConfigParameters }): TransactionInstruction {
  const config = "publicKey" in a.config ? a.config.publicKey : a.config;
  const body = encodeDbcConfigParameters(a.params);
  const data = new Uint8Array(8 + body.length);
  data.set(DBC_IX.createConfig, 0);
  data.set(body, 8);
  const m = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });
  return new TransactionInstruction({
    programId: DBC_PROGRAM_ID,
    keys: [
      m(config, true, true),
      m(feeClaimerPda(), false, false),
      m(rewardPoolPda(), false, false),
      m(WSOL_MINT, false, false),
      m(a.payer, true, true),
      m(SYSTEM_PROGRAM_ID, false, false),
      m(DBC_EVENT_AUTHORITY, false, false),
      m(DBC_PROGRAM_ID, false, false),
    ],
    data: Buffer.from(data),
  });
}
