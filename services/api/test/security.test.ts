/**
 * API-side regressions of the off-chain review:
 *  H-2  client IP from X-Forwarded-For (was security-review/services-poc/xff-rate-limit.test.ts)
 *       + SSR shared secret instead of RATE_LIMIT_ALLOW
 *  H-3  symbol routing never silently picks a coin; mint routes
 *  M-6  global WebSocket cap
 *  L-3  schema validation of query/path params
 *  L-5  slim public /health
 *  prod fail-fast config
 */
import { Keypair } from "@solana/web3.js";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadApiConfig } from "../src/config.js";
import { AmbiguousSymbolError, Repo } from "../src/repo.js";
import { buildServer } from "../src/server.js";

const SSR = "ssr-secret-".repeat(4);
const stubDb = { query: async () => ({ rows: [{ t: null }] }), end: async () => {} };
const liveStub = { subscribers: 0, stats: {}, subscribe: () => () => {}, stop: async () => {} };
const mintA = Keypair.generate().publicKey.toBase58();
const mintB = Keypair.generate().publicKey.toBase58();
const detail = (mint: string) => ({ mint, symbol: "DUP" });
const repoStub = {
  getCoinByMint: async (m: string) => (m === mintA || m === mintB ? detail(m) : null),
  getCoin: async (id: string) => {
    if (id === mintA || id === mintB) return detail(id);
    if (id.toUpperCase() === "DUP") throw new AmbiguousSymbolError("DUP", [mintB, mintA]);
    if (id.toUpperCase() === "ONE") return detail(mintA);
    return null;
  },
  coinsBySymbol: async (s: string) => (s.replace(/^\$/, "").toUpperCase() === "DUP" ? [{ mint: mintB }, { mint: mintA }] : []),
  getFeed: async () => [],
  listCoins: async () => [],
};

async function server(env: Record<string, string>) {
  const cfg = loadApiConfig({ DATABASE_URL: "postgres://stub/stub", LOG_LEVEL: "silent", ...env } as NodeJS.ProcessEnv);
  const { app } = await buildServer(cfg, {
    db: stubDb as never,
    conn: {} as never,
    repo: repoStub as never,
    chain: { solUsd: async () => 150, client: {} } as never,
    live: liveStub as never,
    pool: null,
  });
  return app;
}

describe("H-2 client IP / rate limits", () => {
  let app: FastifyInstance;
  let lastIp = "";
  beforeAll(async () => {
    app = await server({ RATE_LIMIT_PER_MIN: "3", TRUST_PROXY_HOPS: "1", API_SSR_SECRET: SSR });
    app.addHook("onRequest", async (req) => {
      lastIp = req.ip;
    });
  });
  afterAll(() => app.close());

  it("a fresh spoofed X-Forwarded-For per request no longer evades the limit (PoC now fails)", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      // The platform proxy (TCP peer 10.0.0.2) appended the real client 198.51.100.7.
      const r = await app.inject({ method: "GET", url: "/v1/sol-usd", remoteAddress: "10.0.0.2", headers: { "x-forwarded-for": `203.0.113.${i}, 198.51.100.7` } });
      codes.push(r.statusCode);
    }
    expect(codes).toEqual([200, 200, 200, 429, 429, 429]);
    expect(lastIp).toBe("198.51.100.7"); // not the client-chosen leftmost entry
  });

  it("the SSR secret header (not an IP allow-list) exempts server-side rendering", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: "GET", url: "/v1/sol-usd", remoteAddress: "10.0.0.2", headers: { "x-forwarded-for": "198.51.100.7", "x-fumpad-ssr": SSR } });
      expect(r.statusCode).toBe(200);
    }
    const wrong = await app.inject({ method: "GET", url: "/v1/sol-usd", remoteAddress: "10.0.0.2", headers: { "x-forwarded-for": "198.51.100.7", "x-fumpad-ssr": `${SSR}x` } });
    expect(wrong.statusCode).toBe(429);
  });

  it("with TRUST_PROXY_HOPS=0 X-Forwarded-For is ignored entirely", async () => {
    const direct = await server({ RATE_LIMIT_PER_MIN: "100", TRUST_PROXY_HOPS: "0" });
    let ip = "";
    direct.addHook("onRequest", async (req) => {
      ip = req.ip;
    });
    await direct.inject({ method: "GET", url: "/v1/sol-usd", remoteAddress: "192.0.2.10", headers: { "x-forwarded-for": "1.2.3.4" } });
    expect(ip).toBe("192.0.2.10");
    await direct.close();
  });

  it("RATE_LIMIT_ALLOW no longer exempts anyone", async () => {
    const a = await server({ RATE_LIMIT_PER_MIN: "1", RATE_LIMIT_ALLOW: "127.0.0.1" });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await a.inject({ method: "GET", url: "/v1/sol-usd", remoteAddress: "127.0.0.1" })).statusCode);
    expect(codes).toEqual([200, 429, 429]);
    await a.close();
  });
});

describe("L-5 health, L-3 validation, H-3 coin routing", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await server({ API_SSR_SECRET: SSR, TRUST_PROXY_HOPS: "0" });
  });
  afterAll(() => app.close());

  it("public /health is bare; detail needs the SSR secret", async () => {
    const pub = await app.inject({ method: "GET", url: "/health" });
    expect(pub.json()).toEqual({ ok: true });
    const priv = await app.inject({ method: "GET", url: "/health", headers: { "x-fumpad-ssr": SSR } });
    expect(Object.keys(priv.json())).toEqual(expect.arrayContaining(["ok", "version", "lastIndexedBlockAgeSecs", "wsClients", "cache"]));
  });

  it("malformed query/path params are 400s, not 500s", async () => {
    for (const url of ["/v1/feed?before=NaN", "/v1/feed?limit=abc", "/v1/coins?limit=0", "/v1/coins?sort=evil", `/v1/coins/${"x".repeat(80)}`, "/v1/coins/not-a-mint!/holders", `/v1/coins/${mintA}/holders?viewer=bad!`, "/v1/coins/by-mint/nope", "/v1/leaderboards/whatever"]) {
      const r = await app.inject({ method: "GET", url });
      expect(r.statusCode, url).toBe(400);
    }
    expect((await app.inject({ method: "GET", url: "/v1/feed?before=5&limit=3" })).statusCode).toBe(200);
  });

  it("an ambiguous symbol is never silently resolved: 300 + all matches, newest first", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/coins/DUP" });
    expect(r.statusCode).toBe(300);
    expect(r.json().matches.map((m: { mint: string }) => m.mint)).toEqual([mintB, mintA]);
    expect(r.headers.link).toContain("/v1/coins/by-symbol/DUP");
  });

  it("mint routes and the by-symbol list; a unique symbol still works for the current app", async () => {
    expect((await app.inject({ method: "GET", url: `/v1/coins/by-mint/${mintA}` })).json().mint).toBe(mintA);
    expect((await app.inject({ method: "GET", url: `/v1/coins/by-mint/${Keypair.generate().publicKey.toBase58()}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/coins/by-symbol/$dup" })).json().map((m: { mint: string }) => m.mint)).toEqual([mintB, mintA]);
    expect((await app.inject({ method: "GET", url: "/v1/coins/by-symbol/NOPE" })).json()).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/v1/coins?symbol=dup&sort=new&status=all&limit=200" })).json().map((m: { mint: string }) => m.mint)).toEqual([mintB, mintA]);
    expect((await app.inject({ method: "GET", url: "/v1/coins/ONE" })).json().mint).toBe(mintA);
    expect((await app.inject({ method: "GET", url: `/v1/coins/${mintB}` })).json().mint).toBe(mintB);
  });
});

describe("H-3 Repo resolution", () => {
  it("exact mint first, then a unique symbol; several matches throw with all candidates newest first", async () => {
    const [OLD, NEW, SOLO] = [0, 1, 2].map(() => Keypair.generate().publicKey.toBase58());
    const coins = [
      { mint: OLD, symbol: "PEPE", created_at: 1 },
      { mint: NEW, symbol: "pepe", created_at: 2 },
      { mint: SOLO, symbol: "SOLO", created_at: 3 },
    ];
    const db = {
      query: async (sql: string, params: unknown[]) => {
        if (sql.includes("FROM coins c WHERE c.mint = $1")) return { rows: coins.filter((c) => c.mint === params[0]) };
        if (sql.includes("upper(symbol) = upper($1)"))
          return { rows: coins.filter((c) => c.symbol.toUpperCase() === String(params[0]).toUpperCase()).sort((a, b) => b.created_at - a.created_at).map((c) => ({ mint: c.mint })) };
        return { rows: [] };
      },
    };
    const repo = new Repo(db as never);
    expect(await repo.resolveCoinId(OLD)).toBe(OLD);
    expect(await repo.resolveCoinId("$solo")).toBe(SOLO);
    expect(await repo.resolveCoinId("NONE")).toBeNull();
    const e = await repo.resolveCoinId("PEPE").catch((x) => x);
    expect(e).toBeInstanceOf(AmbiguousSymbolError);
    expect((e as AmbiguousSymbolError).mints).toEqual([NEW, OLD]);
  });
});

describe("M-6 global WebSocket cap", () => {
  it("connections beyond MAX_WS_TOTAL are refused", async () => {
    const app = await server({ MAX_WS_TOTAL: "1", MAX_WS_PER_IP: "10" });
    const addr = await app.listen({ port: 0, host: "127.0.0.1" });
    const url = addr.replace(/^http/, "ws") + "/v1/ws";
    const a = new WebSocket(url);
    await new Promise((r) => a.addEventListener("message", r, { once: true })); // hello
    const b = new WebSocket(url);
    const code = await new Promise<number>((r) => b.addEventListener("close", (e) => r(e.code), { once: true }));
    expect(code).toBe(1013);
    a.close();
    await new Promise((r) => a.addEventListener("close", r, { once: true }));
    // A slot freed up: the next client gets in.
    await new Promise((r) => setTimeout(r, 50));
    const c = new WebSocket(url);
    const first = await new Promise<string>((r) => c.addEventListener("message", (e) => r(String(e.data)), { once: true }));
    expect(JSON.parse(first).type).toBe("hello");
    c.close();
    await app.close();
  });
});

describe("production fail-fast", () => {
  const base = { NODE_ENV: "production", DATABASE_URL: "postgres://x/y", RPC_URL: "https://rpc.example", CORS_ORIGINS: "https://fumpad.app", API_SSR_SECRET: SSR };
  it("requires explicit RPC_URL, CORS_ORIGINS and API_SSR_SECRET", () => {
    expect(loadApiConfig(base as NodeJS.ProcessEnv).trustProxyHops).toBe(1);
    for (const k of ["RPC_URL", "CORS_ORIGINS", "API_SSR_SECRET", "DATABASE_URL"] as const) {
      const env = { ...base } as Record<string, string>;
      delete env[k];
      expect(() => loadApiConfig(env as NodeJS.ProcessEnv), k).toThrow(new RegExp(k));
    }
    expect(() => loadApiConfig({ ...base, CORS_ORIGINS: "*" } as NodeJS.ProcessEnv)).toThrow(/CORS_ORIGINS/);
    expect(() => loadApiConfig({ ...base, API_SSR_SECRET: "short" } as NodeJS.ProcessEnv)).toThrow(/32/);
    expect(() => loadApiConfig({ ...base, TRUST_PROXY_HOPS: "-1" } as NodeJS.ProcessEnv)).toThrow(/TRUST_PROXY_HOPS/);
  });
  it("never infers mainnet from HELIUS_API_KEY", () => {
    expect(loadApiConfig({ DATABASE_URL: "postgres://x/y", HELIUS_API_KEY: "k" } as NodeJS.ProcessEnv).rpcUrl).toBe("http://127.0.0.1:8899");
  });
});
