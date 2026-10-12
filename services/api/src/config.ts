import { rpcUrlFromEnv } from "@fumpad/indexer";

export interface ApiConfig {
  databaseUrl: string;
  rpcUrl: string;
  port: number;
  host: string;
  /** Comma-separated origins, or "*" (default) for the public read API. */
  corsOrigins: string[] | "*";
  rateLimitPerMin: number;
  quoteRateLimitPerMin: number;
  maxWsPerIp: number;
  /** IPs exempt from rate limiting (e.g. the app's SSR egress). */
  rateLimitAllow: string[];
  /** Used when the Pyth account can't be read (local dev without Pyth). */
  solUsdFallback: number;
  /** Pyth SOL/USD PriceUpdateV2 account. */
  pythAccount?: string;
  logLevel: string;
  // ── D18 vanity launches (POST /v1/launch/prepare) ─────────────────────────
  /** AES-256-GCM key for pooled mint secrets (same as the grinder's). Unset = launches disabled. */
  mintPoolKey?: string;
  vanitySuffix: string;
  /** A reservation returns to the pool after this long if its launch never landed. */
  launchReservationMs: number;
  launchSweepMs: number;
  /** Per-IP prepare requests per minute. */
  launchRateLimitPerMin: number;
  /** Per-wallet prepare requests per minute. */
  launchWalletLimitPerMin: number;
  /** Active reservations one IP may hold (pool-drain guard). */
  launchMaxActivePerIp: number;
  launchMaxInitialBuyLamports: bigint;
  launchMaxPriorityMicroLamports: number;
}

export function loadApiConfig(env = process.env): ApiConfig {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  return {
    databaseUrl: env.DATABASE_URL,
    rpcUrl: rpcUrlFromEnv(env),
    port: Number(env.PORT ?? env.API_PORT ?? 8080),
    host: env.HOST ?? "0.0.0.0",
    corsOrigins: !env.CORS_ORIGINS || env.CORS_ORIGINS === "*" ? "*" : env.CORS_ORIGINS.split(",").map((s) => s.trim()),
    rateLimitPerMin: Number(env.RATE_LIMIT_PER_MIN ?? 600),
    quoteRateLimitPerMin: Number(env.QUOTE_RATE_LIMIT_PER_MIN ?? 120),
    maxWsPerIp: Number(env.MAX_WS_PER_IP ?? 5),
    rateLimitAllow: (env.RATE_LIMIT_ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    solUsdFallback: Number(env.SOL_USD_FALLBACK ?? 150),
    pythAccount: env.PYTH_SOL_USD_ACCOUNT || undefined,
    logLevel: env.LOG_LEVEL ?? "info",
    mintPoolKey: env.MINT_POOL_KEY || undefined,
    vanitySuffix: env.VANITY_SUFFIX || "fmbL",
    launchReservationMs: Math.round(Number(env.LAUNCH_RESERVATION_MINUTES ?? 10) * 60_000),
    launchSweepMs: Number(env.LAUNCH_SWEEP_SECS ?? 15) * 1000,
    launchRateLimitPerMin: Number(env.LAUNCH_RATE_LIMIT_PER_MIN ?? 10),
    launchWalletLimitPerMin: Number(env.LAUNCH_WALLET_LIMIT_PER_MIN ?? 6),
    launchMaxActivePerIp: Number(env.LAUNCH_MAX_ACTIVE_PER_IP ?? 3),
    launchMaxInitialBuyLamports: BigInt(env.LAUNCH_MAX_INITIAL_BUY_LAMPORTS ?? "100000000000"),
    launchMaxPriorityMicroLamports: Number(env.LAUNCH_MAX_PRIORITY_MICROLAMPORTS ?? 5_000_000),
  };
}
