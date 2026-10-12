/**
 * D18 vanity mint pool without a validator: the real Rust grinder (`--once`, easy suffix
 * for speed) fills Postgres; the API (in-process, fake RPC) reserves + co-signs. Checks:
 * every prepared tx is a FUMPAD launch paid by the creator and signed ONLY by the mint
 * (valid signature), concurrent prepares never share a mint, one wallet keeps one mint,
 * reservations expire back to the pool (only once the blockhash is dead and the mint
 * isn't on chain), rows under another key are never handed out, per-IP caps, and no
 * mint secret ever appears in a response or a log line (API or grinder).
 * The real-chain `…fmbL` launch is in the local e2e (scripts/local/e2e.ts).
 */
import { createDecipheriv, randomBytes, verify } from "node:crypto";
import { Writable } from "node:stream";

import { type Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, type Db, migrate } from "@fumpad/indexer";
import { buildServer, keyFingerprint, loadApiConfig, type MintPool, parsePoolKey } from "@fumpad/api";
import { FUMPAD_PROGRAM_ID, inspectLaunchTx } from "@fumpad/sdk";

import { buildGrinder, type Postgres, runBinary, startPostgres } from "../../scripts/local/harness.js";

const KEY = randomBytes(32).toString("hex");
const OTHER_KEY = randomBytes(32).toString("hex");
const SUFFIX = "fm"; // 58² tries: instant, same code path as fmbL

let pg: Postgres;
let db: Db;
let app: FastifyInstance;
let pool: MintPool;
const logs: string[] = [];
const bodies: string[] = [];
const grinderOut: string[] = [];
const secrets = new Map<string, Buffer>(); // pubkey → seed (decrypted by the test only)
let height = 1_000;
const landed = new Set<string>();

const fakeConn = {
  getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: height + 150 }),
  getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => (landed.has(k.toBase58()) ? { lamports: 1, data: Buffer.alloc(0), owner: PublicKey.default, executable: false } : null)),
  getBlockHeight: async () => height,
  getAccountInfo: async () => null,
} as unknown as Connection;

function decryptSeed(keyHex: string, pubkey: string, blob: Buffer): Buffer {
  const d = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), blob.subarray(0, 12));
  d.setAAD(Buffer.concat([Buffer.from("fumpad-vanity-mint:v1:"), Buffer.from(pubkey)]));
  d.setAuthTag(blob.subarray(44));
  return Buffer.concat([d.update(blob.subarray(12, 44)), d.final()]);
}
const spki = (pk: PublicKey) => ({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pk.toBuffer()]), format: "der" as const, type: "spki" as const });

async function prepare(creator: string, ip = "10.0.0.1", extra: Record<string, unknown> = {}, server = app) {
  const r = await server.inject({ method: "POST", url: "/v1/launch/prepare", remoteAddress: ip, payload: { creator, name: "Sad Pigeon", symbol: "PIGN", uri: "ipfs://bafy", ...extra } });
  bodies.push(r.body);
  return r;
}
const status = async (pubkey: string) => (await db.query<{ status: string }>("SELECT status FROM vanity_mints WHERE pubkey = $1", [pubkey])).rows[0]?.status;

beforeAll(async () => {
  pg = await startPostgres(54331);
  db = createPool(pg.url);
  await migrate(db);
  const bin = buildGrinder();
  const env = { DATABASE_URL: pg.url, MINT_POOL_KEY: KEY };
  grinderOut.push(runBinary(bin, ["--once", "14", "--suffix", SUFFIX, "--threads", "2"], env));
  grinderOut.push(runBinary(bin, ["--once", "1", "--suffix", SUFFIX, "--threads", "2"], { ...env, MINT_POOL_KEY: OTHER_KEY }));
  for (const r of (await db.query<{ pubkey: string; secret_enc: Buffer; key_fp: string }>("SELECT pubkey, secret_enc, key_fp FROM vanity_mints")).rows) {
    secrets.set(r.pubkey, decryptSeed(r.key_fp === keyFingerprint(parsePoolKey(KEY)) ? KEY : OTHER_KEY, r.pubkey, r.secret_enc));
  }
  const cfg = loadApiConfig({
    DATABASE_URL: pg.url,
    MINT_POOL_KEY: KEY,
    VANITY_SUFFIX: SUFFIX,
    LAUNCH_RESERVATION_MINUTES: "0.02", // 1.2 s
    LAUNCH_SWEEP_SECS: "0",
    LAUNCH_MAX_ACTIVE_PER_IP: "100",
    LAUNCH_WALLET_LIMIT_PER_MIN: "100",
    LAUNCH_RATE_LIMIT_PER_MIN: "1000",
    LOG_LEVEL: "trace",
  } as NodeJS.ProcessEnv);
  const sink = new Writable({ write: (c, _e, cb) => (logs.push(String(c)), cb()) });
  const built = await buildServer(cfg, { db, conn: fakeConn }, { logStream: sink });
  app = built.app;
  pool = built.deps.pool!;
}, 600_000);

afterAll(async () => {
  await app?.close();
  await db?.end();
  await pg?.stop();
});

describe("vanity mint pool (D18)", () => {
  it("grinder --once filled the pool with suffix matches, encrypted under the configured key", async () => {
    const rows = (await db.query<{ pubkey: string; suffix: string; key_fp: string; status: string }>("SELECT pubkey, suffix, key_fp, status FROM vanity_mints")).rows;
    expect(rows).toHaveLength(15);
    expect(rows.every((r) => r.pubkey.endsWith(SUFFIX) && r.suffix === SUFFIX && r.status === "available")).toBe(true);
    expect(new Set(rows.map((r) => r.key_fp)).size).toBe(2);
    for (const [pk, seed] of secrets) expect(Keypair.fromSeed(seed).publicKey.toBase58()).toBe(pk);
  });

  it("prepare: a FUMPAD create_coin(+buy) for a pooled mint, creator pays, mint signed (validly) and nothing else", async () => {
    const creator = Keypair.generate().publicKey;
    const r = await prepare(creator.toBase58(), "10.0.0.1", { initialBuyLamports: "0" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    const body = r.json() as { mint: string; transaction: string; lastValidBlockHeight: number; expiresAt: number; suffix: string };
    expect(body.mint.endsWith(SUFFIX)).toBe(true);
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "lastValidBlockHeight", "mint", "suffix", "transaction"]);
    const tx = VersionedTransaction.deserialize(Buffer.from(body.transaction, "base64"));
    const info = inspectLaunchTx(tx);
    expect(info).toMatchObject({ feePayer: creator.toBase58(), creator: creator.toBase58(), mint: body.mint, name: "Sad Pigeon", symbol: "PIGN", uri: "ipfs://bafy" });
    expect(info.signed).toEqual([body.mint]);
    expect(tx.message.header.numRequiredSignatures).toBe(2);
    const mintIdx = tx.message.staticAccountKeys.findIndex((k) => k.toBase58() === body.mint);
    expect(verify(null, tx.message.serialize(), spki(new PublicKey(body.mint)), tx.signatures[mintIdx])).toBe(true);
    expect(tx.message.compiledInstructions.some((ix) => tx.message.staticAccountKeys[ix.programIdIndex].equals(FUMPAD_PROGRAM_ID))).toBe(true);
    expect(await status(body.mint)).toBe("reserved");
  });

  it("one wallet holds one mint: preparing again returns the same mint with a fresh signature", async () => {
    const creator = Keypair.generate().publicKey.toBase58();
    const a = (await prepare(creator)).json() as { mint: string; transaction: string };
    const b = (await prepare(creator)).json() as { mint: string; transaction: string };
    expect(b.mint).toBe(a.mint);
    expect(b.transaction).not.toBe(a.transaction);
    const n = await db.query("SELECT 1 FROM vanity_mints WHERE reserved_by = $1", [creator]);
    expect(n.rowCount).toBe(1);
  });

  it("validation failures consume nothing", async () => {
    const before = (await pool.stats()).available;
    const creator = Keypair.generate().publicKey.toBase58();
    expect((await prepare(creator, "10.0.0.1", { symbol: "WAY_TOO_LONG_TICKER" })).statusCode).toBe(400);
    expect((await prepare("notakey")).statusCode).toBe(400);
    expect((await prepare(creator, "10.0.0.1", { uri: "javascript:alert(1)" })).statusCode).toBe(400);
    expect((await pool.stats()).available).toBe(before);
  });

  it("concurrent prepares never get the same mint; an empty pool answers 503 + Retry-After", async () => {
    const avail = (await pool.stats()).available;
    const wallets = Array.from({ length: avail + 3 }, () => Keypair.generate().publicKey.toBase58());
    const rs = await Promise.all(wallets.map((w, i) => prepare(w, `10.1.0.${i}`)));
    const ok = rs.filter((r) => r.statusCode === 200).map((r) => (r.json() as { mint: string }).mint);
    expect(ok).toHaveLength(avail);
    expect(new Set(ok).size).toBe(avail);
    const busy = rs.filter((r) => r.statusCode === 503);
    expect(busy).toHaveLength(3);
    expect(busy[0].headers["retry-after"]).toBe("30");
    // The row encrypted under another key was never handed out.
    const other = (await db.query<{ status: string }>("SELECT status FROM vanity_mints WHERE key_fp <> $1", [keyFingerprint(parsePoolKey(KEY))])).rows;
    expect(other.map((r) => r.status)).toEqual(["available"]);
  });

  it("reservations expire back to the pool only after TTL + blockhash expiry; landed mints become used (secret wiped)", async () => {
    const reserved = (await db.query<{ pubkey: string }>("SELECT pubkey FROM vanity_mints WHERE status = 'reserved' ORDER BY pubkey")).rows.map((r) => r.pubkey);
    expect(reserved.length).toBeGreaterThan(2);
    await new Promise((r) => setTimeout(r, 1_500)); // > 1.2 s TTL
    // Blockhash still valid (height ≤ lastValidBlockHeight): nothing may be released yet.
    expect(await pool.sweep()).toEqual({ released: 0, used: 0 });
    height += 1_000; // every co-signed tx is now dead
    landed.add(reserved[0]); // …but this launch landed on chain
    const r = await pool.sweep();
    expect(r).toEqual({ released: reserved.length - 1, used: 1 });
    expect(await status(reserved[0])).toBe("used");
    expect((await db.query("SELECT secret_enc FROM vanity_mints WHERE pubkey = $1", [reserved[0]])).rows[0].secret_enc).toBeNull();
    expect(await status(reserved[1])).toBe("available");
    // Released mints are handed out again.
    const again = await prepare(Keypair.generate().publicKey.toBase58());
    expect(again.statusCode).toBe(200);
  });

  it("caps active reservations per IP", async () => {
    const cfg = loadApiConfig({ DATABASE_URL: pg.url, MINT_POOL_KEY: KEY, VANITY_SUFFIX: SUFFIX, LAUNCH_SWEEP_SECS: "0", LAUNCH_MAX_ACTIVE_PER_IP: "2", LOG_LEVEL: "silent" } as NodeJS.ProcessEnv);
    const { app: capped } = await buildServer(cfg, { db, conn: fakeConn });
    try {
      const codes = [];
      for (let i = 0; i < 3; i++) codes.push((await prepare(Keypair.generate().publicKey.toBase58(), "9.9.9.9", {}, capped)).statusCode);
      expect(codes).toEqual([200, 200, 429]);
    } finally {
      await capped.close();
    }
  });

  it("launches are disabled (503) without MINT_POOL_KEY", async () => {
    const cfg = loadApiConfig({ DATABASE_URL: pg.url, LOG_LEVEL: "silent" } as NodeJS.ProcessEnv);
    const { app: off } = await buildServer(cfg, { db, conn: fakeConn });
    try {
      const r = await prepare(Keypair.generate().publicKey.toBase58(), "10.0.0.1", {}, off);
      expect(r.statusCode).toBe(503);
    } finally {
      await off.close();
    }
  });

  it("no mint secret appears in any response body or log line (API and grinder)", () => {
    expect(secrets.size).toBe(15);
    expect(logs.length).toBeGreaterThan(5); // trace-level request logs were captured
    expect(logs.join("")).toContain("launch prepared");
    const haystack = [...bodies, ...logs, ...grinderOut].join("\n");
    for (const seed of secrets.values()) {
      const full = Keypair.fromSeed(seed).secretKey;
      for (const needle of [
        seed.toString("hex"),
        seed.toString("base64"),
        seed.toString("base64url"),
        bs58.encode(seed),
        bs58.encode(full),
        Buffer.from(full).toString("base64"),
        Array.from(seed).join(","),
        JSON.stringify(Array.from(seed)),
      ]) {
        expect(haystack.includes(needle)).toBe(false);
      }
    }
  });
});
