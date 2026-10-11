import type { Commitment } from "@solana/web3.js";

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
  /** Shared secret Helius sends in the Authorization header. */
  webhookSecret?: string;
  /** Re-scan this many recent signatures per address to detect gaps (missed webhooks/polls). */
  reconcileDepth: number;
  reconcileIntervalMs: number;
  finalizeIntervalMs: number;
  deriveIntervalMs: number;
  /** Funding-graph lookups per derive cycle (rate-limit friendly). */
  fundingLookupsPerCycle: number;
  /** Fetch coin metadata JSON from `uri` (off by default in tests). */
  fetchMetadata: boolean;
  healthPort?: number;
  logLevel: string;
}

const num = (v: string | undefined, d: number) => (v === undefined || v === "" ? d : Number(v));

/** RPC URL: explicit RPC_URL, else Helius mainnet from HELIUS_API_KEY. */
export function rpcUrlFromEnv(env = process.env): string {
  if (env.RPC_URL) return env.RPC_URL;
  if (env.HELIUS_API_KEY) return `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;
  return "http://127.0.0.1:8899";
}

export function loadIndexerConfig(env = process.env): IndexerConfig {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const rpcUrl = rpcUrlFromEnv(env);
  return {
    databaseUrl: env.DATABASE_URL,
    rpcUrl,
    wsUrl: env.WS_URL || (env.HELIUS_API_KEY && !env.RPC_URL ? `wss://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}` : undefined),
    heliusApiKey: env.HELIUS_API_KEY || undefined,
    commitment: env.INDEXER_COMMITMENT === "finalized" ? "finalized" : "confirmed",
    pollIntervalMs: num(env.POLL_INTERVAL_MS, 2_000),
    backfillFromSlot: num(env.BACKFILL_FROM_SLOT, 0),
    pageSize: num(env.PAGE_SIZE, 1_000),
    webhookPort: env.WEBHOOK_PORT ? Number(env.WEBHOOK_PORT) : undefined,
    webhookSecret: env.HELIUS_WEBHOOK_SECRET || undefined,
    reconcileDepth: num(env.RECONCILE_DEPTH, 200),
    reconcileIntervalMs: num(env.RECONCILE_INTERVAL_MS, 60_000),
    finalizeIntervalMs: num(env.FINALIZE_INTERVAL_MS, 15_000),
    deriveIntervalMs: num(env.DERIVE_INTERVAL_MS, 10_000),
    fundingLookupsPerCycle: num(env.FUNDING_LOOKUPS_PER_CYCLE, 10),
    fetchMetadata: env.FETCH_METADATA !== "false",
    healthPort: env.PORT ? Number(env.PORT) : env.HEALTH_PORT ? Number(env.HEALTH_PORT) : undefined,
    logLevel: env.LOG_LEVEL ?? "info",
  };
}
