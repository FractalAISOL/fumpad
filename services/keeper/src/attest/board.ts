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
 * Row-level hygiene (operator setup, optional): one DB role per keeper with INSERT/UPDATE only on its own
 * rows (`keeper = current_user`-style policy), SELECT on all.
 */
import { PublicKey } from "@solana/web3.js";
import pg from "pg";

import { type KeeperSignature, verifyAttestation } from "@fumpad/sdk";

import type { AttestKind } from "./records.js";

export interface BoardRow {
  keeper: string;
  signature: Uint8Array;
}

export interface SignatureBoard {
  publish(id: string, kind: AttestKind, mint: string, message: Uint8Array, keeper: string, signature: Uint8Array): Promise<void>;
  signatures(id: string): Promise<BoardRow[]>;
  /** Shared outcome notes (landed tx / permanent failure), so peers stop retrying. */
  setStatus(id: string, status: string, detail?: string): Promise<void>;
  status(id: string): Promise<{ status: string; detail: string | null; updatedAt: Date } | null>;
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
CREATE TABLE IF NOT EXISTS attest_status (
  message_id text PRIMARY KEY,
  status text NOT NULL,
  detail text,
  updated_at timestamptz NOT NULL DEFAULT now()
);`;

export class PgBoard implements SignatureBoard {
  constructor(private pool: pg.Pool) {}

  async init(): Promise<void> {
    await this.pool.query(ATTEST_BOARD_DDL);
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

  async setStatus(id: string, status: string, detail?: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO attest_status (message_id, status, detail, updated_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (message_id) DO UPDATE SET status = EXCLUDED.status, detail = EXCLUDED.detail, updated_at = now()`,
      [id, status, detail ?? null],
    );
  }

  async status(id: string) {
    const r = await this.pool.query<{ status: string; detail: string | null; updated_at: Date }>("SELECT status, detail, updated_at FROM attest_status WHERE message_id = $1", [id]);
    const x = r.rows[0];
    return x ? { status: x.status, detail: x.detail, updatedAt: x.updated_at } : null;
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
  st = new Map<string, { status: string; detail: string | null; updatedAt: Date }>();
  async publish(id: string, _k: AttestKind, _m: string, message: Uint8Array, keeper: string, signature: Uint8Array) {
    const m = this.rows.get(id) ?? new Map();
    if (!m.has(keeper)) m.set(keeper, { signature, at: new Date(this.clockMs()), message });
    this.rows.set(id, m);
  }
  async signatures(id: string) {
    return [...(this.rows.get(id) ?? new Map()).entries()].map(([keeper, v]) => ({ keeper, signature: v.signature }));
  }
  async setStatus(id: string, status: string, detail?: string) {
    this.st.set(id, { status, detail: detail ?? null, updatedAt: new Date(this.clockMs()) });
  }
  async status(id: string) {
    return this.st.get(id) ?? null;
  }
  async firstSeen(id: string) {
    const v = [...(this.rows.get(id) ?? new Map()).values()].map((x) => x.at.getTime());
    return v.length ? new Date(Math.min(...v)) : null;
  }
}
