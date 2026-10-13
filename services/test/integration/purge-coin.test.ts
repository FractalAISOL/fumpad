/**
 * The re-indexed v0.6 coin (SM5k4…fmbL), against a real Postgres:
 *  - cause guards: the indexer binds the DB to its program id (refuses another one), drops cursors of other
 *    program versions instead of polling them, and reports coins it never registered (dbc_pool NULL);
 *  - scripts/ops/purge-coin.ts: dry run deletes nothing and lists exactly the rows `--yes` deletes, scoped to
 *    one mint (another coin's rows and a transaction shared with it are kept).
 */
import { Keypair } from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FUMPAD_PROGRAM_ID } from "@fumpad/sdk";
import { bindProgram, createLogger, createPool, type Db, foreignCoins, getMeta, migrate, PROGRAM_BINDING_KEY, RpcSource } from "@fumpad/indexer";

import { type Postgres, startPostgres } from "../../scripts/local/harness.js";
import { formatReport, purgeCoin } from "../../scripts/ops/purge-coin.js";

let pg: Postgres;
let db: Db;
const OLD = "SM5k4LWqXTrZZYtmbKCvVDiJrk44mEiaJdag9GnfmbL"; // the v0.6 coin
const NEW = Keypair.generate().publicKey.toBase58(); // a v0.7 coin (dbc_pool set)
const V06_PROGRAM = "ASVE6Nk8T1c2Uv81vjPeNDnX54nHGWg98G1afYt2j8Cv";
const pk = () => Keypair.generate().publicKey.toBase58();
const wallet = pk();
const oldPool = pk();
const newPool = pk();

async function coin(mint: string, dbcPool: string | null) {
  await db.query(
    `INSERT INTO coins (mint, creator, name, symbol, uri, created_at, created_sig, virtual_sol, virtual_tokens, real_tokens, price_q64, pool_seeded, pool_tokens, dbc_pool)
     VALUES ($1, $2, 'n', $3, '', 1, $4, 0, 0, 0, 0, 0, 0, $5)`,
    [mint, pk(), mint === OLD ? "FUMB" : "NEW", `${mint}-created`, dbcPool],
  );
}
async function tx(sig: string) {
  await db.query("INSERT INTO transactions (signature, slot, commitment, source, kind) VALUES ($1, 1, 'finalized', 'rpc', 'fumpad')", [sig]);
}
async function trade(sig: string, idx: number, mint: string) {
  await db.query(
    `INSERT INTO trades (signature, idx, slot, ts, mint, wallet, is_buy, on_amm, token_amount, sol_amount, fee_pool, fee_platform, fee_creator, pool_tokens_bought, price_q64, virtual_sol, virtual_tokens)
     VALUES ($1, $2, 1, 3600, $3, $4, true, false, 10, 100, 0, 0, 0, 0, 1, 1, 1)`,
    [sig, idx, mint, wallet],
  );
}
async function event(sig: string, idx: number, mint: string | null) {
  await db.query("INSERT INTO events (signature, idx, program, name, mint, slot, data, raw) VALUES ($1, $2, 'fumpad', 'X', $3, 1, '{}', '')", [sig, idx, mint]);
}
const count = async (sql: string, p: unknown[] = []) => Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM (${sql}) x`, p)).rows[0].n);

beforeAll(async () => {
  pg = await startPostgres(54334);
  db = createPool(pg.url);
  await migrate(db);
  await coin(OLD, null);
  await coin(NEW, newPool);
  // OLD only: launch tx (event w/o mint + event + feed), trade tx.
  await tx("old-launch");
  await event("old-launch", 0, OLD);
  await event("old-launch", 1, null);
  await db.query(`INSERT INTO feed_events (id, kind, ts, mint, actor, signature, payload) VALUES ('old-launch:0:launch', 'launch', 1, $1, $2, 'old-launch', '{}')`, [OLD, wallet]);
  await tx("old-trade");
  await trade("old-trade", 0, OLD);
  // A transaction touching both coins: kept, only OLD's rows go.
  await tx("shared");
  await trade("shared", 0, OLD);
  await trade("shared", 1, NEW);
  // NEW only.
  await tx("new-trade");
  await trade("new-trade", 0, NEW);
  await db.query("INSERT INTO positions (mint, wallet, balance) VALUES ($1, $3, 10), ($2, $3, 5)", [OLD, NEW, wallet]);
  // v0.6 cursors left behind (its program, its PumpSwap pool) + ours.
  await db.query("INSERT INTO cursors (address, kind) VALUES ($1, 'program'), ($2, 'program')", [V06_PROGRAM, FUMPAD_PROGRAM_ID.toBase58()]);
  await db.query("INSERT INTO cursors (address, kind, mint) VALUES ($1, 'pool', $2)", [oldPool, OLD]);
  await db.query("INSERT INTO meteora_pools (pool, venue, base_mint, source) VALUES ($1, 'dbc', $2, 'pool_init')", [newPool, NEW]);
  await db.query("INSERT INTO meteora_cursors (address, kind) VALUES ($1, 'mint')", [NEW]);
  await db.query("INSERT INTO users (address) VALUES ($1)", [wallet]);
}, 120_000);

afterAll(async () => {
  await db?.end();
  await pg?.stop();
});

describe("cause guards (indexer)", () => {
  it("reports coins this program never registered", async () => {
    expect(await foreignCoins(db)).toEqual([OLD]);
  });

  it("binds the database to the program id once, then refuses another program", async () => {
    expect(await bindProgram(db, FUMPAD_PROGRAM_ID.toBase58())).toBe("bound");
    expect(await bindProgram(db, FUMPAD_PROGRAM_ID.toBase58())).toBe("ok");
    expect((await getMeta<{ programId: string }>(db, PROGRAM_BINDING_KEY))?.programId).toBe(FUMPAD_PROGRAM_ID.toBase58());
    await expect(bindProgram(db, V06_PROGRAM)).rejects.toThrow(/bound to fumpad program/);
  });

  it("the poller drops other programs' cursors instead of backfilling them", async () => {
    const src = new RpcSource({} as never, db, {} as never, { commitment: "confirmed", pageSize: 10, backfillFromSlot: 0, reconcileDepth: 1 }, createLogger("test", "silent"));
    await src.ensureCursors();
    expect((await db.query<{ address: string }>("SELECT address FROM cursors ORDER BY address")).rows.map((r) => r.address)).toEqual([FUMPAD_PROGRAM_ID.toBase58()]);
  });
});

describe("purge-coin.ts", () => {
  it("dry run: lists the rows, deletes nothing", async () => {
    const before = await count("SELECT 1 FROM trades");
    const r = await purgeCoin(db, OLD);
    expect(r.applied).toBe(false);
    expect(r.coin).toMatchObject({ symbol: "FUMB", dbcPool: null });
    const t = Object.fromEntries(r.deleted.map((d) => [d.table, d.rows]));
    expect(t.trades).toHaveLength(2); // old-trade:0 + shared:0
    expect(t.trades.join(" ")).not.toContain("idx=1");
    expect(t.transactions.sort()).toEqual(["signature=old-launch", "signature=old-trade"]);
    expect(t.events).toHaveLength(2); // both events of the launch tx (incl. the one without a mint)
    expect(t.coins).toEqual([`mint=${OLD}`]);
    expect(t.positions).toEqual([`mint=${OLD}, wallet=${wallet}`]);
    expect(r.notes.join(" ")).toMatch(/1 transaction\(s\) also touch other coins/);
    expect(formatReport(r)).toMatch(/^DRY RUN: would delete for mint SM5k4/);
    expect(await count("SELECT 1 FROM trades")).toBe(before);
    expect(await count("SELECT 1 FROM coins WHERE mint = $1", [OLD])).toBe(1);
  });

  it("refuses a coin registered by the current program unless --allow-registered", async () => {
    await expect(purgeCoin(db, NEW)).rejects.toThrow(/allow-registered/);
    await expect(purgeCoin(db, "not a mint")).rejects.toThrow(/base58/);
  });

  it("--yes deletes exactly the dry run's rows; the other coin and the shared tx are intact", async () => {
    const dry = await purgeCoin(db, OLD);
    const r = await purgeCoin(db, OLD, { apply: true });
    expect(r.applied).toBe(true);
    expect(r.deleted).toEqual(dry.deleted);
    for (const [sql, n] of [
      ["SELECT 1 FROM coins WHERE mint = $1", 0],
      ["SELECT 1 FROM trades WHERE mint = $1", 0],
      ["SELECT 1 FROM positions WHERE mint = $1", 0],
      ["SELECT 1 FROM feed_events WHERE mint = $1", 0],
      ["SELECT 1 FROM coin_hourly WHERE mint = $1", 0],
      ["SELECT 1 FROM coin_holders WHERE mint = $1", 0],
    ] as const)
      expect(await count(sql, [OLD]), sql).toBe(n);
    expect(await count("SELECT 1 FROM transactions WHERE signature IN ('old-launch', 'old-trade')")).toBe(0);
    expect(await count("SELECT 1 FROM events WHERE signature = 'old-launch'")).toBe(0);
    expect(await count("SELECT 1 FROM transactions WHERE signature IN ('shared', 'new-trade')")).toBe(2);
    expect(await count("SELECT 1 FROM trades WHERE mint = $1", [NEW])).toBe(2);
    expect(await count("SELECT 1 FROM coins WHERE mint = $1", [NEW])).toBe(1);
    expect(await count("SELECT 1 FROM positions WHERE mint = $1", [NEW])).toBe(1);
    expect(await count("SELECT 1 FROM meteora_cursors WHERE address = $1", [NEW])).toBe(1);
    expect(await count("SELECT 1 FROM users WHERE address = $1", [wallet])).toBe(1);
    expect(await foreignCoins(db)).toEqual([]);
    // Idempotent.
    expect((await purgeCoin(db, OLD, { apply: true })).deleted).toEqual([]);
  });
});
