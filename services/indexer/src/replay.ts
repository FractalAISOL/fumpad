/**
 * Rebuild one mint's derived state from the raw `events` table (re-decoding `raw`).
 * Used after a rollback (a confirmed transaction that never finalized) and by the
 * `replay` CLI. Global tables (users, user_stats, wallet_*) are recomputed by derive.ts.
 */
import { decodeEventRaw, type FumpadEvent, type Params } from "@fumpad/sdk/v06";

import { type Db, withTx } from "./db.js";
import { applyEvents } from "./handlers.js";

const PER_MINT_TABLES = [
  "trades",
  "ticket_debits",
  "claims",
  "queue_entries",
  "samples",
  "buybacks",
  "fee_withdrawals",
  "lp_locks",
  "lp_skims",
  "lp_settlements",
  "holdings_registered",
  "positions",
  "feed_events",
  "tickets",
];

export async function replayMint(db: Db, mint: string, params: Params): Promise<number> {
  return withTx(db, async (c) => {
    // Keep off-chain metadata across the rebuild.
    const meta = await c.query<{ metadata: unknown }>("SELECT metadata FROM coins WHERE mint = $1", [mint]);
    for (const t of PER_MINT_TABLES) await c.query(`DELETE FROM ${t} WHERE mint = $1`, [mint]);
    await c.query("DELETE FROM coins WHERE mint = $1", [mint]);
    // Ticket-keyed events (TicketDebited/TicketClosed) were stored with their mint at ingest.
    const rows = await c.query<{ signature: string; idx: number; program: "fumpad" | "locker"; raw: string; slot: string; block_time: string | null }>(
      `SELECT e.signature, e.idx, e.program, e.raw, t.slot, t.block_time
         FROM events e JOIN transactions t USING (signature)
        WHERE e.mint = $1 ORDER BY t.slot, t.seq, e.idx`,
      [mint],
    );
    let n = 0;
    let i = 0;
    while (i < rows.rows.length) {
      const sig = rows.rows[i].signature;
      const group: FumpadEvent[] = [];
      for (; i < rows.rows.length && rows.rows[i].signature === sig; i++) {
        const r = rows.rows[i];
        const ev = decodeEventRaw(r.program, r.raw);
        if (ev) group.push({ ...ev, program: r.program, index: r.idx, topIx: 0, raw: r.raw } as FumpadEvent);
      }
      const head = rows.rows[i - 1];
      await applyEvents({ c, signature: sig, slot: Number(head.slot), blockTime: head.block_time === null ? null : Number(head.block_time), params, touched: new Set() }, group);
      n += group.length;
    }
    if (meta.rows[0]?.metadata) await c.query("UPDATE coins SET metadata = $2 WHERE mint = $1", [mint, JSON.stringify(meta.rows[0].metadata)]);
    return n;
  });
}
