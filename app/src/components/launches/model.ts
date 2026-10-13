/**
 * The Launches board's pure logic: which lane a coin sits in, lane order, filters. No React,
 * so it is easy to reason about (and to test).
 *
 *   New            curve < 50%            newest first
 *   Final stretch  curve ≥ 50% (complete) curve progress, highest first
 *   Graduated      on Meteora DAMM v2     24 h volume (or most recent graduation)
 */
import type { CoinSummary } from "@/data";
import { graduationSolOf } from "@/data/chain";

export type LaneId = "new" | "final" | "graduated";
export const LANES: readonly LaneId[] = ["new", "final", "graduated"];
export const LANE_NAME: Record<LaneId, string> = { new: "New", final: "Final stretch", graduated: "Graduated" };

/** The threshold between New and Final stretch, as a fraction of the graduation target. */
export const STRETCH_AT = 0.5;

export type GradSort = "volume" | "recent";

/** Curve progress 0–1 (graduated and complete coins are 1). */
export function curveFraction(c: CoinSummary, graduationSol?: number): number {
  if (c.status !== "curve") return 1;
  const target = graduationSol ?? graduationSolOf(c);
  return target > 0 ? Math.min(1, Math.max(0, c.curveSol / target)) : 0;
}

export function laneOf(c: CoinSummary, graduationSol?: number): LaneId {
  if (c.status === "graduated") return "graduated";
  return curveFraction(c, graduationSol) >= STRETCH_AT ? "final" : "new";
}

/* ── Filters ──────────────────────────────────────────────────────────────── */

/** Per-lane filters. Money thresholds are USD (what people quote), ages are minutes. */
export interface LaneFilter {
  minMcUsd?: number;
  minVolUsd?: number;
  minHolders?: number;
  /** Curve % range, 0–100 (New and Final stretch only). */
  curveMin?: number;
  curveMax?: number;
  maxAgeMin?: number;
  hideFlagged?: boolean;
}
export type BoardFilters = Record<LaneId, LaneFilter>;
export const NO_FILTERS: BoardFilters = { new: {}, final: {}, graduated: {} };

export function activeCount(f: LaneFilter): number {
  return (
    Number(!!f.minMcUsd) +
    Number(!!f.minVolUsd) +
    Number(!!f.minHolders) +
    Number(f.curveMin !== undefined || f.curveMax !== undefined) +
    Number(!!f.maxAgeMin) +
    Number(!!f.hideFlagged)
  );
}

const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);

/** Whatever localStorage held, reduced to a valid BoardFilters (bad or old shapes drop out). */
export function cleanFilters(raw: unknown): BoardFilters {
  const out: BoardFilters = { new: {}, final: {}, graduated: {} };
  if (!raw || typeof raw !== "object") return out;
  for (const lane of LANES) {
    const f = (raw as Record<string, unknown>)[lane];
    if (!f || typeof f !== "object") continue;
    const g = f as Record<string, unknown>;
    out[lane] = {
      minMcUsd: num(g.minMcUsd, 0, 1e12),
      minVolUsd: num(g.minVolUsd, 0, 1e12),
      minHolders: num(g.minHolders, 0, 1e9),
      curveMin: lane === "graduated" ? undefined : num(g.curveMin, 0, 100),
      curveMax: lane === "graduated" ? undefined : num(g.curveMax, 0, 100),
      maxAgeMin: num(g.maxAgeMin, 0, 1e7),
      hideFlagged: g.hideFlagged === true || undefined,
    };
  }
  return out;
}

export interface MatchCtx {
  solUsd: number;
  now: number;
  graduationSol?: number;
  /** Lower-cased search text (ticker or name), empty for none. */
  query: string;
}

export function matches(c: CoinSummary, f: LaneFilter, x: MatchCtx): boolean {
  if (x.query) {
    const q = x.query.replace(/^\$/, "");
    if (!c.symbol.toLowerCase().includes(q) && !c.name.toLowerCase().includes(q)) return false;
  }
  if (f.minMcUsd && c.marketCapSol * x.solUsd < f.minMcUsd) return false;
  if (f.minVolUsd && c.volume24hSol * x.solUsd < f.minVolUsd) return false;
  if (f.minHolders && c.holders < f.minHolders) return false;
  if (f.maxAgeMin && x.now - c.createdAt > f.maxAgeMin * 60_000) return false;
  if (f.hideFlagged && c.creatorFlagged) return false;
  if (f.curveMin !== undefined || f.curveMax !== undefined) {
    const pct = curveFraction(c, x.graduationSol) * 100;
    if (f.curveMin !== undefined && pct < f.curveMin) return false;
    if (f.curveMax !== undefined && pct > f.curveMax) return false;
  }
  return true;
}

/* ── Order ────────────────────────────────────────────────────────────────── */

export function sortLane(lane: LaneId, coins: CoinSummary[], opts: { gradSort: GradSort; graduationSol?: number }): CoinSummary[] {
  const by =
    lane === "new"
      ? (a: CoinSummary, b: CoinSummary) => b.createdAt - a.createdAt
      : lane === "final"
        ? (a: CoinSummary, b: CoinSummary) => curveFraction(b, opts.graduationSol) - curveFraction(a, opts.graduationSol) || b.createdAt - a.createdAt
        : opts.gradSort === "volume"
          ? (a: CoinSummary, b: CoinSummary) => b.volume24hSol - a.volume24hSol || (b.graduatedAt ?? 0) - (a.graduatedAt ?? 0)
          : (a: CoinSummary, b: CoinSummary) => (b.graduatedAt ?? b.createdAt) - (a.graduatedAt ?? a.createdAt);
  return [...coins].sort(by);
}

/** "12s", "4m", "2h", "3d", "5w": the board's age column (finer than format.ago). */
export function age(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return d < 14 ? `${d}d` : `${Math.floor(d / 7)}w`;
}

/** Spoken form for screen readers: "12 seconds", "4 minutes". */
export function ageSpoken(ts: number, now: number): string {
  const a = age(ts, now);
  const n = parseInt(a, 10);
  const unit = { s: "second", m: "minute", h: "hour", d: "day", w: "week" }[a.slice(-1)]!;
  return `${n} ${unit}${n === 1 ? "" : "s"} old`;
}
