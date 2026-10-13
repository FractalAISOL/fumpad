/**
 * Global.params + the FUMPAD DBC config's curve, cached in `meta.global` for the API (v0.7: the curve lives
 * in the DBC config, D30; the first allow-listed config is "the" curve shown to users).
 */
import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

import { DEFAULT_PARAMS, decodeDbcConfig, decodeGlobal, deltaBase, fumpadConfigParams, globalPda, type Params, REWARD_POOL_BASE, TOTAL_SUPPLY_BASE, virtualReserves } from "@fumpad/sdk";

import { getMeta, type Queryable, setMeta } from "./db.js";

/** Params as stored in `meta.global_params` (bigints as strings). */
type Stored = Record<keyof Params, string | number>;

export function storeable(p: object): Record<string, string | number> {
  const o: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(p)) o[k] = typeof v === "bigint" ? v.toString() : (v as number | string);
  return o;
}
export function fromStored(s: Stored): Params {
  const defs = DEFAULT_PARAMS as unknown as Record<string, unknown>;
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) o[k] = typeof defs[k] === "bigint" ? BigInt(v) : v;
  for (const [k, d] of Object.entries(defs)) if (!(k in o)) o[k] = d;
  return o as unknown as Params;
}

/** The DBC curve in the units the API/app use (v0.6 field names kept where the meaning carries over). */
export interface CurveInfo {
  totalSupply: bigint;
  rewardPoolSupply: bigint;
  /** DBC swap_base_amount */
  curveSupply: bigint;
  /** DBC migration_base_threshold */
  lpSupply: bigint;
  /** constant-product virtual reserves of the first curve segment at the start price */
  initialVirtualSol: bigint;
  initialVirtualToken: bigint;
  /** DBC migration_quote_threshold */
  graduationLamports: bigint;
  /** D34 migration fee to FUMPAD at graduation */
  graduationFeeLamports: bigint;
  /** pool fee, bps (normal rate) */
  feeBps: number;
  /** Meteora's protocol share of the fee, bps of the fee */
  venueFeeShareBps: number;
  snipeWindowSlots: number;
  snipeStartBps: number;
  sqrtStartPrice: bigint;
}

export type ApiParams = Params & CurveInfo & { feePoolShareBps: number };

export function curveFromConfig(cfg: ReturnType<typeof decodeDbcConfig>): CurveInfo {
  const seg = cfg.curve[0];
  const v = virtualReserves(cfg.sqrtStartPrice, seg.liquidity);
  const swapBase = cfg.swapBaseAmount || deltaBase(cfg.sqrtStartPrice, cfg.migrationSqrtPrice, seg.liquidity, false);
  const bf = cfg.baseFee;
  const minNum = bf.cliffFeeNumerator - bf.reductionFactor * BigInt(bf.numberOfPeriod);
  return {
    totalSupply: cfg.preMigrationTokenSupply || TOTAL_SUPPLY_BASE,
    rewardPoolSupply: REWARD_POOL_BASE,
    curveSupply: swapBase,
    lpSupply: cfg.migrationBaseThreshold,
    initialVirtualSol: v.quote,
    initialVirtualToken: v.base,
    graduationLamports: cfg.migrationQuoteThreshold,
    graduationFeeLamports: (cfg.migrationQuoteThreshold * BigInt(cfg.migrationFeePercentage)) / 100n,
    feeBps: Number(minNum / 100_000n),
    venueFeeShareBps: 2_000,
    snipeWindowSlots: bf.numberOfPeriod * Number(bf.periodFrequency),
    snipeStartBps: Number(bf.cliffFeeNumerator / 100_000n),
    sqrtStartPrice: cfg.sqrtStartPrice,
  };
}

/** The mainnet FUMPAD config's curve (contracts' exact-8% derivation), when no config is on chain yet. */
export function defaultCurve(): CurveInfo {
  const p = fumpadConfigParams("mainnet");
  const v = virtualReserves(p.sqrtStartPrice, p.curve[0].liquidity);
  return {
    totalSupply: TOTAL_SUPPLY_BASE,
    rewardPoolSupply: REWARD_POOL_BASE,
    curveSupply: deltaBase(p.sqrtStartPrice, p.curve[0].sqrtPrice, p.curve[0].liquidity, false),
    lpSupply: TOTAL_SUPPLY_BASE - REWARD_POOL_BASE - deltaBase(p.sqrtStartPrice, p.curve[0].sqrtPrice, p.curve[0].liquidity, false),
    initialVirtualSol: v.quote,
    initialVirtualToken: v.base,
    graduationLamports: p.migrationQuoteThreshold,
    graduationFeeLamports: (p.migrationQuoteThreshold * BigInt(p.migrationFeePercentage)) / 100n,
    feeBps: 125,
    venueFeeShareBps: 2_000,
    snipeWindowSlots: p.baseFee.firstFactor * Number(p.baseFee.secondFactor),
    snipeStartBps: Number(p.baseFee.cliffFeeNumerator / 100_000n),
    sqrtStartPrice: p.sqrtStartPrice,
  };
}

const BIG_CURVE_KEYS = ["totalSupply", "rewardPoolSupply", "curveSupply", "lpSupply", "initialVirtualSol", "initialVirtualToken", "graduationLamports", "graduationFeeLamports", "sqrtStartPrice"];
export function curveFromStored(s: Record<string, string | number> | undefined): CurveInfo {
  if (!s) return defaultCurve();
  const o: Record<string, unknown> = { ...s };
  for (const k of BIG_CURVE_KEYS) o[k] = BigInt(s[k] as string);
  return o as unknown as CurveInfo;
}

export const apiParams = (p: Params, c: CurveInfo): ApiParams => ({ ...p, ...c, feePoolShareBps: p.feeBuybackShareBps });

/** Fetch Global (+ its first config's curve) from chain and cache it in `meta`; fall back to the cached copy, then defaults. */
export async function loadParams(conn: Connection, db: Queryable): Promise<{ params: Params; treasury?: string; admin?: string; configs?: string[]; curve: CurveInfo }> {
  try {
    const a = await conn.getAccountInfo(globalPda(), "confirmed");
    if (a) {
      const g = decodeGlobal(new Uint8Array(a.data));
      const configs = g.configs.filter((k) => !k.equals(PublicKey.default)).map((k) => k.toBase58());
      let curve = defaultCurve();
      if (configs.length) {
        const ca = await conn.getAccountInfo(new PublicKey(configs[0]), "confirmed");
        if (ca) curve = curveFromConfig(decodeDbcConfig(new Uint8Array(ca.data)));
      }
      await setMeta(db, "global", {
        params: storeable(g.params),
        curve: storeable(curve),
        admin: g.admin.toBase58(),
        treasury: g.platformTreasury.toBase58(),
        guardian: g.guardian.toBase58(),
        keepers: g.keepers.map((k) => k.toBase58()),
        paused: g.paused,
        pauseExpiresAt: g.pauseExpiresAt.toString(),
        clusterTag: g.clusterTag,
        configs,
      });
      return { params: g.params, treasury: g.platformTreasury.toBase58(), admin: g.admin.toBase58(), configs, curve };
    }
  } catch {
    /* fall through */
  }
  const cached = await getMeta<{ params: Stored; curve?: Record<string, string | number>; treasury: string; admin: string; configs?: string[] }>(db, "global");
  if (cached) return { params: fromStored(cached.params), treasury: cached.treasury, admin: cached.admin, configs: cached.configs, curve: curveFromStored(cached.curve) };
  return { params: DEFAULT_PARAMS, curve: defaultCurve() };
}
