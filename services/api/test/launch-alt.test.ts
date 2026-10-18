/**
 * The launch address lookup table in `POST /v1/launch/prepare` (LAUNCH_ALT, src/launch/alt.ts): every launch is a v0
 * message through the configured, verified table (exact contents, frozen, active); anything else fails closed (503,
 * nothing reserved or signed); inline launches only on localnet without LAUNCH_ALT.
 */
import { AddressLookupTableAccount, AddressLookupTableProgram, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { DBC_PROGRAM_ID, inspectLaunchTx, LAUNCH_TX_MAX_BYTES, launchAltAddresses, STANDARD_FEE_POLICY } from "@fumpad/sdk";

import { loadApiConfig } from "../src/config.js";
import { LaunchAltCache } from "../src/launch/alt.js";
import { buildServer } from "../src/server.js";

const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;
const U64_MAX = (1n << 64n) - 1n;

/** Address Lookup Table account bytes: 56-byte meta (type 1, deactivation slot, last extended slot + index, Option<authority>, padding) + keys. */
function altAccountData(addresses: PublicKey[], o: { authority?: PublicKey; deactivationSlot?: bigint } = {}): Buffer {
  const meta = Buffer.alloc(56);
  meta.writeUInt32LE(1, 0);
  meta.writeBigUInt64LE(o.deactivationSlot ?? U64_MAX, 4);
  meta.writeBigUInt64LE(1n, 12);
  meta.writeUInt8(0, 20);
  if (o.authority) {
    meta.writeUInt8(1, 21);
    o.authority.toBuffer().copy(meta, 22);
  }
  return Buffer.concat([meta, ...addresses.map((a) => a.toBuffer())]);
}

const NAME = "W".repeat(32);
const SYMBOL = "W".repeat(10);
const URI = "https://scarlet-generous-armadillo-291.mypinata.cloud/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"; // our gateway (105 chars): the worst case must still fit

describe("POST /v1/launch/prepare through the launch ALT", () => {
  const altKey = Keypair.generate().publicKey;
  const std = Keypair.generate().publicKey;
  const launchKey = Keypair.generate();
  const global = {
    params: { launchSigner: launchKey.publicKey },
    configs: [std, ...Array(7).fill(PublicKey.default)],
    configPolicies: Array(8).fill(STANDARD_FEE_POLICY),
    configCoins: Array(8).fill(0),
  };
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  /** A server with a fake mint pool (signs as a fresh mint) and a chain holding `alt` (raw ALT account) at LAUNCH_ALT. */
  async function server(e: Record<string, string>, alt: { data: Buffer; owner?: PublicKey } | null) {
    const reads = { alt: 0 };
    const pool = {
      prepared: 0,
      cfg: { suffix: "" },
      async prepare(_creator: string, _ip: string, build: (mint: PublicKey) => Promise<{ tx: VersionedTransaction; lastValidBlockHeight: number }>) {
        const mint = Keypair.generate();
        this.cfg.suffix = mint.publicKey.toBase58().slice(-1);
        const { tx, lastValidBlockHeight } = await build(mint.publicKey);
        tx.sign([mint]);
        this.prepared++;
        return { mint: mint.publicKey.toBase58(), tx, lastValidBlockHeight, reusedReservation: false, expiresAt: Date.now() + 60_000 };
      },
    };
    const conn = {
      getBalance: async () => 1_000_000_000,
      getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000 }),
      getAccountInfo: async (k: PublicKey) => {
        if (k.equals(std)) return { data: Buffer.alloc(1048), owner: DBC_PROGRAM_ID, lamports: 1, executable: false };
        if (k.equals(altKey)) {
          reads.alt++;
          return alt ? { data: alt.data, owner: alt.owner ?? AddressLookupTableProgram.programId, lamports: 1, executable: false } : null;
        }
        return null;
      },
    };
    const cfg = loadApiConfig(
      env({ DATABASE_URL: "postgres://stub/stub", LOG_LEVEL: "silent", LAUNCH_REQUIRE_SIGNATURE: "false", LAUNCH_MIN_BALANCE_LAMPORTS: "0", LAUNCH_SWEEP_SECS: "0", LAUNCH_SIGNER_KEY: JSON.stringify(Array.from(launchKey.secretKey)), LAUNCH_ALT: altKey.toBase58(), ...e }),
    );
    const built = await buildServer(cfg, {
      db: { query: async () => ({ rows: [], rowCount: 0 }), end: async () => {} } as never,
      conn: conn as never,
      repo: {} as never,
      chain: { solUsd: async () => 150, client: {}, global: async () => global } as never,
      live: { subscribers: 0, stats: {}, subscribe: () => () => {}, stop: async () => {} } as never,
      pool: pool as never,
    });
    app = built.app;
    return { app, pool, reads };
  }
  const prepare = (a: FastifyInstance, extra: Record<string, unknown> = {}) =>
    a.inject({ method: "POST", url: "/v1/launch/prepare", payload: { creator: Keypair.generate().publicKey.toBase58(), name: NAME, symbol: SYMBOL, uri: URI, priorityMicroLamports: 5_000_000, ...extra } });
  const table = (data: Buffer) => new AddressLookupTableAccount({ key: altKey, state: AddressLookupTableAccount.deserialize(data) });

  it("a valid frozen ALT: v0 message through it (max name + symbol + https uri + priority fee + co-signature ≤ 1,232 B), verified once", async () => {
    const data = altAccountData(launchAltAddresses());
    const { app: a, pool, reads } = await server({}, { data });
    const r = await prepare(a);
    expect(r.statusCode, r.body).toBe(200);
    const out = r.json();
    expect(out.lookupTable).toBe(altKey.toBase58());
    const tx = VersionedTransaction.deserialize(Buffer.from(out.transaction, "base64"));
    expect(tx.message.addressTableLookups.map((l) => l.accountKey.toBase58())).toEqual([altKey.toBase58()]);
    expect(tx.serialize().length).toBeLessThanOrEqual(LAUNCH_TX_MAX_BYTES);
    const info = inspectLaunchTx(tx, [table(data)]);
    expect(info).toMatchObject({ name: NAME, symbol: SYMBOL, uri: URI, dbcConfig: std.toBase58() });
    expect([...info.signed].sort()).toEqual([out.mint, launchKey.publicKey.toBase58()].sort());
    // without the table the launch can't be read (no silent partial decode)
    expect(() => inspectLaunchTx(tx)).toThrow(/lookup table/);
    // signers stay static keys (the runtime refuses table-loaded signers / program ids)
    expect(tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map((k) => k.toBase58()).sort()).toEqual([info.creator, out.mint, launchKey.publicKey.toBase58()].sort());
    expect((await prepare(a)).statusCode).toBe(200);
    expect(reads.alt).toBe(1); // frozen = immutable: verified once, then cached
    expect(pool.prepared).toBe(2);
  });

  it("fails closed (503, nothing reserved or signed): altered contents, reordered, extra key, not frozen, deactivated, wrong owner, missing", async () => {
    const want = launchAltAddresses();
    const cases: [string, { data: Buffer; owner?: PublicKey } | null][] = [
      ["one key swapped", { data: altAccountData([...want.slice(0, -1), Keypair.generate().publicKey]) }],
      ["reordered", { data: altAccountData([want[1], want[0], ...want.slice(2)]) }],
      ["an extra key", { data: altAccountData([...want, Keypair.generate().publicKey]) }],
      ["one key short", { data: altAccountData(want.slice(0, -1)) }],
      ["not frozen (has an authority)", { data: altAccountData(want, { authority: Keypair.generate().publicKey }) }],
      ["deactivated", { data: altAccountData(want, { deactivationSlot: 5n }) }],
      ["not owned by the ALT program", { data: altAccountData(want), owner: Keypair.generate().publicKey }],
      ["missing", null],
    ];
    for (const [what, alt] of cases) {
      const { app: a, pool } = await server({}, alt);
      const r = await prepare(a);
      expect(r.statusCode, what).toBe(503);
      expect(r.json().error, what).toMatch(/lookup table/);
      expect(JSON.stringify(r.json()), what).not.toMatch(new RegExp(altKey.toBase58()));
      expect(pool.prepared, what).toBe(0);
      await a.close();
      app = undefined;
    }
  });

  it("LAUNCH_ALT unset: 503 on devnet / mainnet (fail closed), an inline launch only on localnet", async () => {
    for (const e of [{}, { FUMPAD_CLUSTER: "devnet" }, { FUMPAD_CLUSTER: "mainnet", LAUNCHES_OPEN: "true", PINATA_JWT: "x" }] as Record<string, string>[]) {
      const { app: a, pool } = await server({ ...e, LAUNCH_ALT: "" }, null);
      const r = await prepare(a);
      expect(r.statusCode).toBe(503);
      expect(r.json().error).toMatch(/lookup table/);
      expect(pool.prepared).toBe(0);
      await a.close();
      app = undefined;
    }
    const { app: a } = await server({ FUMPAD_CLUSTER: "localnet", LAUNCH_ALT: "" }, null);
    const r = await prepare(a, { name: "Pigeon", symbol: "PIGN", uri: "ipfs://x", priorityMicroLamports: 0 });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().lookupTable).toBeUndefined();
    expect(VersionedTransaction.deserialize(Buffer.from(r.json().transaction, "base64")).message.addressTableLookups).toHaveLength(0);
  });

  it("LaunchAltCache: a failed check is not cached (fixed on chain → the next prepare works)", async () => {
    let data = altAccountData(launchAltAddresses(), { authority: Keypair.generate().publicKey });
    const conn = { getAccountInfo: async () => ({ data, owner: AddressLookupTableProgram.programId }) };
    const c = new LaunchAltCache(conn, { launchAlt: altKey.toBase58(), launchAltRequired: true });
    await expect(c.get()).rejects.toThrow(/lookup table/);
    expect(c.lastError).toMatch(/not frozen/);
    data = altAccountData(launchAltAddresses());
    expect((await c.get())!.key.equals(altKey)).toBe(true);
    expect(c.lastError).toBeUndefined();
    expect(new LaunchAltCache(conn, { launchAlt: undefined, launchAltRequired: true }).disabledReason).toMatch(/LAUNCH_ALT/);
    expect(await new LaunchAltCache(conn, { launchAlt: undefined, launchAltRequired: false }).get()).toBeNull();
  });
});
