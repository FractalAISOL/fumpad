import { readFileSync } from "node:fs";

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

export interface KeeperConfig {
  rpcUrl: string;
  /**
   * S-3 / L-9: every transaction (and every rebroadcast) goes out through this RPC — the keeper's private, keyed
   * provider endpoint; defaults to RPC_URL. A public cluster endpoint is refused in production (`publicRpcProblem`).
   */
  sendRpcUrl: string;
  /**
   * S-3: optional Jito private submission for the MEV-sensitive buyback (bundleOnly=true: revert-protected, never
   * forwarded through the public path). Unset = buybacks go through `sendRpcUrl` like everything else.
   */
  jito?: { url: string; tipLamports: number };
  keeper: Keypair;
  dryRun: boolean;
  loopMs: number;
  /** Full-rate sampling interval (claims need 84 keeper samples / 30 min @ 15 s). */
  fullRateSecs: number;
  /** Heartbeat for EVERY graduated coin; must stay < keeper_stale_secs (600). */
  heartbeatSecs: number;
  /** Full rate once spot ≥ this fraction of a coin's lowest open trigger. */
  nearTriggerRatio: number;
  buybackMinLamports: bigint;
  buybackIntervalSecs: number;
  /** L5: each next buyback waits interval × (1 + U[0, jitter)) — unpredictable timing. */
  buybackJitter: number;
  /**
   * S-3: each buyback spends a random U[minFrac, 1] share of what the program allows (and at most
   * BUYBACK_MAX_SLICE_LAMPORTS when set), so slice sizes are unpredictable and small enough that a sandwich's fixed
   * cost (2 × pool fee on the attacker's push) outweighs what it can take from one slice.
   */
  buybackSliceMinFrac: number;
  buybackMaxSliceLamports: bigint;
  /**
   * S-3: keeper-side band, as a fraction of the program's buyback_max_deviation_bps: the keeper only sends when spot is
   * within this tighter band of the guard (the on-chain min_tokens haircut stays the program's; this keeps the keeper
   * from buying into an already-pushed price).
   */
  buybackBandFraction: number;
  /** ONC-4 / L-9: each coin's next sample is due after interval × (1 − U[0, jitter)) — never later than the schedule. */
  sampleJitter: number;
  /** L5: pre-grad guard = TWAP of the keeper's last N spot observations (spaced ≥ spacing), not one sample. */
  pregradTwapSamples: number;
  pregradTwapSpacingSecs: number;
  /** claim_fees once the DBC pool's unclaimed partner fee reaches this (after the launch-window claim). */
  feesMinLamports: bigint;
  feesIntervalSecs: number;
  lpFeesIntervalSecs: number;
  /** Wait this long after the curve completes for Meteora's keepers before migrating ourselves. */
  migrateGraceSecs: number;
  closeIntervalSecs: number;
  closeMaxPerRun: number;
  platformFeesMinLamports: bigint;
  platformFeesIntervalSecs: number;
  queueIntervalSecs: number;
  scanIntervalSecs: number;
  ticketScanIntervalSecs: number;
  /** Priority fee: percentile of recent fees on the touched accounts, clamped. */
  priorityPercentile: number;
  priorityMinMicroLamports: number;
  priorityMaxMicroLamports: number;
  /** M-7: hard cap on the priority fee of ONE transaction (lamports), whatever its CU limit. */
  priorityMaxLamportsPerTx: number;
  /**
   * M-7: daily spend budget (lamports, measured as keeper-balance decreases since 00:00 UTC).
   * Over budget: alert, and only essential jobs (sample, graduate, params) keep sending.
   */
  dailyBudgetLamports: bigint;
  /** Lookup table to reuse (else the one persisted in Postgres `meta`, else a new one, persisted). */
  lookupTable?: string;
  /** Postgres: single-instance advisory lock (L-10), persisted ALT + spend (M-7). Required in production. */
  databaseUrl?: string;
  /**
   * M-7 scan limits: complete + graduated coins are re-scanned every SCAN_INTERVAL_SECS with a
   * status filter; the full scan (incl. every curve coin, only needed for platform-fee
   * withdrawals) runs every FULL_SCAN_INTERVAL_SECS.
   */
  fullScanIntervalSecs: number;
  /** Batch 6–10 coins per record_samples via a v0 tx + address lookup table. */
  useLookupTable: boolean;
  healthPort?: number;
  telegramBotToken?: string;
  telegramChatId?: string;
  /** Alert when the keeper wallet drops below this. */
  minKeeperLamports: bigint;
  logLevel: string;
  /** Crank toggles (all on by default). */
  /** D17 auto-claim: how often each graduated coin is checked, and the most claim_for txs per coin per run. */
  autoClaimIntervalSecs: number;
  autoClaimMaxPerRun: number;
  jobs: Record<"fees" | "graduate" | "sample" | "buyback" | "autoclaim" | "queue" | "close" | "platform" | "params", boolean>;
}

/** KEEPER_KEYPAIR = path to a solana-keygen JSON file; KEEPER_SECRET_KEY = JSON array or base58 (for hosted secrets). */
export function loadKeypair(env = process.env): Keypair {
  if (env.KEEPER_SECRET_KEY) {
    const v = env.KEEPER_SECRET_KEY.trim();
    const bytes = v.startsWith("[") ? Uint8Array.from(JSON.parse(v)) : bs58.decode(v);
    return Keypair.fromSecretKey(bytes);
  }
  if (env.KEEPER_KEYPAIR) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(env.KEEPER_KEYPAIR, "utf8"))));
  throw new Error("KEEPER_KEYPAIR (path) or KEEPER_SECRET_KEY is required");
}

/**
 * Known public (unauthenticated, shared) Solana RPC hosts. Sending through them exposes keeper transactions to
 * anyone watching those nodes, and they rate-limit / drop sends under load.
 */
const PUBLIC_RPC_HOSTS = [/^api\.(mainnet-beta|devnet|testnet)\.solana\.com$/, /(^|\.)publicnode\.com$/, /^solana\.public-rpc\.com$/, /^solana-api\.projectserum\.com$/];
/** Ankr serves its public endpoint and its paid (keyed) endpoints from the same host: public = no key segment. */
const isAnkrPublic = (u: URL) => u.hostname.toLowerCase() === "rpc.ankr.com" && u.pathname.split("/").filter(Boolean).length < 2;

/** Why `url` is a public RPC endpoint, or null (a keyed provider URL, a private host, or a local validator). */
export function publicRpcProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "is not a valid URL";
  }
  const host = u.hostname.toLowerCase();
  return PUBLIC_RPC_HOSTS.some((r) => r.test(host)) || isAnkrPublic(u) ? `is a public endpoint (${host})` : null;
}

const n = (v: string | undefined, d: number) => (v === undefined || v === "" ? d : Number(v));
const on = (v: string | undefined) => v !== "false" && v !== "0";

export function loadKeeperConfig(env = process.env): KeeperConfig {
  const prod = env.NODE_ENV === "production";
  if (prod) {
    const missing = ["RPC_URL", "DATABASE_URL"].filter((k) => !env[k]?.trim());
    if (!env.KEEPER_SECRET_KEY && !env.KEEPER_KEYPAIR) missing.push("KEEPER_SECRET_KEY");
    if (missing.length) throw new Error(`keeper: missing required env ${missing.join(", ")}`);
  }
  // The cluster is never inferred: explicit RPC_URL (local validator outside production).
  const rpcUrl = env.RPC_URL || "http://127.0.0.1:8899";
  const sendRpcUrl = env.SEND_RPC_URL?.trim() || rpcUrl;
  const cluster = (env.FUMPAD_CLUSTER ?? "").trim().toLowerCase();
  const pub = publicRpcProblem(sendRpcUrl);
  if (pub) {
    // ONC-4 / L-9 / S-3: never send through a public endpoint in production; an explicit override exists for
    // devnet/testnet only (mainnet has none).
    const name = env.SEND_RPC_URL?.trim() ? "SEND_RPC_URL" : "RPC_URL (used for sends: SEND_RPC_URL unset)";
    const override = env.ALLOW_PUBLIC_SEND_RPC === "true" && cluster !== "mainnet";
    if (prod && !override) throw new Error(`keeper: ${name} ${pub}: transactions must go through a private (keyed) RPC; set SEND_RPC_URL`);
    console.warn(`keeper: ${name} ${pub}; allowed only outside production or by ALLOW_PUBLIC_SEND_RPC on a non-mainnet cluster`);
  }
  const jitoUrl = env.JITO_URL?.trim();
  return {
    rpcUrl,
    sendRpcUrl,
    jito: jitoUrl ? { url: jitoUrl, tipLamports: Math.max(1_000, n(env.JITO_TIP_LAMPORTS, 10_000)) } : undefined, // Jito's minimum tip: 1000
    buybackSliceMinFrac: Math.min(1, Math.max(0.05, n(env.BUYBACK_SLICE_MIN_FRAC, 0.5))),
    buybackMaxSliceLamports: BigInt(env.BUYBACK_MAX_SLICE_LAMPORTS ?? 0),
    buybackBandFraction: Math.min(1, Math.max(0.1, n(env.BUYBACK_BAND_FRACTION, 0.5))),
    sampleJitter: Math.min(0.5, Math.max(0, n(env.SAMPLE_JITTER, 0.3))),
    keeper: loadKeypair(env),
    dryRun: env.DRY_RUN === "true" || env.DRY_RUN === "1",
    loopMs: n(env.LOOP_MS, 2_000),
    fullRateSecs: n(env.FULL_RATE_SECS, 15),
    heartbeatSecs: n(env.HEARTBEAT_SECS, 480),
    nearTriggerRatio: n(env.NEAR_TRIGGER_RATIO, 0.5),
    buybackMinLamports: BigInt(env.BUYBACK_MIN_LAMPORTS ?? 50_000_000),
    buybackIntervalSecs: n(env.BUYBACK_INTERVAL_SECS, 60),
    buybackJitter: n(env.BUYBACK_JITTER, 1),
    pregradTwapSamples: n(env.PREGRAD_TWAP_SAMPLES, 8),
    pregradTwapSpacingSecs: n(env.PREGRAD_TWAP_SPACING_SECS, 15),
    feesMinLamports: BigInt(env.FEES_MIN_LAMPORTS ?? 50_000_000),
    feesIntervalSecs: n(env.FEES_INTERVAL_SECS, 600),
    lpFeesIntervalSecs: n(env.LP_FEES_INTERVAL_SECS, 1_800),
    migrateGraceSecs: n(env.MIGRATE_GRACE_SECS, 60),
    closeIntervalSecs: n(env.CLOSE_INTERVAL_SECS, 600),
    closeMaxPerRun: n(env.CLOSE_MAX_PER_RUN, 20),
    platformFeesMinLamports: BigInt(env.PLATFORM_FEES_MIN_LAMPORTS ?? 100_000_000),
    platformFeesIntervalSecs: n(env.PLATFORM_FEES_INTERVAL_SECS, 3_600),
    queueIntervalSecs: n(env.QUEUE_INTERVAL_SECS, 30),
    scanIntervalSecs: n(env.SCAN_INTERVAL_SECS, 30),
    ticketScanIntervalSecs: n(env.TICKET_SCAN_INTERVAL_SECS, 60),
    priorityPercentile: n(env.PRIORITY_PERCENTILE, 75),
    priorityMinMicroLamports: n(env.PRIORITY_MIN_MICROLAMPORTS, 1_000),
    priorityMaxMicroLamports: n(env.PRIORITY_MAX_MICROLAMPORTS, 1_000_000),
    priorityMaxLamportsPerTx: n(env.PRIORITY_MAX_LAMPORTS_PER_TX, 200_000),
    dailyBudgetLamports: BigInt(Math.round(Number(env.KEEPER_DAILY_BUDGET_SOL ?? 2) * 1e9)),
    lookupTable: env.KEEPER_LOOKUP_TABLE || undefined,
    databaseUrl: env.DATABASE_URL || undefined,
    fullScanIntervalSecs: n(env.FULL_SCAN_INTERVAL_SECS, 600),
    useLookupTable: env.USE_LOOKUP_TABLE !== "false",
    healthPort: env.PORT ? Number(env.PORT) : env.HEALTH_PORT ? Number(env.HEALTH_PORT) : undefined,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: env.TELEGRAM_CHAT_ID || undefined,
    minKeeperLamports: BigInt(env.MIN_KEEPER_LAMPORTS ?? 500_000_000),
    logLevel: env.LOG_LEVEL ?? "info",
    autoClaimIntervalSecs: n(env.AUTOCLAIM_INTERVAL_SECS, 15),
    autoClaimMaxPerRun: n(env.AUTOCLAIM_MAX_PER_RUN, 20),
    jobs: {
      fees: on(env.JOB_FEES),
      graduate: on(env.JOB_GRADUATE),
      sample: on(env.JOB_SAMPLE),
      buyback: on(env.JOB_BUYBACK),
      autoclaim: on(env.JOB_AUTOCLAIM),
      queue: on(env.JOB_QUEUE),
      close: on(env.JOB_CLOSE),
      platform: on(env.JOB_PLATFORM),
      params: on(env.JOB_PARAMS),
    },
  };
}
