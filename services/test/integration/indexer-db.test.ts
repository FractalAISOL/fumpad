/**
 * Indexer v0.7 → Postgres → API without a validator:
 *  - a coin registered by a (synthetic, borsh-exact) CoinRegistered event, whose DBC pool is the pool of a
 *    RECORDED MAINNET coin (engine/test/fixtures/coin_b), then that coin's real finalized history ingested
 *    through the Meteora pipeline (any app) → trades / positions / price / charts;
 *  - attested tickets, debits, claims and the queue from synthetic fumpad events;
 *  - idempotency, replay to the same state, rollback of a dropped tx, and the API mapping.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bn, DEFAULT_PARAMS, EVENT_IX_TAG, eventAuthorityPda, FUMPAD_IDL, FUMPAD_PROGRAM_ID, fumpadCoder, type Params, q64ToSolPerToken, type TxLike } from "@fumpad/sdk";
import { createLogger, createPool, type Db, Finalizer, Ingestor, MeteoraIngestor, migrate, replayMint, setMeta, storeable } from "@fumpad/indexer";
import { Repo } from "@fumpad/api";
import type { ConfirmedTx } from "@fumpad/meteora";

import { type Postgres, startPostgres } from "../../scripts/local/harness.js";
import { CANDLE_INTERVALS, CANDLE_SECS, CANDLE_WINDOW } from "../../api/src/candles.js";
// the app's own bucketing is the reference the API's SQL must match
import { candlesFromPoints, windowStart } from "../../../app/src/data/candles.js";

const here = dirname(fileURLToPath(import.meta.url));
const F = JSON.parse(gunzipSync(readFileSync(join(here, "../../engine/test/fixtures/coin_b.history.json.gz"))).toString()) as {
  coin: { mint: string; creator: string; dbcPool: string; config: string };
  history: { tx: ConfirmedTx; txIndex: number }[];
};
const P: Params = { ...DEFAULT_PARAMS, oracleWindowSecs: 60n, oracleMinSpacingSecs: 2n, oracleMinSamples: 3 };
const k = () => Keypair.generate().publicKey;
const mint = new PublicKey(F.coin.mint);
const creator = new PublicKey(F.coin.creator);
const evAuth = eventAuthorityPda().toBase58();
const launchTs = F.history[0].tx.blockTime!;

function ev(name: string, data: Record<string, unknown>): Uint8Array {
  const disc = (FUMPAD_IDL.events as { name: string; discriminator: number[] }[]).find((e) => e.name === name)!.discriminator;
  return Uint8Array.from([...EVENT_IX_TAG, ...disc, ...fumpadCoder().types.encode(name, data)]);
}
let slot = F.history[F.history.length - 1].tx.slot + 10;
function tx(sig: string, events: Uint8Array[], at?: number): TxLike {
  slot += 1;
  return {
    slot,
    blockTime: at ?? launchTs + 100_000 + slot,
    transaction: { signatures: [sig], message: { accountKeys: [k().toBase58(), FUMPAD_PROGRAM_ID.toBase58(), evAuth], instructions: [] } },
    meta: { err: null, logMessages: [], innerInstructions: [{ index: 0, instructions: events.map((d) => ({ programIdIndex: 1, accounts: [2], data: bs58.encode(d) })) }] },
  };
}
const sigOf = (n: number) => bs58.encode(new Uint8Array(64).fill(n));

let pg: Postgres;
let db: Db;
let ing: Ingestor;
let met: MeteoraIngestor;
const log = createLogger("test", "warn");

beforeAll(async () => {
  pg = await startPostgres(54339);
  db = createPool(pg.url, 4);
  await migrate(db);
  await setMeta(db, "global", { params: storeable(P) });
  ing = new Ingestor({ db, log, params: () => P });
  met = new MeteoraIngestor(db, { dbcConfigs: [], mints: [] }, log, { params: () => P });
}, 120_000);
afterAll(async () => {
  await db?.end();
  await pg?.stop();
});

const ticketA = k();
const trader = k();

describe("indexer v0.7 → db → api", () => {
  it("registers the coin, then ingests its real mainnet history from the Meteora pipeline", async () => {
    // CoinRegistered as the launch tx would emit it (applied first; the swaps of the launch tx come from Meteora).
    const reg = tx(sigOf(1), [ev("CoinRegistered", { mint, creator, dbc_pool: new PublicKey(F.coin.dbcPool), dbc_config: new PublicKey(F.coin.config), launch_slot: bn(1n), launch_window_slots: bn(8n), ts: bn(BigInt(launchTs)) })], launchTs);
    reg.slot = F.history[0].tx.slot;
    expect((await ing.ingest(reg, "rpc", "finalized")).status).toBe("applied");
    let swaps = 0;
    for (const h of F.history) {
      const r = await met.ingest(h.tx, "backfill", "finalized");
      swaps += r.trades;
    }
    expect(swaps).toBeGreaterThan(50);
    const t = await db.query<{ n: number; venues: string[] }>("SELECT count(*)::int n, array_agg(DISTINCT venue) venues FROM trades WHERE mint = $1", [mint.toBase58()]);
    expect(t.rows[0].n).toBe(swaps);
    expect(t.rows[0].venues.sort()).toEqual(["damm_v2", "dbc"]);
    const c = (await db.query("SELECT * FROM coins WHERE mint = $1", [mint.toBase58()])).rows[0];
    expect(Number(c.trade_count)).toBe(swaps);
    expect(BigInt(c.price_q64)).toBeGreaterThan(0n);
    expect(c.status).toBe("complete"); // saw the curve-completing swap; Graduated not emitted here
    const holders = await db.query<{ n: number }>("SELECT count(*)::int n FROM positions WHERE mint = $1 AND balance > 0", [mint.toBase58()]);
    expect(holders.rows[0].n).toBeGreaterThan(0);
  });

  it("a re-delivered Meteora tx is a duplicate (no double counting)", async () => {
    const before = (await db.query("SELECT volume_lamports, trade_count FROM coins")).rows[0];
    const r = await met.ingest(F.history.find((h) => h.tx.meta && !h.tx.meta.err)!.tx, "rpc", "finalized");
    expect(r.status).toBe("duplicate");
    expect((await db.query("SELECT volume_lamports, trade_count FROM coins")).rows[0]).toEqual(before);
  });

  it("attested tickets, debits, voids, queue and claims", async () => {
    // effective_at (contracts §8.4): = ts, or later when the coin's attestation rate cap deferred the ticket
    const att = (ticket: PublicKey, owner: PublicKey, sig: number, tokens: bigint, deferSecs = 0) =>
      ev("TicketAttested", {
        mint, owner, ticket, seq: bn(0n), pool: new PublicKey(F.coin.dbcPool), venue: 0, source: 1, signature: Array.from(new Uint8Array(64).fill(sig)), ix_key: 0,
        base_amount: bn(tokens), quote_gross: bn(1_000_000_000n), tokens: bn(tokens), sell_price_q64: bn(1n << 50n), sell_usd_cents: bn(15_000n),
        pyth_publish_time: bn(0n), slot: bn(1n), sell_ts: bn(BigInt(launchTs + 1_000)), keepers: [k(), k()], submitter: k(), ts: bn(BigInt(launchTs + 1_100)),
        effective_at: bn(BigInt(launchTs + 1_100 + deferSecs)),
      });
    await ing.ingest(tx(sigOf(2), [att(ticketA, trader, 9, 1_000_000_000n, 300)]), "rpc", "finalized");
    const t = (await db.query("SELECT * FROM tickets WHERE ticket = $1", [ticketA.toBase58()])).rows[0];
    expect(t).toMatchObject({ source: "router", venue: "dbc", sell_signature: sigOf(9), status: "open", attested_at: String(launchTs + 1_100), effective_at: String(launchTs + 1_400) });
    expect(t.keepers).toHaveLength(2);
    await ing.ingest(tx(sigOf(3), [ev("TicketDebited", { ticket: ticketA, mint, owner: trader, signature: Array(64).fill(4), ix_key: 0xffffffff, debited: bn(400_000_000n), remaining: bn(600_000_000n), voided: false, ts: bn(BigInt(launchTs + 1_200)) })]), "rpc", "finalized");
    await ing.ingest(tx(sigOf(4), [ev("ClaimQueued", { mint, ticket: ticketA, owner: trader, amount: bn(60_000_000n), queue_len: 1, ts: bn(BigInt(launchTs + 1_300)), triggered_by: trader })]), "rpc", "confirmed");
    const q = await db.query("SELECT * FROM queue_entries");
    expect(q.rows).toHaveLength(1);
    const after = (await db.query("SELECT tokens, debited, status FROM tickets WHERE ticket = $1", [ticketA.toBase58()])).rows[0];
    expect(after).toEqual({ tokens: "600000000", debited: "400000000", status: "queued" });
    const ticketB = k();
    await ing.ingest(tx(sigOf(5), [att(ticketB, k(), 10, 2_000_000_000n), ev("TicketVoided", { ticket: ticketB, mint, owner: trader, reason: 1, authority: k(), ts: bn(BigInt(launchTs + 1_400)) })]), "rpc", "finalized");
    expect((await db.query("SELECT status, void_reason FROM tickets WHERE ticket = $1", [ticketB.toBase58()])).rows[0]).toEqual({ status: "voided", void_reason: "guardian" });
  });

  it("replays the mint from raw events (fumpad + Meteora) to the same state", async () => {
    const snap = async () => ({
      coin: (await db.query("SELECT trade_count, volume_lamports, price_q64, tickets_created, tickets_open, queue_owed, status FROM coins WHERE mint = $1", [mint.toBase58()])).rows,
      trades: (await db.query("SELECT signature, idx, wallet, token_amount, sol_amount, venue FROM trades ORDER BY signature, idx")).rows,
      tickets: (await db.query("SELECT ticket, tokens, status FROM tickets ORDER BY ticket")).rows,
      positions: (await db.query("SELECT wallet, balance FROM positions ORDER BY wallet")).rows,
    });
    const before = await snap();
    const n = await replayMint(db, mint.toBase58(), P);
    expect(n).toBeGreaterThan(50);
    expect(await snap()).toEqual(before);
  });

  it("rolls back a dropped (never finalized) transaction", async () => {
    const fin = new Finalizer({ getSignatureStatuses: async () => ({ value: [null] }), getTransaction: async () => null } as never, db as never, () => P, log, { dropMisses: 1, dropAfterSecs: -1, minAgeSecs: 0, batch: 10, maxBatches: 2 });
    await fin.runOnce();
    await fin.runOnce();
    expect((await db.query("SELECT count(*)::int n FROM queue_entries")).rows[0].n).toBe(0);
    expect((await db.query("SELECT status FROM tickets WHERE ticket = $1", [ticketA.toBase58()])).rows[0].status).toBe("open");
  });

  it("API repo maps rows to the app's v0.7 types", async () => {
    const repo = new Repo(db);
    const c = await repo.getCoinByMint(mint.toBase58());
    expect(c?.dbcPool).toBe(F.coin.dbcPool);
    expect(c?.trades24h).toBeGreaterThanOrEqual(0);
    const trades = await repo.getRecentTrades(mint.toBase58(), 5);
    expect(trades.length).toBe(5);
    expect(trades.every((t) => t.venue === "dbc" || t.venue === "damm")).toBe(true);
    const tickets = await repo.getTickets(trader.toBase58());
    const a = tickets.find((t) => t.id === ticketA.toBase58())!;
    expect(a.source).toBe("router");
    expect(a.sellSignature).toBe(sigOf(9));
    expect(a.attestedAt).toBe((launchTs + 1_100) * 1000);
    expect(a.effectiveAt).toBe((launchTs + 1_400) * 1000); // deferred by the rate cap: the window runs from here
    expect(a.claimableFrom).toBe((launchTs + 1_400 + 21_600) * 1000);
    const p = await repo.getParams();
    expect(p.ticketChallengeSecs).toBe(21_600);
    expect(p.feeBps).toBe(125);
    void Connection;
  });

  it("chart candles (getCandles): Postgres OHLC buckets of the real history = the app's own bucketing", async () => {
    const repo = new Repo(db);
    const m = mint.toBase58();
    const pts = (
      await db.query<{ ts: string; vs: string | null; vt: string | null; pq: string | null }>(
        `SELECT t.ts, t.slot, x.seq, t.idx, t.virtual_sol vs, t.virtual_tokens vt, NULL::numeric pq FROM trades t JOIN transactions x USING (signature) WHERE t.mint = $1 AND t.virtual_tokens > 0
         UNION ALL SELECT s.ts, x.slot, x.seq, s.idx, NULL, NULL, s.price_q64 FROM samples s JOIN transactions x USING (signature) WHERE s.mint = $1 AND NOT s.fallback
         ORDER BY ts, slot, seq, idx`,
        [m],
      )
    ).rows.map((r) => ({ ts: Number(r.ts), p: q64ToSolPerToken(r.pq ? BigInt(r.pq) : (BigInt(r.vs!) << 64n) / BigInt(r.vt!)) }));
    const created = Number((await db.query("SELECT created_at FROM coins WHERE mint = $1", [m])).rows[0].created_at);
    // the curve's start price (what the line chart starts at)
    const init = q64ToSolPerToken(await (repo as unknown as { initialPriceQ64(): Promise<bigint> }).initialPriceQ64());
    const last = pts[pts.length - 1].ts;
    expect(pts.length).toBeGreaterThan(50);
    // the app's reference: window → points → candlesFromPoints (+ the curve's start price at launch)
    const reference = (iv: "1m" | "5m" | "30m", now: number) => {
      const from = windowStart(iv, now * 1000, created * 1000) / 1000;
      const inWin = pts.filter((x) => x.ts >= from && x.ts < Math.floor(now / CANDLE_SECS[iv]) * CANDLE_SECS[iv] + CANDLE_SECS[iv]).map((x) => ({ t: x.ts * 1000, p: x.p }));
      const before = pts.filter((x) => x.ts < from);
      const open = created < from ? (before.length ? before[before.length - 1].p : init) : undefined;
      const points = created >= from ? [{ t: created * 1000, p: init }, ...inWin] : inWin;
      return { interval: iv, from: from * 1000, ...(open !== undefined ? { open } : {}), candles: candlesFromPoints(points, iv, open) };
    };
    // right after launch (launch candle + start price), mid-history (carried-in open, window cut), long after (flat: no candles)
    for (const iv of CANDLE_INTERVALS)
      for (const now of [created + 90, Math.round((created + last) / 2), last + 600, last + 10 * 86_400]) {
        const got = await repo.getCandles(m, iv, now);
        const want = reference(iv, now);
        expect(got.from).toBe(want.from);
        expect(got.open).toBe(want.open);
        expect(got.candles).toEqual(want.candles);
        expect(got.candles.length).toBeLessThanOrEqual(CANDLE_WINDOW);
      }
    const mid = await repo.getCandles(m, "1m", last);
    expect(mid.candles.length).toBeGreaterThan(3);
    expect(mid.candles.every((c) => c.l <= Math.min(c.o, c.c) && c.h >= Math.max(c.o, c.c) && c.n > 0)).toBe(true);
    expect(mid.candles.slice(1).every((c, i) => c.o === mid.candles[i].c)).toBe(true); // continuous
    expect((await repo.getCandles(m, "1m", last + 10 * 86_400)).candles).toEqual([]);
    expect(await repo.getCandles(k().toBase58(), "5m", last)).toMatchObject({ interval: "5m", candles: [] });
  });

  it("Fumble Checker: a real seller's sells from indexed trades, an attested one matched to its ticket", async () => {
    const repo = new Repo(db);
    // The mainnet wallet with the most sells of the recorded coin.
    const top = (
      await db.query<{ wallet: string; n: number }>("SELECT wallet, count(*)::int n FROM trades WHERE mint = $1 AND NOT is_buy GROUP BY wallet ORDER BY n DESC, wallet LIMIT 1", [mint.toBase58()])
    ).rows[0];
    const sells = (
      await db.query<{ signature: string; idx: number; token_amount: string; sol_amount: string; ts: string }>(
        "SELECT signature, idx, token_amount, sol_amount, ts FROM trades WHERE mint = $1 AND wallet = $2 AND NOT is_buy ORDER BY slot, idx",
        [mint.toBase58(), top.wallet],
      )
    ).rows;
    // Attest its last sell (the indexer stores the sell's signature + ix_key; the checker joins on them).
    const last = sells[sells.length - 1];
    const tk = k();
    await ing.ingest(
      tx(sigOf(30), [
        ev("TicketAttested", {
          mint, owner: new PublicKey(top.wallet), ticket: tk, seq: bn(0n), pool: new PublicKey(F.coin.dbcPool), venue: 0, source: 0,
          signature: Array.from(bs58.decode(last.signature)), ix_key: Number(last.idx), base_amount: bn(BigInt(last.token_amount)), quote_gross: bn(BigInt(last.sol_amount)),
          tokens: bn(BigInt(last.token_amount)), sell_price_q64: bn(1n << 40n), sell_usd_cents: bn(12_345n), pyth_publish_time: bn(0n), slot: bn(1n),
          sell_ts: bn(BigInt(last.ts)), keepers: [k(), k()], submitter: k(), ts: bn(BigInt(last.ts) + 60n), effective_at: bn(BigInt(last.ts) + 60n),
        }),
      ]),
      "rpc",
      "finalized",
    );
    const r = await repo.walletFumbles(top.wallet, mint.toBase58(), 150);
    expect(r).toMatchObject({ wallet: top.wallet, found: true });
    expect(r.coins).toHaveLength(1);
    const c = r.coins[0];
    expect(c.coin.mint).toBe(mint.toBase58());
    expect(c.fees?.feeBps).toBe(125);
    expect(c.sells).toHaveLength(sells.length);
    expect(c.sells.map((s) => s.ts)).toEqual([...c.sells.map((s) => s.ts)].sort((a, b) => b - a));
    const attested = c.sells.find((s) => s.signature === last.signature)!;
    expect(attested).toMatchObject({ outcome: "ticket", usd: 123.45, usdBasis: "attested", checks: { usd: "ok", hold: "ok", creator: "ok" } });
    expect(attested.ticket?.id).toBe(tk.toBase58());
    expect(attested.target!.targetMarketCapSol).toBeCloseTo(attested.ticket!.sellPrice * 10 * 1e9, 3);
    // Every other sell is assessed from indexed trades: an outcome, a reason when there's no ticket, a USD value.
    for (const s of c.sells.filter((x) => x !== attested)) {
      expect(["verifying", "no-ticket"]).toContain(s.outcome);
      if (s.outcome === "no-ticket") expect(s.reason).toBeTruthy();
      expect(s.usd).toBeGreaterThanOrEqual(0);
      expect(s.usdBasis === "nearby" || s.usdBasis === "current").toBe(true);
    }
    // All coins (no mint): the same coin, last sell first. The synthetic trader's ticket has no indexed trade.
    expect((await repo.walletFumbles(top.wallet, undefined, 150)).coins.map((x) => x.coin.mint)).toEqual([mint.toBase58()]);
    const t = await repo.walletFumbles(trader.toBase58(), undefined, 150);
    expect(t.found).toBe(true);
    expect(t.coins[0].sells.find((s) => s.ticket?.id === ticketA.toBase58())).toMatchObject({ outcome: "ticket", signature: sigOf(9) });
    // Unknown wallet / coin.
    expect(await repo.walletFumbles(k().toBase58(), mint.toBase58(), 150)).toMatchObject({ found: false, coins: [{ sells: [] }] });
    expect(await repo.walletFumbles(k().toBase58(), k().toBase58(), 150)).toMatchObject({ found: false, coins: [] });
  });
});
