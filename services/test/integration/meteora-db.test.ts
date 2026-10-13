/**
 * Meteora ingestion → real Postgres (migration 008), no validator: the mainnet fixtures of one
 * curve's life (pool init → curve-completing buy → DBC→DAMM v2 migration → DAMM v2 trades) are
 * ingested in order under its config key, then idempotency, uniqueness and rollback are checked.
 */
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ConfirmedTx, MeteoraRpc } from "@fumpad/meteora";
import { createLogger, createPool, type Db, MeteoraFinalizer, MeteoraIngestor, migrate } from "@fumpad/indexer";

import { type Postgres, startPostgres } from "../../scripts/local/harness.js";

const fx = (name: string): ConfirmedTx => JSON.parse(readFileSync(new URL(`../../meteora/test/fixtures/${name}.json`, import.meta.url), "utf8")) as ConfirmedTx;
const CONFIG = "7oZrYpk9qcCy13J68S2z6d5qhMRHDsSUMHv7dLpPf1uN";
const DBC_POOL = "7wqGhpe3rVqCYFxV5f3ninfmRLRsE4GvVBkCrBPLK6Rp";
const DAMM_POOL = "ApxZdXkBjKWomGyWBA3LcCzUkjhq4UcoiT2kVaj7WDUk";
const log = createLogger("test", "silent");

let pg: Postgres;
let db: Db;
let ing: MeteoraIngestor;

beforeAll(async () => {
  pg = await startPostgres(54341);
  db = createPool(pg.url, 4);
  await migrate(db);
  ing = new MeteoraIngestor(db, { dbcConfigs: [CONFIG], mints: [] }, log);
}, 120_000);
afterAll(async () => {
  await db?.end();
  await pg?.stop();
});

describe("meteora ingestion → postgres", () => {
  const order = ["dbc_pool_init", "dbc_curve_complete", "dbc_migration_damm_v2", "damm_graduated_direct_buy", "damm_legacy_tx", "damm_program_seller_v1", "dbc_direct_sell", "dbc_failed"];

  it("ingests one curve's life and only FUMPAD pools' trades", async () => {
    for (const n of order) expect((await ing.ingest(fx(n), "rpc", "confirmed")).status).toBe("applied");
    const pools = (await db.query("SELECT pool, venue, source, dbc_pool FROM meteora_pools ORDER BY venue")).rows;
    expect(pools).toEqual([
      { pool: DAMM_POOL, venue: "damm_v2", source: "migration", dbc_pool: DBC_POOL },
      { pool: DBC_POOL, venue: "dbc", source: "pool_init", dbc_pool: null },
    ]);
    expect((await db.query("SELECT address, kind FROM meteora_cursors")).rows).toEqual([{ address: DAMM_POOL, kind: "pool" }]);
    const trades = (await db.query("SELECT venue, side, base_amount, quote_gross, trader_source, curve_complete FROM meteora_trades ORDER BY slot, signature")).rows;
    // dbc_direct_sell is another config's pool → not stored; the failed tx has no trades
    expect(trades).toEqual([
      { venue: "dbc", side: "buy", base_amount: "219999968000913", quote_gross: "10000", trader_source: "base_owner_signer", curve_complete: true },
      { venue: "damm_v2", side: "buy", base_amount: "9644958", quote_gross: "49950", trader_source: "base_owner_signer", curve_complete: false },
      { venue: "damm_v2", side: "buy", base_amount: "8758788", quote_gross: "29970", trader_source: "base_owner_signer", curve_complete: false },
      { venue: "damm_v2", side: "sell", base_amount: "9632484", quote_gross: "49940", trader_source: "base_owner_unsigned", curve_complete: false },
    ]);
    const st = (await db.query("SELECT status, count(*)::int AS n FROM meteora_transactions GROUP BY status ORDER BY status")).rows;
    expect(st).toEqual([{ status: "failed", n: 1 }, { status: "ok", n: 7 }]);
  });

  it("re-delivery is a no-op; finalized re-delivery upgrades; (signature, ix_key) is unique", async () => {
    expect((await ing.ingest(fx("damm_legacy_tx"), "webhook", "confirmed")).status).toBe("duplicate");
    expect((await ing.ingest(fx("damm_legacy_tx"), "rpc", "finalized")).status).toBe("upgraded");
    await expect(
      db.query("INSERT INTO meteora_trades SELECT * FROM meteora_trades WHERE pool = $1 LIMIT 1", [DAMM_POOL]),
    ).rejects.toThrow(/duplicate key/);
  });

  it("rolling back the migration tx removes the DAMM v2 pool and its cursor (trades of other txs stay)", async () => {
    const rpc = { async getSignatureStatuses(s: string[]) { return s.map(() => null); }, async getTransaction() { return null; } } as unknown as MeteoraRpc;
    const fin = new MeteoraFinalizer(rpc, db, log, { minAgeSecs: 0, dropMisses: 1, dropAfterSecs: -1 });
    await fin.rollback([fx("dbc_migration_damm_v2").transaction.signatures[0]]);
    expect((await db.query("SELECT pool FROM meteora_pools")).rows).toEqual([{ pool: DBC_POOL }]);
    expect((await db.query("SELECT count(*)::int AS n FROM meteora_cursors")).rows[0].n).toBe(0);
    // full finalizer pass with an RPC that knows nothing: every non-finalized tx is dropped; the one
    // upgraded to finalized above (damm_legacy_tx) is never touched again
    const r = await fin.runOnce();
    expect(r.rolledBack).toBe(6);
    expect((await db.query("SELECT signature FROM meteora_trades")).rows).toEqual([{ signature: fx("damm_legacy_tx").transaction.signatures[0] }]);
  });
});
