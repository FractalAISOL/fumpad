/**
 * Meteora ingestion → real Postgres (migration 008), no validator: the mainnet fixtures of one
 * curve's life (pool init → curve-completing buy → DBC→DAMM v2 migration → DAMM v2 trades) are
 * ingested in order under its config key, then idempotency, uniqueness and rollback are checked.
 */
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import type { ConfirmedTx, MeteoraRpc } from "@fumpad/meteora";
import { bn, DEFAULT_PARAMS, EVENT_IX_TAG, eventAuthorityPda, FUMPAD_IDL, FUMPAD_PROGRAM_ID, fumpadCoder, type TxLike } from "@fumpad/sdk";
import { createLogger, createPool, type Db, Ingestor, MeteoraFinalizer, MeteoraIngestor, migrate } from "@fumpad/indexer";

import { type Postgres, startPostgres } from "../../scripts/local/harness.js";

const fx = (name: string): ConfirmedTx => JSON.parse(readFileSync(new URL(`../../meteora/test/fixtures/${name}.json`, import.meta.url), "utf8")) as ConfirmedTx;
const CONFIG = "7oZrYpk9qcCy13J68S2z6d5qhMRHDsSUMHv7dLpPf1uN";
const DBC_POOL = "7wqGhpe3rVqCYFxV5f3ninfmRLRsE4GvVBkCrBPLK6Rp";
const DAMM_POOL = "ApxZdXkBjKWomGyWBA3LcCzUkjhq4UcoiT2kVaj7WDUk";
const MINT = "BQqBiNLXNVB3Y3h6yqGMvTgEfrYjFzUa2KHPUsaUpump";
const CREATOR = "HSsUqEp3eZ5EckgEB7gEPitunLqnegRmhQT5PpaoQuCk";
const log = createLogger("test", "silent");

/**
 * The recorded mainnet curve was never launched through FUMPAD, so (L2) the indexer would not treat it as
 * ours. Register it the way production does: a (synthetic, borsh-exact) `CoinRegistered` for its mint and
 * DBC pool, applied by the fumpad Ingestor → `coins` row → the Meteora ingestor's registered-mint set.
 */
function coinRegisteredTx(at: ConfirmedTx): TxLike {
  const disc = (FUMPAD_IDL.events as { name: string; discriminator: number[] }[]).find((e) => e.name === "CoinRegistered")!.discriminator;
  const data = fumpadCoder().types.encode("CoinRegistered", {
    mint: new PublicKey(MINT), creator: new PublicKey(CREATOR), dbc_pool: new PublicKey(DBC_POOL), dbc_config: new PublicKey(CONFIG),
    launch_slot: bn(BigInt(at.slot)), launch_window_slots: bn(8n), ts: bn(BigInt(at.blockTime ?? 0)),
  });
  return {
    slot: at.slot,
    blockTime: at.blockTime ?? null,
    transaction: { signatures: [bs58.encode(new Uint8Array(64).fill(1))], message: { accountKeys: [CREATOR, FUMPAD_PROGRAM_ID.toBase58(), eventAuthorityPda().toBase58()], instructions: [] } },
    meta: { err: null, logMessages: [], innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 1, accounts: [2], data: bs58.encode(Uint8Array.from([...EVENT_IX_TAG, ...disc, ...data])) }] }] },
  };
}

let pg: Postgres;
let db: Db;
let ing: MeteoraIngestor;

beforeAll(async () => {
  pg = await startPostgres(54341);
  db = createPool(pg.url, 4);
  await migrate(db);
  const fumpad = new Ingestor({ db, log, params: () => DEFAULT_PARAMS });
  expect((await fumpad.ingest(coinRegisteredTx(fx("dbc_pool_init")), "rpc", "finalized")).status).toBe("applied");
  ing = new MeteoraIngestor(db, { dbcConfigs: [CONFIG], mints: [] }, log);
}, 120_000);
afterAll(async () => {
  await db?.end();
  await pg?.stop();
});

describe("meteora ingestion → postgres", () => {
  // [fixture, expected status]. "duplicate" = nothing of ours in the tx → not recorded:
  //   - dbc_pool_init: CoinRegistered already put the DBC pool in the set (no trades, no new pool);
  //   - dbc_direct_sell: another config's (unregistered) pool;  dbc_failed: failed, no trades.
  const order: [string, "applied" | "duplicate"][] = [
    ["dbc_pool_init", "duplicate"], ["dbc_curve_complete", "applied"], ["dbc_migration_damm_v2", "applied"], ["damm_graduated_direct_buy", "applied"],
    ["damm_legacy_tx", "applied"], ["damm_program_seller_v1", "applied"], ["dbc_direct_sell", "duplicate"], ["dbc_failed", "duplicate"],
  ];

  it("ingests one curve's life and only FUMPAD pools' trades", async () => {
    // the registration alone: the DBC pool (created_sig = the CoinRegistered tx) + the mint cursor
    expect((await db.query("SELECT pool, venue, source FROM meteora_pools")).rows).toEqual([{ pool: DBC_POOL, venue: "dbc", source: "pool_init" }]);
    for (const [n, status] of order) expect([n, (await ing.ingest(fx(n), "rpc", "confirmed")).status]).toEqual([n, status]);
    const pools = (await db.query("SELECT pool, venue, source, dbc_pool FROM meteora_pools ORDER BY venue")).rows;
    expect(pools).toEqual([
      { pool: DAMM_POOL, venue: "damm_v2", source: "migration", dbc_pool: DBC_POOL },
      { pool: DBC_POOL, venue: "dbc", source: "pool_init", dbc_pool: null },
    ]);
    expect((await db.query("SELECT address, kind FROM meteora_cursors ORDER BY kind")).rows).toEqual([{ address: MINT, kind: "mint" }, { address: DAMM_POOL, kind: "pool" }]);
    const trades = (await db.query("SELECT venue, side, base_amount, quote_gross, trader_source, curve_complete FROM meteora_trades ORDER BY slot, signature")).rows;
    // dbc_direct_sell is another config's pool → not stored; the failed tx has no trades
    expect(trades).toEqual([
      { venue: "dbc", side: "buy", base_amount: "219999968000913", quote_gross: "10000", trader_source: "base_owner_signer", curve_complete: true },
      { venue: "damm_v2", side: "buy", base_amount: "9644958", quote_gross: "49950", trader_source: "base_owner_signer", curve_complete: false },
      { venue: "damm_v2", side: "buy", base_amount: "8758788", quote_gross: "29970", trader_source: "base_owner_signer", curve_complete: false },
      { venue: "damm_v2", side: "sell", base_amount: "9632484", quote_gross: "49940", trader_source: "base_owner_unsigned", curve_complete: false },
    ]);
    const st = (await db.query("SELECT status, count(*)::int AS n FROM meteora_transactions GROUP BY status ORDER BY status")).rows;
    expect(st).toEqual([{ status: "ok", n: 5 }]);
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
    // the pool cursor goes; the registered mint's cursor (from CoinRegistered) stays
    expect((await db.query("SELECT address, kind FROM meteora_cursors")).rows).toEqual([{ address: MINT, kind: "mint" }]);
    // full finalizer pass with an RPC that knows nothing: every non-finalized tx is dropped; the one
    // upgraded to finalized above (damm_legacy_tx) is never touched again
    const r = await fin.runOnce();
    expect(r.rolledBack).toBe(3); // curve_complete, damm_graduated_direct_buy, damm_program_seller_v1
    expect((await db.query("SELECT signature FROM meteora_trades")).rows).toEqual([{ signature: fx("damm_legacy_tx").transaction.signatures[0] }]);
  });
});
