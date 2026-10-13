/** Fastify app: REST routes 1:1 with the app's `FumpadData` interface, WebSocket feed, OpenAPI, rate limits, caching. */
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { Connection } from "@solana/web3.js";
import Fastify, { type FastifyInstance } from "fastify";

import { createPool, type Db, serviceInfo } from "@fumpad/indexer";

import { TtlCache } from "./cache.js";
import { ChainReader } from "./chain.js";
import type { ApiConfig } from "./config.js";
import type { Board, ChartRange, FeedKind, Side } from "./generated/app-types.js";
import type { CoinSort } from "./generated/app-interface.js";
import { LiveHub } from "./live.js";
import { OPENAPI } from "./openapi.js";
import { AmbiguousSymbolError, Repo } from "./repo.js";
import { systemStatus } from "./status.js";
import { type ChainProbe, LaunchError, MintPool } from "./launch/pool.js";
import { registerLaunchRoutes } from "./launch/routes.js";
import { MintVault } from "./launch/vault.js";
import { clientIpTrust, ssrAuthorized, SSR_HEADER } from "./net.js";
import { WaitlistError, registerWaitlistRoutes } from "./waitlist.js";

/** Mint-existence / block-height probe for the vanity pool sweeper. */
export function connectionProbe(conn: Connection): ChainProbe {
  return {
    async existing(mints) {
      const out: boolean[] = [];
      for (let i = 0; i < mints.length; i += 100) {
        const infos = await conn.getMultipleAccountsInfo(mints.slice(i, i + 100), "confirmed");
        out.push(...infos.map((a) => !!a && a.lamports > 0));
      }
      return out;
    },
    blockHeight: () => conn.getBlockHeight("confirmed"),
  };
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const B58 = "^[1-9A-HJ-NP-Za-km-z]{32,44}$";

// L-3: JSON-schema validation (Fastify/ajv) for every query string and path parameter;
// a malformed value is a 400 before any handler runs (no NaN reaching SQL).
const mintParam = { type: "object", properties: { mint: { type: "string", pattern: B58 } }, required: ["mint"] } as const;
const viewerQs = { type: "object", properties: { viewer: { type: "string", pattern: `${B58}|^$` } } } as const;
const limitProp = (max: number) => ({ type: "integer", minimum: 1, maximum: max }) as const;
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
  /** D18 vanity mint pool; null when MINT_POOL_KEY is unset (launch endpoints answer 503). */
  pool: MintPool | null;
}

export async function buildServer(
  cfg: ApiConfig,
  deps?: Partial<ApiDeps>,
  opts: { logStream?: NodeJS.WritableStream } = {},
): Promise<{ app: FastifyInstance; deps: ApiDeps }> {
  const app = Fastify({
    logger: {
      level: cfg.logLevel,
      redact: ["req.headers.authorization", `req.headers["${SSR_HEADER}"]`],
      serializers: {
        // `xffHops` (entry count only, never the addresses' content beyond req.ip) lets an
        // operator check TRUST_PROXY_HOPS against what the platform proxy actually sends.
        req: (r: { method: string; url: string; ip: string; headers: Record<string, string | string[] | undefined> }) => ({
          method: r.method,
          url: r.url,
          remoteAddress: r.ip,
          xffHops: typeof r.headers["x-forwarded-for"] === "string" ? r.headers["x-forwarded-for"].split(",").length : 0,
        }),
      },
      ...(opts.logStream ? { stream: opts.logStream } : {}),
    },
    // H-2: never trust every X-Forwarded-For hop (the leftmost entry is client-controlled).
    // Trust exactly TRUST_PROXY_HOPS hops (Railway's edge: 1) plus optional private CIDRs.
    trustProxy: clientIpTrust(cfg.trustProxyHops, cfg.trustProxyCidrs),
    bodyLimit: 64 * 1024,
  });
  const db = deps?.db ?? createPool(cfg.databaseUrl);
  const conn = deps?.conn ?? new Connection(cfg.rpcUrl, "confirmed");
  const cache = deps?.cache ?? new TtlCache();
  const repo = deps?.repo ?? new Repo(db);
  const chain = deps?.chain ?? new ChainReader(conn, cache, { solUsdFallback: cfg.solUsdFallback, pythAccount: cfg.pythAccount, recentAcquired: (w, m, since) => repo.recentAcquired(w, m, since) });
  const live =
    deps?.live ??
    new LiveHub(
      cfg.databaseUrl,
      { feed: (id) => repo.feedById(id), coin: (mint, sig) => repo.liveCoin(mint, sig) },
      // Per transaction: everything keyed by a touched mint/wallet plus the cheap cross-coin
      // lists. Leaderboards (a full ticket scan) are left to their 10 s TTL instead of being
      // recomputed after every trade.
      // L-11: only what a transaction can change — keys of the touched mints/wallets (coin,
      // prices, holders, queue, trades, tickets:<wallet>, portfolio, profile:<wallet>, …), the
      // single-ticket lookups and the small cross-coin lists. No longer every wallet's
      // tickets/profile on every trade.
      (mints, wallets) => cache.invalidate(mints ? [...mints, ...(wallets ?? []), "list", "feed", "stats", "closest", "tickets:one"] : undefined),
      app.log,
      { coalesceMs: cfg.liveCoalesceMs },
    );
  const pool =
    deps?.pool !== undefined
      ? deps.pool
      : cfg.mintPoolKey
        ? new MintPool(db, new MintVault(cfg.mintPoolKey), connectionProbe(conn), {
            suffix: cfg.vanitySuffix,
            reservationMs: cfg.launchReservationMs,
            maxActivePerIp: cfg.launchMaxActivePerIp,
            reserve: cfg.launchPoolReserve,
            rpcTimeoutMs: cfg.launchRpcTimeoutMs,
          })
        : null;
  const all: ApiDeps = { db, conn, repo, chain, cache, live, pool };

  await app.register(cors, { origin: cfg.corsOrigins === "*" ? true : cfg.corsOrigins, methods: ["GET", "POST", "OPTIONS"] });
  // SSR requests (shared secret header, H-2) are exempt; everyone else is limited per real IP.
  const isSsr = (req: { headers: Record<string, string | string[] | undefined> }) => ssrAuthorized(req.headers[SSR_HEADER], cfg.ssrSecret);
  await app.register(rateLimit, { max: cfg.rateLimitPerMin, timeWindow: "1 minute", allowList: (req) => isSsr(req) });
  await app.register(websocket, { options: { maxPayload: 4 * 1024 } });

  app.addHook("onSend", async (_req, reply) => {
    reply.header("x-server-time", String(Date.now()));
  });

  const cached = <T>(key: string, ttl: number, fn: () => Promise<T>) => cache.get(key, ttl, fn);

  // ── REST (one route per FumpadData method) ──────────────────────────────────
  app.get("/v1/stats", async () => cached("stats", 5_000, async () => repo.getStats(await chain.solUsd())));
  app.get("/v1/sol-usd", async () => ({ solUsd: await chain.solUsd() }));
  app.get("/v1/params", async () => cached("params", 30_000, () => repo.getParams()));
  app.get(
    "/v1/coins",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            sort: { type: "string", enum: ["trending", "new", "mcap", "closest", "graduating"] },
            status: { type: "string", enum: ["curve", "graduated", "all"] },
            limit: limitProp(200),
            symbol: { type: "string", minLength: 1, maxLength: 16 },
          },
        },
      },
    },
    async (req) => {
      const qs = req.query as Record<string, string>;
      const sort = oneOf<CoinSort>(qs.sort, ["trending", "new", "mcap", "closest", "graduating"], "sort", "trending");
      const status = oneOf(qs.status, ["curve", "graduated", "all"] as const, "status", "all");
      const limit = int(qs.limit, 50);
      // H-3: `?symbol=` = every coin with that symbol (case-insensitive), newest first (≤ 50).
      if (qs.symbol !== undefined) {
        const sym = qs.symbol.replace(/^\$/, "").toUpperCase();
        const rows = await cached(`symbol:${sym}:50`, 3_000, () => repo.coinsBySymbol(sym, 50));
        return rows.filter((c) => status === "all" || (status === "graduated" ? c.status === "graduated" : c.status !== "graduated")).slice(0, limit);
      }
      return cached(`list:${sort}:${status}:${limit}`, 3_000, () => repo.listCoins({ sort, status, limit }));
    },
  );
  // H-3: mint is the only unambiguous coin id. Clients route by mint.
  app.get("/v1/coins/by-mint/:mint", { schema: { params: mintParam } }, async (req, reply) => {
    const { mint } = req.params as { mint: string };
    const c = await cached(`coin:${mint}`, 2_000, () => repo.getCoinByMint(mint));
    if (!c) return reply.code(404).send({ error: "not found" });
    return c;
  });
  // Every coin with this symbol (case-insensitive, `$` optional), newest first. Never picks one.
  app.get(
    "/v1/coins/by-symbol/:symbol",
    { schema: { params: { type: "object", properties: { symbol: { type: "string", minLength: 1, maxLength: 16 } }, required: ["symbol"] }, querystring: { type: "object", properties: { limit: limitProp(50) } } } },
    async (req) => {
      const { symbol } = req.params as { symbol: string };
      const limit = int((req.query as Record<string, string>).limit, 20);
      return cached(`symbol:${symbol.replace(/^\$/, "").toUpperCase()}:${limit}`, 3_000, () => repo.coinsBySymbol(symbol, limit));
    },
  );
  // Legacy (symbol or mint). An exact mint wins; a symbol must match exactly one coin, else
  // 300 Multiple Choices with the candidates (newest first) instead of silently picking one.
  app.get("/v1/coins/:id", { schema: { params: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 64 } }, required: ["id"] } } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const c = await cached(`coin:${id}`, 2_000, () => repo.getCoin(id));
      if (!c) return reply.code(404).send({ error: "not found" });
      return c;
    } catch (e) {
      if (!(e instanceof AmbiguousSymbolError)) throw e;
      const matches = await repo.coinsBySymbol(e.symbol, 20);
      reply.header("link", `</v1/coins/by-symbol/${encodeURIComponent(e.symbol)}>; rel="alternate"`);
      return reply.code(300).send({ error: "ambiguous symbol: use /v1/coins/by-mint/:mint", symbol: e.symbol, matches });
    }
  });
  app.get("/v1/coins/:mint/prices", { schema: { params: mintParam, querystring: { type: "object", properties: { range: { type: "string", enum: ["1h", "1d", "7d", "all"] } } } } }, async (req) => {
    const mint = addr((req.params as { mint: string }).mint, "mint");
    const range = oneOf<ChartRange>((req.query as Record<string, string>).range, ["1h", "1d", "7d", "all"], "range", "1d");
    return cached(`prices:${mint}:${range}`, 5_000, () => repo.getPriceSeries(mint, range));
  });
  app.get("/v1/coins/:mint/holders", { schema: { params: mintParam, querystring: viewerQs } }, async (req) => {
    const mint = addr((req.params as { mint: string }).mint, "mint");
    const viewer = optAddr((req.query as Record<string, string>).viewer, "viewer");
    return cached(`holders:${mint}:${viewer ?? ""}`, 5_000, () => repo.getHolders(mint, viewer));
  });
  app.get("/v1/coins/:mint/fumbles", { schema: { params: mintParam, querystring: viewerQs } }, async (req) => {
    const mint = addr((req.params as { mint: string }).mint, "mint");
    const viewer = optAddr((req.query as Record<string, string>).viewer, "viewer");
    return cached(`fumbles:${mint}:${viewer ?? ""}`, 3_000, () => repo.getRecentFumbles(mint, viewer));
  });
  app.get("/v1/coins/:mint/queue", { schema: { params: mintParam, querystring: viewerQs } }, async (req) => {
    const mint = addr((req.params as { mint: string }).mint, "mint");
    const viewer = optAddr((req.query as Record<string, string>).viewer, "viewer");
    return cached(`queue:${mint}:${viewer ?? ""}`, 3_000, () => repo.getClaimQueue(mint, viewer));
  });
  app.get("/v1/coins/:mint/trades", { schema: { params: mintParam, querystring: { type: "object", properties: { limit: limitProp(100) } } } }, async (req) => {
    const mint = addr((req.params as { mint: string }).mint, "mint");
    const limit = Math.min(int((req.query as Record<string, string>).limit, 30), 100);
    return cached(`trades:${mint}:${limit}`, 2_000, () => repo.getRecentTrades(mint, limit));
  });
  app.get(
    "/v1/feed",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["launch", "fumble", "cross", "graduation", "claim", "all"] },
            before: { type: "integer", minimum: 0 },
            limit: limitProp(100),
          },
        },
      },
    },
    async (req) => {
    const qs = req.query as Record<string, string>;
    const kind = oneOf<FeedKind | "all">(qs.kind, ["launch", "fumble", "cross", "graduation", "claim", "all"], "kind", "all");
    const before = qs.before !== undefined ? Number(qs.before) : undefined;
    const limit = int(qs.limit, 30);
    return cached(`feed:${kind}:${before ?? ""}:${limit}`, 2_000, () => repo.getFeed({ kind, before, limit }));
    },
  );
  app.get("/v1/closest", { schema: { querystring: { type: "object", properties: { viewer: viewerQs.properties.viewer, limit: limitProp(50) } } } }, async (req) => {
    const qs = req.query as Record<string, string>;
    const viewer = optAddr(qs.viewer, "viewer");
    const limit = Math.min(int(qs.limit, 5), 50);
    return cached(`closest:${limit}:${viewer ?? ""}`, 5_000, () => repo.getClosestTo10x(limit, viewer));
  });
  app.get("/v1/wallets/:owner/tickets", async (req) => {
    const owner = addr((req.params as { owner: string }).owner, "owner");
    return cached(`tickets:${owner}`, 2_000, () => repo.getTickets(owner));
  });
  // Portfolio: chain balances (one getTokenAccountsByOwner) + the wallet's FUMPAD ledger.
  // Keys contain the wallet, so the live hub's wallet invalidation clears them.
  const portfolio = (wallet: string) =>
    cached(`portfolio:${wallet}`, 3_000, async () => {
      const balances = await chain.tokenBalances(wallet).catch((e: Error) => {
        app.log.warn({ wallet, err: e.message }, "token balances unavailable; positions fall back to FUMPAD-tracked amounts");
        return null;
      });
      return repo.getPortfolio(wallet, balances);
    });
  app.get("/v1/wallets/:wallet/positions", async (req) => {
    const wallet = addr((req.params as { wallet: string }).wallet, "wallet");
    return (await portfolio(wallet)).positions;
  });
  app.get("/v1/wallets/:wallet/closed", async (req) => {
    const wallet = addr((req.params as { wallet: string }).wallet, "wallet");
    return (await portfolio(wallet)).closed;
  });
  app.get("/v1/wallets/:wallet/created", async (req) => {
    const wallet = addr((req.params as { wallet: string }).wallet, "wallet");
    return cached(`created:${wallet}`, 3_000, () => repo.getCreatedCoins(wallet));
  });
  app.get("/v1/tickets/:id", async (req, reply) => {
    const id = addr((req.params as { id: string }).id, "ticket");
    const t = await cached(`tickets:one:${id}`, 2_000, () => repo.getTicket(id));
    if (!t) return reply.code(404).send({ error: "not found" });
    return t;
  });
  app.get("/v1/leaderboards/:board", { schema: { params: { type: "object", properties: { board: { type: "string", enum: ["fumbles", "claimers", "diamond"] } }, required: ["board"] }, querystring: viewerQs } }, async (req) => {
    const board = oneOf<Board>((req.params as { board: string }).board, ["fumbles", "claimers", "diamond"], "board");
    const viewer = optAddr((req.query as Record<string, string>).viewer, "viewer");
    const rows = await cached(`board:${board}`, 10_000, () => repo.getLeaderboard(board));
    return rows.map((r) => ({ ...r, isYou: viewer ? r.address === viewer : false }));
  });
  app.get("/v1/profiles/:id", { schema: { params: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 64 } }, required: ["id"] } } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id.length > 64) throw bad("invalid profile");
    const pr = await cached(`profile:${id}`, 5_000, () => repo.getProfile(id));
    if (!pr) return reply.code(404).send({ error: "not found" });
    return pr;
  });
  app.get(
    "/v1/quote",
    {
      config: { rateLimit: { max: cfg.quoteRateLimitPerMin, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          properties: {
            mint: { type: "string", pattern: B58 },
            side: { type: "string", enum: ["buy", "sell"] },
            amount: { type: "number", minimum: 0, maximum: 1e15 },
            wallet: { type: "string", pattern: `${B58}|^$` },
          },
          required: ["mint", "side", "amount"],
        },
      },
    },
    async (req) => {
      const qs = req.query as Record<string, string>;
      const mint = addr(qs.mint, "mint");
      const side = oneOf<Side>(qs.side, ["buy", "sell"], "side");
      const amount = Number(qs.amount);
      if (!Number.isFinite(amount) || amount < 0 || amount > 1e15) throw bad("invalid amount");
      const wallet = optAddr(qs.wallet, "wallet");
      const row = await cached(`coin:${mint}`, 2_000, () => repo.getCoinByMint(mint));
      const maturedTokens = side === "sell" && wallet ? (await chain.maturedBase(wallet, mint)).matured : undefined;
      return chain.quote({ mint, side, amount, wallet, symbol: row?.symbol, maturedTokens });
    },
  );
  app.get("/v1/wallets/:wallet/balances/:mint", async (req) => {
    const { wallet, mint } = req.params as { wallet: string; mint: string };
    addr(wallet, "wallet");
    addr(mint, "mint");
    return cached(`bal:${wallet}:${mint}`, 2_000, () => chain.balances(wallet, mint));
  });

  // ── WebSocket feed ──────────────────────────────────────────────────────────
  // M-6: global cap + per-IP cap (on the H-2 client IP). Backpressure: messages are
  // serialized once per broadcast (LiveHub) and a client with more than
  // WS_MAX_BUFFERED_BYTES unsent is dropped (it reconnects and resyncs).
  const perIp = new Map<string, number>();
  let wsTotal = 0;
  app.get("/v1/ws", { websocket: true }, (socket, req) => {
    const ip = req.ip;
    if (wsTotal >= cfg.maxWsTotal) {
      socket.close(1013, "server busy");
      return;
    }
    const n = (perIp.get(ip) ?? 0) + 1;
    if (n > cfg.maxWsPerIp) {
      socket.close(1008, "too many connections");
      return;
    }
    perIp.set(ip, n);
    wsTotal++;
    socket.send(JSON.stringify({ type: "hello", serverTime: Date.now() }));
    const unsub = live.subscribe((_m, json) => {
      if (socket.readyState !== 1) return;
      // A client that can't keep up (MBs queued) is dropped; it reconnects and resyncs.
      if (socket.bufferedAmount > cfg.wsMaxBufferedBytes) {
        socket.close(1013, "too slow");
        return;
      }
      socket.send(json);
    });
    const ping = setInterval(() => socket.readyState === 1 && socket.ping(), 25_000);
    socket.on("message", () => {
      /* client messages are ignored (read-only feed) */
    });
    socket.on("close", () => {
      unsub();
      clearInterval(ping);
      wsTotal = Math.max(0, wsTotal - 1);
      const left = (perIp.get(ip) ?? 1) - 1;
      if (left > 0) perIp.set(ip, left);
      else perIp.delete(ip);
    });
  });

  // ── docs + health ───────────────────────────────────────────────────────────
  app.get("/openapi.json", async () => OPENAPI);
  app.get("/v1/status", async () => cached("status", 5_000, () => systemStatus(db, pool, cfg.statusKeeperUrl)));
  // L-5: public /health is a bare liveness answer; the detail (lag, pool, live stats) needs
  // the SSR secret header.
  app.get("/health", async (req, reply) => {
    let dbOk = false;
    let lagSecs: number | null = null;
    try {
      // Newest transaction by slot (indexed), not max(block_time) (a full scan at mainnet size).
      const r = await db.query<{ t: string | null }>("SELECT (SELECT block_time FROM transactions ORDER BY slot DESC LIMIT 1) AS t");
      dbOk = true;
      lagSecs = r.rows[0].t ? Math.floor(Date.now() / 1000) - Number(r.rows[0].t) : null;
    } catch {
      /* db down */
    }
    const vanityPool = pool && dbOk && isSsr(req) ? await pool.stats().catch(() => null) : null;
    reply.code(dbOk ? 200 : 503);
    reply.header("cache-control", "no-store");
    if (!isSsr(req)) return { ok: dbOk };
    return { ok: dbOk, version: serviceInfo("api"), lastIndexedBlockAgeSecs: lagSecs, wsClients: live.subscribers, wsConnections: wsTotal, live: live.stats, cache: { hits: cache.hits, misses: cache.misses }, vanityPool };
  });

  // ── D18 vanity launches ─────────────────────────────────────────────────────
  registerLaunchRoutes(app, cfg, { conn, chain, pool, db });

  // ── Pre-launch waitlist ─────────────────────────────────────────────────────
  registerWaitlistRoutes(app, cfg, db);
  let sweeper: NodeJS.Timeout | undefined;
  if (pool && cfg.launchSweepMs > 0) {
    sweeper = setInterval(() => {
      pool.sweep().then(
        (r) => (r.released || r.used) && app.log.info(r, "vanity reservations swept"),
        (e: Error) => app.log.warn({ err: e.message }, "vanity sweep failed"),
      );
    }, cfg.launchSweepMs);
    sweeper.unref();
  }

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof LaunchError) {
      if (err.retryAfterSecs) reply.header("retry-after", String(err.retryAfterSecs));
      if (err.statusCode >= 500) app.log.warn({ msg: err.message }, "launch unavailable");
      return reply.code(err.statusCode).send({ error: err.message });
    }
    if (err instanceof WaitlistError) return reply.code(err.statusCode).send({ error: err.message });
    if ((err as { validation?: unknown }).validation) return reply.code(400).send({ error: err.message });
    const code = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (code >= 500) app.log.error({ err: { message: err.message, name: err.name, stack: err.stack } }, "request failed");
    reply.code(code).send({ error: code >= 500 ? "internal error" : err.message });
  });

  app.addHook("onClose", async () => {
    if (sweeper) clearInterval(sweeper);
    await live.stop();
    if (!deps?.db) await db.end();
  });
  return { app, deps: all };
}
