/**
 * Process wiring for the attestor and watcher modes (main.ts `--mode attestor|watcher`).
 *
 * Env: RPC_URL (this keeper's own provider), KEEPER_SECRET_KEY | KEEPER_KEYPAIR, DATABASE_URL (shared
 * signature board; required in production), ATTEST_LOOP_MS (15 s), PYTH_SOURCE=onchain|hermes|constant
 * (onchain = production default, free: PYTH_RPC_URL = a Solana MAINNET RPC on every cluster (default
 * RPC_URL), PYTH_RPC_MIN_GAP_MS, PYTH_ONCHAIN_INDEX_LAG_SECS (20), PYTH_ONCHAIN_HEAD_TTL_MS (15 s),
 * PYTH_ONCHAIN_MAX_CANDIDATES (100k); hermes = paid Hermes: HERMES_URL, PYTH_API_KEY (alias
 * HERMES_API_KEY; sent as `Authorization: Bearer`), HERMES_API_KEY_HEADER (other header name, raw key);
 * PYTH_CONSTANT_USD for local chains only),
 * TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID, PORT / HEALTH_PORT, DRY_RUN.
 * Liveness (V7-M6, S-1): ATTEST_COIN_CONCURRENCY (4), ATTEST_TICK_BUDGET_MS (60 s), ATTEST_COIN_RPC_BUDGET
 * (5,000 calls per coin per tick; adaptive up to ATTEST_COIN_RPC_BUDGET_MAX = 4×), ATTEST_CRAWL_ALERT_TICKS (4),
 * ATTEST_TX_CACHE (200k txs), ATTEST_BLOCK_CACHE (50k slots).
 * Rebuy spend (H-1): ATTEST_REBUY_PER_TICKET_HOUR (6), ATTEST_REBUY_PER_COIN_HOUR (120), MIN_ATTESTOR_LAMPORTS
 * (low-balance alert; default MIN_KEEPER_LAMPORTS or 0.2 SOL). Consensus engine knobs (identical on all attestors
 * + the watcher): ENGINE_MIN_REBUY_DEBIT_BPS (100), ENGINE_DUST_TRANSFER_BPS (100).
 * Board (V7-M1, S-8): ATTEST_BOARD_REQUIRE_RLS (default 1 in production, 0 elsewhere) refuses to start unless
 * per-keeper roles + effective row-level security are set up (services/README.md "Keeper board"); otherwise a
 * missing RLS setup is logged and alerted.
 * History (L8): RPC_HISTORY_CHECK=off disables the first-available-block check.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";

import { Connection, type Keypair } from "@solana/web3.js";
import pg from "pg";
import pino from "pino";

import { constantPythSource, HermesPythSource, LruMap, OnchainPythSource, type PythSource } from "@fumpad/engine";
import { MeteoraRpc } from "@fumpad/meteora";

import { Alerter } from "../alerts.js";
import { loadKeypair } from "../config.js";
import { Attestor } from "./attestor.js";
import { MemoryBoard, PgBoard, type SignatureBoard } from "./board.js";
import { RpcChainView, RpcSubmitter } from "./chain.js";
import { type DeriveCaches, deriveCoin, type EngineOverrides, engineOverridesFromEnv, newCaches } from "./derive.js";
import { guardHistory } from "./history-check.js";
import { requireKeyRole } from "../role.js";

export function pythSourceFromEnv(env = process.env): PythSource {
  const kind = env.PYTH_SOURCE ?? (env.NODE_ENV === "production" ? "onchain" : "constant");
  if (kind === "onchain") {
    // Free, chain-native (engine/src/pyth-onchain.ts): the SOL/USD push account's writes, always read on
    // Solana MAINNET (devnet's copy updates only every ~5 min). PYTH_RPC_URL defaults to RPC_URL, so a
    // devnet keeper must set it to a mainnet endpoint (same provider: e.g. Helius host devnet→mainnet).
    const url = env.PYTH_RPC_URL || env.RPC_URL;
    if (!url) throw new Error("PYTH_SOURCE=onchain needs PYTH_RPC_URL (Solana mainnet) or RPC_URL");
    const rpc = new MeteoraRpc(url, { minGapMs: Number(env.PYTH_RPC_MIN_GAP_MS ?? env.RPC_MIN_GAP_MS ?? 0) });
    // The selection window (grace / lookback) is consensus: never configurable per keeper.
    return new OnchainPythSource(rpc, {
      indexLagSecs: env.PYTH_ONCHAIN_INDEX_LAG_SECS ? Number(env.PYTH_ONCHAIN_INDEX_LAG_SECS) : undefined,
      headTtlMs: env.PYTH_ONCHAIN_HEAD_TTL_MS ? Number(env.PYTH_ONCHAIN_HEAD_TTL_MS) : undefined,
      maxCandidates: env.PYTH_ONCHAIN_MAX_CANDIDATES ? Number(env.PYTH_ONCHAIN_MAX_CANDIDATES) : undefined,
      expectGenesisHash: env.PYTH_ONCHAIN_ANY_CLUSTER === "1" && env.NODE_ENV !== "production" ? null : undefined,
    });
  }
  if (kind === "hermes") {
    const apiKey = env.PYTH_API_KEY || env.HERMES_API_KEY || undefined;
    // Hermes refuses unauthenticated requests since 2026-10: without a key every sell would go unattested.
    if (!apiKey && env.NODE_ENV === "production" && !env.HERMES_URL) throw new Error("PYTH_SOURCE=hermes needs PYTH_API_KEY (public Hermes answers 401 without it)");
    return new HermesPythSource({ baseUrl: env.HERMES_URL || undefined, apiKey, apiKeyHeader: env.HERMES_API_KEY_HEADER || undefined });
  }
  if (kind === "constant") {
    if (env.NODE_ENV === "production") throw new Error("PYTH_SOURCE=constant is for local chains only");
    const usd = Number(env.PYTH_CONSTANT_USD ?? 150);
    return constantPythSource(BigInt(Math.round(usd * 1e8)), 0n, -8, 1);
  }
  throw new Error(`unknown PYTH_SOURCE ${kind}`);
}

/** Fail fast at startup when PYTH_SOURCE=onchain points at a non-mainnet RPC. */
export async function checkPythSource(pyth: PythSource): Promise<void> {
  if (pyth instanceof OnchainPythSource) await pyth.verifyCluster();
}

/** Session advisory lock id per keeper key: one process per attestor key, several keys per database. */
export const lockIdFor = (mode: string, keeper: string) => createHash("sha256").update(`${mode}:${keeper}`).digest().readInt32LE(0);

/**
 * Bounded derive caches + per-coin crawl budget from env (V7-M6, S-1) + the consensus engine knobs (H-1 / M-1:
 * ENGINE_MIN_REBUY_DEBIT_BPS / ENGINE_DUST_TRANSFER_BPS — identical on every attestor and the watcher).
 */
export function deriveLimitsFromEnv(env = process.env): {
  caches: DeriveCaches;
  maxRpcCalls: number;
  maxRpcCallsCeiling: number;
  engine: EngineOverrides;
  priceCache: Map<number, import("@fumpad/engine").PythPrice | null>;
} {
  const maxRpcCalls = Number(env.ATTEST_COIN_RPC_BUDGET ?? 5_000);
  return {
    caches: newCaches({ txs: Number(env.ATTEST_TX_CACHE ?? 200_000), blocks: Number(env.ATTEST_BLOCK_CACHE ?? 50_000) }),
    maxRpcCalls,
    maxRpcCallsCeiling: Math.max(maxRpcCalls, Number(env.ATTEST_COIN_RPC_BUDGET_MAX ?? maxRpcCalls * 4)),
    engine: engineOverridesFromEnv(env),
    priceCache: new LruMap(Number(env.ATTEST_PRICE_CACHE ?? 100_000)),
  };
}

/** S-8 / L-1: refuse to start without board RLS — default ON in production (ATTEST_BOARD_REQUIRE_RLS=0 opts out). */
export function boardRlsRequired(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.ATTEST_BOARD_REQUIRE_RLS;
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return env.NODE_ENV === "production";
}

/** H-1: alert below this balance (MIN_ATTESTOR_LAMPORTS, else MIN_KEEPER_LAMPORTS, else 0.2 SOL). */
export const minAttestorLamports = (env: Record<string, string | undefined> = process.env): number =>
  Number(env.MIN_ATTESTOR_LAMPORTS ?? env.MIN_KEEPER_LAMPORTS ?? 200_000_000);

export interface Running {
  stop(): Promise<void>;
}

export async function runAttestor(env = process.env, keeper: Keypair = loadKeypair(env)): Promise<Running> {
  const log = pino({ level: env.LOG_LEVEL ?? "info", base: { svc: "attestor", keeper: keeper.publicKey.toBase58().slice(0, 8) } });
  const prod = env.NODE_ENV === "production";
  if (prod && (!env.RPC_URL || !env.DATABASE_URL)) throw new Error("attestor: RPC_URL and DATABASE_URL are required in production");
  const url = env.RPC_URL || "http://127.0.0.1:8899";
  const conn = new Connection(url, "confirmed");
  // Never attest with the jobs keeper's (operator) key.
  await requireKeyRole("attestor", conn, keeper.publicKey);
  const rpc = new MeteoraRpc(url, { minGapMs: Number(env.RPC_MIN_GAP_MS ?? 0) });
  const pool = env.DATABASE_URL ? new pg.Pool({ connectionString: env.DATABASE_URL, max: 3, application_name: "fumpad-attestor" }) : undefined;
  let board: SignatureBoard;
  let lockClient: pg.Client | undefined;
  const alerts = new Alerter(log, { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID, prefix: `[fumpad-attestor ${keeper.publicKey.toBase58().slice(0, 6)}]` });
  if (pool) {
    const b = new PgBoard(pool);
    await b.init();
    const problems = await b.rlsProblems();
    if (problems.length) {
      const msg = `attest board row-level security is not effective for this role (${problems.join("; ")}): any keeper/DB writer can delete or squat peers' signatures (set up per-keeper roles, services/README.md 'Keeper board')`;
      if (boardRlsRequired(env)) throw new Error(`${msg}. Refusing to start (ATTEST_BOARD_REQUIRE_RLS; default on in production).`);
      log.error(msg);
      if (prod) await alerts.alert("board-rls", msg);
    }
    board = b;
    lockClient = new pg.Client({ connectionString: env.DATABASE_URL });
    await lockClient.connect();
    const id = lockIdFor("attestor", keeper.publicKey.toBase58());
    for (;;) {
      const r = await lockClient.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [id]);
      if (r.rows[0]?.ok) break;
      log.warn("another attestor with this key holds the lock; waiting");
      await new Promise((r) => setTimeout(r, 10_000));
    }
  } else {
    log.warn("no DATABASE_URL: in-memory signature board (single-process local runs only)");
    board = new MemoryBoard();
  }
  const pyth = pythSourceFromEnv(env);
  await checkPythSource(pyth);
  const { caches, maxRpcCalls, maxRpcCallsCeiling, engine, priceCache } = deriveLimitsFromEnv(env);
  const chain = new RpcChainView(conn);
  const derive = (coin: Parameters<typeof deriveCoin>[1], g: Parameters<typeof deriveCoin>[2]) =>
    deriveCoin({ rpc, fetchPrice: (t, d) => pyth.priceAt(t, d), caches, priceCache, maxRpcCalls, maxRpcCallsCeiling, engine }, coin, g);
  const attestor = new Attestor({
    keeper,
    chain,
    derive: env.RPC_HISTORY_CHECK === "off" ? derive : guardHistory(rpc, derive, { onFloor: (slot) => log.info({ firstAvailableSlot: slot }, "attestor: RPC history floor") }),
    coinConcurrency: Number(env.ATTEST_COIN_CONCURRENCY ?? 4),
    tickBudgetMs: Number(env.ATTEST_TICK_BUDGET_MS ?? 60_000),
    board,
    submitter: new RpcSubmitter(conn, keeper, log, { dryRun: env.DRY_RUN === "true" || env.DRY_RUN === "1" }),
    log,
    alerts,
    fallbackSubmitSecs: Number(env.ATTEST_FALLBACK_SUBMIT_SECS ?? 60),
    crawlAlertTicks: Number(env.ATTEST_CRAWL_ALERT_TICKS ?? 4),
    rebuyPerTicketPerHour: Number(env.ATTEST_REBUY_PER_TICKET_HOUR ?? 6),
    rebuyPerCoinPerHour: Number(env.ATTEST_REBUY_PER_COIN_HOUR ?? 120),
    balance: () => conn.getBalance(keeper.publicKey, "confirmed"),
    minLamports: minAttestorLamports(env),
  });
  const loopMs = Number(env.ATTEST_LOOP_MS ?? 15_000);
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      try {
        await attestor.tick();
      } catch (e) {
        log.error({ err: String(e).slice(0, 300) }, "attestor tick failed");
        await alerts.alert("tick", `tick failed: ${String(e).slice(0, 200)}`);
      }
      await new Promise((r) => setTimeout(r, loopMs));
    }
  })();
  const port = Number(env.PORT ?? env.HEALTH_PORT ?? 0);
  const server = port
    ? createServer((req, res) => {
        res.writeHead(req.url?.startsWith("/health") ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, mode: "attestor", keeper: keeper.publicKey.toBase58(), ...attestor.stats }));
      }).listen(port)
    : undefined;
  log.info({ rpc: new URL(url).origin, board: pool ? "postgres" : "memory" }, "attestor started");
  return {
    async stop() {
      stopped = true;
      await loop.catch(() => {});
      server?.close();
      await lockClient?.end().catch(() => {});
      await pool?.end().catch(() => {});
    },
  };
}
