/**
 * D18 vanity mint pool (table `vanity_mints`, filled by services/grinder).
 *
 * Lifecycle: available → reserved (POST /v1/launch/prepare, one per creator wallet) →
 * used (indexer sees CoinCreated, or the sweeper finds the mint on chain). A reservation
 * whose transaction never landed goes back to `available` once it is older than the TTL
 * AND the chain is past the `lastValidBlockHeight` of every transaction we co-signed for
 * it (so no signed launch for that mint can still land) AND the mint account doesn't exist.
 *
 * Concurrency: reservation is one UPDATE on a row picked `FOR UPDATE SKIP LOCKED`, inside a
 * transaction that first takes a per-creator advisory lock, so two concurrent prepares can
 * never get the same mint and one wallet never holds two.
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

export class MintPool {
  constructor(
    private db: Db,
    private vault: MintVault,
    private chain: ChainProbe,
    readonly cfg: PoolConfig,
  ) {}

  /**
   * Reserve a mint for `creator` (or reuse the one it already holds), let `build` make the
   * launch transaction for it, sign it as the mint, and record the reservation. Everything
   * rolls back (mint stays available) if building or signing fails.
   */
  async prepare(creator: string, ip: string, build: (mint: PublicKey) => Promise<{ tx: VersionedTransaction; lastValidBlockHeight: number }>): Promise<Prepared> {
    return withTx(this.db, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`vanity:${creator}`]);
      const sel = `SELECT pubkey, secret_enc, enc_version FROM vanity_mints`;
      let row: Row | undefined = (
        await c.query<Row>(`${sel} WHERE status = 'reserved' AND reserved_by = $1 AND suffix = $2 AND key_fp = $3 ORDER BY reserved_at DESC LIMIT 1 FOR UPDATE`, [
          creator,
          this.cfg.suffix,
          this.vault.fingerprint,
        ])
      ).rows[0];
      let reused = !!row;
      if (row && (await this.chain.existing([new PublicKey(row.pubkey)]))[0]) {
        // That launch already landed (indexer not caught up yet): it's spent.
        await c.query(`UPDATE vanity_mints SET status = 'used', used_at = now(), secret_enc = NULL WHERE pubkey = $1`, [row.pubkey]);
        row = undefined;
        reused = false;
      }
      if (!row) {
        const active = await c.query<{ n: string }>(
          `SELECT count(*) AS n FROM vanity_mints WHERE status = 'reserved' AND reserved_ip = $1 AND reserved_at > now() - make_interval(secs => $2)`,
          [ip, this.cfg.reservationMs / 1000],
        );
        if (Number(active.rows[0].n) >= this.cfg.maxActivePerIp) throw new LaunchError(429, "too many pending launches from this address; finish or wait for one to expire", 60);
        row = (
          await c.query<Row>(
            `${sel} WHERE status = 'available' AND suffix = $1 AND key_fp = $2 ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
            [this.cfg.suffix, this.vault.fingerprint],
          )
        ).rows[0];
        if (!row) throw new LaunchError(503, "no launch addresses ready right now, try again in a minute", 30);
      }
      const signer: MintSigner = this.vault.signer(row.pubkey, row.secret_enc, row.enc_version);
      const { tx, lastValidBlockHeight } = await build(signer.publicKey);
      const idx = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).findIndex((k) => k.equals(signer.publicKey));
      if (idx < 0) throw new Error("launch tx does not require the mint signature");
      tx.addSignature(signer.publicKey, signer.sign(tx.message.serialize()));
      const upd = await c.query<{ reserved_at: Date }>(
        `UPDATE vanity_mints
            SET status = 'reserved', reserved_at = now(), reserved_by = $2, reserved_ip = $3,
                last_valid_block_height = GREATEST(COALESCE(last_valid_block_height, 0), $4), reserve_count = reserve_count + 1
          WHERE pubkey = $1 RETURNING reserved_at`,
        [row.pubkey, creator, ip, lastValidBlockHeight],
      );
      const expiresAt = upd.rows[0].reserved_at.getTime() + this.cfg.reservationMs;
      return { mint: row.pubkey, tx, lastValidBlockHeight, reusedReservation: reused, expiresAt };
    });
  }

  /** Return expired reservations to the pool (or mark them used if the mint exists). */
  async sweep(): Promise<{ released: number; used: number }> {
    return withTx(this.db, async (c) => {
      const rows = (
        await c.query<{ pubkey: string; lvbh: string | null }>(
          `SELECT pubkey, last_valid_block_height AS lvbh FROM vanity_mints
            WHERE status = 'reserved' AND reserved_at < now() - make_interval(secs => $1)
            ORDER BY reserved_at LIMIT 100 FOR UPDATE SKIP LOCKED`,
          [this.cfg.reservationMs / 1000],
        )
      ).rows;
      if (!rows.length) return { released: 0, used: 0 };
      const [exists, height] = await Promise.all([this.chain.existing(rows.map((r) => new PublicKey(r.pubkey))), this.chain.blockHeight()]);
      let released = 0;
      let used = 0;
      for (const [i, r] of rows.entries()) {
        if (exists[i]) {
          await c.query(`UPDATE vanity_mints SET status = 'used', used_at = now(), secret_enc = NULL WHERE pubkey = $1`, [r.pubkey]);
          used++;
        } else if (r.lvbh === null || height > Number(r.lvbh)) {
          await c.query(
            `UPDATE vanity_mints SET status = 'available', reserved_at = NULL, reserved_by = NULL, reserved_ip = NULL, last_valid_block_height = NULL WHERE pubkey = $1`,
            [r.pubkey],
          );
          released++;
        }
      }
      return { released, used };
    });
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
