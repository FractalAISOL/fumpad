/** Fastify app: REST routes 1:1 with the app's `FumpadData` interface, WebSocket feed, OpenAPI, rate limits, caching. */
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { Connection } from "@solana/web3.js";
import Fastify, { type FastifyInstance } from "fastify";

import { createPool, type Db } from "@fumpad/indexer";

import { TtlCache } from "./cache.js";
import { ChainReader } from "./chain.js";
import type { ApiConfig } from "./config.js";
import type { Board, ChartRange, FeedKind, Side } from "./generated/app-types.js";
import type { CoinSort } from "./generated/app-interface.js";
import { LiveHub } from "./live.js";
import { OPENAPI } from "./openapi.js";
import { Repo } from "./repo.js";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const bad = (msg: string) => Object.assign(new Error(msg), { statusCode: 400 });
const addr = (v: unknown, name: string) => {
  if (typeof v !== "string" || !BASE58.test(v)) throw bad(`invalid ${name}`);
  return v;
};
const optAddr = (v: unknown, name: string) => (v === undefined || v === "" ? undefined : addr(v, name));
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], name: string, dflt?: T): T => {
  if (v === undefined && dflt !== undefined) return dflt;
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw bad(`invalid ${name}`);
  return v as T;
};
const int = (v: unknown, dflt: number) => (v === undefined ? dflt : Number.isFinite(Number(v)) ? Math.floor(Number(v)) : dflt);

export interface ApiDeps {
  db: Db;
  conn: Connection;
  repo: Repo;
  chain: ChainReader;
  cache: TtlCache;
  live: LiveHub;
}

export async function buildServer(cfg: ApiConfig, deps?: Partial<ApiDeps>): Promise<{ app: FastifyInstance; deps: ApiDeps }> {
  const app = Fastify({
    logger: { level: cfg.logLevel, redact: ["req.headers.authorization"] },
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });
  const db = deps?.db ?? createPool(cfg.databaseUrl);
  const conn = deps?.conn ?? new Connection(cfg.rpcUrl, "confirmed");
  const cache = deps?.cache ?? new TtlCache();
  const repo = deps?.repo ?? new Repo(db);
  const chain = deps?.chain ?? new ChainReader(conn, cache, { solUsdFallback: cfg.solUsdFallback, pythAccount: cfg.pythAccount });
  const live =
    deps?.live ??
    new LiveHub(cfg.databaseUrl, (id) => repo.feedById(id), (mints) => cache.invalidate(mints ? [...mints, "list", "feed", "stats", "board", "closest", "tickets"] : undefined), app.log);
  const all: ApiDeps = { db, conn, repo, chain, cache, live };

  await app.register(cors, { origin: cfg.corsOrigins === "*" ? true : cfg.corsOrigins, methods: ["GET", "OPTIONS"] });
  await app.register(rateLimit, { max: cfg.rateLimitPerMin, timeWindow: "1 minute", allowList: cfg.rateLimitAllow });
  await app.register(websocket, { options: { maxPayload: 4 * 1024 } });

  app.addHook("onSend", async (_req, reply) => {
    reply.header("x-server-time", String(Date.now()));
  });

  const cached = <T>(key: string, ttl: number, fn: () => Promise<T>) => cache.get(key, ttl, fn);

  // ── REST (one route per FumpadData method) ──────────────────────────────────
  app.get("/v1/stats", async () => cached("stats", 5_000, async () => repo.getStats(await chain.solUsd())));
  app.get("/v1/sol-usd", async () => ({ solUsd: await chain.solUsd() }));
  app.get("/v1/coins", async (req) => {
    const qs = req.query as Record<string, string>;
    const sort = oneOf<CoinSort>(qs.sort, ["trending", "new", "mcap", "closest", "graduating"], "sort", "trending");
    const status = oneOf(qs.status, ["curve", "graduated", "all"] as const, "status", "all");
    const limit = int(qs.limit, 50);
    return cached(`list:${sort}:${status}:${limit}`, 3_000, () => repo.listCoins({ sort, status, limit }));
  });
  app.get("/v1/coins/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id.length > 64) throw bad("invalid coin");
    const c = await cached(`coin:${id}`, 2_000, () => repo.getCoin(id));
    if (!c) return reply.code(404).send({ error: "not found" });
    return c;
  });
  app.get("/v1/coins/:mint/prices", async (req) => {
    const mint = addr((req.params as { mint: string }).mint, "mint");
    const range = oneOf<ChartRange>((req.query as Record<string, string>).range, ["1h", "1d", "7d", "all"], "range", "1d");
    return cached(`prices:${mint}:${range}`, 5_000, () => repo.getPriceSeries(mint, range));
  });
  app.get("/v1/coins/:mint/holders", async (req) => {
    const mint = addr((req.params as { mint: string }).mint, "mint");
    const viewer = optAddr((req.query as Record<string, string>).viewer, "viewer");
    return cached(`holders:${mint}:${viewer ?? ""}`, 5_000, () => repo.getHolders(mint, viewer));
  });
  app.get("/v1/coins/:mint/fumbles", async (req) => {
    const mint = addr((req.params as { mint: string }).mint, "mint");
    const viewer = optAddr((req.query as Record<string, string>).viewer, "viewer");
    return cached(`fumbles:${mint}:${viewer ?? ""}`, 3_000, () => repo.getRecentFumbles(mint, viewer));
  });
  app.get("/v1/coins/:mint/queue", async (req) => {
    const mint = addr((req.params as { mint: string }).mint, "mint");
    const viewer = optAddr((req.query as Record<string, string>).viewer, "viewer");
    return cached(`queue:${mint}:${viewer ?? ""}`, 3_000, () => repo.getClaimQueue(mint, viewer));
  });
  app.get("/v1/feed", async (req) => {
    const qs = req.query as Record<string, string>;
    const kind = oneOf<FeedKind | "all">(qs.kind, ["launch", "fumble", "cross", "graduation", "claim", "all"], "kind", "all");
    const before = qs.before !== undefined ? Number(qs.before) : undefined;
    const limit = int(qs.limit, 30);
    return cached(`feed:${kind}:${before ?? ""}:${limit}`, 2_000, () => repo.getFeed({ kind, before, limit }));
  });
  app.get("/v1/closest", async (req) => {
    const qs = req.query as Record<string, string>;
    const viewer = optAddr(qs.viewer, "viewer");
    const limit = Math.min(int(qs.limit, 5), 50);
    return cached(`closest:${limit}:${viewer ?? ""}`, 5_000, () => repo.getClosestTo10x(limit, viewer));
  });
  app.get("/v1/wallets/:owner/tickets", async (req) => {
    const owner = addr((req.params as { owner: string }).owner, "owner");
    return cached(`tickets:${owner}`, 2_000, () => repo.getTickets(owner));
  });
  app.get("/v1/tickets/:id", async (req, reply) => {
    const id = addr((req.params as { id: string }).id, "ticket");
    const t = await cached(`tickets:one:${id}`, 2_000, () => repo.getTicket(id));
    if (!t) return reply.code(404).send({ error: "not found" });
    return t;
  });
  app.get("/v1/leaderboards/:board", async (req) => {
    const board = oneOf<Board>((req.params as { board: string }).board, ["fumbles", "claimers", "diamond"], "board");
    const viewer = optAddr((req.query as Record<string, string>).viewer, "viewer");
    const rows = await cached(`board:${board}`, 10_000, () => repo.getLeaderboard(board));
    return rows.map((r) => ({ ...r, isYou: viewer ? r.address === viewer : false }));
  });
  app.get("/v1/profiles/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id.length > 64) throw bad("invalid profile");
    const pr = await cached(`profile:${id}`, 5_000, () => repo.getProfile(id));
    if (!pr) return reply.code(404).send({ error: "not found" });
    return pr;
  });
  app.get(
    "/v1/quote",
    { config: { rateLimit: { max: cfg.quoteRateLimitPerMin, timeWindow: "1 minute" } } },
    async (req) => {
      const qs = req.query as Record<string, string>;
      const mint = addr(qs.mint, "mint");
      const side = oneOf<Side>(qs.side, ["buy", "sell"], "side");
      const amount = Number(qs.amount);
      if (!Number.isFinite(amount) || amount < 0 || amount > 1e15) throw bad("invalid amount");
      const wallet = optAddr(qs.wallet, "wallet");
      const row = await cached(`coin:${mint}`, 2_000, () => repo.getCoin(mint));
      return chain.quote({ mint, side, amount, wallet, symbol: row?.symbol });
    },
  );
  app.get("/v1/wallets/:wallet/balances/:mint", async (req) => {
    const { wallet, mint } = req.params as { wallet: string; mint: string };
    addr(wallet, "wallet");
    addr(mint, "mint");
    return cached(`bal:${wallet}:${mint}`, 2_000, () => chain.balances(wallet, mint));
  });

  // ── WebSocket feed ──────────────────────────────────────────────────────────
  const perIp = new Map<string, number>();
  app.get("/v1/ws", { websocket: true }, (socket, req) => {
    const ip = req.ip;
    const n = (perIp.get(ip) ?? 0) + 1;
    if (n > cfg.maxWsPerIp) {
      socket.close(1008, "too many connections");
      return;
    }
    perIp.set(ip, n);
    socket.send(JSON.stringify({ type: "hello", serverTime: Date.now() }));
    const unsub = live.subscribe((m) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(m));
    });
    const ping = setInterval(() => socket.readyState === 1 && socket.ping(), 25_000);
    socket.on("message", () => {
      /* client messages are ignored (read-only feed) */
    });
    socket.on("close", () => {
      unsub();
      clearInterval(ping);
      perIp.set(ip, Math.max(0, (perIp.get(ip) ?? 1) - 1));
    });
  });

  // ── docs + health ───────────────────────────────────────────────────────────
  app.get("/openapi.json", async () => OPENAPI);
  app.get("/health", async (_req, reply) => {
    let dbOk = false;
    let lagSecs: number | null = null;
    try {
      const r = await db.query<{ t: string | null }>("SELECT max(block_time) AS t FROM transactions");
      dbOk = true;
      lagSecs = r.rows[0].t ? Math.floor(Date.now() / 1000) - Number(r.rows[0].t) : null;
    } catch {
      /* db down */
    }
    reply.code(dbOk ? 200 : 503);
    return { ok: dbOk, lastIndexedBlockAgeSecs: lagSecs, wsClients: live.subscribers, live: live.stats, cache: { hits: cache.hits, misses: cache.misses } };
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const code = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (code >= 500) app.log.error(err);
    reply.code(code).send({ error: code >= 500 ? "internal error" : err.message });
  });

  app.addHook("onClose", async () => {
    await live.stop();
    if (!deps?.db) await db.end();
  });
  return { app, deps: all };
}
