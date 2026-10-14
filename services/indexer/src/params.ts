/**
 * Global.params + the FUMPAD DBC config's curve, cached in `meta.global` for the API (v0.7: the curve lives
 * in the DBC config, D30; the first allow-listed STANDARD-policy config is "the" curve shown to users). Every
 * allow-listed config's fee schedule + fee policy is cached too (`configCurves`, `configPolicies`): a coin's own
 * fee is its config's (the first-coin config trades at 3%, INTERFACE §5.9).
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
  /** DAMM v2 pool fee after graduation, bps. */
  migratedPoolFeeBps: number;
}

/** A config's fee schedule (what a coin on it pays), as cached per config. */
export interface ConfigFees {
  feeBps: number;
  snipeStartBps: number;
  snipeWindowSlots: number;
  migratedPoolFeeBps: number;
}
export const configFees = (c: CurveInfo): ConfigFees => ({ feeBps: c.feeBps, snipeStartBps: c.snipeStartBps, snipeWindowSlots: c.snipeWindowSlots, migratedPoolFeeBps: c.migratedPoolFeeBps });

/** An allow-list slot's fee policy, JSON-safe (wallet base58, null when standard). */
export interface StoredPolicy {
  config: string;
  kind: number;
  buybackShare: number;
  walletShare: number;
  maxCoins: number;
  coins: number;
  wallet: string | null;
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
    migratedPoolFeeBps: cfg.migratedPoolFeeBps,
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
    migratedPoolFeeBps: p.migratedPoolFeeBps,
  };
}

const BIG_CURVE_KEYS = ["totalSupply", "rewardPoolSupply", "curveSupply", "lpSupply", "initialVirtualSol", "initialVirtualToken", "graduationLamports", "graduationFeeLamports", "sqrtStartPrice"];
export function curveFromStored(s: Record<string, string | number> | undefined): CurveInfo {
  if (!s) return defaultCurve();
  const o: Record<string, unknown> = { ...s };
  for (const k of BIG_CURVE_KEYS) o[k] = BigInt(s[k] as string);
  if (o.migratedPoolFeeBps === undefined) o.migratedPoolFeeBps = o.feeBps; // cached before the field existed
  return o as unknown as CurveInfo;
}

export const apiParams = (p: Params, c: CurveInfo): ApiParams => ({ ...p, ...c, feePoolShareBps: p.feeBuybackShareBps });

/** Fetch Global (+ its configs' curves) from chain and cache it in `meta`; fall back to the cached copy, then defaults. */
export async function loadParams(conn: Connection, db: Queryable): Promise<{ params: Params; treasury?: string; admin?: string; configs?: string[]; curve: CurveInfo; configPolicies?: StoredPolicy[] }> {
  try {
    const a = await conn.getAccountInfo(globalPda(), "confirmed");
    if (a) {
      const g = decodeGlobal(new Uint8Array(a.data));
      const slots = g.configs.map((k, i) => ({ k, i })).filter(({ k }) => !k.equals(PublicKey.default));
      const configs = slots.map(({ k }) => k.toBase58());
      const configPolicies: StoredPolicy[] = slots.map(({ k, i }) => {
        const p = g.configPolicies?.[i];
        return {
          config: k.toBase58(),
          kind: p?.kind ?? 0,
          buybackShare: p?.buybackShare ?? 0,
          walletShare: p?.walletShare ?? 0,
          maxCoins: p?.maxCoins ?? 0,
          coins: g.configCoins?.[i] ?? 0,
          wallet: p && p.kind !== 0 ? p.wallet.toBase58() : null,
        };
      });
      let curve = defaultCurve();
      const configCurves: Record<string, ConfigFees> = {};
      const infos = configs.length ? await conn.getMultipleAccountsInfo(configs.map((c) => new PublicKey(c)), "confirmed") : [];
      let shown = false;
      infos.forEach((ca, i) => {
        if (!ca) return;
        const c = curveFromConfig(decodeDbcConfig(new Uint8Array(ca.data)));
        configCurves[configs[i]] = configFees(c);
        // "The" curve users see: the first standard-policy config (the first-coin config is a one-off).
        if (!shown && configPolicies[i].kind === 0) {
          curve = c;
          shown = true;
        }
      });
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
        configPolicies,
        configCurves,
      });
      return { params: g.params, treasury: g.platformTreasury.toBase58(), admin: g.admin.toBase58(), configs, curve, configPolicies };
    }
  } catch {
    /* fall through */
  }
  const cached = await getMeta<{ params: Stored; curve?: Record<string, string | number>; treasury: string; admin: string; configs?: string[] }>(db, "global");
  if (cached) return { params: fromStored(cached.params), treasury: cached.treasury, admin: cached.admin, configs: cached.configs, curve: curveFromStored(cached.curve) };
  return { params: DEFAULT_PARAMS, curve: defaultCurve() };
}
