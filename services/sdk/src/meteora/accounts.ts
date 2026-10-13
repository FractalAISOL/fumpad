/**
 * Meteora DBC 0.2.1 / DAMM v2 0.2.4 account decoders (byte offsets incl. the 8-byte discriminator, from
 * the programs' sources: dynamic-bonding-curve state/{virtual_pool,config}.rs, cp-amm state/pool.rs).
 */
import { PublicKey } from "@solana/web3.js";

const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const pk = (d: Uint8Array, off: number) => new PublicKey(d.subarray(off, off + 32));
const u64 = (d: Uint8Array, off: number) => dv(d).getBigUint64(off, true);
const u128 = (d: Uint8Array, off: number) => u64(d, off) | (u64(d, off + 8) << 64n);

/** DBC migration_progress values. */
/** Anchor account discriminators (sha256("account:<Name>")[..8]) of the Meteora accounts decoded here. */
export const METEORA_ACCOUNT_DISCRIMINATOR = {
  dbcPoolConfig: Uint8Array.from([26, 108, 14, 123, 116, 230, 129, 43]),
  dbcVirtualPool: Uint8Array.from([213, 224, 5, 209, 98, 69, 119, 92]),
  dammPool: Uint8Array.from([241, 154, 109, 4, 17, 177, 109, 188]),
} as const;
/** True when `data` starts with that Meteora account discriminator. */
export const hasMeteoraDiscriminator = (data: Uint8Array, kind: keyof typeof METEORA_ACCOUNT_DISCRIMINATOR): boolean =>
  METEORA_ACCOUNT_DISCRIMINATOR[kind].every((b, i) => data[i] === b);

export const DBC_MIGRATION_PROGRESS = { preBondingCurve: 0, postBondingCurve: 1, lockedVesting: 2, createdPool: 3 } as const;

export interface DbcVirtualPool {
  config: PublicKey;
  creator: PublicKey;
  baseMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  baseReserve: bigint;
  quoteReserve: bigint;
  protocolBaseFee: bigint;
  protocolQuoteFee: bigint;
  partnerBaseFee: bigint;
  partnerQuoteFee: bigint;
  sqrtPrice: bigint;
  activationPoint: bigint;
  poolType: number;
  isMigrated: number;
  isPartnerWithdrawSurplus: number;
  migrationProgress: number;
  isWithdrawLeftover: number;
  migrationFeeWithdrawStatus: number;
  finishCurveTimestamp: bigint;
}

/** VirtualPool (zero-copy, 8 + 416 bytes). */
export function decodeDbcPool(d: Uint8Array): DbcVirtualPool {
  if (d.length < 424) throw new Error(`DBC pool is ${d.length} bytes`);
  return {
    config: pk(d, 72),
    creator: pk(d, 104),
    baseMint: pk(d, 136),
    baseVault: pk(d, 168),
    quoteVault: pk(d, 200),
    baseReserve: u64(d, 232),
    quoteReserve: u64(d, 240),
    protocolBaseFee: u64(d, 248),
    protocolQuoteFee: u64(d, 256),
    partnerBaseFee: u64(d, 264),
    partnerQuoteFee: u64(d, 272),
    sqrtPrice: u128(d, 280),
    activationPoint: u64(d, 296),
    poolType: d[304],
    isMigrated: d[305],
    isPartnerWithdrawSurplus: d[306],
    migrationProgress: d[308],
    isWithdrawLeftover: d[309],
    migrationFeeWithdrawStatus: d[311],
    finishCurveTimestamp: u64(d, 344),
  };
}

export interface DbcCurvePoint {
  sqrtPrice: bigint;
  liquidity: bigint;
}

export interface DbcBaseFee {
  cliffFeeNumerator: bigint;
  /** fee scheduler: number_of_period (first_factor) */
  numberOfPeriod: number;
  /** period_frequency (second_factor) */
  periodFrequency: bigint;
  /** reduction_factor (third_factor) */
  reductionFactor: bigint;
  /** 0 linear, 1 exponential, 2 rate limiter */
  baseFeeMode: number;
}

export interface DbcPoolConfig {
  quoteMint: PublicKey;
  feeClaimer: PublicKey;
  leftoverReceiver: PublicKey;
  baseFee: DbcBaseFee;
  collectFeeMode: number;
  migrationOption: number;
  activationType: number;
  tokenDecimal: number;
  tokenType: number;
  partnerPermanentLockedLiquidityPercentage: number;
  migrationFeeOption: number;
  fixedTokenSupplyFlag: number;
  creatorTradingFeePercentage: number;
  migrationFeePercentage: number;
  swapBaseAmount: bigint;
  migrationQuoteThreshold: bigint;
  migrationBaseThreshold: bigint;
  migrationSqrtPrice: bigint;
  preMigrationTokenSupply: bigint;
  postMigrationTokenSupply: bigint;
  migratedCollectFeeMode: number;
  migratedPoolFeeBps: number;
  enableFirstSwapWithMinFee: number;
  poolCreationFee: bigint;
  sqrtStartPrice: bigint;
  /** Non-empty segments (sqrt_price > 0). */
  curve: DbcCurvePoint[];
}

export const DBC_CONFIG_SIZE = 1048;
/** sqrt_start_price offset (engine reference init). */
export const DBC_CONFIG_SQRT_START_PRICE_OFFSET = 392;

/** PoolConfig (zero-copy, 8 + 1040 bytes). */
export function decodeDbcConfig(d: Uint8Array): DbcPoolConfig {
  if (d.length < DBC_CONFIG_SIZE) throw new Error(`DBC config is ${d.length} bytes`);
  const v = dv(d);
  const curve: DbcCurvePoint[] = [];
  for (let i = 0; i < 20; i++) {
    const off = 408 + i * 32;
    const sqrtPrice = u128(d, off);
    if (sqrtPrice === 0n) break;
    curve.push({ sqrtPrice, liquidity: u128(d, off + 16) });
  }
  return {
    quoteMint: pk(d, 8),
    feeClaimer: pk(d, 40),
    leftoverReceiver: pk(d, 72),
    baseFee: {
      cliffFeeNumerator: u64(d, 104),
      periodFrequency: u64(d, 112),
      reductionFactor: u64(d, 120),
      numberOfPeriod: v.getUint16(128, true),
      baseFeeMode: d[130],
    },
    collectFeeMode: d[232],
    migrationOption: d[233],
    activationType: d[234],
    tokenDecimal: d[235],
    tokenType: d[237],
    partnerPermanentLockedLiquidityPercentage: d[239],
    migrationFeeOption: d[243],
    fixedTokenSupplyFlag: d[244],
    creatorTradingFeePercentage: d[245],
    migrationFeePercentage: d[247],
    swapBaseAmount: u64(d, 256),
    migrationQuoteThreshold: u64(d, 264),
    migrationBaseThreshold: u64(d, 272),
    migrationSqrtPrice: u128(d, 280),
    preMigrationTokenSupply: u64(d, 344),
    postMigrationTokenSupply: u64(d, 352),
    migratedCollectFeeMode: d[360],
    migratedPoolFeeBps: v.getUint16(362, true),
    enableFirstSwapWithMinFee: d[365],
    poolCreationFee: u64(d, 368),
    sqrtStartPrice: u128(d, 392),
    curve,
  };
}

export interface DammPool {
  /** pool_fees.base_fee.base_fee_info: cliff fee numerator (1e9 = 100%) and mode */
  cliffFeeNumerator: bigint;
  baseFeeMode: number;
  protocolFeePercent: number;
  tokenAMint: PublicKey;
  tokenBMint: PublicKey;
  tokenAVault: PublicKey;
  tokenBVault: PublicKey;
  liquidity: bigint;
  sqrtMinPrice: bigint;
  sqrtMaxPrice: bigint;
  sqrtPrice: bigint;
  activationPoint: bigint;
  activationType: number;
  poolStatus: number;
  collectFeeMode: number;
  permanentLockLiquidity: bigint;
  creator: PublicKey;
  tokenAAmount: bigint;
  tokenBAmount: bigint;
}

/** DAMM v2 Pool (zero-copy, 8 + 1104 bytes). */
export function decodeDammPool(d: Uint8Array): DammPool {
  if (d.length < 8 + 1104) throw new Error(`DAMM v2 pool is ${d.length} bytes`);
  return {
    cliffFeeNumerator: u64(d, 8),
    baseFeeMode: d[16],
    protocolFeePercent: d[8 + 40],
    tokenAMint: pk(d, 168),
    tokenBMint: pk(d, 200),
    tokenAVault: pk(d, 232),
    tokenBVault: pk(d, 264),
    liquidity: u128(d, 360),
    sqrtMinPrice: u128(d, 424),
    sqrtMaxPrice: u128(d, 440),
    sqrtPrice: u128(d, 456),
    activationPoint: u64(d, 472),
    activationType: d[480],
    poolStatus: d[481],
    collectFeeMode: d[484],
    permanentLockLiquidity: u128(d, 552),
    creator: pk(d, 648),
    tokenAAmount: u64(d, 680),
    tokenBAmount: u64(d, 688),
  };
}

/** Q64.64 price (quote raw per base raw) from a Meteora sqrt price: sqrt² >> 64. */
export const priceQ64FromSqrt = (sqrtPrice: bigint): bigint => (sqrtPrice * sqrtPrice) >> 64n;
/** SOL per whole token for a 6-dec base / 9-dec WSOL pool. */
export const solPerTokenFromSqrt = (sqrtPrice: bigint): number => (Number(sqrtPrice) / 2 ** 64) ** 2 * 1e-3;
