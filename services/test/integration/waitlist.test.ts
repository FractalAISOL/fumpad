/**
 * Pre-launch waitlist against a real Postgres (migration 007) and the in-process API:
 * stores lowercased contacts with an IP hash (never the raw IP), dedupes case-insensitively
 * with the same response, enforces the per-IP daily cap and the route rate limit.
 * First block: the development fallback (no WAITLIST_DATABASE_URL → the backend DB). Second block:
 * the production layout (its own database), the disabled mode and the CSV export.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Connection } from "@solana/web3.js";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, type Db, migrate } from "@fumpad/indexer";
import { buildServer, ipHasher, loadApiConfig, migrateWaitlist } from "@fumpad/api";

import { type Postgres, startPostgres } from "../../scripts/local/harness.js";
import { exportWaitlist } from "../../scripts/ops/waitlist-export.js";

let pg: Postgres;
let db: Db;
let app: FastifyInstance;

const post = (payload: object, ip = "203.0.113.7", server = app) =>
  server.inject({ method: "POST", url: "/v1/waitlist", headers: { "x-forwarded-for": `198.51.100.1, ${ip}` }, payload });

beforeAll(async () => {
  pg = await startPostgres(54333);
  db = createPool(pg.url);
  await migrate(db);
  const cfg = loadApiConfig({ DATABASE_URL: pg.url, TRUST_PROXY_HOPS: "1", WAITLIST_PER_IP_PER_DAY: "3", WAITLIST_RATE_LIMIT_PER_MIN: "100", WAITLIST_IP_SALT: "test-salt", LOG_LEVEL: "silent" } as NodeJS.ProcessEnv);
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
    const cfg = loadApiConfig({ DATABASE_URL: pg.url, TRUST_PROXY_HOPS: "1", WAITLIST_RATE_LIMIT_PER_MIN: "2", LOG_LEVEL: "silent" } as NodeJS.ProcessEnv);
    const { app: tight } = await buildServer(cfg, { db, conn: {} as Connection });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await post({ contact: `@rl${i}` }, "192.0.2.50", tight)).statusCode);
    expect(codes).toEqual([201, 201, 429]);
    await tight.close();
  });
});

// ── its own database (production layout), the disabled mode, an unreachable DB, the export ──
const PROD_ENV = { NODE_ENV: "production", RPC_URL: "http://127.0.0.1:1", CORS_ORIGINS: "https://fumpad.app", API_SSR_SECRET: "s".repeat(32), TRUST_PROXY_HOPS: "1", LOG_LEVEL: "info" };
const dbUrl = (base: string, name: string) => {
  const u = new URL(base);
  u.pathname = `/${name}`;
  return u.toString();
};
const tables = async (q: Db) => (await q.query<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1")).rows.map((r) => r.t);
const sink = (into: string[]) => ({ write: (s: string) => into.push(s) }) as unknown as NodeJS.WritableStream;

describe("waitlist in its own database (WAITLIST_DATABASE_URL)", () => {
  let ownUrl: string;
  let own: Db;
  let prodApp: FastifyInstance;
  const logs: string[] = [];

  beforeAll(async () => {
    await db.query("DROP DATABASE IF EXISTS waitlist_own");
    await db.query("CREATE DATABASE waitlist_own");
    ownUrl = dbUrl(pg.url, "waitlist_own");
    own = createPool(ownUrl);
    const cfg = loadApiConfig({ ...PROD_ENV, DATABASE_URL: pg.url, WAITLIST_DATABASE_URL: ownUrl, WAITLIST_IP_SALT: "prod-salt" } as NodeJS.ProcessEnv);
    expect(cfg.waitlistDisabledReason).toBeUndefined();
    prodApp = (await buildServer(cfg, { db, conn: {} as Connection }, { logStream: sink(logs) })).app;
  });
  afterAll(async () => {
    await prodApp?.close();
    await own?.end();
  });

  it("creates only the waitlist table there (idempotent) and stores sign-ups there, not in the backend DB", async () => {
    const before = (await db.query("SELECT count(*)::int AS n FROM waitlist")).rows[0].n;
    expect((await post({ contact: "Own@Example.com" }, "203.0.113.40", prodApp)).statusCode).toBe(201);
    expect(await tables(own)).toEqual(["waitlist"]);
    expect((await own.query("SELECT email FROM waitlist")).rows).toEqual([{ email: "own@example.com" }]);
    expect((await db.query("SELECT count(*)::int AS n FROM waitlist")).rows[0].n).toBe(before);
    await Promise.all([migrateWaitlist(own), migrateWaitlist(own)]); // concurrent re-runs are no-ops
    expect((await own.query("SELECT count(*)::int AS n FROM waitlist")).rows[0].n).toBe(1);
    expect(logs.join("")).toContain("waitlist schema ready");
    const health = await prodApp.inject({ method: "GET", url: "/health", headers: { "x-fumpad-ssr": "s".repeat(32) } });
    expect(health.json().waitlist).toBe("own-db");
  });

  it("hashes with WAITLIST_IP_SALT only (not derived from any database URL)", async () => {
    const [row] = (await own.query("SELECT ip_hash FROM waitlist")).rows;
    expect(row.ip_hash).toBe(ipHasher("prod-salt")("203.0.113.40"));
  });

  it("survives a backend schema reset", async () => {
    await db.query("DROP DATABASE IF EXISTS backend_reset");
    await db.query("CREATE DATABASE backend_reset");
    const backend = createPool(dbUrl(pg.url, "backend_reset"));
    await migrate(backend);
    await backend.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"); // what the devnet reset does
    await backend.end();
    expect((await own.query("SELECT count(*)::int AS n FROM waitlist")).rows[0].n).toBe(1);
  });

  it("exports a CSV with mode 600, never overwriting, ip_hash only on request", async () => {
    await own.query(`INSERT INTO waitlist (email, x_handle, ip_hash) VALUES (NULL, 'quote_me', 'h'), ('a,b"c@x.co', NULL, 'h')`);
    const dir = mkdtempSync(join(tmpdir(), "wl-export-"));
    const out = join(dir, "sub", "w.csv");
    const r = await exportWaitlist(ownUrl, out);
    expect(r.rows).toBe(3);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(out)).mode & 0o777).toBe(0o700);
    const lines = readFileSync(out, "utf8").trimEnd().split("\n");
    expect(lines[0]).toBe("id,email,x_handle,created_at");
    expect(lines[1]).toMatch(/^\d+,own@example\.com,,\d{4}-\d\d-\d\dT/);
    expect(lines.some((l) => l.includes(`,"a,b""c@x.co",,`))).toBe(true);
    expect(lines.some((l) => l.includes(",,quote_me,"))).toBe(true);
    await expect(exportWaitlist(ownUrl, out)).rejects.toThrow(/EEXIST/);
    const full = join(dir, "full.csv");
    await exportWaitlist(ownUrl, full, { includeIpHash: true });
    expect(readFileSync(full, "utf8").split("\n")[0]).toBe("id,email,x_handle,created_at,ip_hash");
    rmSync(dir, { recursive: true, force: true });
  });

  it("production without WAITLIST_DATABASE_URL: waitlist 503 + loud log, the rest of the API up", async () => {
    const out: string[] = [];
    const cfg = loadApiConfig({ ...PROD_ENV, DATABASE_URL: pg.url, WAITLIST_IP_SALT: "prod-salt" } as NodeJS.ProcessEnv);
    const { app: off } = await buildServer(cfg, { db, conn: {} as Connection }, { logStream: sink(out) });
    const r = await post({ contact: "@nope" }, "203.0.113.41", off);
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toMatch(/unavailable/);
    expect((await off.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect(out.join("")).toMatch(/WAITLIST DISABLED.*WAITLIST_DATABASE_URL is not set/);
    expect((await db.query("SELECT count(*)::int AS n FROM waitlist WHERE x_handle = 'nope'")).rows[0].n).toBe(0);
    await off.close();
  });

  it("an unreachable waitlist DB: 503 on sign-up, the rest of the API up", async () => {
    const cfg = loadApiConfig({ ...PROD_ENV, LOG_LEVEL: "silent", DATABASE_URL: pg.url, WAITLIST_DATABASE_URL: "postgres://nobody@127.0.0.1:1/none", WAITLIST_IP_SALT: "prod-salt" } as NodeJS.ProcessEnv);
    const { app: down } = await buildServer(cfg, { db, conn: {} as Connection });
    expect((await post({ contact: "@down" }, "203.0.113.42", down)).statusCode).toBe(503);
    expect((await down.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    await down.close();
  });
});
