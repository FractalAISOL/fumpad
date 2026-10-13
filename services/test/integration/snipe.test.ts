/**
 * v0.5 events through indexer → Postgres → API (no validator): D19 snipe tax on Trade and the
 * D20 graduation fee split on Graduated, plus the v0.4 layouts the still-live devnet program
 * emits (decoded with the appended fields zeroed / NULL), and replay of both.
 */
import { Connection, Keypair, type PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bn, DEFAULT_PARAMS, EVENT_IX_TAG, FUMPAD_IDL, FUMPAD_PROGRAM_ID, fumpadCoder, type Params, type TxLike, eventAuthorityPda } from "@fumpad/sdk/v06";
import { createLogger, createPool, type Db, Ingestor, migrate, replayMint, setMeta, storeable } from "@fumpad/indexer";
import { Repo } from "@fumpad/api";

import { type Postgres, startPostgres } from "../../scripts/local/harness.js";

const P: Params = { ...DEFAULT_PARAMS };
const Q = 1n << 64n;
const k = () => Keypair.generate().publicKey;
const evAuth = eventAuthorityPda().toBase58();
const creator = k();
const sniper = k();
const late = k();
const pool = k();
const coinNew = k(); // launched + graduated under v0.5
const coinOld = k(); // v0.4 events only

function payload(name: string, data: Record<string, unknown>): Uint8Array {
  const disc = (FUMPAD_IDL.events as { name: string; discriminator: number[] }[]).find((e) => e.name === name)!.discriminator;
  return Uint8Array.from([...disc, ...fumpadCoder().types.encode(name, data)]);
}
const cpi = (p: Uint8Array) => Uint8Array.from([...EVENT_IX_TAG, ...p]);
const ev = (name: string, data: Record<string, unknown>) => cpi(payload(name, data));
/** The same event as the v0.4 program emits it: without the trailing `n` bytes added in v0.5. */
const legacyEv = (name: string, data: Record<string, unknown>, n: number) => {
  const p = payload(name, data);
  return cpi(p.subarray(0, p.length - n));
};

let slot = 1_000;
function tx(sig: string, events: Uint8Array[]): TxLike {
  slot += 1;
  return {
    slot,
    blockTime: 1_800_000_000 + slot,
    transaction: { signatures: [sig], message: { accountKeys: [creator.toBase58(), FUMPAD_PROGRAM_ID.toBase58(), evAuth], instructions: [] } },
    meta: { err: null, logMessages: [], innerInstructions: [{ index: 0, instructions: events.map((d) => ({ programIdIndex: 1, accounts: [2], data: bs58.encode(d) })) }] },
  };
}
const T = (n: number) => bn(BigInt(1_800_000_000 + n));
const trade = (mint: PublicKey, user: PublicKey, sol: bigint, tokens: bigint, vsol: bigint, t: number, tax = 0n, bps = 0) => ({
  mint, user, is_buy: true, on_amm: false, token_amount: bn(tokens), sol_amount: bn(sol), fee_pool: bn(sol / 200n), fee_platform: bn((sol * 3n) / 1000n),
  fee_creator: bn((sol * 2n) / 1000n), pool_tokens_bought: bn(1_000_000n + tax), price_q64: bn((sol * Q) / tokens),
  virtual_sol_reserves: bn(vsol), virtual_token_reserves: bn(P.initialVirtualToken - tokens), ts: T(t), snipe_tax: bn(tax), snipe_tax_bps: bps,
});

let pg: Postgres;
let db: Db;
let ing: Ingestor;

beforeAll(async () => {
  pg = await startPostgres(54341);
  db = createPool(pg.url, 4);
  await migrate(db);
  await setMeta(db, "global", { params: storeable(P) });
  ing = new Ingestor({ db, conn: new Connection("http://127.0.0.1:1"), log: createLogger("test", "warn"), params: () => P });
}, 120_000);
afterAll(async () => {
  await db?.end();
  await pg?.stop();
});

const vs = P.initialVirtualSol;
// Sniper: 1 SOL budget at 99% → 10,000,000 lamports to the curve, 990,000,000 tax.
const TAX = 990_000_000n;

describe("v0.5 snipe tax + graduation split (and v0.4 layouts)", () => {
  it("ingests creator's exempt launch buy, a taxed snipe, a normal buy, graduation with the fee split", async () => {
    const list: [string, Uint8Array[]][] = [
      ["n1", [
        ev("CoinCreated", { mint: coinNew, creator, name: "Snipe", symbol: "SNIP", uri: "https://x", ts: T(1) }),
        ev("Trade", trade(coinNew, creator, 500_000_000n, 16_000_000_000_000n, vs + 500_000_000n, 1)),
      ]],
      ["n2", [ev("Trade", trade(coinNew, sniper, 10_000_000n, 300_000_000_000n, vs + 510_000_000n, 1, TAX, 9_900))]],
      ["n3", [ev("Trade", trade(coinNew, late, 2_000_000_000n, 60_000_000_000_000n, vs + 2_510_000_000n, 9))]],
      ["n4", [ev("CurveCompleted", { mint: coinNew, ts: T(20) })]],
      ["n5", [ev("Graduated", { mint: coinNew, pool, sol_deposited: bn(84_350_000_000n), tokens_deposited: bn(189_188_574_214_782n), lp_locked: bn(1_000n), ts: T(21),
        caller_refund: bn(13_000_000n), setup_prefunded: bn(629_900_000n), platform_fee: bn(7_100_000n) })]],
    ];
    for (const [s, evs] of list) expect((await ing.ingest(tx(s, evs), "rpc", "confirmed")).status).toBe("applied");

    const tr = (await db.query("SELECT wallet, snipe_tax, snipe_tax_bps FROM trades WHERE mint = $1 ORDER BY slot", [coinNew.toBase58()])).rows;
    expect(tr).toEqual([
      { wallet: creator.toBase58(), snipe_tax: "0", snipe_tax_bps: 0 },
      { wallet: sniper.toBase58(), snipe_tax: TAX.toString(), snipe_tax_bps: 9_900 },
      { wallet: late.toBase58(), snipe_tax: "0", snipe_tax_bps: 0 },
    ]);
    const c = (await db.query("SELECT * FROM coins WHERE mint = $1", [coinNew.toBase58()])).rows[0];
    expect(c.snipe_tax_lamports).toBe(TAX.toString());
    expect(c.snipe_taxed_buys).toBe(1);
    // Reward-pool inflow = every trade's pool fee share + the snipe tax.
    const feePool = 500_000_000n / 200n + 10_000_000n / 200n + 2_000_000_000n / 200n;
    expect(BigInt(c.pool_inflow_lamports)).toBe(feePool + TAX);
    expect([c.graduation_caller_refund, c.graduation_setup_prefunded, c.graduation_platform_fee]).toEqual(["13000000", "629900000", "7100000"]);
    // The sniper's cost basis includes the tax.
    const pos = (await db.query("SELECT sol_in FROM positions WHERE mint = $1 AND wallet = $2", [coinNew.toBase58(), sniper.toBase58()])).rows[0];
    expect(BigInt(pos.sol_in)).toBe(10_000_000n + 50_000n + 30_000n + 20_000n + TAX);
  });

  it("ingests v0.4-layout Trade and Graduated (fields absent → 0 / NULL)", async () => {
    const list: [string, Uint8Array[]][] = [
      ["o1", [ev("CoinCreated", { mint: coinOld, creator, name: "Old", symbol: "OLD", uri: "https://x", ts: T(30) })]],
      ["o2", [legacyEv("Trade", trade(coinOld, late, 1_000_000_000n, 30_000_000_000_000n, vs + 1_000_000_000n, 31), 10)]],
      ["o3", [legacyEv("Graduated", { mint: coinOld, pool: k(), sol_deposited: bn(85_000_000_000n), tokens_deposited: bn(5n), lp_locked: bn(6n), ts: T(40),
        caller_refund: bn(0n), setup_prefunded: bn(0n), platform_fee: bn(0n) }, 24)]],
    ];
    for (const [s, evs] of list) expect((await ing.ingest(tx(s, evs), "rpc", "confirmed")).status).toBe("applied");
    const t = (await db.query("SELECT sol_amount, snipe_tax, snipe_tax_bps, ts FROM trades WHERE mint = $1", [coinOld.toBase58()])).rows[0];
    expect(t).toEqual({ sol_amount: "1000000000", snipe_tax: "0", snipe_tax_bps: 0, ts: "1800000031" });
    const c = (await db.query("SELECT status, raised_lamports, snipe_tax_lamports, graduation_caller_refund, graduation_platform_fee FROM coins WHERE mint = $1", [coinOld.toBase58()])).rows[0];
    expect(c).toEqual({ status: "graduated", raised_lamports: "85000000000", snipe_tax_lamports: "0", graduation_caller_refund: null, graduation_platform_fee: null });
  });

  it("replay rebuilds both coins to the same state (legacy raw re-decodes)", async () => {
    const snap = async () =>
      (await db.query(
        `SELECT mint, status, snipe_tax_lamports, snipe_taxed_buys, pool_inflow_lamports, graduation_caller_refund, graduation_setup_prefunded, graduation_platform_fee,
                (SELECT json_agg(json_build_object('t', snipe_tax, 'b', snipe_tax_bps) ORDER BY slot) FROM trades t WHERE t.mint = c.mint) AS trades
           FROM coins c ORDER BY mint`,
      )).rows;
    const before = await snap();
    await replayMint(db, coinNew.toBase58(), P);
    await replayMint(db, coinOld.toBase58(), P);
    expect(await snap()).toEqual(before);
  });

  it("API: trades, coin summary, feed and params carry the snipe fields", async () => {
    const repo = new Repo(db);
    const trades = await repo.getRecentTrades(coinNew.toBase58());
    const sn = trades.find((x) => x.wallet === sniper.toBase58())!;
    expect(sn.snipeTaxSol).toBeCloseTo(0.99, 9);
    expect(sn.snipeTaxBps).toBe(9_900);
    expect(trades.filter((x) => x.snipeTaxSol !== undefined)).toHaveLength(1);
    const coin = await repo.getCoin("SNIP");
    expect(coin?.snipeTaxSol).toBeCloseTo(0.99, 9);
    expect(coin?.snipeTaxedBuys).toBe(1);
    expect(coin?.poolInflowSol).toBeCloseTo(0.99 + 0.01255, 9);
    expect((await repo.getCoin("OLD"))?.snipeTaxSol).toBeUndefined();
    const list = await repo.listCoins({ sort: "new" });
    expect(list.find((x) => x.symbol === "SNIP")?.snipeTaxSol).toBeCloseTo(0.99, 9);
    const feed = await repo.getFeed({ kind: "launch" });
    expect(feed.find((f) => f.symbol === "SNIP")).toMatchObject({ kind: "launch", snipeTaxSol: 0.99 });
    expect(feed.find((f) => f.symbol === "OLD")).not.toHaveProperty("snipeTaxSol");
    const p = await repo.getParams();
    expect(p).toMatchObject({ snipeWindowSlots: 4, snipeStartBps: 9_900, graduationFeeSol: 0.65, initialVirtualTokens: 988_744_870.180001 });
    // Ledger cost basis: the sniper's buy costs sol + fees + tax.
    const led = await repo.ledger(sniper.toBase58());
    expect(led[0].lamports).toBe(10_100_000n + TAX);
  });

  it("params cached by a v0.4 indexer (no snipe keys) read as snipe off", async () => {
    const { snipeWindowSlots: _w, snipeStartBps: _s, ...old } = storeable(P);
    await setMeta(db, "global", { params: old });
    const p = await new Repo(db).getParams();
    expect(p.snipeWindowSlots).toBe(0);
    expect(p.snipeStartBps).toBe(0);
    expect(p.feeBps).toBe(100);
  });
});
