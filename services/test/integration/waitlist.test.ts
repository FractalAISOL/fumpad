/**
 * Pre-launch waitlist against a real Postgres (migration 007) and the in-process API:
 * stores lowercased contacts with an IP hash (never the raw IP), dedupes case-insensitively
 * with the same response, enforces the per-IP daily cap and the route rate limit.
 */
import type { Connection } from "@solana/web3.js";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, type Db, migrate } from "@fumpad/indexer";
import { buildServer, loadApiConfig } from "@fumpad/api";

import { type Postgres, startPostgres } from "../../scripts/local/harness.js";

let pg: Postgres;
let db: Db;
let app: FastifyInstance;

const post = (payload: object, ip = "203.0.113.7", server = app) =>
  server.inject({ method: "POST", url: "/v1/waitlist", headers: { "x-forwarded-for": `198.51.100.1, ${ip}` }, payload });

beforeAll(async () => {
  pg = await startPostgres(54333);
  db = createPool(pg.url);
  await migrate(db);
  const cfg = loadApiConfig({ DATABASE_URL: pg.url, WAITLIST_PER_IP_PER_DAY: "3", WAITLIST_RATE_LIMIT_PER_MIN: "100", WAITLIST_IP_SALT: "test-salt", LOG_LEVEL: "silent" } as NodeJS.ProcessEnv);
  app = (await buildServer(cfg, { db, conn: {} as Connection })).app;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.end();
  await pg?.stop();
});

describe("POST /v1/waitlist", () => {
  it("stores an email and a handle, lowercased, with an IP hash only", async () => {
    expect((await post({ contact: "Ana@Example.com" })).statusCode).toBe(201);
    expect((await post({ contact: "@Bob_X" })).statusCode).toBe(201);
    const rows = (await db.query("SELECT email, x_handle, ip_hash FROM waitlist ORDER BY id")).rows;
    expect(rows.map((r) => [r.email, r.x_handle])).toEqual([
      ["ana@example.com", null],
      [null, "bob_x"],
    ]);
    expect(rows[0].ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain("203.0.113.7");
  });

  it("dedupes case-insensitively and answers the same", async () => {
    const r = await post({ contact: "ANA@example.com" }, "203.0.113.8");
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ ok: true });
    expect((await db.query("SELECT count(*)::int AS n FROM waitlist WHERE email = 'ana@example.com'")).rows[0].n).toBe(1);
  });

  it("400s bad input with a sentence", async () => {
    const r = await post({ contact: "not an email@" });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/email/);
  });

  it("drops honeypot submissions silently", async () => {
    expect((await post({ contact: "@bot", website: "x" }, "203.0.113.9")).statusCode).toBe(201);
    expect((await db.query("SELECT count(*)::int AS n FROM waitlist WHERE x_handle = 'bot'")).rows[0].n).toBe(0);
  });

  it("caps sign-ups per IP per day (by hash)", async () => {
    // 203.0.113.7 already added 2; the cap is 3.
    expect((await post({ contact: "@third" })).statusCode).toBe(201);
    const r = await post({ contact: "@fourth" });
    expect(r.statusCode).toBe(429);
    expect((await post({ contact: "@fourth" }, "203.0.113.10")).statusCode).toBe(201);
  });

  it("rate-limits per client IP", async () => {
    const cfg = loadApiConfig({ DATABASE_URL: pg.url, WAITLIST_RATE_LIMIT_PER_MIN: "2", LOG_LEVEL: "silent" } as NodeJS.ProcessEnv);
    const { app: tight } = await buildServer(cfg, { db, conn: {} as Connection });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await post({ contact: `@rl${i}` }, "192.0.2.50", tight)).statusCode);
    expect(codes).toEqual([201, 201, 429]);
    await tight.close();
  });
});
