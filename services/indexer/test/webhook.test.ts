/**
 * H-1 / L-6 regression (was security-review/services-poc/webhook-forgery.test.ts): a forged
 * webhook body carrying a fabricated FUMPAD Trade under a real-looking signature used to be
 * ingested as chain data, unauthenticated when HELIUS_WEBHOOK_SECRET was unset.
 * Now: no secret → no webhook (boot fails if enabled); wrong/missing Authorization → 401
 * (constant-time compare); oversized bodies → 413; and an AUTHENTICATED forged body only
 * yields signature hints that are re-fetched from our RPC — the forged contents never reach
 * the ingestor.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bn, EVENT_IX_TAG, eventAuthorityPda, FUMPAD_IDL, FUMPAD_PROGRAM_ID, fumpadCoder, type TxLike } from "@fumpad/sdk";

import { loadIndexerConfig } from "../src/config.js";
import { RpcSource } from "../src/sources/rpc.js";
import { heliusWebhookHandler, webhookAuthorized, webhookSignatures } from "../src/sources/push.js";

const SECRET = "s3cret-".repeat(5);
const log = { warn() {}, info() {}, debug() {}, error() {} } as never;
const disc = (name: string) => (FUMPAD_IDL.events as { name: string; discriminator: number[] }[]).find((e) => e.name === name)!.discriminator;

function forgedTrade(signature: string): TxLike {
  const user = Keypair.generate().publicKey;
  // A forged v0.7 TicketAttested (a ticket nobody attested).
  const k = () => Keypair.generate().publicKey;
  const body = fumpadCoder().types.encode("TicketAttested", {
    mint: k(), owner: user, ticket: k(), seq: bn(0n), pool: k(), venue: 0, source: 0, signature: Array(64).fill(1), ix_key: 0,
    base_amount: bn(1n), quote_gross: bn(1_000_000_000_000n), tokens: bn(1n), sell_price_q64: bn(1n), sell_usd_cents: bn(10_000_000n),
    pyth_publish_time: bn(0n), slot: bn(1n), sell_ts: bn(0n), keepers: [k(), k()], submitter: k(), ts: bn(BigInt(Math.floor(Date.now() / 1000))),
  });
  const data = bs58.encode(Uint8Array.from([...EVENT_IX_TAG, ...disc("TicketAttested"), ...body]));
  return {
    slot: 999_999_999,
    blockTime: Math.floor(Date.now() / 1000),
    transaction: { signatures: [signature], message: { accountKeys: [user.toBase58(), FUMPAD_PROGRAM_ID.toBase58(), eventAuthorityPda().toBase58()], instructions: [] } },
    meta: { err: null, logMessages: [], innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 1, accounts: [2], data }] }] },
  };
}

const SIG = "5".repeat(88);
const ingested: TxLike[] = [];
const fetched: string[] = [];
// Our RPC doesn't know the forged signature (or knows the REAL tx, which differs from the body).
const conn = { getTransaction: async (s: string) => (fetched.push(s), null) } as never;
const db = { query: async () => ({ rows: [] }) } as never;
const ingestor = { ingest: async (tx: TxLike) => (ingested.push(tx), { status: "applied" }), watchedPools: () => new Map() } as never;
const rpc = new RpcSource(conn, db, ingestor, { commitment: "confirmed", pageSize: 1000, backfillFromSlot: 0, reconcileDepth: 10, fetchAttempts: 1 }, log);
let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer(heliusWebhookHandler((s) => rpc.hint(s), log, { secret: SECRET, maxBodyBytes: 64 * 1024 }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/helius`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("H-1 webhook forgery is rejected", () => {
  it("boot refuses an enabled webhook without a secret; no secret = no webhook", () => {
    expect(() => loadIndexerConfig({ DATABASE_URL: "postgres://x/y", HELIUS_WEBHOOK_ENABLED: "true" } as NodeJS.ProcessEnv)).toThrow(/HELIUS_WEBHOOK_SECRET/);
    expect(() => loadIndexerConfig({ DATABASE_URL: "postgres://x/y", HELIUS_WEBHOOK_SECRET: "short" } as NodeJS.ProcessEnv)).toThrow(/24/);
    expect(loadIndexerConfig({ DATABASE_URL: "postgres://x/y" } as NodeJS.ProcessEnv).webhookEnabled).toBe(false);
    expect(loadIndexerConfig({ DATABASE_URL: "postgres://x/y", HELIUS_WEBHOOK_SECRET: SECRET } as NodeJS.ProcessEnv).webhookEnabled).toBe(true);
    expect(() => heliusWebhookHandler(() => {}, log, { secret: "" })).toThrow();
  });

  it("unauthenticated forged transaction → 401, nothing fetched or ingested", async () => {
    const body = JSON.stringify([forgedTrade(SIG)]);
    for (const headers of [{}, { authorization: "wrong" }, { authorization: `${SECRET}x` }, { authorization: SECRET.slice(0, -1) }] as Record<string, string>[]) {
      const res = await fetch(url, { method: "POST", body, headers });
      expect(res.status).toBe(401);
    }
    await rpc.drainHints();
    expect(fetched).toEqual([]);
    expect(ingested).toEqual([]);
  });

  it("authenticated forged body is only a hint: re-fetched from RPC, forged contents never ingested", async () => {
    const res = await fetch(url, { method: "POST", body: JSON.stringify([forgedTrade(SIG)]), headers: { authorization: SECRET } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 1 });
    await new Promise((r) => setTimeout(r, 20));
    await rpc.drainHints();
    expect([...new Set(fetched)]).toEqual([SIG]);
    expect(ingested).toEqual([]); // the PoC asserted a decoded fake Trade here
  });

  it("a hint whose real transaction doesn't touch FUMPAD is ignored", async () => {
    const other = new RpcSource(
      { getTransaction: async () => ({ ...forgedTrade(SIG), transaction: { signatures: [SIG], message: { accountKeys: [Keypair.generate().publicKey.toBase58()], instructions: [] } } }) } as never,
      db,
      ingestor,
      { commitment: "confirmed", pageSize: 1000, backfillFromSlot: 0, reconcileDepth: 10, fetchAttempts: 1 },
      log,
    );
    other.hint([SIG]);
    await other.drainHints();
    expect(ingested).toEqual([]);
    expect(other.stats.hintsIgnored).toBe(1);
  });

  it("L-6: body over the limit → 413; non-JSON → 400", async () => {
    const big = await fetch(url, { method: "POST", body: "x".repeat(70 * 1024), headers: { authorization: SECRET } }).catch(() => null);
    expect(big === null || big.status === 413).toBe(true);
    const bad = await fetch(url, { method: "POST", body: "{nope", headers: { authorization: SECRET } });
    expect(bad.status).toBe(400);
  });

  it("signature extraction validates shape and caps the count", () => {
    expect(webhookSignatures([{ signature: SIG }, { transaction: { signatures: [SIG] } }, { signature: "not-base58!" }, { signature: 5 }])).toEqual([SIG]);
    const many = Array.from({ length: 300 }, (_, i) => ({ signature: bs58.encode(Buffer.alloc(64, i + 1)) }));
    expect(webhookSignatures(many, 100)).toHaveLength(100);
    expect(webhookAuthorized(SECRET, SECRET)).toBe(true);
    expect(webhookAuthorized(undefined, SECRET)).toBe(false);
    expect(webhookAuthorized([SECRET], SECRET)).toBe(false);
  });
});
