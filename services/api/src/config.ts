import { PublicKey } from "@solana/web3.js";

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
   * peer is the client. Never "trust everything". Default: 2 in production (Railway, audit
   * S-4 / L-2: 1 there made per-IP limits key on Railway's edge), 0 elsewhere.
   */
  trustProxyHops: number;
  /** Extra trusted proxy networks (CIDRs), e.g. a private-network hop. Usually empty. */
  trustProxyCidrs: string[];
  /**
   * Shared secret the app's SSR sends in `x-fumpad-ssr` (replaces the RATE_LIMIT_ALLOW IP
   * allow-list): lifts the request to the SSR rate-limit ceiling and unlocks detailed /health
   * and the exact vanity-pool counts in /v1/status.
   */
  ssrSecret?: string;
  /**
   * Per-IP requests per minute for SSR-authenticated requests (`SSR_RATE_LIMIT_PER_MIN`, audit I-1): a high
   * ceiling instead of no limit, so a leaked secret can't turn into unthrottled API/RPC load.
   */
  ssrRateLimitPerMin: number;
  /**
   * Per-IP requests per minute on routes that read the chain for a caller-chosen wallet
   * (`WALLET_RPC_RATE_LIMIT_PER_MIN`, audit S-7 / L-4): positions, closed, balances.
   */
  walletRpcRateLimitPerMin: number;
  /** Live updates: coalescing window for per-coin WebSocket messages (ms). */
  liveCoalesceMs: number;
  /** Drop a WebSocket client whose unsent backlog exceeds this many bytes. */
  wsMaxBufferedBytes: number;
  /** Optional keeper /health URL (private network) probed by /v1/status. */
  statusKeeperUrl?: string;
  /**
   * `SOL_USD_FALLBACK`: a fixed SOL/USD used when the Pyth account can't be read. Opt-in only (local stacks without
   * Pyth set it explicitly); unset = no fallback (audit S-11 / I-2): after `solUsdMaxStaleMs` without a Pyth read the
   * USD routes answer 503 `price_unavailable` and the API logs it at error level. Never a silent $150.
   */
  solUsdFallback?: number;
  /** How long the last good Pyth price may stand in for a failed read (`SOL_USD_MAX_STALE_SECS`, default 300 s). */
  solUsdMaxStaleMs: number;
  /** Pyth SOL/USD PriceUpdateV2 account. */
  pythAccount?: string;
  logLevel: string;
  // ── D18 vanity launches (POST /v1/launch/prepare) ─────────────────────────
  /** AES-256-GCM key for pooled mint secrets (same as the grinder's). Unset = launches disabled. */
  mintPoolKey?: string;
  /** Launch binding key (L1): co-signs register_coin when Global.params.launch_signer is set. Separate from MINT_POOL_KEY. */
  launchSignerKey?: string;
  /**
   * LAUNCH_ALT: the FUMPAD launch address lookup table (bootstrap `--step alt`; @fumpad/sdk `launchAltAddresses`).
   * Prepare builds every launch through it (room for the https metadata uri). Required on every cluster but
   * localnet (`launchAltRequired`): unset there = launches answer 503 (fail closed); localnet without it builds
   * inline launches (tests / the local stack before its ALT exists).
   */
  launchAlt?: string;
  launchAltRequired: boolean;
  /**
   * LAUNCH_FIRST_COIN=true: `POST /v1/launch/prepare` accepts `launchConfig: "first_coin"` (the one-off first-coin
   * DBC config: 3% fee, wallet-split fee policy, INTERFACE §5.9). Off by default; turn it off again after the first
   * launch (the admin also removes the config from the allow-list, services/LAUNCH-DAY.md).
   */
  launchFirstCoin: boolean;
  /**
   * FIRST_COIN_CREATOR (audit S-2 / H-3): the only creator wallet `launchConfig: "first_coin"` is prepared (and its
   * metadata pinned) for, and the only `?creator=` `GET /v1/launch/options` shows the option to. Required when
   * LAUNCH_FIRST_COIN=true (the API refuses to start without it). Mainnet: EiwHzSkty4mD1463dvbr7o1fHMNaA8xQPgk4PyXpnVGc.
   */
  firstCoinCreator?: string;
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
  /** Active reservations one IP (an IPv6 address counts as its /64) may hold (pool-drain guard). */
  launchMaxActivePerIp: number;
  /** Fresh mint reservations one wallet may take per hour (audit M-3 / S-5; per API instance). */
  launchWalletReservationsPerHour: number;
  /** Fresh mint reservations one IP (IPv6: its /64) may take per hour (audit M-3 / S-5; per API instance). */
  launchIpReservationsPerHour: number;
  launchMaxInitialBuyLamports: bigint;
  launchMaxPriorityMicroLamports: number;
  /** M-2: prepare requires an ed25519 signature by the creator over the launch message. */
  launchRequireSignature: boolean;
  /** Signed launch messages are accepted for this long after `issuedAt` (and 60 s of clock skew ahead). */
  launchSignatureMaxAgeSecs: number;
  /**
   * L-3: the `domain:` values a signed launch message may name (`LAUNCH_AUTH_DOMAINS`, comma-separated hosts; default
   * the hosts of CORS_ORIGINS). null = any (CORS_ORIGINS=* outside production).
   */
  launchAuthDomains: string[] | null;
  /** L-3: the `cluster:` a signed launch message must name (FUMPAD_CLUSTER; unset = devnet, as in @fumpad/sdk). */
  launchAuthCluster: string;
  /**
   * L-3: accept the old five-line message without `domain:` / `cluster:` (`LAUNCH_AUTH_LEGACY`, default true while
   * apps that predate it are live; set false once the app that signs the new message is deployed). Single-use
   * nonces apply to both forms.
   */
  launchAuthAllowLegacy: boolean;
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
  /** Concurrent upstream image fetches per creator host (`IMG_MAX_PER_HOST`, audit L-7); the global cap is `IMG_MAX_CONCURRENT`. */
  imgMaxPerHost: number;
  imgMaxConcurrent: number;
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

/** SOL_USD_FALLBACK: opt-in fixed price (S-11 / I-2); unset or empty = none. A non-positive or non-number value is a startup error. */
export function solUsdFallbackFromEnv(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.SOL_USD_FALLBACK?.trim();
  if (!raw) return undefined;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`api: SOL_USD_FALLBACK=${JSON.stringify(raw)}: expected a positive number`);
  return v;
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

/**
 * LAUNCH_ALT (base58, validated at boot) and whether this cluster needs it: every cluster but localnet (unset
 * FUMPAD_CLUSTER = devnet, as in @fumpad/sdk). A malformed value is a startup error, never a guess.
 */
export function launchAltConfig(env: NodeJS.ProcessEnv): Pick<ApiConfig, "launchAlt" | "launchAltRequired"> {
  const raw = env.LAUNCH_ALT?.trim() || undefined;
  if (raw && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw)) throw new Error(`api: LAUNCH_ALT=${JSON.stringify(raw)} is not a base58 address`);
  return { launchAlt: raw, launchAltRequired: (env.FUMPAD_CLUSTER?.trim().toLowerCase() ?? "") !== "localnet" };
}

/**
 * LAUNCH_FIRST_COIN + FIRST_COIN_CREATOR (audit S-2 / H-3). The first-coin config co-signed by our launch key is a
 * one-off, team-only launch: with LAUNCH_FIRST_COIN=true a missing or malformed FIRST_COIN_CREATOR is a startup
 * error (never "any wallet"). FIRST_COIN_CREATOR without LAUNCH_FIRST_COIN is kept but unused.
 */
export function firstCoinConfig(env: NodeJS.ProcessEnv): Pick<ApiConfig, "launchFirstCoin" | "firstCoinCreator"> {
  const launchFirstCoin = env.LAUNCH_FIRST_COIN === "true";
  const raw = env.FIRST_COIN_CREATOR?.trim() || undefined;
  if (raw !== undefined) {
    let ok = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw);
    if (ok) {
      try {
        ok = PublicKey.isOnCurve(new PublicKey(raw).toBytes());
      } catch {
        ok = false;
      }
    }
    if (!ok) throw new Error(`api: FIRST_COIN_CREATOR=${JSON.stringify(raw)} is not a wallet address`);
  }
  if (launchFirstCoin && !raw) throw new Error("api: LAUNCH_FIRST_COIN=true needs FIRST_COIN_CREATOR (the only wallet allowed to launch on the first-coin config)");
  return { launchFirstCoin, firstCoinCreator: raw };
}

/** L-3: the hosts a signed launch message may name (LAUNCH_AUTH_DOMAINS, else the CORS_ORIGINS hosts; null = any). */
export function launchAuthDomainsFromEnv(env: NodeJS.ProcessEnv): string[] | null {
  const explicit = env.LAUNCH_AUTH_DOMAINS?.trim();
  if (explicit) return explicit.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const cors = env.CORS_ORIGINS?.trim();
  if (!cors || cors === "*") return null;
  const hosts: string[] = [];
  for (const o of cors.split(",").map((s) => s.trim()).filter(Boolean)) {
    try {
      hosts.push(new URL(o).host.toLowerCase());
    } catch {
      /* not a URL: ignored */
    }
  }
  return hosts.length ? hosts : null;
}

const boolEnv = (env: NodeJS.ProcessEnv, name: string, dflt: boolean): boolean => {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return dflt;
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  throw new Error(`api: ${name}=${JSON.stringify(env[name])}: expected true or false`);
};

export function loadApiConfig(env = process.env): ApiConfig {
  const prod = isProduction(env);
  requireEnv(env, "api", prod ? ["DATABASE_URL", "RPC_URL", "CORS_ORIGINS", "API_SSR_SECRET"] : ["DATABASE_URL"]);
  const cors = env.CORS_ORIGINS?.trim();
  if (prod && (!cors || cors === "*")) throw new Error("api: CORS_ORIGINS must list explicit origins in production");
  const ssrSecret = env.API_SSR_SECRET?.trim() || undefined;
  if (ssrSecret && ssrSecret.length < 32) throw new Error("api: API_SSR_SECRET must be at least 32 characters");
  // S-4 / L-2: Railway's edge forwards "<client>, <edge>" (2 hops, verified live); 1 keyed every limit on the edge.
  const hops = Number(env.TRUST_PROXY_HOPS ?? (prod ? 2 : 0));
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
    ssrRateLimitPerMin: Number(env.SSR_RATE_LIMIT_PER_MIN ?? 6_000),
    walletRpcRateLimitPerMin: Number(env.WALLET_RPC_RATE_LIMIT_PER_MIN ?? 60),
    liveCoalesceMs: Number(env.LIVE_COALESCE_MS ?? 250),
    wsMaxBufferedBytes: Number(env.WS_MAX_BUFFERED_BYTES ?? 4 * 1024 * 1024),
    statusKeeperUrl: env.STATUS_KEEPER_URL || undefined,
    solUsdFallback: solUsdFallbackFromEnv(env),
    solUsdMaxStaleMs: Number(env.SOL_USD_MAX_STALE_SECS ?? 300) * 1000,
    pythAccount: env.PYTH_SOL_USD_ACCOUNT || undefined,
    logLevel: env.LOG_LEVEL ?? "info",
    mintPoolKey: env.MINT_POOL_KEY || undefined,
    launchSignerKey: env.LAUNCH_SIGNER_KEY || undefined,
    ...launchAltConfig(env),
    ...firstCoinConfig(env),
    launchesOpen: launchesOpenFromEnv(env),
    vanitySuffix: env.VANITY_SUFFIX || "fmbL",
    launchReservationMs: Math.round(Number(env.LAUNCH_RESERVATION_MINUTES ?? 10) * 60_000),
    launchSweepMs: Number(env.LAUNCH_SWEEP_SECS ?? 15) * 1000,
    launchRateLimitPerMin: Number(env.LAUNCH_RATE_LIMIT_PER_MIN ?? 10),
    launchWalletLimitPerMin: Number(env.LAUNCH_WALLET_LIMIT_PER_MIN ?? 6),
    launchMaxActivePerIp: Number(env.LAUNCH_MAX_ACTIVE_PER_IP ?? 3),
    launchWalletReservationsPerHour: Number(env.LAUNCH_WALLET_RESERVATIONS_PER_HOUR ?? 6),
    launchIpReservationsPerHour: Number(env.LAUNCH_IP_RESERVATIONS_PER_HOUR ?? 20),
    launchMaxInitialBuyLamports: BigInt(env.LAUNCH_MAX_INITIAL_BUY_LAMPORTS ?? "100000000000"),
    launchMaxPriorityMicroLamports: Number(env.LAUNCH_MAX_PRIORITY_MICROLAMPORTS ?? 5_000_000),
    launchRequireSignature: env.LAUNCH_REQUIRE_SIGNATURE !== "false",
    launchSignatureMaxAgeSecs: Number(env.LAUNCH_SIGNATURE_MAX_AGE_SECS ?? 600),
    launchAuthDomains: launchAuthDomainsFromEnv(env),
    launchAuthCluster: env.FUMPAD_CLUSTER?.trim().toLowerCase() || "devnet",
    launchAuthAllowLegacy: boolEnv(env, "LAUNCH_AUTH_LEGACY", true),
    launchMinBalanceLamports: BigInt(env.LAUNCH_MIN_BALANCE_LAMPORTS ?? "10000000"),
    launchPoolReserve: Number(env.LAUNCH_POOL_RESERVE ?? 5),
    launchRpcTimeoutMs: Number(env.LAUNCH_RPC_TIMEOUT_MS ?? 5_000),
    waitlistRateLimitPerMin: Number(env.WAITLIST_RATE_LIMIT_PER_MIN ?? 5),
    waitlistPerIpPerDay: Number(env.WAITLIST_PER_IP_PER_DAY ?? 20),
    imgRateLimitPerMin: Number(env.IMG_RATE_LIMIT_PER_MIN ?? 600),
    fumblesRateLimitPerMin: Number(env.FUMBLES_RATE_LIMIT_PER_MIN ?? 60),
    imgMaxPerHost: Number(env.IMG_MAX_PER_HOST ?? 2),
    imgMaxConcurrent: Number(env.IMG_MAX_CONCURRENT ?? 16),
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
