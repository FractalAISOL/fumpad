import type { Connection } from "@solana/web3.js";

import { DEFAULT_PARAMS, decodeGlobal, globalPda, type Params } from "@fumpad/sdk";

import { getMeta, type Queryable, setMeta } from "./db.js";

/** Params as stored in `meta.global_params` (bigints as strings). */
type Stored = Record<keyof Params, string | number>;

export function storeable(p: Params): Stored {
  const o: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(p)) o[k] = typeof v === "bigint" ? v.toString() : (v as number | string);
  return o as Stored;
}
export function fromStored(s: Stored): Params {
  const defs = DEFAULT_PARAMS as unknown as Record<string, unknown>;
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) o[k] = typeof defs[k] === "bigint" ? BigInt(v) : v;
  // Params appended since the copy was stored (e.g. v0.5 snipe_*) didn't exist then: 0 = off.
  for (const [k, d] of Object.entries(defs)) if (!(k in o)) o[k] = typeof d === "bigint" ? 0n : typeof d === "number" ? 0 : d;
  return o as unknown as Params;
}

/** Fetch Global from chain and cache it in `meta`; fall back to the cached copy, then defaults. */
export async function loadParams(conn: Connection, db: Queryable): Promise<{ params: Params; treasury?: string; admin?: string }> {
  try {
    const a = await conn.getAccountInfo(globalPda(), "confirmed");
    if (a) {
      const g = decodeGlobal(new Uint8Array(a.data));
      await setMeta(db, "global", { params: storeable(g.params), admin: g.admin.toBase58(), treasury: g.platformTreasury.toBase58(), keepers: g.keepers.map((k) => k.toBase58()), paused: g.paused });
      return { params: g.params, treasury: g.platformTreasury.toBase58(), admin: g.admin.toBase58() };
    }
  } catch {
    /* fall through */
  }
  const cached = await getMeta<{ params: Stored; treasury: string; admin: string }>(db, "global");
  if (cached) return { params: fromStored(cached.params), treasury: cached.treasury, admin: cached.admin };
  return { params: DEFAULT_PARAMS };
}
