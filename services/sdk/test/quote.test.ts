// DBC / DAMM v2 quote math against the FUMPAD curve's known totals (contracts: exact 8% curves).
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  type DammPool,
  type DbcPoolConfig,
  type DbcVirtualPool,
  dbcFeeNumerator,
  deltaBase,
  deltaQuote,
  FUMPAD_CURVES,
  fumpadConfigParams,
  quoteDammBuy,
  quoteDammSell,
  quoteDbcBuy,
  quoteDbcSell,
  virtualReserves,
} from "../src/index.js";

function cfgFor(net: "mainnet" | "devnet"): DbcPoolConfig {
  const p = fumpadConfigParams(net);
  return {
    baseFee: { cliffFeeNumerator: p.baseFee.cliffFeeNumerator, numberOfPeriod: p.baseFee.firstFactor, periodFrequency: p.baseFee.secondFactor, reductionFactor: p.baseFee.thirdFactor, baseFeeMode: 0 },
    migrationQuoteThreshold: p.migrationQuoteThreshold,
    migrationSqrtPrice: p.curve[0].sqrtPrice,
    sqrtStartPrice: p.sqrtStartPrice,
    curve: p.curve,
  } as DbcPoolConfig;
}
const pool = (sqrtPrice: bigint): DbcVirtualPool => ({ sqrtPrice, activationPoint: 100n, quoteReserve: 0n }) as DbcVirtualPool;

describe("DBC curve math", () => {
  it("the whole FUMPAD curve raises the 85 SOL threshold and sells ≈ 731 M tokens", () => {
    const [s0, s1, L] = FUMPAD_CURVES.mainnet.curve;
    const q = deltaQuote(s0, s1, L, true);
    expect(Number(q) / 1e9).toBeCloseTo(85, 1);
    const b = deltaBase(s0, s1, L, false);
    expect(Number(b) / 1e6 / 1e6).toBeCloseTo(731.17, 1);
  });
  it("fee scheduler: 99% at the launch slot, 13.47% at +7, 1.25% from +8; first swap gets the min fee", () => {
    const c = cfgFor("mainnet");
    expect(dbcFeeNumerator(c, pool(1n), 100n)).toBe(990_000_000n);
    expect(dbcFeeNumerator(c, pool(1n), 107n)).toBe(990_000_000n - 7n * 122_187_500n);
    expect(dbcFeeNumerator(c, pool(1n), 108n)).toBe(12_500_000n);
    expect(dbcFeeNumerator(c, pool(1n), 10_000n)).toBe(12_500_000n);
    expect(dbcFeeNumerator(c, pool(1n), 100n, true)).toBe(12_500_000n);
  });
  it("buy then sell round trip loses about two fees; overshoot needs PartialFill", () => {
    const c = cfgFor("mainnet");
    const start = c.sqrtStartPrice;
    const buy = quoteDbcBuy(c, pool(start), 1_000_000_000n, 1_000n);
    expect(buy.fee).toBe(12_500_000n);
    expect(buy.tradingFee + buy.protocolFee).toBe(buy.fee);
    expect(buy.protocolFee).toBe(2_500_000n);
    const sell = quoteDbcSell(c, { ...pool(buy.nextSqrtPrice) }, buy.amountOut, 1_000n);
    const back = Number(sell.amountOut) / 1e9;
    expect(back).toBeGreaterThan(0.97);
    expect(back).toBeLessThan(0.976);
    expect(sell.nextSqrtPrice - start).toBeLessThan(10n); // rounding favors the pool
    expect(() => quoteDbcBuy(c, pool(start), 200_000_000_000n, 1_000n)).toThrow(/PartialFill/);
    const pf = quoteDbcBuy(c, pool(start), 200_000_000_000n, 1_000n, { partialFill: true });
    expect(pf.partialFill && pf.completesCurve).toBe(true);
    expect(Number(pf.amountInAfterFee) / 1e9).toBeCloseTo(85, 1);
  });
  it("virtual reserves reproduce the spot price", () => {
    const [s0, , L] = FUMPAD_CURVES.mainnet.curve;
    const v = virtualReserves(s0, L);
    const spot = (s0 * s0) >> 64n;
    const ratio = (v.quote << 64n) / v.base;
    expect(Number(ratio - spot) / Number(spot)).toBeLessThan(1e-9);
  });
});

describe("DAMM v2 math", () => {
  const [, s1, L] = FUMPAD_CURVES.mainnet.curve;
  const p: DammPool = {
    cliffFeeNumerator: 12_500_000n,
    baseFeeMode: 0,
    protocolFeePercent: 20,
    liquidity: L,
    sqrtPrice: s1,
    sqrtMinPrice: 4_295_048_016n,
    sqrtMaxPrice: 79_226_673_521_066_979_257_578_248_091n,
    tokenAMint: PublicKey.default,
  } as DammPool;
  it("buy fee on input, sell fee on output (OnlyB)", () => {
    const b = quoteDammBuy(p, 1_000_000_000n);
    expect(b.fee).toBe(12_500_000n);
    const s = quoteDammSell({ ...p, sqrtPrice: b.nextSqrtPrice }, b.amountOut);
    expect(Number(s.amountOut) / 1e9).toBeGreaterThan(0.97);
    expect(s.fee * 1_000n / (s.amountOut + s.fee)).toBe(12n);
  });
});
