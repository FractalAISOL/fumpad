import type { Commitment } from "@solana/web3.js";

import { loadMeteoraConfig, type MeteoraIndexerConfig } from "./meteora/config.js";

export interface IndexerConfig {
  databaseUrl: string;
  rpcUrl: string;
  /** Optional websocket endpoint for `logsSubscribe` low-latency pokes. */
  wsUrl?: string;
  heliusApiKey?: string;
  /** Commitment for ingestion (confirmed = low latency; finalizer upgrades rows later). */
  commitment: Extract<Commitment, "confirmed" | "finalized">;
  pollIntervalMs: number;
  /** First slot to backfill from on an empty database (0 = from the beginning of history). */
  backfillFromSlot: number;
  /** Max signatures per getSignaturesForAddress page. */
  pageSize: number;
  webhookPort?: number;
  /**
   * `POST /helius` is served only when enabled (HELIUS_WEBHOOK_ENABLED=true or a secret is
   * set). Enabled without a secret = boot failure (the route must never be open).
   */
  webhookEnabled: boolean;
  /** Shared secret Helius sends in the Authorization header (≥ 24 chars). */
  webhookSecret?: string;
  /** Max webhook request body (bytes). */
  webhookMaxBodyBytes: number;
  /** Re-scan this many recent signatures per address to detect gaps (missed webhooks/polls). */
  reconcileDepth: number;
  reconcileIntervalMs: number;
  finalizeIntervalMs: number;
  deriveIntervalMs: number;
  /** Funding-graph lookups per derive cycle (rate-limit friendly). */
  fundingLookupsPerCycle: number;
  /** Fetch coin metadata JSON from `uri` (off by default in tests). */
  fetchMetadata: boolean;
  /** ipfs:// URIs are fetched through this https gateway (path appended). */
  ipfsGateway: string;
  /**
   * Gateways tried in order for IPFS content (ipfs:// or an https `/ipfs/<cid>` URL): the dedicated Pinata gateway
   * (`PINATA_GATEWAY`) when set, then `ipfsGateway`. See `ipfsGatewaysFromEnv`.
   */
  ipfsGateways: string[];
  /** Finalizer: consecutive "unknown to the cluster" checks before a row is rolled back. */
  finalizeDropMisses: number;
  finalizeDropAfterSecs: number;
  healthPort?: number;
  logLevel: string;
  /** Meteora DBC/DAMM v2 trade indexing; absent or `enabled: false` = off (default). */
  meteora?: MeteoraIndexerConfig;
}

const num = (v: string | undefined, d: number) => (v === undefined || v === "" ? d : Number(v));

/** NODE_ENV=production (set by the Dockerfile): required env is enforced, no dev defaults. */
export const isProduction = (env: NodeJS.ProcessEnv = process.env) => env.NODE_ENV === "production";

/** Throw one error naming every missing variable (fail fast at boot, not on first use). */
export function requireEnv(env: NodeJS.ProcessEnv, service: string, names: string[]): void {
  const missing = names.filter((n) => !env[n] || !env[n]!.trim());
  if (missing.length) throw new Error(`${service}: missing required env ${missing.join(", ")}`);
}

/**
 * RPC URL: always explicit `RPC_URL`. The cluster is never inferred (no mainnet default from
 * HELIUS_API_KEY); outside production an unset value means the local validator.
 */
export function rpcUrlFromEnv(env = process.env): string {
  if (env.RPC_URL) return env.RPC_URL;
  if (isProduction(env)) throw new Error("RPC_URL is required in production");
  return "http://127.0.0.1:8899";
}

export const PUBLIC_IPFS_GATEWAY = "https://ipfs.io/ipfs/";

/**
 * `PINATA_GATEWAY`: a dedicated gateway domain (`<name>.mypinata.cloud`, or a custom domain; a full `https://…`
 * URL is accepted too) → `https://<domain>/ipfs/`. Unset/empty → undefined. Anything else is a startup error.
 */
export function pinataGatewayFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.PINATA_GATEWAY?.trim();
  if (!raw) return undefined;
  const host = raw.replace(/^https:\/\//i, "").replace(/\/(ipfs\/?)?$/i, "").toLowerCase();
  if (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) throw new Error(`PINATA_GATEWAY must be a gateway domain like <name>.mypinata.cloud (got ${JSON.stringify(raw)})`);
  return `https://${host}/ipfs/`;
}

/** IPFS gateways in the order our own fetches use them: the dedicated one (if set), then IPFS_GATEWAY / ipfs.io. */
export function ipfsGatewaysFromEnv(env: NodeJS.ProcessEnv): string[] {
  const pub = env.IPFS_GATEWAY?.trim() || PUBLIC_IPFS_GATEWAY;
  const dedicated = pinataGatewayFromEnv(env);
  return dedicated && dedicated !== pub ? [dedicated, pub] : [pub];
}

export function loadIndexerConfig(env = process.env): IndexerConfig {
  requireEnv(env, "indexer", isProduction(env) ? ["DATABASE_URL", "RPC_URL"] : ["DATABASE_URL"]);
  const rpcUrl = rpcUrlFromEnv(env);
  const webhookSecret = env.HELIUS_WEBHOOK_SECRET?.trim() || undefined;
  const webhookEnabled = env.HELIUS_WEBHOOK_ENABLED === "true" || !!webhookSecret;
  if (webhookEnabled && !webhookSecret) throw new Error("indexer: HELIUS_WEBHOOK_ENABLED=true requires HELIUS_WEBHOOK_SECRET");
  if (webhookSecret && webhookSecret.length < 24) throw new Error("indexer: HELIUS_WEBHOOK_SECRET must be at least 24 characters");
  return {
    databaseUrl: env.DATABASE_URL!,
    rpcUrl,
    wsUrl: env.WS_URL || undefined,
    heliusApiKey: env.HELIUS_API_KEY || undefined,
    commitment: env.INDEXER_COMMITMENT === "finalized" ? "finalized" : "confirmed",
    pollIntervalMs: num(env.POLL_INTERVAL_MS, 2_000),
    backfillFromSlot: num(env.BACKFILL_FROM_SLOT, 0),
    pageSize: num(env.PAGE_SIZE, 1_000),
    webhookPort: env.WEBHOOK_PORT ? Number(env.WEBHOOK_PORT) : undefined,
    webhookEnabled,
    webhookSecret,
    webhookMaxBodyBytes: num(env.WEBHOOK_MAX_BODY_BYTES, 1024 * 1024),
    reconcileDepth: num(env.RECONCILE_DEPTH, 200),
    reconcileIntervalMs: num(env.RECONCILE_INTERVAL_MS, 60_000),
    finalizeIntervalMs: num(env.FINALIZE_INTERVAL_MS, 15_000),
    deriveIntervalMs: num(env.DERIVE_INTERVAL_MS, 10_000),
    fundingLookupsPerCycle: num(env.FUNDING_LOOKUPS_PER_CYCLE, 10),
    fetchMetadata: env.FETCH_METADATA !== "false",
    ipfsGateway: env.IPFS_GATEWAY || PUBLIC_IPFS_GATEWAY,
    ipfsGateways: ipfsGatewaysFromEnv(env),
    finalizeDropMisses: num(env.FINALIZE_DROP_MISSES, 3),
    finalizeDropAfterSecs: num(env.FINALIZE_DROP_AFTER_SECS, 180),
    healthPort: env.PORT ? Number(env.PORT) : env.HEALTH_PORT ? Number(env.HEALTH_PORT) : undefined,
    logLevel: env.LOG_LEVEL ?? "info",
    meteora: loadMeteoraConfig(env),
  };
}
