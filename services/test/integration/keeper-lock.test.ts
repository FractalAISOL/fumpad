/**
 * L-10: only one keeper sends at a time (Postgres advisory lock); M-7: the keeper's lookup
 * table address and daily spend survive restarts (meta).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";

import { createPool, type Db, migrate } from "@fumpad/indexer";

import { KeeperStore } from "../../keeper/src/store.js";
import { type Postgres, startPostgres } from "../../scripts/local/harness.js";

let pg: Postgres;
let db: Db;
const log = pino({ level: "silent" });

beforeAll(async () => {
  pg = await startPostgres(54333);
  db = createPool(pg.url, 2);
  await migrate(db);
}, 120_000);
afterAll(async () => {
  await db?.end();
  await pg?.stop();
});

describe("keeper single instance + persistence", () => {
  it("a second keeper waits for the lock until the first one exits", async () => {
    const a = new KeeperStore(pg.url, log);
    const b = new KeeperStore(pg.url, log);
    let lost = false;
    await a.acquireLock(() => (lost = true), { retryMs: 50 });
    let bHas = false;
    const bWait = b.acquireLock(() => {}, { retryMs: 50 }).then(() => (bHas = true));
    await new Promise((r) => setTimeout(r, 400));
    expect(bHas).toBe(false);
    await a.close(); // first keeper exits
    await bWait;
    expect(bHas).toBe(true);
    expect(lost).toBe(false); // a clean shutdown is not a "lost lock"
    await b.close();
  });

  it("losing the lock connection is reported (the keeper exits instead of running unlocked)", async () => {
    const a = new KeeperStore(pg.url, log);
    let lost = false;
    await a.acquireLock(() => (lost = true), { retryMs: 50 });
    await db.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'fumpad-keeper-lock'");
    await new Promise((r) => setTimeout(r, 200));
    expect(lost).toBe(true);
    await a.close();
  });

  it("lookup table + spend persist in meta", async () => {
    const s = new KeeperStore(pg.url, log);
    await s.setMeta("keeper:K:alt", { address: "Alt111" });
    await s.setMeta("keeper:K:spend", { day: "2026-10-12", lamports: "5", lastBalance: "10" });
    const t = new KeeperStore(pg.url, log);
    expect(await t.getMeta("keeper:K:alt")).toEqual({ address: "Alt111" });
    expect(await t.getMeta("keeper:K:spend")).toEqual({ day: "2026-10-12", lamports: "5", lastBalance: "10" });
    await s.close();
    await t.close();
  });
});
