/**
 * Keeper signature exchange: a shared Postgres table used as a bulletin board, with SIGNATURE-ONLY trust.
 *
 * Why a shared table, not a peer protocol: each attestor already needs Postgres (single-instance lock,
 * persisted state); a table needs no inbound ports, TLS or peer discovery between three machines on
 * different providers, and it survives restarts. Trust doesn't depend on it: a keeper reads only the
 * (keeper, signature) pairs filed under the sha256 id of a message IT derived itself, and keeps a pair
 * only if Ed25519 verifies over ITS OWN bytes and the key is an active keeper in `Global.keepers`. The
 * message bytes stored alongside are informational (watcher / debugging) and never used for signing.
 * So whoever controls the database can only withhold or spam signatures (liveness), never make a keeper
 * submit something it didn't derive, and never forge a peer's signature. The program re-verifies
 * everything (Ed25519 precompile + 2 distinct active keepers) anyway.
 *
 * Status rows are HINTS only (V7-M1): one row per (message, keeper). A keeper decides "landed" from the
 * chain (consumed marker at finalized) and "dropped" only from its own simulation; a peer's fresh
 * "landed" hint merely defers its own submission once, for a bounded time (attestor.ts).
 *
 * Per-keeper DB roles are the documented default (ATTEST_BOARD_RLS, services/README.md "Keeper board"):
 * each keeper connects as its own role, every row records `db_role = current_user`, and row-level
 * security lets a role write/delete only its own rows (SELECT on all). Then one compromised keeper or a
 * leaked keeper DATABASE_URL can't delete or overwrite the other keepers' signatures or hints.
 */
import { PublicKey } from "@solana/web3.js";
import pg from "pg";

import { type KeeperSignature, verifyAttestation } from "@fumpad/sdk";

import type { AttestKind } from "./records.js";

export interface BoardRow {
  keeper: string;
  signature: Uint8Array;
}

export interface BoardHint {
  keeper: string;
  status: string;
  detail: string | null;
  updatedAt: Date;
}

export interface SignatureBoard {
  publish(id: string, kind: AttestKind, mint: string, message: Uint8Array, keeper: string, signature: Uint8Array): Promise<void>;
  signatures(id: string): Promise<BoardRow[]>;
  /** This keeper's outcome note (landed tx / its own permanent failure): a hint for peers, never authoritative. */
  setStatus(id: string, keeper: string, status: string, detail?: string): Promise<void>;
  /** Every keeper's hint for a message. */
  hints(id: string): Promise<BoardHint[]>;
  firstSeen(id: string): Promise<Date | null>;
}

/** Keep only signatures that verify over `message` from distinct active keepers. */
export function validSignatures(message: Uint8Array, rows: readonly BoardRow[], active: readonly PublicKey[]): KeeperSignature[] {
  const allowed = new Set(active.map((k) => k.toBase58()));
  const out: KeeperSignature[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!allowed.has(r.keeper) || seen.has(r.keeper) || r.signature.length !== 64) continue;
    const s = { keeper: new PublicKey(r.keeper), signature: r.signature };
    if (!verifyAttestation(message, s)) continue;
    seen.add(r.keeper);
    out.push(s);
  }
  return out.sort((a, b) => (a.keeper.toBase58() < b.keeper.toBase58() ? -1 : 1));
}

export const ATTEST_BOARD_DDL = `
CREATE TABLE IF NOT EXISTS attest_signatures (
  message_id text NOT NULL,
  keeper text NOT NULL,
  kind text NOT NULL,
  mint text NOT NULL,
  message bytea NOT NULL,
  signature bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, keeper)
);
CREATE INDEX IF NOT EXISTS attest_signatures_created ON attest_signatures (created_at);
ALTER TABLE attest_signatures ADD COLUMN IF NOT EXISTS db_role text NOT NULL DEFAULT current_user;
CREATE TABLE IF NOT EXISTS attest_hints (
  message_id text NOT NULL,
  keeper text NOT NULL,
  status text NOT NULL,
  detail text,
  db_role text NOT NULL DEFAULT current_user,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, keeper)
);`;

/**
 * Per-keeper roles (V7-M1), run once by the database OWNER after the tables exist, then per keeper:
 *   CREATE ROLE keeper_a LOGIN PASSWORD '…';
 *   GRANT SELECT, INSERT, UPDATE, DELETE ON attest_signatures, attest_hints TO keeper_a;
 *   GRANT SELECT ON attest_keeper_roles TO keeper_a;
 *   INSERT INTO attest_keeper_roles VALUES ('keeper_a', '<keeper A pubkey>');
 * (the watcher role gets SELECT only). A role can only write rows filed under ITS keeper key, so a
 * compromised keeper can neither delete peers' rows nor squat a (message, peer) primary key.
 */
export const ATTEST_BOARD_RLS = `
CREATE TABLE IF NOT EXISTS attest_keeper_roles (db_role text PRIMARY KEY, keeper text NOT NULL UNIQUE);
ALTER TABLE attest_signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE attest_hints ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS board_read ON attest_signatures;
DROP POLICY IF EXISTS board_own ON attest_signatures;
DROP POLICY IF EXISTS hints_read ON attest_hints;
DROP POLICY IF EXISTS hints_own ON attest_hints;
CREATE POLICY board_read ON attest_signatures FOR SELECT USING (true);
CREATE POLICY board_own ON attest_signatures FOR ALL USING (db_role = current_user)
  WITH CHECK (db_role = current_user AND keeper = (SELECT r.keeper FROM attest_keeper_roles r WHERE r.db_role = current_user));
CREATE POLICY hints_read ON attest_hints FOR SELECT USING (true);
CREATE POLICY hints_own ON attest_hints FOR ALL USING (db_role = current_user)
  WITH CHECK (db_role = current_user AND keeper = (SELECT r.keeper FROM attest_keeper_roles r WHERE r.db_role = current_user));`;

export class PgBoard implements SignatureBoard {
  constructor(private pool: pg.Pool) {}

  /**
   * Idempotent; serialised with an advisory lock because concurrent `CREATE TABLE IF NOT EXISTS` races in
   * Postgres. With per-keeper roles the tables already exist (created by the owner): DDL errors from a
   * role without CREATE/ALTER rights are then ignored.
   */
  async init(): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtext('fumpad_attest_board_ddl'))");
      await c.query(ATTEST_BOARD_DDL);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      const exists = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('attest_signatures','attest_hints')").catch(() => ({ rows: [{ n: 0 }] }));
      if ((exists.rows[0]?.n ?? 0) < 2) throw e;
    } finally {
      c.release();
    }
  }

  /** True when both board tables enforce row-level security (per-keeper roles, ATTEST_BOARD_RLS). */
  async rowSecurity(): Promise<boolean> {
    const r = await this.pool.query<{ relname: string; relrowsecurity: boolean }>(
      "SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('attest_signatures','attest_hints')",
    );
    return r.rows.length === 2 && r.rows.every((x) => x.relrowsecurity);
  }

  async publish(id: string, kind: AttestKind, mint: string, message: Uint8Array, keeper: string, signature: Uint8Array): Promise<void> {
    await this.pool.query(
      `INSERT INTO attest_signatures (message_id, keeper, kind, mint, message, signature) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (message_id, keeper) DO NOTHING`,
      [id, keeper, kind, mint, Buffer.from(message), Buffer.from(signature)],
    );
  }

  async signatures(id: string): Promise<BoardRow[]> {
    const r = await this.pool.query<{ keeper: string; signature: Buffer }>("SELECT keeper, signature FROM attest_signatures WHERE message_id = $1", [id]);
    return r.rows.map((x) => ({ keeper: x.keeper, signature: Uint8Array.from(x.signature) }));
  }

  async setStatus(id: string, keeper: string, status: string, detail?: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO attest_hints (message_id, keeper, status, detail, updated_at) VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (message_id, keeper) DO UPDATE SET status = EXCLUDED.status, detail = EXCLUDED.detail, updated_at = now()`,
      [id, keeper, status, detail ?? null],
    );
  }

  async hints(id: string): Promise<BoardHint[]> {
    const r = await this.pool.query<{ keeper: string; status: string; detail: string | null; updated_at: Date }>(
      "SELECT keeper, status, detail, updated_at FROM attest_hints WHERE message_id = $1",
      [id],
    );
    return r.rows.map((x) => ({ keeper: x.keeper, status: x.status, detail: x.detail, updatedAt: x.updated_at }));
  }

  async firstSeen(id: string): Promise<Date | null> {
    const r = await this.pool.query<{ t: Date | null }>("SELECT min(created_at) AS t FROM attest_signatures WHERE message_id = $1", [id]);
    return r.rows[0]?.t ?? null;
  }
}

/** In-memory board (tests, single-process local runs). */
export class MemoryBoard implements SignatureBoard {
  constructor(private clockMs: () => number = () => Date.now()) {}
  rows = new Map<string, Map<string, { signature: Uint8Array; at: Date; message: Uint8Array }>>();
  /** message id → keeper → hint */
  st = new Map<string, Map<string, BoardHint>>();
  async publish(id: string, _k: AttestKind, _m: string, message: Uint8Array, keeper: string, signature: Uint8Array) {
    const m = this.rows.get(id) ?? new Map();
    if (!m.has(keeper)) m.set(keeper, { signature, at: new Date(this.clockMs()), message });
    this.rows.set(id, m);
  }
  async signatures(id: string) {
    return [...(this.rows.get(id) ?? new Map()).entries()].map(([keeper, v]) => ({ keeper, signature: v.signature }));
  }
  async setStatus(id: string, keeper: string, status: string, detail?: string) {
    const m = this.st.get(id) ?? new Map<string, BoardHint>();
    m.set(keeper, { keeper, status, detail: detail ?? null, updatedAt: new Date(this.clockMs()) });
    this.st.set(id, m);
  }
  async hints(id: string) {
    return [...(this.st.get(id)?.values() ?? [])];
  }
  async firstSeen(id: string) {
    const v = [...(this.rows.get(id) ?? new Map()).values()].map((x) => x.at.getTime());
    return v.length ? new Date(Math.min(...v)) : null;
  }
}
