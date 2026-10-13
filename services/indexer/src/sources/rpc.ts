/**
 * RPC source: `getSignaturesForAddress` + `getTransaction` polling. Canonical for gap
 * detection in every deployment (webhooks / websockets only make it faster):
 *
 * - Per-address cursor (fumpad, locker, and every graduated coin's PumpSwap pool).
 * - New signatures are fetched newest→oldest with `until = cursor` and paging via
 *   `before`, then applied OLDEST FIRST; the cursor advances only after the batch is
 *   applied, and NEVER past a signature whose transaction couldn't be fetched (M-5): it
 *   stops just before the oldest missing one, so the next poll re-lists it. Missing
 *   signatures also go to a retry queue; one that stays unknown to the RPC for `giveUpMs`
 *   (a dropped fork) stops holding the cursor back (logged as an error).
 * - First run: backfill back to BACKFILL_FROM_SLOT (or the start of history).
 * - `reconcile()` re-scans the newest N signatures per address without a cursor and
 *   applies anything missing — catches dropped webhooks, RPC node gaps and cursor
 *   signatures that were themselves rolled back.
 * - Webhook hints (`hint()`): signatures from a push source are re-fetched from OUR RPC
 *   and ingested only if the transaction touches a watched address (H-1: the push body is
 *   never trusted as chain data).
 */
import type { ConfirmedSignatureInfo, Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

import { accountKeys, FUMPAD_PROGRAM_ID, LP_LOCKER_PROGRAM_ID, type TxLike } from "@fumpad/sdk/v06";

import type { Db } from "../db.js";
import type { Commit, Ingestor, Source } from "../ingest.js";
import type { Logger } from "../log.js";

export interface RpcSourceOpts {
  commitment: Commit;
  pageSize: number;
  backfillFromSlot: number;
  reconcileDepth: number;
  concurrency?: number;
  /** A signature missing from getTransaction for this long no longer blocks its cursor. */
  giveUpMs?: number;
  /** Max queued webhook hints (oldest dropped beyond this; the poller still catches up). */
  maxHints?: number;
  /** getTransaction attempts per signature (backoff 300 ms × n between). */
  fetchAttempts?: number;
}

/**
 * Where a cursor may move after applying `sigs` (oldest first): the newest signature with no
 * still-blocking missing signature at or before it. null = don't move.
 */
export function cursorTarget(sigs: ConfirmedSignatureInfo[], missing: string[], blocks: (sig: string) => boolean): ConfirmedSignatureInfo | null {
  const miss = new Set(missing);
  let target: ConfirmedSignatureInfo | null = null;
  for (const s of sigs) {
    if (miss.has(s.signature) && blocks(s.signature)) break;
    target = s;
  }
  return target;
}

export class RpcSource {
  private running = false;
  private pending = false;
  stats = { polls: 0, fetched: 0, gapsFilled: 0, errors: 0, lastPollAt: 0, missing: 0, retried: 0, gaveUp: 0, hints: 0, hintsIngested: 0, hintsIgnored: 0 };
  /** signature → first time getTransaction returned nothing for it (retry queue). */
  private missing = new Map<string, number>();
  private hints = new Set<string>();
  private draining?: Promise<void>;

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

  /** Signatures waiting in the retry queue (for tests / health). */
  get missingSignatures(): string[] {
    return [...this.missing.keys()];
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
      n += await this.retryMissing();
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
    const { applied, missing } = await this.applySignatures(sigs, source);
    const target = cursorTarget(sigs, missing, (s) => this.blocksCursor(s));
    if (target) {
      await this.db.query(
        "UPDATE cursors SET last_signature = $2, last_slot = $3, backfill_done = true, updated_at = now() WHERE address = $1",
        [address, target.signature, target.slot],
      );
    }
    return applied;
  }

  /** Still worth holding a cursor for: missing, but not yet for `giveUpMs`. */
  private blocksCursor(sig: string): boolean {
    const first = this.missing.get(sig);
    if (first === undefined) return false;
    if (Date.now() - first < (this.opts.giveUpMs ?? 10 * 60_000)) return true;
    this.missing.delete(sig);
    this.stats.gaveUp++;
    this.log.error({ signature: sig }, "signature listed but never fetchable; advancing past it (dropped fork?) — reconcile will re-check");
    return false;
  }

  /** Retry queue: re-fetch signatures that were listed but not fetchable. */
  private async retryMissing(): Promise<number> {
    if (!this.missing.size) return 0;
    const sigs = [...this.missing.keys()].slice(0, 200).map((signature) => ({ signature, slot: 0 }) as ConfirmedSignatureInfo);
    this.stats.retried += sigs.length;
    return (await this.applySignatures(sigs, "rpc")).applied;
  }

  /**
   * Fetch + ingest signatures not yet in `transactions`, in the given order. Signatures that
   * couldn't be fetched are returned (and queued for retry).
   */
  async applySignatures(sigs: ConfirmedSignatureInfo[], source: Source): Promise<{ applied: number; missing: string[] }> {
    const known = new Set(
      (await this.db.query<{ signature: string }>("SELECT signature FROM transactions WHERE signature = ANY($1)", [sigs.map((s) => s.signature)])).rows.map((r) => r.signature),
    );
    for (const k of known) this.missing.delete(k);
    const todo = sigs.filter((s) => !known.has(s.signature));
    const conc = this.opts.concurrency ?? 4;
    let applied = 0;
    const missing: string[] = [];
    // Fetch in parallel windows but ingest strictly in order.
    for (let i = 0; i < todo.length; i += conc) {
      const win = todo.slice(i, i + conc);
      const txs = await Promise.all(win.map((s) => this.fetchTx(s.signature)));
      for (let j = 0; j < win.length; j++) {
        const tx = txs[j];
        const sig = win[j].signature;
        if (!tx) {
          if (!this.missing.has(sig)) this.missing.set(sig, Date.now());
          missing.push(sig);
          this.stats.missing++;
          this.log.warn({ signature: sig }, "transaction not found (yet); cursor held, will retry");
          continue;
        }
        this.missing.delete(sig);
        const r = await this.ingestor.ingest(tx, source, this.opts.commitment);
        if (r.status === "applied") applied++;
      }
    }
    this.stats.fetched += todo.length;
    return { applied, missing };
  }

  /**
   * Webhook hints (H-1). The push body only tells us WHICH signatures to look at; each is
   * fetched from our own RPC and ingested only if it touches a watched program/pool.
   */
  hint(signatures: string[]) {
    for (const s of signatures) {
      if (this.hints.size >= (this.opts.maxHints ?? 5_000)) {
        const oldest = this.hints.values().next().value;
        if (oldest !== undefined) this.hints.delete(oldest);
      }
      this.hints.add(s);
    }
    this.stats.hints += signatures.length;
    void this.drainHints();
  }

  /** Process queued hints; resolves when the queue is empty (tests await it). */
  drainHints(): Promise<void> {
    this.draining ??= this.drain().finally(() => (this.draining = undefined));
    return this.draining;
  }

  private async drain(): Promise<void> {
    try {
      while (this.hints.size) {
        const batch = [...this.hints].slice(0, 20);
        for (const s of batch) this.hints.delete(s);
        const known = new Set((await this.db.query<{ signature: string }>("SELECT signature FROM transactions WHERE signature = ANY($1)", [batch])).rows.map((r) => r.signature));
        const txs = await Promise.all(batch.filter((s) => !known.has(s)).map(async (s) => [s, await this.fetchTx(s, 2)] as const));
        for (const [sig, tx] of txs) {
          if (!tx) continue; // not visible to our RPC yet: the poller will get it
          if (tx.transaction.signatures[0] !== sig || !this.isWatched(tx)) {
            this.stats.hintsIgnored++;
            continue;
          }
          try {
            const r = await this.ingestor.ingest(tx, "webhook", this.opts.commitment);
            if (r.status === "applied") this.stats.hintsIngested++;
          } catch (e) {
            this.log.warn({ err: String(e), signature: sig }, "webhook hint ingest failed (poller will catch up)");
          }
        }
      }
    } catch (e) {
      this.log.warn({ err: String(e) }, "webhook hints failed (poller will catch up)");
    }
  }

  private isWatched(tx: TxLike): boolean {
    const keys = new Set(accountKeys(tx));
    if (keys.has(FUMPAD_PROGRAM_ID.toBase58()) || keys.has(LP_LOCKER_PROGRAM_ID.toBase58())) return true;
    for (const pool of this.ingestor.watchedPools().keys()) if (keys.has(pool)) return true;
    return false;
  }

  async fetchTx(signature: string, attempts = this.opts.fetchAttempts ?? 4): Promise<TxLike | null> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const tx = await this.conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: this.opts.commitment });
        if (tx) return tx as unknown as TxLike;
      } catch (e) {
        this.log.debug({ signature, err: String(e) }, "getTransaction failed");
      }
      if (attempt + 1 < attempts) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
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
      const n = (await this.applySignatures(sigs, "reconcile")).applied;
      if (n) this.log.warn({ address, filled: n }, "reconcile filled a gap");
      filled += n;
    }
    this.stats.gapsFilled += filled;
    return filled;
  }
}
