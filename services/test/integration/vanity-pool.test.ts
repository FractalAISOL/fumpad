/**
 * External audit 2026-10-17, M-3 / S-5: the vanity mint pool can't be held indefinitely (real Postgres, fake chain).
 *  - re-preparing reuses the wallet's mint but never moves `reserved_at` (hard expiry); after the TTL the wallet
 *    gets a fresh mint, counted against its hourly cap;
 *  - fresh reservations per wallet / per IP per hour (an IPv6 /64 counts as one IP);
 *  - the sweeper releases a reservation whose creator's balance fell below the minimum, once its signed
 *    transactions expired (the 0.01 SOL check is bound to the reservation, not reusable across wallets).
 */
import { createCipheriv, randomBytes } from "node:crypto";

import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPool, type Db, migrate } from "@fumpad/indexer";
import { type ChainProbe, LaunchError, MintPool, MintVault } from "@fumpad/api";

import { type Postgres, startPostgres } from "../../scripts/local/harness.js";

const KEY_HEX = "22".repeat(32);
const vault = new MintVault(KEY_HEX);
const SUFFIX = "x"; // any suffix: the pool only filters on the column

function encryptSeed(pubkey: string, seed: Uint8Array): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", Buffer.from(KEY_HEX, "hex"), nonce);
  c.setAAD(Buffer.concat([Buffer.from("fumpad-vanity-mint:v1:"), Buffer.from(pubkey)]));
  return Buffer.concat([nonce, c.update(seed), c.final(), c.getAuthTag()]);
}

let pg: Postgres;
let db: Db;
const chain = { exists: new Set<string>(), height: 1_000, balances: new Map<string, bigint>() };
const probe: ChainProbe = {
  existing: async (ms) => ms.map((m) => chain.exists.has(m.toBase58())),
  blockHeight: async () => chain.height,
  balances: async (ws) => ws.map((w) => chain.balances.get(w.toBase58()) ?? 0n),
};

/** A launch-like tx that needs the mint's signature (payer = creator). */
const build = (creator: PublicKey) => async (mint: PublicKey) => {
  const msg = new TransactionMessage({
    payerKey: creator,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [{ programId: PublicKey.default, keys: [{ pubkey: mint, isSigner: true, isWritable: true }], data: Buffer.alloc(0) }],
  }).compileToV0Message();
  return { tx: new VersionedTransaction(msg), lastValidBlockHeight: chain.height + 150 };
};

async function fill(n: number) {
  for (let i = 0; i < n; i++) {
    const kp = Keypair.generate();
    const pk = kp.publicKey.toBase58();
    await db.query(`INSERT INTO vanity_mints (pubkey, suffix, secret_enc, key_fp) VALUES ($1, $2, $3, $4)`, [pk, SUFFIX, encryptSeed(pk, kp.secretKey.subarray(0, 32)), vault.fingerprint]);
  }
}

const mkPool = (o: Partial<ConstructorParameters<typeof MintPool>[3]> = {}) =>
  new MintPool(db, vault, probe, { suffix: SUFFIX, reservationMs: 600_000, maxActivePerIp: 100, reserve: 0, walletReservationsPerHour: 2, ipReservationsPerHour: 100, minBalanceLamports: 10_000_000n, ...o });

const reservedAt = async (mint: string) => (await db.query<{ t: Date }>(`SELECT reserved_at AS t FROM vanity_mints WHERE pubkey = $1`, [mint])).rows[0].t.getTime();

beforeAll(async () => {
  pg = await startPostgres(54334);
  db = createPool(pg.url);
  await migrate(db);
}, 120_000);

afterAll(async () => {
  await db?.end();
  await pg?.stop();
});

beforeEach(async () => {
  await db.query("DELETE FROM vanity_mints");
  chain.exists.clear();
  chain.balances.clear();
  chain.height = 1_000;
  await fill(10);
});

describe("M-3 vanity pool holding", () => {
  it("re-prepare reuses the mint without refreshing reserved_at; after the TTL the wallet gets a fresh mint, capped per hour", async () => {
    const pool = mkPool();
    const w = Keypair.generate().publicKey;
    const a = await pool.prepare(w.toBase58(), "203.0.113.1", build(w));
    const t0 = await reservedAt(a.mint);
    await new Promise((r) => setTimeout(r, 20));
    const b = await pool.prepare(w.toBase58(), "203.0.113.1", build(w));
    expect(b.mint).toBe(a.mint);
    expect(b.reusedReservation).toBe(true);
    expect(await reservedAt(a.mint)).toBe(t0); // hard expiry: not refreshed
    expect(b.expiresAt).toBe(a.expiresAt);

    // Past the TTL: no reuse (the old mint is left for the sweeper), a fresh one instead.
    await db.query(`UPDATE vanity_mints SET reserved_at = now() - interval '11 minutes' WHERE pubkey = $1`, [a.mint]);
    const c = await pool.prepare(w.toBase58(), "203.0.113.1", build(w));
    expect(c.mint).not.toBe(a.mint);
    expect(c.reusedReservation).toBe(false);
    // Third fresh reservation within the hour: over walletReservationsPerHour (2).
    await db.query(`UPDATE vanity_mints SET reserved_at = now() - interval '11 minutes' WHERE pubkey = $1`, [c.mint]);
    await expect(pool.prepare(w.toBase58(), "203.0.113.1", build(w))).rejects.toMatchObject({ statusCode: 429, message: expect.stringMatching(/this wallet in the last hour/) });
    // The expired one is released once its signed tx can no longer land (and the mint never appeared).
    chain.height += 1_000;
    chain.balances.set(w.toBase58(), 1_000_000_000n);
    const swept = await pool.sweep();
    expect(swept.released).toBe(2);
  });

  it("per-IP hourly cap: rotating IPv6 addresses inside one /64 counts as one IP", async () => {
    const pool = mkPool({ ipReservationsPerHour: 2, walletReservationsPerHour: 100 });
    const take = (ip: string) => {
      const w = Keypair.generate().publicKey;
      return pool.prepare(w.toBase58(), ip, build(w));
    };
    await take("2001:db8:1:2::1");
    await take("2001:db8:1:2:ffff::42");
    await expect(take("2001:0db8:0001:0002:1234:5678:9abc:def0")).rejects.toBeInstanceOf(LaunchError);
    // Another /64 is another bucket.
    await expect(take("2001:db8:1:3::1")).resolves.toMatchObject({ reusedReservation: false });
  });

  it("the sweeper releases an unexpired reservation whose creator moved its SOL away (after its tx expired), keeps a funded one", async () => {
    const pool = mkPool({ walletReservationsPerHour: 100 });
    const rich = Keypair.generate().publicKey;
    const poor = Keypair.generate().publicKey;
    chain.balances.set(rich.toBase58(), 50_000_000n);
    chain.balances.set(poor.toBase58(), 50_000_000n);
    const r1 = await pool.prepare(rich.toBase58(), "198.51.100.1", build(rich));
    const r2 = await pool.prepare(poor.toBase58(), "198.51.100.2", build(poor));
    chain.balances.set(poor.toBase58(), 1_000n); // the 0.01 SOL moved on to the next wallet
    // Its signed launch can still land: nothing is released yet.
    expect(await pool.sweep()).toMatchObject({ released: 0, unfunded: 0 });
    chain.height += 1_000;
    expect(await pool.sweep()).toMatchObject({ released: 1, unfunded: 1 });
    const st = (await db.query<{ pubkey: string; status: string }>(`SELECT pubkey, status FROM vanity_mints WHERE pubkey = ANY($1)`, [[r1.mint, r2.mint]])).rows;
    expect(Object.fromEntries(st.map((x) => [x.pubkey, x.status]))).toEqual({ [r1.mint]: "reserved", [r2.mint]: "available" });
  });
});
