/**
 * Pool lifecycle facts used to build the FUMPAD pool set (which pools' trades count):
 *  - DBC `EvtInitializePool` (pool, config, base mint, creator)       → a curve pool exists under `config`
 *  - DBC `migration_damm_v2` + DAMM v2 `EvtInitializePool` in the SAME successful tx → the DAMM v2 pool
 *    the curve graduated into (both must agree on pool + mints, else nothing is returned).
 * Same authentication rules as swaps (emit_cpi from the program, event authority account).
 */
import { DAMM_V2_EVENT_AUTHORITY, DBC_EVENT_AUTHORITY, DBC_MIGRATION_DAMM_V2_ACCOUNTS as MG, DBC_PROGRAM_ID } from "./constants.js";
import { decodeEventPayload, eventPayload, instructionName, venueOf } from "./decode.js";
import { type ConfirmedTx, normalizeTx } from "./tx.js";

export interface DbcPoolCreated {
  pool: string;
  config: string;
  baseMint: string;
  creator: string;
}
export interface DammMigration {
  dbcPool: string;
  config: string;
  dammPool: string;
  baseMint: string;
  quoteMint: string;
  /** DAMM v2 `EvtInitializePool.sqrt_price`: the graduated pool's opening spot (Q64.64). */
  sqrtPrice: bigint;
}
export interface PoolFacts {
  signature: string;
  slot: number;
  dbcPools: DbcPoolCreated[];
  migrations: DammMigration[];
}

export function parsePoolFacts(input: ConfirmedTx): PoolFacts {
  const tx = normalizeTx(input);
  const out: PoolFacts = { signature: tx.signature, slot: tx.slot, dbcPools: [], migrations: [] };
  if (tx.err) return out;
  const dammInits = new Map<string, { a: string; b: string; sqrtPrice: bigint }>();
  for (const ix of tx.flat) {
    const venue = venueOf(ix.programId);
    if (!venue) continue;
    const payload = eventPayload(ix.data);
    if (!payload) continue;
    if (ix.accounts[0] !== (venue === "dbc" ? DBC_EVENT_AUTHORITY : DAMM_V2_EVENT_AUTHORITY)) continue;
    let ev;
    try {
      ev = decodeEventPayload(venue, payload);
    } catch {
      continue;
    }
    if (!ev || ev.name !== "EvtInitializePool") continue;
    if (venue === "dbc") out.dbcPools.push({ pool: ev.data.pool as string, config: ev.data.config as string, baseMint: ev.data.base_mint as string, creator: ev.data.creator as string });
    else dammInits.set(ev.data.pool as string, { a: ev.data.token_a_mint as string, b: ev.data.token_b_mint as string, sqrtPrice: BigInt(ev.data.sqrt_price as bigint) });
  }
  for (const ix of tx.flat) {
    if (ix.programId !== DBC_PROGRAM_ID || instructionName("dbc", ix.data) !== "migration_damm_v2") continue;
    const a = ix.accounts;
    if (a.length <= MG.dammEventAuthority) continue;
    const init = dammInits.get(a[MG.dammPool]);
    if (!init || init.a !== a[MG.baseMint] || init.b !== a[MG.quoteMint]) continue;
    out.migrations.push({ dbcPool: a[MG.virtualPool], config: a[MG.config], dammPool: a[MG.dammPool], baseMint: a[MG.baseMint], quoteMint: a[MG.quoteMint], sqrtPrice: init.sqrtPrice });
  }
  return out;
}
