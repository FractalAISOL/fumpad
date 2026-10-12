/**
 * GET /v1/status: one cheap summary of the backend for the app's footer dot and /status page.
 *
 *   indexer     heartbeat the indexer writes to `meta` every 15 s (version, last poll, tip slot)
 *   keeper      age of the newest keeper price sample (it samples every graduated coin ≥ every 8 min)
 *   vanityPool  available / reserved `…fmbL` launch mints (null when launches are off here)
 *   services    api (this process), indexer (heartbeat), keeper (its /health, if STATUS_KEEPER_URL)
 *
 * Everything is read from Postgres except the optional keeper probe, so it works on a private
 * network without any external monitor.
 */
import { heartbeatKey, type Queryable, serviceInfo } from "@fumpad/indexer";

import type { HealthLevel, ServiceVersion, SystemStatus } from "./generated/app-types.js";
import type { MintPool } from "./launch/pool.js";

/** Indexer: no heartbeat for this long = down; this much staleness = degraded. */
export const INDEXER_DOWN_SECS = 120;
export const INDEXER_LAG_DEGRADED_SECS = 60;
/** Keeper: heartbeat sampling is every 480 s; allow 2.5× before calling it late, 7.5× down. */
export const KEEPER_LATE_SECS = 1_200;
export const KEEPER_DOWN_SECS = 3_600;
/** Vanity pool: launches stop at 0 available. */
export const VANITY_LOW = 20;

const RANK: Record<HealthLevel, number> = { ok: 0, unknown: 1, degraded: 2, down: 3 };
export const worst = (...ls: HealthLevel[]): HealthLevel => ls.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "ok");

interface Heartbeat {
  name: string;
  sha: string | null;
  deploymentId: string | null;
  startedAt: number;
  at: number;
  ok: boolean;
  tipSlot: number | null;
  msSinceLastPoll: number;
}

export interface StatusInputs {
  now: number;
  lastTxTime: number | null;
  lastSampleTs: number | null;
  graduatedCoins: number;
  indexer: Heartbeat | null;
  pool: { available: number; reserved: number } | null;
  keeper: { ok: boolean; version?: Partial<ServiceVersion> } | null;
}

/** Pure: inputs → status (unit tested). */
export function summarize(x: StatusInputs): SystemStatus {
  const secs = (t: number | null) => (t === null ? null : Math.max(0, Math.round(x.now / 1000 - t)));
  // Indexer
  let indexer: SystemStatus["indexer"];
  if (!x.indexer) indexer = { level: "unknown", lagSecs: null, lastTxAgeSecs: secs(x.lastTxTime), tipSlot: null };
  else {
    const hbAge = Math.max(0, (x.now - x.indexer.at) / 1000);
    const lag = Math.round(hbAge + x.indexer.msSinceLastPoll / 1000);
    const level: HealthLevel = hbAge > INDEXER_DOWN_SECS ? "down" : lag > INDEXER_LAG_DEGRADED_SECS || !x.indexer.ok ? "degraded" : "ok";
    indexer = { level, lagSecs: lag, lastTxAgeSecs: secs(x.lastTxTime), tipSlot: x.indexer.tipSlot };
  }
  // Keeper
  const sampleAge = secs(x.lastSampleTs);
  const keeperLevel: HealthLevel =
    x.graduatedCoins === 0
      ? x.keeper && !x.keeper.ok
        ? "degraded"
        : "ok" // nothing to sample yet
      : sampleAge === null
        ? "degraded"
        : sampleAge > KEEPER_DOWN_SECS
          ? "down"
          : sampleAge > KEEPER_LATE_SECS || (x.keeper && !x.keeper.ok)
            ? "degraded"
            : "ok";
  const keeper = { level: keeperLevel, lastSampleAgeSecs: sampleAge, graduatedCoins: x.graduatedCoins };
  // Vanity pool
  const vanityPool = x.pool
    ? { level: (x.pool.available === 0 ? "down" : x.pool.available < VANITY_LOW ? "degraded" : "ok") as HealthLevel, available: x.pool.available, reserved: x.pool.reserved }
    : null;
  // Versions
  const api = serviceInfo("api");
  const services: ServiceVersion[] = [{ name: "api", sha: api.sha, deploymentId: api.deploymentId, startedAt: api.startedAt, seenAt: x.now }];
  if (x.indexer) services.push({ name: "indexer", sha: x.indexer.sha ?? null, deploymentId: x.indexer.deploymentId ?? null, startedAt: x.indexer.startedAt ?? null, seenAt: x.indexer.at });
  if (x.keeper) {
    const v = x.keeper.version ?? {};
    services.push({ name: "keeper", sha: v.sha ?? null, deploymentId: v.deploymentId ?? null, startedAt: v.startedAt ?? null, seenAt: x.keeper.ok ? x.now : null });
  }
  return {
    level: worst(indexer.level, keeper.level, vanityPool?.level ?? "ok"),
    at: x.now,
    indexer,
    keeper,
    vanityPool,
    services,
  };
}

/** Optional keeper probe (Railway private network, e.g. http://keeper.railway.internal:8080/health). */
async function probeKeeper(url: string | undefined): Promise<StatusInputs["keeper"]> {
  if (!url) return null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; version?: { sha?: string | null; deploymentId?: string | null; startedAt?: number } };
    return { ok: r.ok && j.ok !== false, version: j.version ? { sha: j.version.sha ?? null, deploymentId: j.version.deploymentId ?? null, startedAt: j.version.startedAt ?? null } : undefined };
  } catch {
    return { ok: false };
  }
}

export async function systemStatus(db: Queryable, pool: MintPool | null, keeperUrl?: string): Promise<SystemStatus> {
  const [r, vanity, keeper] = await Promise.all([
    db.query<{ last_tx: string | null; last_sample: string | null; grads: string; hb: Heartbeat | null }>(
      `SELECT (SELECT block_time FROM transactions ORDER BY slot DESC LIMIT 1) AS last_tx,
              (SELECT ts FROM samples WHERE NOT fallback ORDER BY ts DESC LIMIT 1) AS last_sample,
              (SELECT count(*) FROM coins WHERE status = 'graduated') AS grads,
              (SELECT value FROM meta WHERE key = $1) AS hb`,
      [heartbeatKey("indexer")],
    ),
    pool ? pool.stats().catch(() => null) : Promise.resolve(null),
    probeKeeper(keeperUrl),
  ]);
  const x = r.rows[0];
  return summarize({
    now: Date.now(),
    lastTxTime: x.last_tx === null ? null : Number(x.last_tx),
    lastSampleTs: x.last_sample === null ? null : Number(x.last_sample),
    graduatedCoins: Number(x.grads),
    indexer: x.hb,
    pool: pool ? (vanity ?? { available: 0, reserved: 0 }) : null,
    keeper,
  });
}
