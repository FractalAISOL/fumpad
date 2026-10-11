/**
 * Indexer → Postgres → API without a validator: synthetic transactions carrying real
 * borsh-encoded events (exactly what emit_cpi puts in inner instructions) are ingested,
 * then idempotency, replay, rollback and the API mapping are checked.
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bn,
  DEFAULT_PARAMS,
  EVENT_IX_TAG,
  FUMPAD_IDL,
  FUMPAD_PROGRAM_ID,
  fumpadCoder,
  type Params,
  PUMPSWAP_PROGRAM_ID,
  type TxLike,
  WSOL_MINT,
  eventAuthorityPda,
} from "@fumpad/sdk";
import { createLogger, createPool, type Db, Finalizer, Ingestor, migrate, replayMint, setMeta, storeable } from "@fumpad/indexer";
import { Repo } from "@fumpad/api";

import { type Postgres, startPostgres } from "../../scripts/local/harness.js";

const P: Params = { ...DEFAULT_PARAMS, oracleWindowSecs: 60n, oracleMinSpacingSecs: 2n, oracleMinSamples: 3 };
const Q = 1n << 64n;
const k = () => Keypair.generate().publicKey;
const mint = k();
const creator = k();
const alice = k();
const bob = k();
const pool = k();
const ticketA = k();
const ticketB = k();
const evAuth = eventAuthorityPda().toBase58();

function ev(name: string, data: Record<string, unknown>): Uint8Array {
  const disc = (FUMPAD_IDL.events as { name: string; discriminator: number[] }[]).find((e) => e.name === name)!.discriminator;
  return Uint8Array.from([...EVENT_IX_TAG, ...disc, ...fumpadCoder().types.encode(name, data)]);
}
let slot = 100;
function tx(sig: string, events: Uint8Array[], extra: Partial<NonNullable<TxLike["meta"]>> = {}, keys: string[] = []): TxLike {
  slot += 1;
  return {
    slot,
    blockTime: 1_800_000_000 + slot,
    transaction: { signatures: [sig], message: { accountKeys: [alice.toBase58(), FUMPAD_PROGRAM_ID.toBase58(), evAuth, ...keys], instructions: [] } },
    meta: { err: null, logMessages: [], innerInstructions: [{ index: 0, instructions: events.map((d) => ({ programIdIndex: 1, accounts: [2], data: bs58.encode(d) })) }], ...extra },
  };
}
const T = (n: number) => bn(BigInt(1_800_000_000 + n));

let pg: Postgres;
let db: Db;
let ing: Ingestor;
const log = createLogger("test", "warn");

beforeAll(async () => {
  pg = await startPostgres(54339);
  db = createPool(pg.url, 4);
  await migrate(db);
  await setMeta(db, "global", { params: storeable(P) });
  ing = new Ingestor({ db, conn: new Connection("http://127.0.0.1:1"), log, params: () => P });
}, 120_000);
afterAll(async () => {
  await db?.end();
  await pg?.stop();
});

describe("indexer → db → api (synthetic events)", () => {
  const sigs: string[] = [];
  it("ingests a coin lifecycle", async () => {
    const vs = P.initialVirtualSol;
    const vt = P.initialVirtualToken;
    const trade = (user: PublicKey, isBuy: boolean, tokens: bigint, sol: bigint, vsol: bigint, vtok: bigint, t: number, onAmm = false) =>
      ev("Trade", {
        mint, user, is_buy: isBuy, on_amm: onAmm, token_amount: bn(tokens), sol_amount: bn(sol), fee_pool: bn(sol / 200n), fee_platform: bn((sol * 3n) / 1000n),
        fee_creator: bn((sol * 2n) / 1000n), pool_tokens_bought: bn(isBuy && !onAmm ? 1_000_000n : 0n), price_q64: bn((sol * Q) / tokens), virtual_sol_reserves: bn(vsol), virtual_token_reserves: bn(vtok), ts: T(t),
      });
    const list: [string, Uint8Array[]][] = [
      ["s1", [ev("CoinCreated", { mint, creator, name: "Fumble", symbol: "FUMB", uri: "https://x", ts: T(1) })]],
      ["s2", [trade(alice, true, 60_000_000_000_000n, 2_000_000_000n, vs + 2_000_000_000n, vt - 60_000_000_000_000n, 2)]],
      ["s3", [
        ev("TicketCreated", { mint, owner: alice, ticket: ticketA, tokens: bn(30_000_000_000_000n), sell_price_q64: bn(Q / 30_000n), sell_usd_cents: bn(15_000n), ts: T(5) }),
        trade(alice, false, 30_000_000_000_000n, 1_000_000_000n, vs + 1_000_000_000n, vt - 30_000_000_000_000n, 5),
      ]],
      ["s4", [ev("TicketCreated", { mint, owner: bob, ticket: ticketB, tokens: bn(80_000_000_000_000n), sell_price_q64: bn(Q / 30_000n), sell_usd_cents: bn(40_000n), ts: T(6) })]],
      ["s5", [ev("CurveCompleted", { mint, ts: T(10) })]],
      ["s6", [ev("Graduated", { mint, pool, sol_deposited: bn(85_000_000_000n), tokens_deposited: bn(196_551_724_137_931n), lp_locked: bn(1_000n), ts: T(11) })]],
    ];
    // Keeper samples spread over the 60 s window (6 buckets) at ~14× alice's ticket price.
    for (let i = 0; i < 7; i++) list.push([`samp${i}`, [ev("SampleRecorded", { mint, price_q64: bn((Q * 14n) / 30_000n), fallback: false, ts: T(12 + i * 10) })]]);
    list.push(["s7", [ev("ClaimPaid", { mint, ticket: ticketA, owner: alice, amount: bn(3_000_000_000_000n), from_queue: false, median_price_q64: bn((Q * 14n) / 30_000n), ts: T(80) })]]);
    list.push(["s8", [ev("ClaimQueued", { mint, ticket: ticketB, owner: bob, amount: bn(8_000_000_000_000n), queue_len: 1, ts: T(81) })]]);
    for (const [s, evs] of list) {
      const r = await ing.ingest(tx(s, evs), "rpc", "confirmed");
      expect(r.status).toBe("applied");
      sigs.push(s);
    }
    const coin = (await db.query("SELECT * FROM coins")).rows[0];
    expect(coin.status).toBe("graduated");
    expect(coin.amm_pool).toBe(pool.toBase58());
    expect(BigInt(coin.queue_owed)).toBe(8_000_000_000_000n);
    expect(BigInt(coin.pool_tokens)).toBe(P.rewardPoolSupply + 1_000_000n - 3_000_000_000_000n);
    expect(coin.median_q64).not.toBeNull();
    const t = (await db.query("SELECT ticket, status, seq, crossed_at FROM tickets ORDER BY sell_ts")).rows;
    expect(t.map((x) => x.status)).toEqual(["claimed", "queued"]);
    expect(t[0].crossed_at).not.toBeNull(); // crossed 10× on the first covered median
    const kinds = (await db.query("SELECT kind FROM feed_events ORDER BY seq")).rows.map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(["launch", "fumble", "graduation", "cross", "claim"]));
  });

  it("is idempotent (re-delivery = duplicate, no double counting)", async () => {
    const before = (await db.query("SELECT volume_lamports, trade_count FROM coins")).rows[0];
    const r = await ing.ingest(tx("s2", [ev("Trade", { mint, user: alice, is_buy: true, on_amm: false, token_amount: bn(1n), sol_amount: bn(1n), fee_pool: bn(0n), fee_platform: bn(0n), fee_creator: bn(0n), pool_tokens_bought: bn(0n), price_q64: bn(1n), virtual_sol_reserves: bn(1n), virtual_token_reserves: bn(1n), ts: T(2) })]), "webhook", "confirmed");
    expect(r.status).toBe("duplicate");
    expect((await db.query("SELECT volume_lamports, trade_count FROM coins")).rows[0]).toEqual(before);
  });

  it("detects a rebuy made directly on PumpSwap (external trade → flag)", async () => {
    const extTx: TxLike = {
      slot: ++slot,
      blockTime: 1_800_000_090,
      transaction: { signatures: ["ext1"], message: { accountKeys: [bob.toBase58(), PUMPSWAP_PROGRAM_ID.toBase58(), pool.toBase58()], instructions: [{ programIdIndex: 1, accounts: [0, 2], data: bs58.encode(Uint8Array.from([1])) }] } },
      meta: {
        err: null, logMessages: [], innerInstructions: [],
        preTokenBalances: [{ accountIndex: 0, mint: mint.toBase58(), owner: bob.toBase58(), uiTokenAmount: { amount: "0" } }, { accountIndex: 0, mint: WSOL_MINT.toBase58(), owner: bob.toBase58(), uiTokenAmount: { amount: "500" } }],
        postTokenBalances: [{ accountIndex: 0, mint: mint.toBase58(), owner: bob.toBase58(), uiTokenAmount: { amount: "777" } }, { accountIndex: 0, mint: WSOL_MINT.toBase58(), owner: bob.toBase58(), uiTokenAmount: { amount: "0" } }],
      },
    };
    await ing.refreshPools(true);
    const r = await ing.ingest(extTx, "rpc", "confirmed");
    expect(r.status).toBe("applied");
    const x = (await db.query("SELECT * FROM external_trades")).rows[0];
    expect(x.wallet).toBe(bob.toBase58());
    expect(x.base_delta).toBe("777");
    const f = (await db.query("SELECT reason, mint FROM wallet_flags WHERE wallet = $1", [bob.toBase58()])).rows;
    expect(f).toEqual([{ reason: "rebuy_elsewhere", mint: mint.toBase58() }]);
  });

  it("replays a mint from raw events to the same state", async () => {
    const snap = async () => ({
      coin: (await db.query("SELECT status, virtual_sol, pool_tokens, queue_owed, tickets_open, tickets_created, median_q64 FROM coins")).rows,
      tickets: (await db.query("SELECT ticket, status, tokens, claim_amount, crossed_at FROM tickets ORDER BY ticket")).rows,
      queue: (await db.query("SELECT * FROM queue_entries")).rows,
      trades: (await db.query("SELECT count(*) FROM trades")).rows,
    });
    const before = await snap();
    const n = await replayMint(db, mint.toBase58(), P);
    expect(n).toBeGreaterThan(10);
    expect(await snap()).toEqual(before);
  });

  it("rolls back a dropped transaction and rebuilds the mint", async () => {
    const fin = new Finalizer(new Connection("http://127.0.0.1:1"), db, () => P, log);
    await fin.rollback(["s7"]); // alice's ClaimPaid never finalized
    const t = (await db.query("SELECT status FROM tickets WHERE ticket = $1", [ticketA.toBase58()])).rows[0];
    expect(t.status).toBe("open");
    const coin = (await db.query("SELECT pool_tokens FROM coins")).rows[0];
    expect(BigInt(coin.pool_tokens)).toBe(P.rewardPoolSupply + 1_000_000n);
    expect((await db.query("SELECT count(*)::int AS n FROM claims")).rows[0].n).toBe(0);
  });

  it("API repo maps rows to the app's types", async () => {
    const repo = new Repo(db);
    const c = await repo.getCoin("FUMB");
    expect(c?.mint).toBe(mint.toBase58());
    expect(c?.status).toBe("graduated");
    expect(c?.ticketsCreated).toBe(2);
    expect(c?.spark).toHaveLength(24);
    const tickets = await repo.getTickets(alice.toBase58());
    expect(tickets[0].state).toBe("claimable"); // after the rollback alice can claim again
    expect(tickets[0].multiple).toBeCloseTo(14, 3);
    const q = await repo.getClaimQueue(mint.toBase58(), bob.toBase58());
    expect(q.entries[0]).toMatchObject({ position: 1, isYou: true, fits: false });
    const feed = await repo.getFeed({ limit: 50 });
    expect(feed.every((f) => f.symbol === "FUMB" && typeof f.ts === "number")).toBe(true);
    expect(await repo.getCoin("NOPE")).toBeNull();
  });
});
