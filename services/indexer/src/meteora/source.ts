/**
 * Meteora signature source: same rules as sources/rpc.ts (RpcSource), on its own cursor table:
 *  - per-address cursors (`meteora_cursors`: DBC config keys, FUMPAD mints, discovered DAMM v2 pools);
 *  - new signatures listed newest→oldest (`until` = cursor, paging via `before`), applied OLDEST FIRST;
 *  - the cursor never moves past a listed signature whose transaction couldn't be fetched (M-5,
 *    `cursorTarget`); missing ones sit in a retry queue and stop blocking after `giveUpMs`;
 *  - `reconcile()` re-scans the newest N signatures per address (gap detection);
 *  - webhook hints (H-1): only signatures are taken from a push body; each is re-fetched from OUR RPC
 *    and ingested only if the real transaction touches a watched address.
 * Transactions are fetched with `maxSupportedTransactionVersion: 1` through MeteoraRpc (web3.js v1
 * can't decode version-1 transactions, which apps like Axiom already send).
 */
import type { ConfirmedSignatureInfo } from "@solana/web3.js";

import type { ConfirmedTx, MeteoraRpc, SignatureInfo } from "@fumpad/meteora";
import { normalizeTx } from "@fumpad/meteora";

import type { Db } from "../db.js";
import type { Logger } from "../log.js";
import { cursorTarget } from "../sources/rpc.js";
import type { Commit } from "../ingest.js";
import type { MeteoraIngestor, MeteoraSource as SourceKind } from "./ingest.js";

export interface MeteoraSourceOpts {
  commitment: Commit;
  pageSize: number;
  backfillFromSlot: number;
  reconcileDepth: number;
  dbcConfigs: string[];
  mints: string[];
  concurrency?: number;
  giveUpMs?: number;
  maxHints?: number;
  fetchAttempts?: number;
}

type Sig = Pick<SignatureInfo, "signature" | "slot">;

export class MeteoraSignatureSource {
  private running = false;
  private pending = false;
  private missing = new Map<string, number>();
  private hints = new Set<string>();
  private draining?: Promise<void>;
  stats = { polls: 0, fetched: 0, gapsFilled: 0, errors: 0, lastPollAt: 0, missing: 0, gaveUp: 0, hints: 0, hintsIngested: 0, hintsIgnored: 0 };

  constructor(private rpc: MeteoraRpc, private db: Db, private ingestor: MeteoraIngestor, private opts: MeteoraSourceOpts, private log: Logger) {}

  async ensureCursors() {
    for (const a of this.opts.dbcConfigs) await this.db.query("INSERT INTO meteora_cursors (address, kind) VALUES ($1, 'dbc_config') ON CONFLICT DO NOTHING", [a]);
    for (const a of this.opts.mints) await this.db.query("INSERT INTO meteora_cursors (address, kind) VALUES ($1, 'mint') ON CONFLICT DO NOTHING", [a]);
  }

  get missingSignatures(): string[] {
    return [...this.missing.keys()];
  }

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
      n += await this.retryMissing();
      // pools first registered by this poll get their cursor on the next one
      const cursors = await this.db.query<{ address: string; last_signature: string | null; backfill_done: boolean }>(
        "SELECT address, last_signature, backfill_done FROM meteora_cursors ORDER BY kind, address",
      );
      for (const cur of cursors.rows) n += await this.pollAddress(cur.address, cur.last_signature, cur.backfill_done ? "rpc" : "backfill");
      this.stats.polls++;
      this.stats.lastPollAt = Date.now();
    } catch (e) {
      this.stats.errors++;
      this.log.warn({ err: String(e) }, "meteora poll failed");
    } finally {
      this.running = false;
      if (this.pending) {
        this.pending = false;
        setTimeout(() => this.poke(), 0);
      }
    }
    return n;
  }

  private async signaturesSince(address: string, until: string | null): Promise<Sig[]> {
    const out: Sig[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.rpc.getSignaturesForAddress(address, { until: until ?? undefined, before, limit: this.opts.pageSize, commitment: this.opts.commitment });
      for (const s of page) {
        if (!until && s.slot < this.opts.backfillFromSlot) return out;
        out.push({ signature: s.signature, slot: s.slot });
      }
      if (page.length < this.opts.pageSize) return out;
      before = page[page.length - 1].signature;
    }
  }

  private async pollAddress(address: string, until: string | null, source: SourceKind): Promise<number> {
    const sigs = await this.signaturesSince(address, until);
    if (!sigs.length) {
      if (source === "backfill") await this.db.query("UPDATE meteora_cursors SET backfill_done = true WHERE address = $1", [address]);
      return 0;
    }
    sigs.reverse();
    const { applied, missing } = await this.applySignatures(sigs, source);
    const target = cursorTarget(sigs as unknown as ConfirmedSignatureInfo[], missing, (s) => this.blocksCursor(s));
    if (target) {
      await this.db.query("UPDATE meteora_cursors SET last_signature = $2, last_slot = $3, backfill_done = true, updated_at = now() WHERE address = $1", [
        address,
        target.signature,
        target.slot,
      ]);
    }
    return applied;
  }

  private blocksCursor(sig: string): boolean {
    const first = this.missing.get(sig);
    if (first === undefined) return false;
    if (Date.now() - first < (this.opts.giveUpMs ?? 10 * 60_000)) return true;
    this.missing.delete(sig);
    this.stats.gaveUp++;
    this.log.error({ signature: sig }, "meteora: signature listed but never fetchable; advancing past it (dropped fork?) — reconcile will re-check");
    return false;
  }

  private async retryMissing(): Promise<number> {
    if (!this.missing.size) return 0;
    const sigs = [...this.missing.keys()].slice(0, 200).map((signature) => ({ signature, slot: 0 }));
    return (await this.applySignatures(sigs, "rpc")).applied;
  }

  async applySignatures(sigs: Sig[], source: SourceKind): Promise<{ applied: number; missing: string[] }> {
    const known = new Set(
      (await this.db.query<{ signature: string }>("SELECT signature FROM meteora_transactions WHERE signature = ANY($1)", [sigs.map((s) => s.signature)])).rows.map((r) => r.signature),
    );
    for (const k of known) this.missing.delete(k);
    const todo = sigs.filter((s) => !known.has(s.signature));
    const conc = this.opts.concurrency ?? 4;
    let applied = 0;
    const missing: string[] = [];
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

  drainHints(): Promise<void> {
    this.draining ??= this.drain().finally(() => (this.draining = undefined));
    return this.draining;
  }

  private async drain(): Promise<void> {
    try {
      while (this.hints.size) {
        const batch = [...this.hints].slice(0, 20);
        for (const s of batch) this.hints.delete(s);
        const known = new Set((await this.db.query<{ signature: string }>("SELECT signature FROM meteora_transactions WHERE signature = ANY($1)", [batch])).rows.map((r) => r.signature));
        const txs = await Promise.all(batch.filter((s) => !known.has(s)).map(async (s) => [s, await this.fetchTx(s, 2)] as const));
        for (const [sig, tx] of txs) {
          if (!tx) continue;
          if (tx.transaction.signatures[0] !== sig || !(await this.isWatched(tx))) {
            this.stats.hintsIgnored++;
            continue;
          }
          try {
            const r = await this.ingestor.ingest(tx, "webhook", this.opts.commitment);
            if (r.status === "applied") this.stats.hintsIngested++;
          } catch (e) {
            this.log.warn({ err: String(e), signature: sig }, "meteora webhook hint ingest failed (poller will catch up)");
          }
        }
      }
    } catch (e) {
      this.log.warn({ err: String(e) }, "meteora webhook hints failed (poller will catch up)");
    }
  }

  /** The tx (as fetched from our RPC) references a cursor address or a registered pool. */
  async isWatched(tx: ConfirmedTx): Promise<boolean> {
    let keys: Set<string>;
    try {
      keys = new Set(normalizeTx(tx).accountKeys);
    } catch {
      return false;
    }
    for (const a of [...this.opts.dbcConfigs, ...this.opts.mints]) if (keys.has(a)) return true;
    await this.ingestor.refreshPools();
    for (const p of this.ingestor.watchedPools().keys()) if (keys.has(p)) return true;
    return false;
  }

  async fetchTx(signature: string, attempts = this.opts.fetchAttempts ?? 4): Promise<ConfirmedTx | null> {
    for (let a = 0; a < attempts; a++) {
      try {
        const tx = await this.rpc.getTransaction(signature, this.opts.commitment);
        if (tx) return tx;
      } catch (e) {
        this.log.debug({ signature, err: String(e) }, "meteora getTransaction failed");
      }
      if (a + 1 < attempts) await new Promise((r) => setTimeout(r, 300 * (a + 1)));
    }
    return null;
  }

  async reconcile(): Promise<number> {
    if (this.running || this.stats.polls === 0) return 0;
    this.running = true;
    try {
      let filled = 0;
      const cursors = await this.db.query<{ address: string }>("SELECT address FROM meteora_cursors");
      for (const { address } of cursors.rows) {
        const sigs = (await this.rpc.getSignaturesForAddress(address, { limit: this.opts.reconcileDepth, commitment: this.opts.commitment })).map((s) => ({ signature: s.signature, slot: s.slot }));
        sigs.reverse();
        const n = (await this.applySignatures(sigs, "reconcile")).applied;
        if (n) this.log.warn({ address, filled: n }, "meteora reconcile filled a gap");
        filled += n;
      }
      this.stats.gapsFilled += filled;
      return filled;
    } finally {
      this.running = false;
    }
  }
}
