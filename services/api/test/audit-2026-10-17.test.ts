/**
 * External audit 2026-10-17 (services/api, off-chain) regressions. S-2 / H-3 lives in poc-s2-first-coin.test.ts, the
 * DB side of M-3 / S-5 in test/integration/vanity-pool.test.ts.
 *  S-4 / L-2  TRUST_PROXY_HOPS production default (security.test.ts)
 *  I-1        SSR secret = high ceiling, not unlimited
 *  S-7 / L-4  per-route limits on chain-reading wallet routes; per-namespace LRU cache + negative caching
 *  S-11 / I-2 no silent SOL/USD fallback: 503 price_unavailable
 *  S-6        CSV formula injection neutralised
 *  M-3        /v1/status vanity counts exact only for SSR; IPv6 /64 bucketing
 *  L-3        launch auth: domain + cluster, single-use nonce (prepare)
 */
import { Keypair, PublicKey, type VersionedTransaction } from "@solana/web3.js";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { DBC_CONFIG_SIZE, PYTH_SOL_USD_ACCOUNT, STANDARD_FEE_POLICY } from "@fumpad/sdk";

import { TtlCache } from "../src/cache.js";
import { ChainReader, PriceUnavailableError } from "../src/chain.js";
import { loadApiConfig, solUsdFallbackFromEnv } from "../src/config.js";
import { LaunchError } from "../src/launch/pool.js";
import { ipBucket } from "../src/net.js";
import { buildServer } from "../src/server.js";
import { coarseCount, publicStatus } from "../src/status.js";
import { csvCell, waitlistCsv } from "../src/waitlist.js";
import { NonceStore, signLaunchAuth, verifyLaunchAuth } from "../src/launch/auth.js";

const SSR = "ssr-secret-".repeat(4);
const env = (e: Record<string, string>) => ({ DATABASE_URL: "postgres://stub/stub", LOG_LEVEL: "silent", LAUNCH_SWEEP_SECS: "0", ...e }) as NodeJS.ProcessEnv;
const live = { subscribers: 0, stats: {}, subscribe: () => () => {}, stop: async () => {} };
let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("I-1: the SSR secret lifts the limit to a ceiling, it no longer removes it", () => {
  it("SSR_RATE_LIMIT_PER_MIN applies to SSR callers; others keep RATE_LIMIT_PER_MIN", async () => {
    ({ app } = await buildServer(loadApiConfig(env({ API_SSR_SECRET: SSR, RATE_LIMIT_PER_MIN: "2", SSR_RATE_LIMIT_PER_MIN: "4" })), {
      db: { query: async () => ({ rows: [] }), end: async () => {} } as never,
      conn: {} as never,
      repo: {} as never,
      chain: { solUsd: async () => 150 } as never,
      live: live as never,
      pool: null,
    }));
    const hit = (ssr: boolean, ip: string) => app!.inject({ method: "GET", url: "/v1/sol-usd", remoteAddress: ip, headers: ssr ? { "x-fumpad-ssr": SSR } : {} });
    const ssrCodes = [];
    for (let i = 0; i < 6; i++) ssrCodes.push((await hit(true, "10.0.0.9")).statusCode);
    expect(ssrCodes).toEqual([200, 200, 200, 200, 429, 429]);
    const pub = [];
    for (let i = 0; i < 3; i++) pub.push((await hit(false, "10.0.0.10")).statusCode);
    expect(pub).toEqual([200, 200, 429]);
  });
});

describe("S-7 / L-4: chain-reading wallet routes", () => {
  it("positions / closed / balances have their own per-IP limit below the global one", async () => {
    let rpc = 0;
    ({ app } = await buildServer(loadApiConfig(env({ RATE_LIMIT_PER_MIN: "1000", WALLET_RPC_RATE_LIMIT_PER_MIN: "2" })), {
      db: { query: async () => ({ rows: [] }), end: async () => {} } as never,
      conn: {} as never,
      repo: { getPortfolio: async () => ({ positions: [], closed: [] }) } as never,
      chain: {
        solUsd: async () => 150,
        tokenBalances: async () => {
          rpc++;
          return new Map();
        },
        balances: async () => ({ sol: 0, tokens: 0, maturedTokens: 0 }),
      } as never,
      live: live as never,
      pool: null,
    }));
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await app.inject({ method: "GET", url: `/v1/wallets/${Keypair.generate().publicKey.toBase58()}/positions`, remoteAddress: "198.51.100.3" })).statusCode);
    expect(codes).toEqual([200, 200, 429, 429]);
    expect(rpc).toBe(2); // the refused ones never reached the RPC
    expect((await app.inject({ method: "GET", url: "/v1/sol-usd", remoteAddress: "198.51.100.3" })).statusCode).toBe(200);
  });

  it("cache: attacker-chosen keys only churn their own namespace (LRU), failures are cached briefly", async () => {
    const c = new TtlCache({ perNamespace: 50, negativeTtlMs: 60_000 });
    await c.get("list:trending:all:50", 60_000, async () => "hot");
    await c.get("chain:global", 60_000, async () => "global");
    for (let i = 0; i < 1_000; i++) await c.get(`portfolio:${i}`, 60_000, async () => i);
    for (let i = 0; i < 1_000; i++) await c.get(`chain:coin:${i}`, 60_000, async () => i);
    let loads = 0;
    expect(await c.get("list:trending:all:50", 60_000, async () => (loads++, "reloaded"))).toBe("hot");
    expect(await c.get("chain:global", 60_000, async () => (loads++, "reloaded"))).toBe("global");
    expect(loads).toBe(0);
    expect(c.size).toBe(102); // 50 + 50 + the two hot entries
    // LRU within a namespace: a touched entry survives a flood of new keys
    for (let i = 0; i < 60; i++) {
      await c.get("portfolio:keep", 60_000, async () => "kept");
      await c.get(`portfolio:new${i}`, 60_000, async () => i);
    }
    expect(await c.get("portfolio:keep", 60_000, async () => "lost")).toBe("kept");
    // negative caching: a failing load is not retried on every request
    let fails = 0;
    const bad = () => c.get("bal:x:y", 60_000, async () => {
      fails++;
      throw new Error("rpc down");
    });
    await expect(bad()).rejects.toThrow("rpc down");
    await new Promise((r) => setTimeout(r, 0));
    await expect(bad()).rejects.toThrow("rpc down");
    expect(fails).toBe(1);
    // invalidation still reaches every namespace
    c.invalidate(["keep"]);
    expect(await c.get("portfolio:keep", 60_000, async () => "fresh")).toBe("fresh");
  });
});

describe("S-11 / I-2: no silent SOL/USD fallback", () => {
  const pythFails = { getAccountInfo: async () => null };
  it("config: SOL_USD_FALLBACK is opt-in (no default), validated", () => {
    expect(loadApiConfig(env({})).solUsdFallback).toBeUndefined();
    expect(solUsdFallbackFromEnv({ SOL_USD_FALLBACK: "150" } as NodeJS.ProcessEnv)).toBe(150);
    expect(() => solUsdFallbackFromEnv({ SOL_USD_FALLBACK: "abc" } as NodeJS.ProcessEnv)).toThrow(/SOL_USD_FALLBACK/);
    expect(() => solUsdFallbackFromEnv({ SOL_USD_FALLBACK: "0" } as NodeJS.ProcessEnv)).toThrow(/SOL_USD_FALLBACK/);
  });

  it("Pyth unreadable and no fallback: PriceUnavailableError, logged at error level; an explicit fallback is used (warned)", async () => {
    const logs: string[] = [];
    const log = { warn: (_o: object, m: string) => logs.push(`warn ${m}`), error: (_o: object, m: string) => logs.push(`error ${m}`) };
    const none = new ChainReader(pythFails as never, new TtlCache(), { log });
    await expect(none.solUsd()).rejects.toBeInstanceOf(PriceUnavailableError);
    expect(logs).toEqual(["error SOL/USD price unavailable: USD routes answer 503 price_unavailable"]);
    const fb = new ChainReader(pythFails as never, new TtlCache(), { solUsdFallback: 123, log });
    expect(await fb.solUsd()).toBe(123);
    expect(logs[1]).toMatch(/^warn .*SOL_USD_FALLBACK/);
  });

  it("a recent good Pyth price bridges a failed read, then it goes stale", async () => {
    let ok = true;
    const conn = {
      getAccountInfo: async (k: PublicKey) => {
        expect(k.equals(PYTH_SOL_USD_ACCOUNT)).toBe(true);
        if (!ok) throw new Error("rpc down");
        return { data: pythAccount(180.5) };
      },
    };
    const cache = new TtlCache({ negativeTtlMs: 0 });
    const r = new ChainReader(conn as never, cache, { solUsdMaxStaleMs: 60_000 });
    expect(await r.solUsd()).toBeCloseTo(180.5, 1);
    ok = false;
    cache.invalidate();
    expect(await r.solUsd()).toBeCloseTo(180.5, 1); // last good, within SOL_USD_MAX_STALE_SECS
    const stale = new ChainReader(conn as never, new TtlCache(), { solUsdMaxStaleMs: 0 });
    await expect(stale.solUsd()).rejects.toBeInstanceOf(PriceUnavailableError);
  });

  it("routes answer 503 { code: price_unavailable } instead of a made-up price", async () => {
    ({ app } = await buildServer(loadApiConfig(env({})), {
      db: { query: async () => ({ rows: [] }), end: async () => {} } as never,
      conn: pythFails as never,
      repo: {} as never,
      live: live as never,
      pool: null,
    }));
    const r = await app.inject({ method: "GET", url: "/v1/sol-usd" });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: "SOL/USD price unavailable right now, try again shortly", code: "price_unavailable" });
  });
});

/** A minimal Pyth PriceUpdateV2 account (the SDK decoder's layout: discriminator, write authority, verification, feed). */
function pythAccount(usd: number): Buffer {
  const b = Buffer.alloc(134);
  let o = 8 + 32; // discriminator + write_authority
  b.writeUInt8(1, o); // verification_level: Full
  o += 1;
  o += 32; // feed_id
  const exponent = -8;
  b.writeBigInt64LE(BigInt(Math.round(usd * 1e8)), o); // price
  b.writeBigUInt64LE(0n, o + 8); // conf
  b.writeInt32LE(exponent, o + 16);
  b.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)), o + 20); // publish_time
  return b;
}

describe("S-6: waitlist CSV export neutralises formulas", () => {
  it("leading = + - @ tab CR become text ('-prefixed, quoted); plain values unchanged", async () => {
    expect(csvCell("=HYPERLINK(\"http://x\")@evil.io")).toBe(`"'=HYPERLINK(""http://x"")@evil.io"`);
    for (const v of ["+1@a.io", "-2+3@a.io", "@cmd", "\tx", "\rx"]) expect(csvCell(v).startsWith(`"'`), JSON.stringify(v)).toBe(true);
    expect(csvCell("ana@example.com")).toBe("ana@example.com");
    expect(csvCell("a,b")).toBe(`"a,b"`);
    expect(csvCell(null)).toBe("");
    const { csv } = await waitlistCsv({ query: async () => ({ rows: [{ id: 1, email: "=1+1@x.io", x_handle: null, created_at: new Date(0) }] }) } as never);
    expect(csv).toBe(`id,email,x_handle,created_at\n1,"'=1+1@x.io",,1970-01-01T00:00:00.000Z\n`);
  });
});

describe("M-3: /v1/status vanity counts", () => {
  it("coarse for the public, exact with the SSR secret", async () => {
    expect([0, 1, 4, 5, 19, 20, 49, 50, 99, 100, 347, 999, 5_000].map(coarseCount)).toEqual([0, 1, 1, 5, 5, 20, 20, 50, 50, 100, 100, 500, 1_000]);
    const s = { level: "ok", vanityPool: { level: "ok", available: 347, reserved: 3 } } as never;
    expect(publicStatus(s)).toMatchObject({ vanityPool: { level: "ok", available: 100, reserved: 1 } });
    ({ app } = await buildServer(loadApiConfig(env({ API_SSR_SECRET: SSR })), {
      db: { query: async () => ({ rows: [{ last_tx: null, last_sample: null, grads: "0", hb: null }] }), end: async () => {} } as never,
      conn: {} as never,
      repo: {} as never,
      chain: { solUsd: async () => 150 } as never,
      live: live as never,
      pool: { cfg: { suffix: "fmbL" }, stats: async () => ({ available: 347, reserved: 3, used: 9 }) } as never,
    }));
    expect((await app.inject({ method: "GET", url: "/v1/status" })).json().vanityPool).toEqual({ level: "ok", available: 100, reserved: 1 });
    expect((await app.inject({ method: "GET", url: "/v1/status", headers: { "x-fumpad-ssr": SSR } })).json().vanityPool).toEqual({ level: "ok", available: 347, reserved: 3 });
  });

  it("ipBucket: IPv4 as is, IPv6 by /64, IPv4-mapped → IPv4", () => {
    expect(ipBucket("203.0.113.9")).toBe("203.0.113.9");
    expect(ipBucket("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(ipBucket("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(ipBucket("2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(ipBucket("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipBucket("::1")).toBe("0:0:0:0::/64");
  });
});

describe("L-3: launch auth bound to domain + cluster, nonce single use", () => {
  const kp = Keypair.generate();
  const creator = kp.publicKey;
  const c58 = creator.toBase58();
  const policy = { maxAgeSecs: 600, domains: ["fumpad.app"], cluster: "mainnet" };

  it("verifies the seven-line message; refuses another site / cluster / a reordered header", () => {
    const a = signLaunchAuth(kp.secretKey, { creator: c58, symbol: "PIGN", domain: "fumpad.app", cluster: "mainnet" });
    expect(a.message.split("\n").slice(0, 3)).toEqual(["FUMPAD launch", "domain: fumpad.app", "cluster: mainnet"]);
    const ok = verifyLaunchAuth(a, { creator, symbol: "PIGN" }, policy);
    expect(ok.ok && ok.fields.domain === "fumpad.app" && !ok.legacy).toBe(true);
    expect(verifyLaunchAuth(signLaunchAuth(kp.secretKey, { creator: c58, symbol: "PIGN", domain: "fumpad.app.evil.example", cluster: "mainnet" }), { creator, symbol: "PIGN" }, policy)).toEqual({ ok: false, error: "auth message is for another site" });
    expect(verifyLaunchAuth(signLaunchAuth(kp.secretKey, { creator: c58, symbol: "PIGN", domain: "fumpad.app", cluster: "devnet" }), { creator, symbol: "PIGN" }, policy)).toEqual({ ok: false, error: "auth message is for another cluster" });
    expect(verifyLaunchAuth(signLaunchAuth(kp.secretKey, { creator: c58, symbol: "PIGN", domain: "FUMPAD.app", cluster: "mainnet" }), { creator, symbol: "PIGN" }, policy)).toEqual({ ok: false, error: "invalid auth message" });
    const legacy = signLaunchAuth(kp.secretKey, { creator: c58, symbol: "PIGN" });
    expect(verifyLaunchAuth(legacy, { creator, symbol: "PIGN" }, policy).ok).toBe(true);
    expect(verifyLaunchAuth(legacy, { creator, symbol: "PIGN" }, { ...policy, allowLegacy: false })).toEqual({ ok: false, error: "outdated launch message: reload the page and sign again" });
  });

  it("NonceStore: once per scope until expiry, release gives it back, full = 503 not forgetting", () => {
    const n = new NonceStore(2);
    const now = 1_000;
    expect(n.consume("prepare", c58, "nonce-aaaaaaaaaaaaaa", now + 100, now)).toBe(true);
    expect(n.consume("prepare", c58, "nonce-aaaaaaaaaaaaaa", now + 100, now)).toBe(false);
    expect(n.consume("metadata", c58, "nonce-aaaaaaaaaaaaaa", now + 100, now)).toBe(true); // other route, own use
    expect(() => n.consume("prepare", c58, "nonce-bbbbbbbbbbbbbb", now + 100, now)).toThrow(/too many/);
    expect(n.consume("prepare", c58, "nonce-bbbbbbbbbbbbbb", now + 500, now + 200)).toBe(true); // expired ones dropped
    n.release("prepare", c58, "nonce-bbbbbbbbbbbbbb");
    expect(n.consume("prepare", c58, "nonce-bbbbbbbbbbbbbb", now + 500, now + 200)).toBe(true);
  });

  it("POST /v1/launch/prepare: a signature prepares once; a failed prepare gives the nonce back", async () => {
    let fail = true;
    let prepared = 0;
    const mintKp = Keypair.generate();
    ({ app } = await buildServer(loadApiConfig(env({ FUMPAD_CLUSTER: "localnet", LAUNCH_MIN_BALANCE_LAMPORTS: "0", CORS_ORIGINS: "https://fumpad.app" })), {
      db: { query: async () => ({ rows: [], rowCount: 0 }), end: async () => {} } as never,
      conn: {
        getAccountInfo: async () => ({ data: Buffer.alloc(DBC_CONFIG_SIZE), owner: PublicKey.default, lamports: 1, executable: false }),
        getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
      } as never,
      repo: {} as never,
      chain: { solUsd: async () => 150, global: async () => ({ params: { launchSigner: PublicKey.default }, configs: [Keypair.generate().publicKey, ...Array(7).fill(PublicKey.default)], configPolicies: Array(8).fill(STANDARD_FEE_POLICY), configCoins: Array(8).fill(0) }) } as never,
      live: live as never,
      pool: {
        cfg: { suffix: mintKp.publicKey.toBase58().slice(-1) },
        prepare: async (_c: string, _ip: string, build: (m: PublicKey) => Promise<{ tx: VersionedTransaction; lastValidBlockHeight: number }>) => {
          if (fail) throw new LaunchError(503, "no launch addresses ready right now, try again in a minute", 30);
          prepared++;
          const { tx, lastValidBlockHeight } = await build(mintKp.publicKey);
          return { mint: mintKp.publicKey.toBase58(), tx, lastValidBlockHeight, expiresAt: Date.now() + 60_000, reusedReservation: false };
        },
      } as never,
    }));
    const auth = signLaunchAuth(kp.secretKey, { creator: c58, symbol: "PIGN", domain: "fumpad.app", cluster: "localnet" });
    const prepare = () => app!.inject({ method: "POST", url: "/v1/launch/prepare", payload: { creator: c58, name: "Sad Pigeon", symbol: "PIGN", uri: "ipfs://bafy", auth } });
    expect((await prepare()).statusCode).toBe(503); // pool empty: nothing signed, nonce given back
    fail = false;
    expect((await prepare()).statusCode).toBe(200);
    const replay = await prepare();
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error).toBe("auth message already used, sign again");
    expect(prepared).toBe(1);
  });
});
