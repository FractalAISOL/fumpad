/**
 * PoC for finding H-2: the API trusts every X-Forwarded-For hop (`trustProxy: true`), so
 * `req.ip` is whatever the client puts first in X-Forwarded-For. Every per-IP control keys
 * on it: the global and quote rate limits, `RATE_LIMIT_ALLOW`, `MAX_WS_PER_IP`, the launch
 * prepare rate limit and `LAUNCH_MAX_ACTIVE_PER_IP` (vanity pool drain guard).
 *
 * Uses the real `buildServer` with stubbed DB/chain deps (no Postgres, no RPC).
 * Run (from services/):  node --import tsx --test ../security-review/services-poc/xff-rate-limit.test.ts
 */
import assert from "node:assert/strict";
import { after, it } from "node:test";

import { loadApiConfig } from "../../services/api/src/config.ts";
import { buildServer } from "../../services/api/src/server.ts";

const cfg = loadApiConfig({ DATABASE_URL: "postgres://stub/stub", RATE_LIMIT_PER_MIN: "3", LOG_LEVEL: "silent" } as NodeJS.ProcessEnv);
const stubDb = { query: async () => ({ rows: [{ t: null }] }), end: async () => {} };
const { app } = await buildServer(cfg, {
  db: stubDb as never,
  conn: {} as never,
  repo: {} as never,
  chain: { solUsd: async () => 150, client: {} } as never,
  live: { subscribers: 0, stats: {}, subscribe: () => () => {}, stop: async () => {} } as never,
  pool: null,
});
let lastIp = "";
app.addHook("onRequest", async (req) => {
  lastIp = req.ip;
});
after(() => app.close());

it("same client is rate limited after 3 requests…", async () => {
  const codes: number[] = [];
  for (let i = 0; i < 5; i++) codes.push((await app.inject({ method: "GET", url: "/v1/sol-usd" })).statusCode);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
});

it("…but a fresh X-Forwarded-For per request is never limited, and req.ip is the spoofed value", async () => {
  const codes: number[] = [];
  for (let i = 0; i < 50; i++) {
    const r = await app.inject({ method: "GET", url: "/v1/sol-usd", headers: { "x-forwarded-for": `203.0.113.${i}, 10.0.0.1` } });
    codes.push(r.statusCode);
  }
  assert.ok(codes.every((c) => c === 200), `got ${codes.join(",")}`);
  // The leftmost (client-controlled) entry wins even when a proxy appended the real address.
  await app.inject({ method: "GET", url: "/v1/sol-usd", headers: { "x-forwarded-for": "1.2.3.4, 198.51.100.7" } });
  assert.equal(lastIp, "1.2.3.4");
});
