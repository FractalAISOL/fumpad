import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import pg from "pg";

// NUMERIC → string (exact), BIGINT → string; callers convert with BigInt()/Number().
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(url: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString: url, max, application_name: "fumpad" });
}

export async function withTx<T>(db: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));

/** Apply pending `migrations/NNN_*.sql` files in order (advisory-locked, idempotent). */
export async function migrate(db: pg.Pool, log: (m: string) => void = () => {}): Promise<string[]> {
  const c = await db.connect();
  const applied: string[] = [];
  try {
    await c.query("SELECT pg_advisory_lock(7271001)");
    await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    const done = new Set((await c.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = readFileSync(MIGRATIONS + f, "utf8");
      await c.query("BEGIN");
      try {
        await c.query(sql);
        await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
      applied.push(f);
      log(`applied migration ${f}`);
    }
  } finally {
    await c.query("SELECT pg_advisory_unlock(7271001)").catch(() => {});
    c.release();
  }
  return applied;
}

/** meta key binding a database to the fumpad program id its rows describe. */
export const PROGRAM_BINDING_KEY = "fumpad_program_id";

/**
 * Bind the database to `programId` on first start, and refuse to run against a database bound to another
 * program (a previous version's DB, or a reset schema that an old process re-filled). Returns what it did.
 */
export async function bindProgram(db: Queryable, programId: string): Promise<"bound" | "ok"> {
  const cur = await getMeta<{ programId?: string } | string>(db, PROGRAM_BINDING_KEY);
  const bound = typeof cur === "string" ? cur : cur?.programId;
  if (bound && bound !== programId)
    throw new Error(
      `database is bound to fumpad program ${bound}, this build indexes ${programId}: point DATABASE_URL at the right database, or reset the schema with every old service stopped (DEPLOY-v07.md §3)`,
    );
  if (bound) return "ok";
  await setMeta(db, PROGRAM_BINDING_KEY, { programId, at: new Date().toISOString() });
  return "bound";
}

/**
 * Coins this program never registered: v0.7's CoinRegistered always sets `dbc_pool`, a v0.6 indexer's insert
 * never does. Rows like these mean an old-version process wrote into this database (see purge-coin.ts).
 */
export async function foreignCoins(db: Queryable, limit = 20): Promise<string[]> {
  const r = await db.query<{ mint: string }>("SELECT mint FROM coins WHERE dbc_pool IS NULL ORDER BY created_at LIMIT $1", [limit]);
  return r.rows.map((x) => x.mint);
}

export async function getMeta<T>(db: Queryable, key: string): Promise<T | null> {
  const r = await db.query<{ value: T }>("SELECT value FROM meta WHERE key = $1", [key]);
  return r.rows[0]?.value ?? null;
}
export async function setMeta(db: Queryable, key: string, value: unknown): Promise<void> {
  await db.query(
    "INSERT INTO meta (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
    [key, JSON.stringify(value)],
  );
}

/** pg NOTIFY channel the API listens on for live feed + ticket/coin updates. */
export const NOTIFY_CHANNEL = "fumpad_live";
