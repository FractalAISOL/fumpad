/**
 * Rebuild one mint's derived state from the raw `events` table: fumpad events are re-decoded from
 * their borsh `raw`, Meteora swaps and launch metadata from their JSON `raw`. Used after a rollback (a
 * confirmed transaction that never finalized) and by the `replay` CLI.
 */
import { decodeEventRaw, type Params } from "@fumpad/sdk";

import { type Db, withTx } from "./db.js";
import { applyEvents, type IndexedEvent } from "./handlers.js";

const PER_MINT_TABLES = ["trades", "ticket_debits", "claims", "queue_entries", "samples", "buybacks", "fee_withdrawals", "fee_claims", "positions", "feed_events", "tickets"];

export function decodeStored(program: string, name: string, idx: number, raw: string): IndexedEvent | null {
  if (program === "fumpad") {
    const ev = decodeEventRaw(raw);
    return ev ? { name: ev.name, program: "fumpad", index: idx, data: ev.data, raw } : null;
  }
  if (program === "meteora" || program === "meta") return { name, program, index: idx, data: JSON.parse(raw), raw };
  return null;
}

export async function replayMint(db: Db, mint: string, params: Params): Promise<number> {
  return withTx(db, async (c) => {
    const meta = await c.query<{ metadata: unknown }>("SELECT metadata FROM coins WHERE mint = $1", [mint]);
    for (const t of PER_MINT_TABLES) await c.query(`DELETE FROM ${t} WHERE mint = $1`, [mint]);
    await c.query("DELETE FROM coins WHERE mint = $1", [mint]);
    const rows = await c.query<{ signature: string; idx: number; program: string; name: string; raw: string; slot: string; block_time: string | null }>(
      `SELECT e.signature, e.idx, e.program, e.name, e.raw, t.slot, t.block_time
         FROM events e JOIN transactions t USING (signature)
        WHERE e.mint = $1 ORDER BY t.slot, t.seq, e.idx`,
      [mint],
    );
    let n = 0;
    let i = 0;
    while (i < rows.rows.length) {
      const sig = rows.rows[i].signature;
      const group: IndexedEvent[] = [];
      for (; i < rows.rows.length && rows.rows[i].signature === sig; i++) {
        const r = rows.rows[i];
        const ev = decodeStored(r.program, r.name, r.idx, r.raw);
        if (ev) group.push(ev);
      }
      // Within a tx: fumpad events and Meteora swaps in instruction order (swaps use idx = 100_000 + ixKey order).
      const head = rows.rows[i - 1];
      await applyEvents({ c, signature: sig, slot: Number(head.slot), blockTime: head.block_time === null ? null : Number(head.block_time), params, touched: new Set() }, group);
      n += group.length;
    }
    if (meta.rows[0]?.metadata) await c.query("UPDATE coins SET metadata = $2 WHERE mint = $1", [mint, JSON.stringify(meta.rows[0].metadata)]);
    return n;
  });
}
