/**
 * RPC source: `getSignaturesForAddress` + `getTransaction` polling. Canonical for gap
 * detection in every deployment (webhooks / websockets only make it faster):
 *
 * - Per-address cursor (fumpad, locker, and every graduated coin's PumpSwap pool).
 * - New signatures are fetched newest→oldest with `until = cursor` and paging via
 *   `before`, then applied OLDEST FIRST; the cursor advances only after the whole batch
 *   is applied, so a crash replays (idempotently) instead of skipping.
 * - First run: backfill back to BACKFILL_FROM_SLOT (or the start of history).
 * - `reconcile()` re-scans the newest N signatures per address without a cursor and
 *   applies anything missing — catches dropped webhooks, RPC node gaps and cursor
 *   signatures that were themselves rolled back.
 */
import type { ConfirmedSignatureInfo, Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

import { FUMPAD_PROGRAM_ID, LP_LOCKER_PROGRAM_ID, type TxLike } from "@fumpad/sdk";

import type { Db } from "../db.js";
import type { Commit, Ingestor, Source } from "../ingest.js";
import type { Logger } from "../log.js";

export interface RpcSourceOpts {
  commitment: Commit;
  pageSize: number;
  backfillFromSlot: number;
  reconcileDepth: number;
  concurrency?: number;
}

export class RpcSource {
  private running = false;
  private pending = false;
  stats = { polls: 0, fetched: 0, gapsFilled: 0, errors: 0, lastPollAt: 0 };

  constructor(private conn: Connection, private db: Db, private ingestor: Ingestor, private opts: RpcSourceOpts, private log: Logger) {}

  async ensureCursors() {
    await this.db.query(
      `INSERT INTO cursors (address, kind) VALUES ($1, 'program'), ($2, 'program') ON CONFLICT DO NOTHING`,
      [FUMPAD_PROGRAM_ID.toBase58(), LP_LOCKER_PROGRAM_ID.toBase58()],
    );
    await this.db.query(
      `INSERT INTO cursors (address, kind, mint) SELECT amm_pool, 'pool', mint FROM coins WHERE amm_pool IS NOT NULL ON CONFLICT DO NOTHING`,
    );
  }

  /** Coalescing trigger: run a poll now (or right after the current one). */
  poke() {
    if (this.running) {
      this.pending = true;
      return;
    }
    void this.pollOnce();
  }

  async pollOnce(): Promise<number> {
    if (this.running) {
      this.pending = true;
      return 0;
    }
    this.running = true;
    let n = 0;
    try {
      await this.ensureCursors();
      const cursors = await this.db.query<{ address: string; last_signature: string | null; last_slot: string; backfill_done: boolean }>(
        "SELECT address, last_signature, last_slot, backfill_done FROM cursors ORDER BY kind DESC, address",
      );
      for (const cur of cursors.rows) {
        n += await this.pollAddress(cur.address, cur.last_signature, cur.backfill_done ? "rpc" : "backfill");
      }
      this.stats.polls++;
      this.stats.lastPollAt = Date.now();
    } catch (e) {
      this.stats.errors++;
      this.log.warn({ err: String(e) }, "poll failed");
    } finally {
      this.running = false;
      if (this.pending) {
        this.pending = false;
        setTimeout(() => this.poke(), 0);
      }
    }
    return n;
  }

  private async signaturesSince(address: string, until: string | null, stopBelowSlot: number): Promise<ConfirmedSignatureInfo[]> {
    const out: ConfirmedSignatureInfo[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.conn.getSignaturesForAddress(new PublicKey(address), { until: until ?? undefined, before, limit: this.opts.pageSize }, this.opts.commitment);
      for (const s of page) {
        if (!until && s.slot < stopBelowSlot) return out;
        out.push(s);
      }
      if (page.length < this.opts.pageSize) return out;
      before = page[page.length - 1].signature;
    }
  }

  private async pollAddress(address: string, until: string | null, source: Source): Promise<number> {
    const sigs = await this.signaturesSince(address, until, this.opts.backfillFromSlot);
    if (!sigs.length) {
      if (source === "backfill") await this.db.query("UPDATE cursors SET backfill_done = true WHERE address = $1", [address]);
      return 0;
    }
    sigs.reverse(); // oldest first
    const n = await this.applySignatures(sigs, source);
    const newest = sigs[sigs.length - 1];
    await this.db.query(
      "UPDATE cursors SET last_signature = $2, last_slot = $3, backfill_done = true, updated_at = now() WHERE address = $1",
      [address, newest.signature, newest.slot],
    );
    return n;
  }

  /** Fetch + ingest signatures not yet in `transactions`, in the given order. */
  async applySignatures(sigs: ConfirmedSignatureInfo[], source: Source): Promise<number> {
    const known = new Set(
      (await this.db.query<{ signature: string }>("SELECT signature FROM transactions WHERE signature = ANY($1)", [sigs.map((s) => s.signature)])).rows.map((r) => r.signature),
    );
    const todo = sigs.filter((s) => !known.has(s.signature));
    const conc = this.opts.concurrency ?? 4;
    let applied = 0;
    // Fetch in parallel windows but ingest strictly in order.
    for (let i = 0; i < todo.length; i += conc) {
      const win = todo.slice(i, i + conc);
      const txs = await Promise.all(win.map((s) => this.fetchTx(s.signature)));
      for (let j = 0; j < win.length; j++) {
        const tx = txs[j];
        if (!tx) {
          this.log.warn({ signature: win[j].signature }, "transaction not found (yet); will retry on reconcile");
          continue;
        }
        const r = await this.ingestor.ingest(tx, source, this.opts.commitment);
        if (r.status === "applied") applied++;
      }
    }
    this.stats.fetched += todo.length;
    return applied;
  }

  async fetchTx(signature: string): Promise<TxLike | null> {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const tx = await this.conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: this.opts.commitment });
        if (tx) return tx as unknown as TxLike;
      } catch (e) {
        this.log.debug({ signature, err: String(e) }, "getTransaction failed");
      }
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
    return null;
  }

  /** Gap detection: re-scan the newest `reconcileDepth` signatures of every address. */
  async reconcile(): Promise<number> {
    // Never race the poller (it would look like a gap); skip until the first full poll.
    if (this.running || this.stats.polls === 0) return 0;
    this.running = true;
    try {
      return await this.reconcileInner();
    } finally {
      this.running = false;
    }
  }

  private async reconcileInner(): Promise<number> {
    let filled = 0;
    const cursors = await this.db.query<{ address: string }>("SELECT address FROM cursors");
    for (const { address } of cursors.rows) {
      const sigs = await this.conn.getSignaturesForAddress(new PublicKey(address), { limit: this.opts.reconcileDepth }, this.opts.commitment);
      sigs.reverse();
      const n = await this.applySignatures(sigs, "reconcile");
      if (n) this.log.warn({ address, filled: n }, "reconcile filled a gap");
      filled += n;
    }
    this.stats.gapsFilled += filled;
    return filled;
  }
}
