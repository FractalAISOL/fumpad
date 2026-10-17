import { ipfsGatewaysFromEnv, isProduction, PUBLIC_IPFS_GATEWAY, requireEnv, rpcUrlFromEnv } from "@fumpad/indexer";

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
  /** Launch binding key (L1): co-signs register_coin when Global.params.launch_signer is set. Separate from MINT_POOL_KEY. */
  launchSignerKey?: string;
  /**
   * LAUNCH_FIRST_COIN=true: `POST /v1/launch/prepare` accepts `launchConfig: "first_coin"` (the one-off first-coin
   * DBC config: 3% fee, wallet-split fee policy, INTERFACE §5.9). Off by default; turn it off again after the first
   * launch (the admin also removes the config from the allow-list, services/LAUNCH-DAY.md).
   */
  launchFirstCoin: boolean;
  /**
   * LAUNCHES_OPEN: whether `POST /v1/launch/prepare` accepts standard launches. Closed = 403 `launches_closed`
   * (every launch needs this API's co-signature, so this also blocks launches on chain); the first-coin path
   * (LAUNCH_FIRST_COIN) is not affected. Default: open on devnet/testnet/localnet, **closed on mainnet** (fail-safe
   * until the public opening, services/LAUNCH-DAY.md §5). See `launchesOpenFromEnv`.
   */
  launchesOpen: boolean;
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
  /**
   * HMAC key for ip_hash (`WAITLIST_IP_SALT`). Independent of every DATABASE_URL, so moving or
   * rotating a database never changes the hashes. Required in production; outside production an
   * unset value means a fixed development salt.
   */
  waitlistIpSalt?: string;
  /**
   * The waitlist's own Postgres (`WAITLIST_DATABASE_URL`, e.g. Railway `waitlist-db`): kept out
   * of the backend DB so a devnet/backend schema reset can never wipe sign-ups. Outside production
   * an unset value falls back to DATABASE_URL.
   */
  waitlistDatabaseUrl?: string;
  /**
   * Set when the waitlist routes must not run (production without WAITLIST_DATABASE_URL or
   * WAITLIST_IP_SALT, or pointed at the backend DB): `POST /v1/waitlist` answers 503 and the API
   * logs it loudly; every other route keeps working.
   */
  waitlistDisabledReason?: string;
  // ── Coin image proxy (GET /v1/img/:mint, V7-L6) ──────────────────────────
  /** Per-IP image requests per minute (a board renders ~50 tiles). */
  imgRateLimitPerMin: number;
  /** Per-IP Fumble Checker lookups per minute (`GET /v1/wallets/:wallet/fumbles`). */
  fumblesRateLimitPerMin: number;
  /** Largest image accepted from a creator's host. */
  imgMaxBytes: number;
  /** In-memory image cache budget (bytes). */
  imgCacheBytes: number;
  /** ipfs:// images are fetched through this https gateway. */
  ipfsGateway: string;
  /** IPFS gateways our image fetches try in order: `PINATA_GATEWAY` (dedicated) when set, then `ipfsGateway`. */
  ipfsGateways: string[];
  // ── Coin metadata upload (POST /v1/launch/metadata, launch/metadata.ts) ──
  /** Pinata JWT (sealed). Unset: devnet/localnet answer the placeholder uri; mainnet disables uploads (503). */
  pinataJwt?: string;
  /**
   * Mainnet (FUMPAD_CLUSTER not devnet/testnet/localnet/unset): metadata must be real. Prepare refuses the
   * placeholder uri, and without PINATA_JWT the metadata route answers 503 (`metadataDisabledReason`).
   */
  metadataRequired: boolean;
  metadataDisabledReason?: string;
  /** Per-IP metadata uploads per minute. */
  launchMetadataRateLimitPerMin: number;
  /** Per-wallet metadata uploads per minute and per hour. */
  launchMetadataWalletLimitPerMin: number;
  launchMetadataWalletLimitPerHour: number;
}

/** Outside production only: the ip_hash key when WAITLIST_IP_SALT is unset. */
export const DEV_WAITLIST_IP_SALT = "fumpad-waitlist-dev-salt-not-for-production";

/** Where the waitlist lives and why it may be off (pure; see ApiConfig.waitlist*). */
export function waitlistConfig(env: NodeJS.ProcessEnv, prod: boolean): Pick<ApiConfig, "waitlistIpSalt" | "waitlistDatabaseUrl" | "waitlistDisabledReason"> {
  const url = env.WAITLIST_DATABASE_URL?.trim() || undefined;
  const salt = env.WAITLIST_IP_SALT?.trim() || undefined;
  if (!prod) return { waitlistDatabaseUrl: url ?? env.DATABASE_URL, waitlistIpSalt: salt ?? DEV_WAITLIST_IP_SALT };
  const problems: string[] = [];
  if (!url) problems.push("WAITLIST_DATABASE_URL is not set (the waitlist must live in its own database in production)");
  else if (url === env.DATABASE_URL?.trim()) problems.push("WAITLIST_DATABASE_URL equals DATABASE_URL (it must be a separate database)");
  if (!salt) problems.push("WAITLIST_IP_SALT is not set (generate: openssl rand -hex 32)");
  return { waitlistDatabaseUrl: url, waitlistIpSalt: salt, waitlistDisabledReason: problems.length ? problems.join("; ") : undefined };
}

/** Clusters where standard launches are open unless LAUNCHES_OPEN says otherwise (unset FUMPAD_CLUSTER = devnet, as in @fumpad/sdk). */
const OPEN_BY_DEFAULT_CLUSTERS = new Set(["", "devnet", "testnet", "localnet"]);

/**
 * LAUNCHES_OPEN (true/false, also 1/0, yes/no). Unset: true on devnet/testnet/localnet (and an unset FUMPAD_CLUSTER),
 * false on mainnet or any other cluster name (fail-safe). An unrecognised value is a startup error, never a guess.
 */
export function launchesOpenFromEnv(env: NodeJS.ProcessEnv): boolean {
  const raw = env.LAUNCHES_OPEN?.trim().toLowerCase();
  if (raw === undefined || raw === "") return OPEN_BY_DEFAULT_CLUSTERS.has(env.FUMPAD_CLUSTER?.trim().toLowerCase() ?? "");
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  throw new Error(`api: LAUNCHES_OPEN=${JSON.stringify(env.LAUNCHES_OPEN)}: expected true or false`);
}

/** PINATA_JWT and whether metadata must be real on this cluster (pure; see ApiConfig.metadata*). */
export function metadataConfig(env: NodeJS.ProcessEnv): Pick<ApiConfig, "pinataJwt" | "metadataRequired" | "metadataDisabledReason"> {
  const pinataJwt = env.PINATA_JWT?.trim() || undefined;
  const metadataRequired = !OPEN_BY_DEFAULT_CLUSTERS.has(env.FUMPAD_CLUSTER?.trim().toLowerCase() ?? "");
  return {
    pinataJwt,
    metadataRequired,
    metadataDisabledReason: metadataRequired && !pinataJwt ? "PINATA_JWT is not set (required on mainnet: coin metadata is pinned to IPFS through Pinata)" : undefined,
  };
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
    launchSignerKey: env.LAUNCH_SIGNER_KEY || undefined,
    launchFirstCoin: env.LAUNCH_FIRST_COIN === "true",
    launchesOpen: launchesOpenFromEnv(env),
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
    imgRateLimitPerMin: Number(env.IMG_RATE_LIMIT_PER_MIN ?? 600),
    fumblesRateLimitPerMin: Number(env.FUMBLES_RATE_LIMIT_PER_MIN ?? 60),
    imgMaxBytes: Number(env.IMG_MAX_BYTES ?? 2 * 1024 * 1024),
    imgCacheBytes: Number(env.IMG_CACHE_MB ?? 64) * 1024 * 1024,
    ipfsGateway: env.IPFS_GATEWAY || PUBLIC_IPFS_GATEWAY,
    ipfsGateways: ipfsGatewaysFromEnv(env),
    ...metadataConfig(env),
    launchMetadataRateLimitPerMin: Number(env.LAUNCH_METADATA_RATE_LIMIT_PER_MIN ?? 6),
    launchMetadataWalletLimitPerMin: Number(env.LAUNCH_METADATA_WALLET_LIMIT_PER_MIN ?? 3),
    launchMetadataWalletLimitPerHour: Number(env.LAUNCH_METADATA_WALLET_LIMIT_PER_HOUR ?? 20),
    ...waitlistConfig(env, prod),
  };
}
