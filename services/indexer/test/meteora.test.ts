/**
 * Meteora indexing (feature-flagged): config, FUMPAD pool-set growth from real mainnet fixtures,
 * cursor safety (M-5) and webhook hints (H-1) with in-memory DB/RPC stubs.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { type ConfirmedTx, type MeteoraRpc, parseMeteoraTrades, parsePoolFacts } from "@fumpad/meteora";

import { loadIndexerConfig } from "../src/config.js";
import { loadMeteoraConfig } from "../src/meteora/config.js";
import { MeteoraIngestor } from "../src/meteora/ingest.js";
import { MeteoraSignatureSource } from "../src/meteora/source.js";

const log = { warn() {}, info() {}, debug() {}, error() {}, child() { return log; } } as never;
const fx = (name: string): ConfirmedTx => JSON.parse(readFileSync(new URL(`../../meteora/test/fixtures/${name}.json`, import.meta.url), "utf8")) as ConfirmedTx;
const sigOf = (name: string) => fx(name).transaction.signatures[0];

// The pool in the fixtures: DBC config 7oZr…, pool 7wqG…, migrated into DAMM v2 pool ApxZ….
const CONFIG = "7oZrYpk9qcCy13J68S2z6d5qhMRHDsSUMHv7dLpPf1uN";
const DBC_POOL = "7wqGhpe3rVqCYFxV5f3ninfmRLRsE4GvVBkCrBPLK6Rp";
const DAMM_POOL = "ApxZdXkBjKWomGyWBA3LcCzUkjhq4UcoiT2kVaj7WDUk";
const MINT = "BQqBiNLXNVB3Y3h6yqGMvTgEfrYjFzUa2KHPUsaUpump";

describe("config", () => {
  it("is off by default and leaves the indexer config otherwise unchanged", () => {
    const c = loadIndexerConfig({ DATABASE_URL: "postgres://x" });
    expect(c.meteora?.enabled).toBe(false);
  });
  it("parses lists and refuses bad input", () => {
    const c = loadMeteoraConfig({ METEORA_INDEXER_ENABLED: "true", METEORA_DBC_CONFIGS: ` ${CONFIG} ,`, METEORA_MINTS: MINT });
    expect(c).toMatchObject({ enabled: true, dbcConfigs: [CONFIG], mints: [MINT] });
    expect(() => loadMeteoraConfig({ METEORA_INDEXER_ENABLED: "true" })).toThrow(/needs METEORA_DBC_CONFIGS/);
    expect(() => loadMeteoraConfig({ METEORA_MINTS: "not-a-key!" })).toThrow(/invalid address/);
  });
});

describe("FUMPAD pool set", () => {
  const ing = (configs: string[] = [CONFIG], mints: string[] = []) => new MeteoraIngestor({} as never, { dbcConfigs: configs, mints }, log);
  const facts = (name: string) => parsePoolFacts(fx(name));

  it("a pool init under a FUMPAD config registers the DBC pool; another config doesn't", () => {
    expect(ing().newPoolsFrom(parseMeteoraTrades(fx("dbc_pool_init")), facts("dbc_pool_init"))).toEqual([
      { pool: DBC_POOL, venue: "dbc", baseMint: MINT, quoteMint: null, config: CONFIG, dbcPool: null, source: "pool_init" },
    ]);
    expect(ing(["11111111111111111111111111111111"]).newPoolsFrom(parseMeteoraTrades(fx("dbc_pool_init")), facts("dbc_pool_init"))).toEqual([]);
  });

  it("a swap seen under a FUMPAD config registers its pool (pool created before indexing started)", () => {
    const r = parseMeteoraTrades(fx("dbc_curve_complete"));
    expect(ing().newPoolsFrom(r, facts("dbc_curve_complete")).map((p) => [p.pool, p.source])).toEqual([[DBC_POOL, "swap"]]);
  });

  it("the verified migration registers the DAMM v2 pool; by config or by mint", () => {
    const want = [{ pool: DAMM_POOL, venue: "damm_v2", baseMint: MINT, quoteMint: "So11111111111111111111111111111111111111112", config: CONFIG, dbcPool: DBC_POOL, source: "migration" }];
    expect(ing().newPoolsFrom(parseMeteoraTrades(fx("dbc_migration_damm_v2")), facts("dbc_migration_damm_v2"))).toEqual(want);
    expect(ing([], [MINT]).newPoolsFrom(parseMeteoraTrades(fx("dbc_migration_damm_v2")), facts("dbc_migration_damm_v2"))).toEqual(want);
    expect(ing([], ["11111111111111111111111111111111"]).newPoolsFrom(parseMeteoraTrades(fx("dbc_migration_damm_v2")), facts("dbc_migration_damm_v2"))).toEqual([]);
  });

  it("a DAMM v2 trade alone never registers a pool (only migrations do)", () => {
    const i = ing([CONFIG], [MINT]);
    expect(i.newPoolsFrom(parseMeteoraTrades(fx("damm_graduated_direct_buy")), facts("damm_graduated_direct_buy"))).toEqual([]);
  });
});

// ── source: in-memory DB + RPC stubs ────────────────────────────────────────

function harness(opts: { sigs: string[]; fetchable: (sig: string) => ConfirmedTx | null; pools?: string[] }) {
  const db = {
    cursors: new Map<string, { last_signature: string | null; backfill_done: boolean; kind: string }>(),
    txs: new Set<string>(),
    async query(sql: string, params: unknown[] = []) {
      if (sql.startsWith("INSERT INTO meteora_cursors")) {
        const a = params[0] as string;
        if (!this.cursors.has(a)) this.cursors.set(a, { last_signature: null, backfill_done: false, kind: sql.includes("'mint'") ? "mint" : "dbc_config" });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("SELECT address, last_signature")) return { rows: [...this.cursors].map(([address, c]) => ({ address, ...c })) };
      if (sql.startsWith("UPDATE meteora_cursors SET last_signature")) {
        const c = this.cursors.get(params[0] as string)!;
        c.last_signature = params[1] as string;
        c.backfill_done = true;
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE meteora_cursors SET backfill_done")) return { rows: [], rowCount: 1 };
      if (sql.startsWith("SELECT signature FROM meteora_transactions")) return { rows: (params[0] as string[]).filter((s) => this.txs.has(s)).map((signature) => ({ signature })) };
      if (sql.startsWith("SELECT address FROM meteora_cursors")) return { rows: [...this.cursors.keys()].map((address) => ({ address })) };
      throw new Error(`unexpected sql ${sql}`);
    },
  };
  const ingested: string[] = [];
  const ingestor = {
    async ingest(tx: ConfirmedTx) {
      const s = tx.transaction.signatures[0];
      ingested.push(s);
      db.txs.add(s);
      return { signature: s, status: "applied", trades: 0, newPools: [] };
    },
    async refreshPools() {},
    watchedPools: () => new Map((opts.pools ?? []).map((p) => [p, {}])),
  };
  // newest first, like getSignaturesForAddress
  const rpc = {
    async getSignaturesForAddress(_a: string, o: { until?: string; limit?: number }) {
      const all = [...opts.sigs].reverse().map((signature, i) => ({ signature, slot: 1000 - i, err: null }));
      const cut = o.until ? all.findIndex((s) => s.signature === o.until) : -1;
      return (cut >= 0 ? all.slice(0, cut) : all).slice(0, o.limit);
    },
    async getTransaction(sig: string) {
      return opts.fetchable(sig);
    },
  } as unknown as MeteoraRpc;
  const src = new MeteoraSignatureSource(rpc, db as never, ingestor as never, { commitment: "confirmed", pageSize: 100, backfillFromSlot: 0, reconcileDepth: 50, dbcConfigs: [CONFIG], mints: [], fetchAttempts: 1, giveUpMs: 60_000 }, log);
  return { src, db, ingested };
}

describe("source cursor safety (M-5) and hints (H-1)", () => {
  const names = ["dbc_pool_init", "dbc_curve_complete", "dbc_migration_damm_v2"];
  const bySig = new Map(names.map((n) => [sigOf(n), fx(n)]));

  it("applies oldest first and never moves the cursor past an unfetchable signature", async () => {
    let hide: string | null = sigOf("dbc_curve_complete");
    const { src, db, ingested } = harness({ sigs: names.map(sigOf), fetchable: (s) => (s === hide ? null : bySig.get(s) ?? null) });
    await src.ensureCursors();
    await src.pollOnce();
    expect(ingested).toEqual([sigOf("dbc_pool_init"), sigOf("dbc_migration_damm_v2")]);
    expect(db.cursors.get(CONFIG)!.last_signature).toBe(sigOf("dbc_pool_init")); // held before the missing one
    expect(src.missingSignatures).toEqual([sigOf("dbc_curve_complete")]);
    hide = null;
    await src.pollOnce();
    expect(ingested).toContain(sigOf("dbc_curve_complete"));
    expect(db.cursors.get(CONFIG)!.last_signature).toBe(sigOf("dbc_migration_damm_v2"));
    expect(src.missingSignatures).toEqual([]);
  });

  it("webhook hints are re-fetched and ingested only if the real tx touches a watched address", async () => {
    const other = fx("dbc_direct_sell"); // a DBC trade on an unrelated pool/config
    const { src, ingested } = harness({ sigs: [], fetchable: (s) => (s === other.transaction.signatures[0] ? other : bySig.get(s) ?? null) });
    src.hint([other.transaction.signatures[0], sigOf("dbc_pool_init")]);
    await src.drainHints();
    expect(ingested).toEqual([sigOf("dbc_pool_init")]);
    expect(src.stats.hintsIgnored).toBe(1);
  });

  it("a DAMM v2 trade hint is watched once its pool is registered", async () => {
    const t = fx("damm_graduated_direct_buy");
    const s = t.transaction.signatures[0];
    const a = harness({ sigs: [], fetchable: () => t });
    expect(await a.src.isWatched(t)).toBe(false);
    const b = harness({ sigs: [], fetchable: () => t, pools: [DAMM_POOL] });
    expect(await b.src.isWatched(t)).toBe(true);
    b.src.hint([s]);
    await b.src.drainHints();
    expect(b.ingested).toEqual([s]);
  });
});
