/**
 * Keeper ↔ Postgres (optional outside production, required in it):
 *  - L-10 single instance: a session-level advisory lock held on a dedicated connection for
 *    the life of the process. A second keeper waits (and never sends) until the first one
 *    exits; losing the lock connection exits the process (Railway restarts it, and it waits
 *    for the lock again).
 *  - M-7 persistence in `meta` (created by the indexer's migrations): the lookup table
 *    address (reused across restarts instead of a new ~0.06 SOL table each boot) and the
 *    day's spend.
 */
import pg from "pg";
import type { Logger } from "pino";

/** Advisory lock id shared by every keeper on this database. */
export const KEEPER_LOCK_ID = 7_271_002;

export class KeeperStore {
  private pool: pg.Pool;
  private lockClient?: pg.Client;

  constructor(
    private url: string,
    private log: Logger,
  ) {
    this.pool = new pg.Pool({ connectionString: url, max: 2, application_name: "fumpad-keeper" });
    this.pool.on("error", (e) => this.log.warn({ err: e.message }, "keeper db pool error"));
  }

  /**
   * Block until this process holds the keeper lock. `onLost` runs if the lock connection
   * dies (the caller must stop sending immediately).
   */
  async acquireLock(onLost: (e: Error) => void, opts: { retryMs?: number; signal?: { stopped: boolean } } = {}): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      if (opts.signal?.stopped) throw new Error("stopped while waiting for the keeper lock");
      const c = new pg.Client({ connectionString: this.url, application_name: "fumpad-keeper-lock" });
      try {
        await c.connect();
        const r = await c.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [KEEPER_LOCK_ID]);
        if (r.rows[0]?.ok) {
          c.on("error", (e) => onLost(e));
          c.on("end", () => onLost(new Error("lock connection closed")));
          this.lockClient = c;
          return;
        }
        if (attempt % 6 === 0) this.log.warn("another keeper holds the lock; waiting (single instance, L-10)");
      } catch (e) {
        this.log.warn({ err: String(e) }, "keeper lock: database unavailable; retrying");
      }
      await c.end().catch(() => {});
      await new Promise((r) => setTimeout(r, opts.retryMs ?? 10_000));
    }
  }

  async getMeta<T>(key: string): Promise<T | null> {
    try {
      const r = await this.pool.query<{ value: T }>("SELECT value FROM meta WHERE key = $1", [key]);
      return r.rows[0]?.value ?? null;
    } catch (e) {
      this.log.warn({ err: String(e), key }, "keeper meta read failed");
      return null;
    }
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    try {
      await this.pool.query(
        "INSERT INTO meta (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        [key, JSON.stringify(value)],
      );
    } catch (e) {
      this.log.warn({ err: String(e), key }, "keeper meta write failed");
    }
  }

  async close(): Promise<void> {
    const c = this.lockClient;
    this.lockClient = undefined;
    if (c) {
      c.removeAllListeners("end");
      c.removeAllListeners("error");
      await c.query("SELECT pg_advisory_unlock($1)", [KEEPER_LOCK_ID]).catch(() => {});
      await c.end().catch(() => {});
    }
    await this.pool.end().catch(() => {});
  }
}
