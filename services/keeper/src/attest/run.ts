/**
 * Process wiring for the attestor and watcher modes (main.ts `--mode attestor|watcher`).
 *
 * Env: RPC_URL (this keeper's own provider), KEEPER_SECRET_KEY | KEEPER_KEYPAIR, DATABASE_URL (shared
 * signature board; required in production), ATTEST_LOOP_MS (15 s), PYTH_SOURCE=hermes|constant
 * (HERMES_URL, PYTH_API_KEY (alias HERMES_API_KEY; sent as `Authorization: Bearer`), HERMES_API_KEY_HEADER
 * (other header name, raw key); PYTH_CONSTANT_USD for local chains only),
 * TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID, PORT / HEALTH_PORT, DRY_RUN.
 * Liveness (V7-M6): ATTEST_COIN_CONCURRENCY (4), ATTEST_TICK_BUDGET_MS (60 s), ATTEST_COIN_RPC_BUDGET
 * (5,000 calls per coin per tick), ATTEST_TX_CACHE (200k txs), ATTEST_BLOCK_CACHE (50k slots).
 * Board (V7-M1): ATTEST_BOARD_REQUIRE_RLS=1 refuses to start unless per-keeper roles + row-level security
 * are set up (services/README.md "Keeper board"); otherwise a missing RLS setup is logged and alerted.
 * History (L8): RPC_HISTORY_CHECK=off disables the first-available-block check.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";

import { Connection, type Keypair } from "@solana/web3.js";
import pg from "pg";
import pino from "pino";

import { constantPythSource, HermesPythSource, LruMap, type PythSource } from "@fumpad/engine";
import { MeteoraRpc } from "@fumpad/meteora";

import { Alerter } from "../alerts.js";
import { loadKeypair } from "../config.js";
import { Attestor } from "./attestor.js";
import { MemoryBoard, PgBoard, type SignatureBoard } from "./board.js";
import { RpcChainView, RpcSubmitter } from "./chain.js";
import { type DeriveCaches, deriveCoin, newCaches } from "./derive.js";
import { guardHistory } from "./history-check.js";

export function pythSourceFromEnv(env = process.env): PythSource {
  const kind = env.PYTH_SOURCE ?? (env.NODE_ENV === "production" ? "hermes" : "constant");
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

/** Session advisory lock id per keeper key: one process per attestor key, several keys per database. */
export const lockIdFor = (mode: string, keeper: string) => createHash("sha256").update(`${mode}:${keeper}`).digest().readInt32LE(0);

/** Bounded derive caches + per-coin crawl budget from env (V7-M6). */
export function deriveLimitsFromEnv(env = process.env): { caches: DeriveCaches; maxRpcCalls: number; priceCache: Map<number, import("@fumpad/engine").PythPrice | null> } {
  return {
    caches: newCaches({ txs: Number(env.ATTEST_TX_CACHE ?? 200_000), blocks: Number(env.ATTEST_BLOCK_CACHE ?? 50_000) }),
    maxRpcCalls: Number(env.ATTEST_COIN_RPC_BUDGET ?? 5_000),
    priceCache: new LruMap(Number(env.ATTEST_PRICE_CACHE ?? 100_000)),
  };
}

export interface Running {
  stop(): Promise<void>;
}

export async function runAttestor(env = process.env, keeper: Keypair = loadKeypair(env)): Promise<Running> {
  const log = pino({ level: env.LOG_LEVEL ?? "info", base: { svc: "attestor", keeper: keeper.publicKey.toBase58().slice(0, 8) } });
  const prod = env.NODE_ENV === "production";
  if (prod && (!env.RPC_URL || !env.DATABASE_URL)) throw new Error("attestor: RPC_URL and DATABASE_URL are required in production");
  const url = env.RPC_URL || "http://127.0.0.1:8899";
  const conn = new Connection(url, "confirmed");
  const rpc = new MeteoraRpc(url, { minGapMs: Number(env.RPC_MIN_GAP_MS ?? 0) });
  const pool = env.DATABASE_URL ? new pg.Pool({ connectionString: env.DATABASE_URL, max: 3, application_name: "fumpad-attestor" }) : undefined;
  let board: SignatureBoard;
  let lockClient: pg.Client | undefined;
  const alerts = new Alerter(log, { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID, prefix: `[fumpad-attestor ${keeper.publicKey.toBase58().slice(0, 6)}]` });
  if (pool) {
    const b = new PgBoard(pool);
    await b.init();
    if (!(await b.rowSecurity())) {
      const msg = "attest board has no row-level security: any keeper/DB writer can delete or squat peers' signatures (set up per-keeper roles, services/README.md 'Keeper board')";
      if (env.ATTEST_BOARD_REQUIRE_RLS === "1") throw new Error(msg);
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
  const { caches, maxRpcCalls, priceCache } = deriveLimitsFromEnv(env);
  const chain = new RpcChainView(conn);
  const derive = (coin: Parameters<typeof deriveCoin>[1], g: Parameters<typeof deriveCoin>[2]) =>
    deriveCoin({ rpc, fetchPrice: (t, d) => pyth.priceAt(t, d), caches, priceCache, maxRpcCalls }, coin, g);
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
