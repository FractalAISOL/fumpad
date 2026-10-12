/**
 * D18 vanity mint pool (table `vanity_mints`, filled by services/grinder).
 *
 * Lifecycle: available → reserved (POST /v1/launch/prepare, one per creator wallet) →
 * used (indexer sees CoinCreated, or the sweeper finds the mint on chain). A reservation
 * whose transaction never landed goes back to `available` once it is older than the TTL
 * AND the chain is past the `lastValidBlockHeight` of every transaction we co-signed for
 * it (so no signed launch for that mint can still land) AND the mint account doesn't exist.
 *
 * M-2: `prepare` never holds a DB transaction across RPC calls. It runs in three steps:
 *   1. (no tx) chain checks for the wallet's existing reservation, with a timeout;
 *   2. (short tx) reserve: per-creator advisory lock, reuse or pick a row
 *      `FOR UPDATE SKIP LOCKED`, per-IP cap, pool reserve; commit;
 *   3. (no tx) build the launch transaction (RPC, with a timeout);
 *   4. (short tx) re-lock the row, check it is still ours, sign as the mint, record the
 *      blockhash height. A fresh reservation that fails in 3/4 before anything was signed
 *      is returned to the pool immediately (nothing signed can land).
 * The last `reserve` available mints only go to wallets the indexer already knows (FUMPAD
 * history), so throwaway wallets can't empty the pool.
 */
import type { VersionedTransaction } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

import { type Db, withTx } from "@fumpad/indexer";

import type { MintSigner, MintVault } from "./vault.js";

export class LaunchError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly retryAfterSecs?: number,
  ) {
    super(message);
  }
}

export interface PoolConfig {
  suffix: string;
  reservationMs: number;
  maxActivePerIp: number;
  /** Available mints kept for established wallets (default 0). */
  reserve?: number;
  /** Timeout for each chain call made by prepare (default 5 s). */
  rpcTimeoutMs?: number;
}

export interface ChainProbe {
  /** Which of these mint accounts exist on chain. */
  existing(mints: PublicKey[]): Promise<boolean[]>;
  blockHeight(): Promise<number>;
}

export interface Prepared {
  mint: string;
  tx: VersionedTransaction;
  lastValidBlockHeight: number;
  reusedReservation: boolean;
  expiresAt: number;
}

interface Row {
  pubkey: string;
  secret_enc: Buffer;
  enc_version: number;
}

/** Reject after `ms` (the underlying call keeps running; its result is ignored). */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      t = setTimeout(() => rej(new LaunchError(503, `${what} timed out, try again`, 5)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

export class MintPool {
  constructor(
    private db: Db,
    private vault: MintVault,
    private chain: ChainProbe,
    readonly cfg: PoolConfig,
  ) {}

  private get timeout() {
    return this.cfg.rpcTimeoutMs ?? 5_000;
  }

  /**
   * Reserve a mint for `creator` (or reuse the one it already holds), let `build` make the
   * launch transaction for it, sign it as the mint, and record the reservation.
   * `established`: the wallet has FUMPAD history (may use the reserve).
   */
  async prepare(
    creator: string,
    ip: string,
    build: (mint: PublicKey) => Promise<{ tx: VersionedTransaction; lastValidBlockHeight: number }>,
    opts: { established?: boolean } = {},
  ): Promise<Prepared> {
    // 1. Existing reservation already landed on chain? (RPC outside any transaction.)
    const held = (
      await this.db.query<{ pubkey: string }>(
        `SELECT pubkey FROM vanity_mints WHERE status = 'reserved' AND reserved_by = $1 AND suffix = $2 AND key_fp = $3 ORDER BY reserved_at DESC LIMIT 1`,
        [creator, this.cfg.suffix, this.vault.fingerprint],
      )
    ).rows[0];
    if (held && (await withTimeout(this.chain.existing([new PublicKey(held.pubkey)]), this.timeout, "chain lookup"))[0]) {
      // That launch already landed (indexer not caught up yet): it's spent.
      await this.db.query(`UPDATE vanity_mints SET status = 'used', used_at = now(), secret_enc = NULL WHERE pubkey = $1 AND status = 'reserved'`, [held.pubkey]);
    }

    // 2. Reserve (short transaction, no network).
    const { pubkey, reused } = await withTx(this.db, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`vanity:${creator}`]);
      const mine = (
        await c.query<{ pubkey: string }>(
          `SELECT pubkey FROM vanity_mints WHERE status = 'reserved' AND reserved_by = $1 AND suffix = $2 AND key_fp = $3 ORDER BY reserved_at DESC LIMIT 1 FOR UPDATE`,
          [creator, this.cfg.suffix, this.vault.fingerprint],
        )
      ).rows[0];
      if (mine) {
        await c.query(`UPDATE vanity_mints SET reserved_ip = $2 WHERE pubkey = $1`, [mine.pubkey, ip]);
        return { pubkey: mine.pubkey, reused: true };
      }
      const active = await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM vanity_mints WHERE status = 'reserved' AND reserved_ip = $1 AND reserved_at > now() - make_interval(secs => $2)`,
        [ip, this.cfg.reservationMs / 1000],
      );
      if (Number(active.rows[0].n) >= this.cfg.maxActivePerIp) throw new LaunchError(429, "too many pending launches from this address; finish or wait for one to expire", 60);
      const reserve = this.cfg.reserve ?? 0;
      if (reserve > 0 && !opts.established) {
        const avail = await c.query<{ n: string }>(
          `SELECT count(*) AS n FROM (SELECT 1 FROM vanity_mints WHERE status = 'available' AND suffix = $1 AND key_fp = $2 LIMIT $3) x`,
          [this.cfg.suffix, this.vault.fingerprint, reserve + 1],
        );
        if (Number(avail.rows[0].n) <= reserve) throw new LaunchError(503, "no launch addresses ready right now, try again in a minute", 30);
      }
      const row = (
        await c.query<{ pubkey: string }>(
          `SELECT pubkey FROM vanity_mints WHERE status = 'available' AND suffix = $1 AND key_fp = $2 ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
          [this.cfg.suffix, this.vault.fingerprint],
        )
      ).rows[0];
      if (!row) throw new LaunchError(503, "no launch addresses ready right now, try again in a minute", 30);
      await c.query(
        `UPDATE vanity_mints SET status = 'reserved', reserved_at = now(), reserved_by = $2, reserved_ip = $3, last_valid_block_height = NULL, reserve_count = reserve_count + 1 WHERE pubkey = $1`,
        [row.pubkey, creator, ip],
      );
      return { pubkey: row.pubkey, reused: false };
    });

    try {
      // 3. Build (RPC, no transaction held).
      const { tx, lastValidBlockHeight } = await withTimeout(build(new PublicKey(pubkey)), this.timeout * 2, "building the launch");
      // 4. Sign + record (short transaction).
      return await withTx(this.db, async (c) => {
        const row = (
          await c.query<Row>(`SELECT pubkey, secret_enc, enc_version FROM vanity_mints WHERE pubkey = $1 AND status = 'reserved' AND reserved_by = $2 AND key_fp = $3 FOR UPDATE`, [
            pubkey,
            creator,
            this.vault.fingerprint,
          ])
        ).rows[0];
        if (!row?.secret_enc) throw new LaunchError(409, "reservation changed, prepare again", 1);
        const signer: MintSigner = this.vault.signer(row.pubkey, row.secret_enc, row.enc_version);
        const idx = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).findIndex((k) => k.equals(signer.publicKey));
        if (idx < 0) throw new Error("launch tx does not require the mint signature");
        tx.addSignature(signer.publicKey, signer.sign(tx.message.serialize()));
        const upd = await c.query<{ reserved_at: Date }>(
          `UPDATE vanity_mints SET reserved_at = now(), last_valid_block_height = GREATEST(COALESCE(last_valid_block_height, 0), $2) WHERE pubkey = $1 RETURNING reserved_at`,
          [row.pubkey, lastValidBlockHeight],
        );
        const expiresAt = upd.rows[0].reserved_at.getTime() + this.cfg.reservationMs;
        return { mint: row.pubkey, tx, lastValidBlockHeight, reusedReservation: reused, expiresAt };
      });
    } catch (e) {
      // Nothing was signed for a fresh reservation: hand the mint straight back.
      if (!reused)
        await this.db
          .query(
            `UPDATE vanity_mints SET status = 'available', reserved_at = NULL, reserved_by = NULL, reserved_ip = NULL
              WHERE pubkey = $1 AND status = 'reserved' AND reserved_by = $2 AND last_valid_block_height IS NULL`,
            [pubkey, creator],
          )
          .catch(() => {});
      throw e;
    }
  }

  /** Return expired reservations to the pool (or mark them used if the mint exists). */
  async sweep(): Promise<{ released: number; used: number }> {
    // Pick candidates and query the chain WITHOUT holding row locks across the RPC calls.
    const rows = (
      await this.db.query<{ pubkey: string; lvbh: string | null }>(
        `SELECT pubkey, last_valid_block_height AS lvbh FROM vanity_mints
          WHERE status = 'reserved' AND reserved_at < now() - make_interval(secs => $1)
          ORDER BY reserved_at LIMIT 100`,
        [this.cfg.reservationMs / 1000],
      )
    ).rows;
    if (!rows.length) return { released: 0, used: 0 };
    const [exists, height] = await Promise.all([
      withTimeout(this.chain.existing(rows.map((r) => new PublicKey(r.pubkey))), this.timeout, "chain lookup"),
      withTimeout(this.chain.blockHeight(), this.timeout, "block height"),
    ]);
    let released = 0;
    let used = 0;
    for (const [i, r] of rows.entries()) {
      if (exists[i]) {
        const u = await this.db.query(`UPDATE vanity_mints SET status = 'used', used_at = now(), secret_enc = NULL WHERE pubkey = $1 AND status = 'reserved'`, [r.pubkey]);
        used += u.rowCount ?? 0;
      } else if (r.lvbh === null || height > Number(r.lvbh)) {
        // Re-check in the UPDATE: a prepare that signed meanwhile raised last_valid_block_height.
        const u = await this.db.query(
          `UPDATE vanity_mints SET status = 'available', reserved_at = NULL, reserved_by = NULL, reserved_ip = NULL, last_valid_block_height = NULL
            WHERE pubkey = $1 AND status = 'reserved' AND reserved_at < now() - make_interval(secs => $2)
              AND (last_valid_block_height IS NULL OR last_valid_block_height < $3)`,
          [r.pubkey, this.cfg.reservationMs / 1000, height],
        );
        released += u.rowCount ?? 0;
      }
    }
    return { released, used };
  }

  async stats(): Promise<{ available: number; reserved: number; used: number }> {
    const r = await this.db.query<{ status: string; n: string }>(
      `SELECT status, count(*) AS n FROM vanity_mints WHERE suffix = $1 AND (key_fp = $2 OR status = 'used') GROUP BY status`,
      [this.cfg.suffix, this.vault.fingerprint],
    );
    const out = { available: 0, reserved: 0, used: 0 };
    for (const x of r.rows) out[x.status as keyof typeof out] = Number(x.n);
    return out;
  }
}
