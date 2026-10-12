import { readFileSync } from "node:fs";

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

export interface KeeperConfig {
  rpcUrl: string;
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
  skimIntervalSecs: number;
  platformFeesMinLamports: bigint;
  platformFeesIntervalSecs: number;
  queueIntervalSecs: number;
  scanIntervalSecs: number;
  ticketScanIntervalSecs: number;
  /** Priority fee: percentile of recent fees on the touched accounts, clamped. */
  priorityPercentile: number;
  priorityMinMicroLamports: number;
  priorityMaxMicroLamports: number;
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
  jobs: Record<"sample" | "graduate" | "buyback" | "skim" | "queue" | "fees" | "params" | "autoclaim", boolean>;
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

const n = (v: string | undefined, d: number) => (v === undefined || v === "" ? d : Number(v));
const on = (v: string | undefined) => v !== "false" && v !== "0";

export function loadKeeperConfig(env = process.env): KeeperConfig {
  const rpcUrl = env.RPC_URL || (env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}` : "http://127.0.0.1:8899");
  return {
    rpcUrl,
    keeper: loadKeypair(env),
    dryRun: env.DRY_RUN === "true" || env.DRY_RUN === "1",
    loopMs: n(env.LOOP_MS, 2_000),
    fullRateSecs: n(env.FULL_RATE_SECS, 15),
    heartbeatSecs: n(env.HEARTBEAT_SECS, 480),
    nearTriggerRatio: n(env.NEAR_TRIGGER_RATIO, 0.5),
    buybackMinLamports: BigInt(env.BUYBACK_MIN_LAMPORTS ?? 50_000_000),
    buybackIntervalSecs: n(env.BUYBACK_INTERVAL_SECS, 60),
    skimIntervalSecs: n(env.SKIM_INTERVAL_SECS, 1_800),
    platformFeesMinLamports: BigInt(env.PLATFORM_FEES_MIN_LAMPORTS ?? 100_000_000),
    platformFeesIntervalSecs: n(env.PLATFORM_FEES_INTERVAL_SECS, 3_600),
    queueIntervalSecs: n(env.QUEUE_INTERVAL_SECS, 30),
    scanIntervalSecs: n(env.SCAN_INTERVAL_SECS, 30),
    ticketScanIntervalSecs: n(env.TICKET_SCAN_INTERVAL_SECS, 60),
    priorityPercentile: n(env.PRIORITY_PERCENTILE, 75),
    priorityMinMicroLamports: n(env.PRIORITY_MIN_MICROLAMPORTS, 1_000),
    priorityMaxMicroLamports: n(env.PRIORITY_MAX_MICROLAMPORTS, 2_000_000),
    useLookupTable: env.USE_LOOKUP_TABLE !== "false",
    healthPort: env.PORT ? Number(env.PORT) : env.HEALTH_PORT ? Number(env.HEALTH_PORT) : undefined,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: env.TELEGRAM_CHAT_ID || undefined,
    minKeeperLamports: BigInt(env.MIN_KEEPER_LAMPORTS ?? 500_000_000),
    logLevel: env.LOG_LEVEL ?? "info",
    autoClaimIntervalSecs: n(env.AUTOCLAIM_INTERVAL_SECS, 15),
    autoClaimMaxPerRun: n(env.AUTOCLAIM_MAX_PER_RUN, 20),
    jobs: {
      sample: on(env.JOB_SAMPLE),
      graduate: on(env.JOB_GRADUATE),
      buyback: on(env.JOB_BUYBACK),
      skim: on(env.JOB_SKIM),
      queue: on(env.JOB_QUEUE),
      fees: on(env.JOB_FEES),
      params: on(env.JOB_PARAMS),
      autoclaim: on(env.JOB_AUTOCLAIM),
    },
  };
}
