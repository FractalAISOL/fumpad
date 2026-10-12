import { isProduction, requireEnv, rpcUrlFromEnv } from "@fumpad/indexer";

export interface ApiConfig {
  databaseUrl: string;
  rpcUrl: string;
  port: number;
  host: string;
  /** Comma-separated origins; "*" only outside production. */
  corsOrigins: string[] | "*";
  rateLimitPerMin: number;
  quoteRateLimitPerMin: number;
  maxWsPerIp: number;
  /** Global WebSocket connection cap (M-6). */
  maxWsTotal: number;
  /**
   * Client IP derivation (H-2): number of reverse-proxy hops in front of the API whose
   * X-Forwarded-For entries are trusted (Railway: 2, verified live). 0 = the TCP
   * peer is the client. Never "trust everything".
   */
  trustProxyHops: number;
  /** Extra trusted proxy networks (CIDRs), e.g. a private-network hop. Usually empty. */
  trustProxyCidrs: string[];
  /**
   * Shared secret the app's SSR sends in `x-fumpad-ssr` (replaces the RATE_LIMIT_ALLOW IP
   * allow-list): exempts the request from rate limits and unlocks detailed /health.
   */
  ssrSecret?: string;
  /** Live updates: coalescing window for per-coin WebSocket messages (ms). */
  liveCoalesceMs: number;
  /** Drop a WebSocket client whose unsent backlog exceeds this many bytes. */
  wsMaxBufferedBytes: number;
  /** Optional keeper /health URL (private network) probed by /v1/status. */
  statusKeeperUrl?: string;
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
  /** M-2: prepare requires an ed25519 signature by the creator over the launch message. */
  launchRequireSignature: boolean;
  /** Signed launch messages are accepted for this long after `issuedAt` (and 60 s of clock skew ahead). */
  launchSignatureMaxAgeSecs: number;
  /** Creator wallet must hold at least this much SOL (lamports) to reserve a mint. */
  launchMinBalanceLamports: bigint;
  /** The last N available mints only go to wallets with FUMPAD history (pool can't be drained by fresh wallets). */
  launchPoolReserve: number;
  /** Timeout for each RPC call made by prepare (outside the DB transaction). */
  launchRpcTimeoutMs: number;
  // ── Pre-launch waitlist (POST /v1/waitlist) ───────────────────────────────
  /** Per-IP waitlist requests per minute. */
  waitlistRateLimitPerMin: number;
  /** Sign-ups one IP may add per rolling day (DB-enforced, across instances). */
  waitlistPerIpPerDay: number;
  /** HMAC key for ip_hash. Unset = derived from DATABASE_URL. */
  waitlistIpSalt?: string;
}

export function loadApiConfig(env = process.env): ApiConfig {
  const prod = isProduction(env);
  requireEnv(env, "api", prod ? ["DATABASE_URL", "RPC_URL", "CORS_ORIGINS", "API_SSR_SECRET"] : ["DATABASE_URL"]);
  const cors = env.CORS_ORIGINS?.trim();
  if (prod && (!cors || cors === "*")) throw new Error("api: CORS_ORIGINS must list explicit origins in production");
  const ssrSecret = env.API_SSR_SECRET?.trim() || undefined;
  if (ssrSecret && ssrSecret.length < 32) throw new Error("api: API_SSR_SECRET must be at least 32 characters");
  const hops = Number(env.TRUST_PROXY_HOPS ?? (prod ? 1 : 0));
  if (!Number.isInteger(hops) || hops < 0 || hops > 5) throw new Error("api: TRUST_PROXY_HOPS must be an integer 0..5");
  return {
    databaseUrl: env.DATABASE_URL!,
    rpcUrl: rpcUrlFromEnv(env),
    port: Number(env.PORT ?? env.API_PORT ?? 8080),
    host: env.HOST ?? "0.0.0.0",
    corsOrigins: !cors || cors === "*" ? "*" : cors.split(",").map((s) => s.trim()).filter(Boolean),
    rateLimitPerMin: Number(env.RATE_LIMIT_PER_MIN ?? 600),
    quoteRateLimitPerMin: Number(env.QUOTE_RATE_LIMIT_PER_MIN ?? 120),
    maxWsPerIp: Number(env.MAX_WS_PER_IP ?? 5),
    maxWsTotal: Number(env.MAX_WS_TOTAL ?? 5_000),
    trustProxyHops: hops,
    trustProxyCidrs: (env.TRUST_PROXY_CIDRS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    ssrSecret,
    liveCoalesceMs: Number(env.LIVE_COALESCE_MS ?? 250),
    wsMaxBufferedBytes: Number(env.WS_MAX_BUFFERED_BYTES ?? 4 * 1024 * 1024),
    statusKeeperUrl: env.STATUS_KEEPER_URL || undefined,
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
    launchRequireSignature: env.LAUNCH_REQUIRE_SIGNATURE !== "false",
    launchSignatureMaxAgeSecs: Number(env.LAUNCH_SIGNATURE_MAX_AGE_SECS ?? 600),
    launchMinBalanceLamports: BigInt(env.LAUNCH_MIN_BALANCE_LAMPORTS ?? "10000000"),
    launchPoolReserve: Number(env.LAUNCH_POOL_RESERVE ?? 5),
    launchRpcTimeoutMs: Number(env.LAUNCH_RPC_TIMEOUT_MS ?? 5_000),
    waitlistRateLimitPerMin: Number(env.WAITLIST_RATE_LIMIT_PER_MIN ?? 5),
    waitlistPerIpPerDay: Number(env.WAITLIST_PER_IP_PER_DAY ?? 20),
    waitlistIpSalt: env.WAITLIST_IP_SALT || undefined,
  };
}
