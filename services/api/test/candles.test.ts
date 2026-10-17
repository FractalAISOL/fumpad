/** Chart candles: `Repo.getCandles` assembly (window, launch candle, carried-in open), the route, and parity with the app. */
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import * as app from "../../../app/src/data/candles.js";
import { CANDLE_INTERVALS, CANDLE_SECS, CANDLE_WINDOW, chainCandles } from "../src/candles.js";
import { loadApiConfig } from "../src/config.js";
import { Repo } from "../src/repo.js";
import { buildServer } from "../src/server.js";

const MINT = Keypair.generate().publicKey.toBase58();
/** A raw Q64 price for `p` (the repo maps it to SOL per token with the token decimals). */
const Q = (p: number) => (BigInt(Math.round(p * 1e6)) << 64n) / 1_000_000n;

/** A db that answers the queries getCandles makes; records the bucket query's parameters. */
function stubDb(opts: { created: number; buckets?: { b: number; n: number; o: bigint; h: bigint; l: bigint; c: bigint }[]; before?: bigint | null }) {
  const seen: unknown[][] = [];
  const db = {
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes("FROM coins c WHERE c.mint = $1")) return { rows: params[0] === MINT ? [{ mint: MINT, created_at: String(opts.created) }] : [] };
      if (sql.includes("array_agg")) {
        seen.push(params);
        return { rows: (opts.buckets ?? []).map((b) => ({ b: String(b.b), n: b.n, o: String(b.o), h: String(b.h), l: String(b.l), c: String(b.c) })) };
      }
      if (sql.includes("seq DESC, idx DESC LIMIT 1")) return { rows: opts.before ? [{ q: String(opts.before) }] : [] };
      return { rows: [] };
    },
  };
  return { repo: new Repo(db as never), seen };
}

describe("getCandles", () => {
  const NOW = 1_800_000_000 + 37; // unix secs, mid-minute

  it("an old coin: the last 150 buckets, the price before the window as `open`, the first candle opening at it", async () => {
    const nowB = Math.floor(NOW / 60) * 60;
    const from = nowB - 149 * 60;
    const { repo, seen } = stubDb({ created: NOW - 86_400, before: Q(2), buckets: [{ b: from / 60 + 3, n: 2, o: Q(3), h: Q(4), l: Q(3), c: Q(3.5) }, { b: nowB / 60, n: 1, o: Q(5), h: Q(5), l: Q(5), c: Q(5) }] });
    const s = await repo.getCandles(MINT, "1m", NOW);
    expect(seen[0]).toEqual([MINT, from, 60, nowB + 60]);
    expect(s.interval).toBe("1m");
    expect(s.from).toBe(from * 1000);
    expect(s.open).toBeCloseTo(2 * 1e-3, 12);
    expect(s.candles.map((c) => c.t)).toEqual([(from + 180) * 1000, nowB * 1000]);
    const [a, b] = s.candles;
    expect(a.o).toBe(s.open); // continuous: opens at the carried price…
    expect(a.l).toBe(s.open); // …which widens its low
    expect(b.o).toBe(a.c);
    expect(b.n).toBe(1);
  });

  it("no trade before the window: `open` is the curve's start price", async () => {
    const { repo } = stubDb({ created: NOW - 86_400, before: null });
    const s = await repo.getCandles(MINT, "5m", NOW);
    expect(s.open).toBeGreaterThan(0);
    expect(s.candles).toEqual([]);
  });

  it("a coin launched inside the window: the window starts at the launch bucket, whose candle opens at the start price", async () => {
    const created = NOW - 200; // 3m20s ago
    const { repo, seen } = stubDb({ created, buckets: [{ b: Math.floor(created / 60), n: 2, o: Q(9), h: Q(9), l: Q(8), c: Q(8) }] });
    const s = await repo.getCandles(MINT, "1m", NOW);
    expect(seen[0][1]).toBe(Math.floor(created / 60) * 60);
    expect(s.from).toBe(Math.floor(created / 60) * 60_000);
    expect(s.open).toBeUndefined();
    const [c] = s.candles;
    expect(c.n).toBe(3); // + the start price
    expect(c.o).toBeLessThan(c.c); // the curve starts below the first buys
    expect(c.l).toBe(c.o);
  });

  it("a fresh coin with no trade yet: one flat candle at the start price", async () => {
    const created = NOW - 20;
    const { repo } = stubDb({ created });
    const s = await repo.getCandles(MINT, "30m", NOW);
    expect(s.candles).toHaveLength(1);
    const [c] = s.candles;
    expect([c.o, c.h, c.l]).toEqual([c.c, c.c, c.c]);
    expect(c.t).toBe(Math.floor(created / 1800) * 1_800_000);
  });

  it("an unknown coin: an empty window", async () => {
    const { repo } = stubDb({ created: 0 });
    const s = await repo.getCandles(Keypair.generate().publicKey.toBase58(), "5m", NOW);
    expect(s).toEqual({ interval: "5m", from: (Math.floor(NOW / 300) * 300 - 149 * 300) * 1000, candles: [] });
  });
});

describe("parity with the app (app/src/data/candles.ts)", () => {
  it("same intervals, bucket sizes and window", () => {
    expect([...CANDLE_INTERVALS]).toEqual([...app.CANDLE_INTERVALS]);
    for (const iv of CANDLE_INTERVALS) expect(CANDLE_SECS[iv] * 1000).toBe(app.INTERVAL_MS[iv]);
    expect(CANDLE_WINDOW).toBe(app.CANDLE_WINDOW);
  });
  it("same continuity rule", () => {
    const raw = [
      { t: 0, o: 10, h: 11, l: 10, c: 11, n: 2 },
      { t: 120_000, o: 9, h: 9, l: 8, c: 8, n: 2 },
    ];
    for (const open of [undefined, 12, 0.5]) expect(chainCandles(raw, open)).toEqual(app.chainCandles(raw, open));
  });
});

describe("GET /v1/coins/:mint/candles", () => {
  async function server() {
    const calls: string[] = [];
    const cfg = loadApiConfig({ DATABASE_URL: "postgres://stub/stub", LOG_LEVEL: "silent" } as NodeJS.ProcessEnv);
    const { app: srv } = await buildServer(cfg, {
      db: { query: async () => ({ rows: [{ t: null }] }), end: async () => {} } as never,
      conn: {} as never,
      repo: { getCandles: async (m: string, iv: string) => (calls.push(`${m}:${iv}`), { interval: iv, from: 0, candles: [] }) } as never,
      chain: { solUsd: async () => 150, client: {} } as never,
      live: { subscribers: 0, stats: {}, subscribe: () => () => {}, stop: async () => {} } as never,
      pool: null,
    });
    return { srv, calls };
  }
  it("takes 1m / 5m / 30m (default 1m); anything else is a 400", async () => {
    const { srv, calls } = await server();
    try {
      for (const iv of ["1m", "5m", "30m"]) expect((await srv.inject({ url: `/v1/coins/${MINT}/candles?interval=${iv}` })).statusCode).toBe(200);
      expect((await srv.inject({ url: `/v1/coins/${MINT}/candles` })).json()).toMatchObject({ interval: "1m" });
      expect(calls).toEqual([`${MINT}:1m`, `${MINT}:5m`, `${MINT}:30m`]); // the default reuses the cached 1m
      for (const bad of ["1h", "all", "7d", "60"]) expect((await srv.inject({ url: `/v1/coins/${MINT}/candles?interval=${bad}` })).statusCode).toBe(400);
      expect((await srv.inject({ url: `/v1/coins/not-a-mint/candles` })).statusCode).toBe(400);
    } finally {
      await srv.close();
    }
  });
});
