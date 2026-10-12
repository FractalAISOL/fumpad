/**
 * API load test at mainnet-like volume.
 *
 *   npx tsx scripts/loadtest.ts [--coins 5000] [--trades 2000000] [--tickets 200000] [--wallets 50000]
 *                               [--requests 150] [--concurrency 8] [--cache] [--reseed] [--no-ws]
 *                               [--out .local/loadtest-<label>.json] [--label after]
 *
 * 1. Postgres: `DATABASE_URL` if set, else a scratch `initdb` cluster in `.local/pg-loadtest`
 *    (port 54360, kept between runs, stopped at the end).
 * 2. Seed (when the DB is empty, smaller than asked, or `--reseed`): synthetic but realistic
 *    distributions, all generated inside Postgres — coin popularity is a power law (the top 1%
 *    of coins carry ~15% of trades), wallets are skewed (a few whales, a long tail), ~5% of coins
 *    graduated with keeper samples every 8 min, tickets come from real sell rows with a status mix
 *    (open / expired / claimed / queued / voided), claims + queue entries + feed events + flags,
 *    and `user_stats` from the indexer's own derive SQL. Then ANALYZE.
 * 3. HTTP: the real Fastify server (`buildServer`) on a random port with the response cache
 *    DISABLED (every request hits Postgres; `--cache` keeps it) and no RPC (quotes and chain
 *    balances are not measured — `/v1/quote` = coin detail + RPC). Per endpoint: warmup, then
 *    `--requests` at `--concurrency`, p50/p95/p99/max.
 * 4. WebSocket burst: 50 clients connected to /v1/ws; 200 trades/s across 50 coins for 10 s,
 *    each committed + NOTIFYed exactly like the indexer does. Reports per-coin `coin` message
 *    rate, NOTIFY → client latency, backlog drain time, and the fan-out cost per message.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { Connection } from "@solana/web3.js";

import { createLogger, createPool, type Db, Deriver, migrate, NOTIFY_CHANNEL } from "@fumpad/indexer";
import { buildServer, ChainReader, loadApiConfig, TtlCache } from "@fumpad/api";

import { LOCAL, SERVICES } from "./local/harness.js";

const { values: args } = parseArgs({
  options: {
    coins: { type: "string", default: "5000" },
    trades: { type: "string", default: "2000000" },
    tickets: { type: "string", default: "200000" },
    wallets: { type: "string", default: "50000" },
    requests: { type: "string", default: "150" },
    concurrency: { type: "string", default: "8" },
    cache: { type: "boolean", default: false },
    reseed: { type: "boolean", default: false },
    "no-ws": { type: "boolean", default: false },
    "ws-clients": { type: "string", default: "50" },
    "burst-rate": { type: "string", default: "200" },
    "burst-coins": { type: "string", default: "50" },
    "burst-secs": { type: "string", default: "10" },
    label: { type: "string", default: "run" },
    out: { type: "string" },
    only: { type: "string" },
  },
});
const N = {
  coins: Number(args.coins),
  trades: Number(args.trades),
  tickets: Number(args.tickets),
  wallets: Number(args.wallets),
};

// ── Postgres ──────────────────────────────────────────────────────────────────
const PATH = `/opt/homebrew/opt/postgresql@18/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`;
function startScratchPostgres(port = 54360): { url: string; stop: () => void } {
  if (process.env.DATABASE_URL) return { url: process.env.DATABASE_URL, stop: () => {} };
  const dir = join(LOCAL, "pg-loadtest");
  const env = { ...process.env, PATH };
  mkdirSync(LOCAL, { recursive: true });
  const fresh = !existsSync(join(dir, "PG_VERSION"));
  if (fresh) execFileSync("initdb", ["-D", dir, "-U", "fumpad", "--auth=trust", "-E", "UTF8"], { env, stdio: "ignore" });
  // Laptop-ish settings close to a small managed Postgres.
  const opts = `-p ${port} -c unix_socket_directories= -c listen_addresses=127.0.0.1 -c shared_buffers=512MB -c work_mem=16MB -c max_connections=200 -c fsync=off -c synchronous_commit=off -c full_page_writes=off`;
  try {
    execFileSync("pg_ctl", ["-D", dir, "-o", opts, "-l", join(dir, "log.txt"), "-w", "start"], { env, stdio: "ignore" });
  } catch {
    /* already running */
  }
  if (fresh) execFileSync("createdb", ["-h", "127.0.0.1", "-p", String(port), "-U", "fumpad", "fumpad"], { env, stdio: "ignore" });
  return {
    url: `postgres://fumpad@127.0.0.1:${port}/fumpad`,
    stop: () => {
      try {
        execFileSync("pg_ctl", ["-D", dir, "-m", "fast", "-w", "stop"], { env, stdio: "ignore" });
      } catch {
        /* already stopped */
      }
    },
  };
}

// ── seed ──────────────────────────────────────────────────────────────────────
/** Synthetic base58 addresses (no 0/O/I/l), unique per (tag, n). */
const ADDR_FN = `
CREATE OR REPLACE FUNCTION lt_addr(tag text, n bigint, tail text DEFAULT 'AbCdEfGhJkMnPqRsTuVw') RETURNS text
  LANGUAGE sql IMMUTABLE AS $$ SELECT tag || translate(lpad(n::text, 12, '0'), '0', 'z') || tail $$;`;

async function seed(pool: Db, now: number) {
  const t0 = Date.now();
  // One session (temp tables); `$1` is the seed's "now" (inlined: multi-statement steps take no params).
  const db = await pool.connect();
  try {
    await seedWith(db, pool, now);
  } finally {
    db.release();
  }
  console.log(`seeded in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

async function seedWith(db: import("pg").PoolClient, pool: Db, now: number) {
  const step = async (name: string, sql: string, params: unknown[] = []) => {
    const s = Date.now();
    await db.query(params.length ? sql.replace(/\$1\b/g, String(params[0])) : sql);
    console.log(`  seed ${name.padEnd(16)} ${((Date.now() - s) / 1000).toFixed(1)} s`);
  };
  const DAY = 86_400;
  const SPAN = 30 * DAY;
  await db.query(ADDR_FN);
  await step(
    "truncate",
    `TRUNCATE transactions, events, coins, trades, tickets, ticket_debits, claims, queue_entries, samples, buybacks, fee_withdrawals,
              lp_locks, lp_skims, lp_settlements, holdings_registered, positions, users, feed_events, external_trades,
              wallet_funding, wallet_clusters, wallet_flags, user_stats CASCADE`,
  );
  await db.query("DO $$ BEGIN IF to_regclass('coin_hourly') IS NOT NULL THEN TRUNCATE coin_hourly, coin_holders; END IF; END $$");
  // Bulk load without row triggers (and FK checks); maintained aggregates are rebuilt at the end.
  await db.query("SET session_replication_role = replica");
  await db.query("SELECT setseed(0.4242)");
  // Coins: id 1 is the hottest. ~5% graduated, mostly among popular coins.
  await step(
    "coins",
    `CREATE TEMP TABLE lt_coin AS
     SELECT i, lt_addr('Mt', i, 'AbCdEfGhJkMnPqRsfmbL') AS mint, lt_addr('Wa', 1 + floor(${N.wallets} * random())::int) AS creator,
            ($1::bigint - floor(${SPAN} * random()))::bigint AS created_at,
            (random() < CASE WHEN i <= 200 THEN 0.7 ELSE 0.02 END) AS grad,
            random() AS progress
       FROM generate_series(1, ${N.coins}) i;
     ALTER TABLE lt_coin ADD COLUMN graduated_at bigint;
     UPDATE lt_coin SET graduated_at = created_at + floor(($1 - created_at) * (0.1 + 0.4 * random())) WHERE grad;
     INSERT INTO coins (mint, creator, name, symbol, uri, created_at, created_sig, status, graduated_at, completed_at, amm_pool,
                        raised_lamports, virtual_sol, virtual_tokens, real_sol, real_tokens, amm_base, amm_quote, price_q64, median_q64, median_samples,
                        volume_lamports, trade_count, pool_seeded, pool_tokens, metadata)
     SELECT mint, creator, 'Coin ' || i, 'C' || i, 'ipfs://pending', created_at, 'L' || i,
            CASE WHEN grad THEN 'graduated' ELSE 'curve' END, graduated_at, graduated_at,
            CASE WHEN grad THEN lt_addr('Po', i) END,
            CASE WHEN grad THEN 85000000000 ELSE 0 END,
            vs, (30000000000::numeric * 988744870180001 / vs)::numeric(40,0),
            CASE WHEN grad THEN 0 ELSE vs - 30000000000 END,
            CASE WHEN grad THEN 0 ELSE greatest(730811425785218 - (988744870180001 - 30000000000::numeric * 988744870180001 / vs), 0)::numeric(40,0) END,
            CASE WHEN grad THEN 189188574214782 END, CASE WHEN grad THEN 115000000000 END,
            (vs * 18446744073709551616 / (30000000000::numeric * 988744870180001 / vs))::numeric(40,0),
            CASE WHEN grad THEN (vs * 18446744073709551616 / (30000000000::numeric * 988744870180001 / vs) * (0.9 + 0.2 * random()))::numeric(40,0) END,
            CASE WHEN grad THEN 6 ELSE 0 END, 0, 0,
            80000000000000, (80000000000000 * (0.2 + 0.8 * random()))::numeric(40,0),
            jsonb_build_object('description', 'Synthetic coin ' || i, 'image', 'https://example.com/' || i || '.png')
       FROM (SELECT *, (30000000000 + CASE WHEN grad THEN 115000000000 ELSE floor(85000000000 * progress) END)::numeric AS vs FROM lt_coin) x`,
    [now],
  );
  await step("users", `INSERT INTO users (address, first_seen, last_seen) SELECT lt_addr('Wa', i), $1 - ${SPAN}, $1 FROM generate_series(1, ${N.wallets}) i`, [now]);
  // Trades: coin ~ power law, wallet ~ skewed, time uniform over the coin's life.
  await step(
    "trades(tmp)",
    `CREATE TEMP TABLE lt_trade AS
     SELECT n, c.mint, c.created_at, c.graduated_at, c.created_at + floor(($1 - c.created_at) * random())::bigint AS ts,
            lt_addr('Wa', 1 + floor(${N.wallets} * power(random(), 1.6))::int) AS wallet, random() < 0.55 AS is_buy,
            (10000000 * exp(random() * 6))::numeric(40,0) AS sol, cv.virtual_sol AS cvs, c.grad
       FROM (SELECT n, 1 + floor(${N.coins} * power(random(), 2.5))::int AS ci FROM generate_series(1, ${N.trades}) n) g
       JOIN lt_coin c ON c.i = g.ci JOIN coins cv ON cv.mint = c.mint`,
    [now],
  );
  await step("transactions", `INSERT INTO transactions (signature, slot, block_time, commitment, source, kind, event_count) SELECT 'S' || n, n, ts, 'finalized', 'backfill', 'fumpad', 1 FROM lt_trade`);
  await step(
    "trades",
    `INSERT INTO trades (signature, idx, slot, ts, mint, wallet, is_buy, on_amm, token_amount, sol_amount, fee_pool, fee_platform, fee_creator,
                         pool_tokens_bought, price_q64, virtual_sol, virtual_tokens)
     SELECT 'S' || n, 0, n, ts, mint, wallet, is_buy, grad AND ts > graduated_at, (sol * vt / vs)::numeric(40,0), sol, sol / 200, sol * 3 / 1000, sol / 1000,
            CASE WHEN grad AND ts > graduated_at THEN (sol * vt / vs / 400)::numeric(40,0) ELSE 0 END,
            (vs * 18446744073709551616 / vt)::numeric(40,0), vs::numeric(40,0), vt::numeric(40,0)
       FROM (SELECT *, (30000000000 + (cvs - 30000000000) * (ts - created_at) / greatest($1 - created_at, 1))::numeric AS vs FROM lt_trade) a
       CROSS JOIN LATERAL (SELECT (30000000000::numeric * 988744870180001 / vs) AS vt) b`,
    [now],
  );
  await step(
    "coin totals",
    `UPDATE coins c SET volume_lamports = t.v, trade_count = t.n, last_trade_at = t.last, pool_inflow_lamports = t.pi
       FROM (SELECT mint, sum(sol_amount) v, count(*) n, max(ts) last, sum(fee_pool) pi FROM trades GROUP BY mint) t WHERE t.mint = c.mint`,
  );
  await step(
    "positions",
    `INSERT INTO positions (mint, wallet, balance, bought, sold, sol_in, sol_out, buys, sells, first_ts, last_ts)
     SELECT mint, wallet, greatest(sum(CASE WHEN is_buy THEN token_amount ELSE 0 END) - sum(CASE WHEN is_buy THEN 0 ELSE token_amount END) / 2, 0),
            sum(CASE WHEN is_buy THEN token_amount ELSE 0 END), sum(CASE WHEN is_buy THEN 0 ELSE token_amount END),
            sum(CASE WHEN is_buy THEN sol_amount ELSE 0 END), sum(CASE WHEN is_buy THEN 0 ELSE sol_amount END),
            count(*) FILTER (WHERE is_buy), count(*) FILTER (WHERE NOT is_buy), min(ts), max(ts)
       FROM trades GROUP BY mint, wallet`,
  );
  // Tickets from sells. Status mix; open tickets inside the 90-day claim window by construction.
  await step(
    "tickets",
    `INSERT INTO tickets (ticket, mint, owner, seq, tokens, original_tokens, sell_price_q64, exec_price_q64, sell_usd_cents, sell_lamports, sell_ts,
                          status, queued_at, claim_amount, claimed_at, claim_sig, claim_median_q64, peak_multiple, last_multiple, crossed_at, crossed_multiple,
                          created_sig, created_slot)
     SELECT lt_addr('Tk', rn), x.mint, x.wallet, rn, x.token_amount, x.token_amount, x.price_q64, x.price_q64, (x.sol_amount / 1e9 * 150 * 100)::numeric(40,0),
            x.sol_amount, x.ts, st, CASE WHEN st = 'queued' THEN x.ts + 3600 END,
            CASE WHEN st IN ('claimed','queued') THEN x.token_amount / 2 ELSE 0 END,
            CASE WHEN st = 'claimed' THEN least(x.ts + 86400, $1) END, CASE WHEN st = 'claimed' THEN 'S' || x.slot END,
            CASE WHEN st = 'claimed' THEN cur END,
            greatest(m, m * (1 + random())), m, CASE WHEN m >= 10 THEN least(x.ts + 7200, $1) END, CASE WHEN m >= 10 THEN m END,
            x.signature, x.slot
       FROM (SELECT t.*, row_number() OVER () AS rn, r,
                    COALESCE(c.median_q64, c.price_q64) AS cur,
                    (COALESCE(c.median_q64, c.price_q64) / t.price_q64)::float8 AS m,
                    CASE WHEN r < 0.6 THEN 'open' WHEN r < 0.85 THEN 'expired' WHEN r < 0.93 THEN 'claimed' WHEN r < 0.95 THEN 'queued' ELSE 'voided' END AS st
               FROM (SELECT *, random() AS r FROM trades WHERE NOT is_buy) t JOIN coins c USING (mint)
              ORDER BY t.r LIMIT ${N.tickets}) x`,
    [now],
  );
  await step(
    "claims+queue",
    `INSERT INTO claims (signature, idx, mint, ticket, owner, amount, from_queue, median_q64, sell_price_q64, ts, triggered_by)
     SELECT claim_sig, 1, mint, ticket, owner, claim_amount, false, claim_median_q64, sell_price_q64, claimed_at, owner FROM tickets WHERE status = 'claimed';
     INSERT INTO queue_entries (ticket, mint, owner, amount, sell_ts, queued_at) SELECT ticket, mint, owner, claim_amount, sell_ts, queued_at FROM tickets WHERE status = 'queued';
     UPDATE coins c SET tickets_created = t.n, tickets_open = t.o, queue_owed = t.q
       FROM (SELECT mint, count(*) n, count(*) FILTER (WHERE status IN ('open','queued')) o, COALESCE(sum(claim_amount) FILTER (WHERE status = 'queued'),0) q FROM tickets GROUP BY mint) t
      WHERE t.mint = c.mint`,
  );
  // Keeper samples every 8 min on graduated coins (+ their transactions).
  await step(
    "samples",
    `CREATE TEMP TABLE lt_sample AS
     SELECT row_number() OVER () AS n, c.mint, s.ts, (c.median_q64 * (0.8 + 0.4 * random()))::numeric(40,0) AS q
       FROM coins c CROSS JOIN LATERAL generate_series(c.graduated_at, $1, 480) s(ts) WHERE c.status = 'graduated';
     INSERT INTO transactions (signature, slot, block_time, commitment, source, kind, event_count)
       SELECT 'K' || n, 10000000000 + n, ts, 'finalized', 'backfill', 'fumpad', 1 FROM lt_sample;
     INSERT INTO samples (signature, idx, mint, price_q64, fallback, ts) SELECT 'K' || n, 0, mint, q, false, ts FROM lt_sample`,
    [now],
  );
  await step(
    "buybacks/skims",
    `INSERT INTO buybacks (signature, idx, mint, lamports_in, tokens_out, ts) SELECT signature, 7, mint, 100000000, 1000000000, ts FROM samples WHERE random() < 0.05;
     INSERT INTO lp_skims (signature, idx, pool, mint, lp_withdrawn, base_out, quote_out, lp_held, ts) SELECT signature, 8, 'pool', mint, 1, 500000000, 1000, 1, ts FROM samples WHERE random() < 0.01;
     INSERT INTO fee_withdrawals (signature, idx, mint, recipient, lamports, is_creator, ts) SELECT created_sig || '', 9, mint, creator, 1000000, true, created_at FROM coins WHERE random() < 0.1 AND EXISTS (SELECT 1 FROM transactions x WHERE x.signature = coins.created_sig)`,
  );
  await step(
    "feed",
    `INSERT INTO feed_events (id, kind, ts, mint, actor, payload)
     SELECT 'launch:' || mint, 'launch', created_at, mint, creator, jsonb_build_object('poolTokens', 80000000) FROM coins
     UNION ALL SELECT 'fumble:' || ticket, 'fumble', sell_ts, mint, owner, jsonb_build_object('tokens', original_tokens / 1e6, 'sol', sell_lamports / 1e9, 'ticketPrice', 1e-7) FROM tickets
     UNION ALL SELECT 'cross:' || ticket, 'cross', crossed_at, mint, owner, jsonb_build_object('multiple', crossed_multiple, 'claimTokens', 1, 'claimSol', 0.1) FROM tickets WHERE crossed_at IS NOT NULL
     UNION ALL SELECT 'grad:' || mint, 'graduation', graduated_at, mint, creator, jsonb_build_object('raisedSol', 85, 'ticketsUnlocked', tickets_open) FROM coins WHERE status = 'graduated'
     UNION ALL SELECT 'claim:' || ticket, 'claim', ts, mint, owner, jsonb_build_object('multiple', 12, 'tokens', amount / 1e6, 'sol', 1, 'fromQueue', false, 'skippedAhead', false) FROM claims
     ORDER BY 3`,
  );
  await db.query("SET session_replication_role = DEFAULT");
  await step("aggregates", "DO $$ BEGIN IF to_regproc('fumpad_rebuild_aggregates') IS NOT NULL THEN PERFORM fumpad_rebuild_aggregates(); END IF; END $$");
  await step("flags", `INSERT INTO wallet_flags (wallet, reason, mint, ts) SELECT address, 'linked_wallets', '', $1 FROM users WHERE random() < 0.01`, [now]);
  const s = Date.now();
  await new Deriver(null as never, pool, createLogger("loadtest", "warn"), { fundingLookupsPerCycle: 0, claimWindowSecs: () => 90n * 86_400n }).userStats();
  console.log(`  seed ${"user_stats".padEnd(16)} ${((Date.now() - s) / 1000).toFixed(1)} s`);
  await step("analyze", "VACUUM ANALYZE");
  await db.query("INSERT INTO meta (key, value) VALUES ('loadtest', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify({ ...N, seededAt: now })]);
}

// ── HTTP bench ────────────────────────────────────────────────────────────────
class NoCache extends TtlCache {
  override get<T>(_key: string, _ttl: number, load: () => Promise<T>): Promise<T> {
    return load();
  }
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function bench(base: string, paths: () => string, requests: number, concurrency: number) {
  for (let i = 0; i < 5; i++) await fetch(base + paths()).then((r) => r.arrayBuffer());
  const lat: number[] = [];
  let errors = 0;
  let next = 0;
  const worker = async () => {
    while (next++ < requests) {
      const s = performance.now();
      const r = await fetch(base + paths());
      await r.arrayBuffer();
      if (!r.ok) errors++;
      lat.push(performance.now() - s);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: Math.max(...lat), errors };
}

async function main() {
  const pg = startScratchPostgres();
  const db = createPool(pg.url, 20);
  const results: Record<string, unknown> = { label: args.label, at: new Date().toISOString(), size: N };
  try {
    const m0 = Date.now();
    const applied = await migrate(db);
    if (applied.length) console.log(`migrations ${applied.join(", ")} applied in ${((Date.now() - m0) / 1000).toFixed(1)} s`);
    const have = await db.query<{ value: typeof N | null }>("SELECT value FROM meta WHERE key = 'loadtest'");
    const prev = have.rows[0]?.value;
    if (args.reseed || !prev || prev.coins !== N.coins || prev.trades !== N.trades || prev.tickets !== N.tickets || prev.wallets !== N.wallets) {
      console.log(`seeding ${N.coins} coins, ${N.trades} trades, ${N.tickets} tickets, ${N.wallets} wallets …`);
      await seed(db, Math.floor(Date.now() / 1000));
    } else console.log("reusing seeded data (pass --reseed to regenerate)");
    const counts = (await db.query("SELECT (SELECT count(*) FROM coins) coins, (SELECT count(*) FROM trades) trades, (SELECT count(*) FROM tickets) tickets, (SELECT count(*) FROM users) wallets, (SELECT count(*) FROM positions) positions, (SELECT count(*) FROM samples) samples, (SELECT count(*) FROM feed_events) feed")).rows[0];
    console.log("rows:", counts);
    results.rows = counts;

    // Sample ids: hot coins weighted like traffic, whales and tail wallets.
    const hot = (await db.query<{ mint: string; symbol: string }>("SELECT mint, symbol FROM coins ORDER BY trade_count DESC LIMIT 100")).rows;
    const rnd = (await db.query<{ mint: string }>("SELECT mint FROM coins ORDER BY random() LIMIT 300")).rows;
    const grads = (await db.query<{ mint: string }>("SELECT mint FROM coins WHERE status = 'graduated' ORDER BY trade_count DESC LIMIT 50")).rows;
    const whales = (await db.query<{ owner: string }>("SELECT owner FROM tickets GROUP BY owner ORDER BY count(*) DESC LIMIT 30")).rows.map((r) => r.owner);
    const tail = (await db.query<{ address: string }>("SELECT address FROM users ORDER BY random() LIMIT 300")).rows.map((r) => r.address);
    const creators = (await db.query<{ creator: string }>("SELECT creator FROM coins GROUP BY creator ORDER BY count(*) DESC LIMIT 50")).rows.map((r) => r.creator);
    const tix = (await db.query<{ ticket: string }>("SELECT ticket FROM tickets ORDER BY random() LIMIT 300")).rows.map((r) => r.ticket);
    const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
    const coin = () => (Math.random() < 0.6 ? pick(hot).mint : pick(rnd).mint);
    const wallet = () => (Math.random() < 0.3 ? pick(whales) : pick(tail));

    const cfg = { ...loadApiConfig({ DATABASE_URL: pg.url, LOG_LEVEL: "error", RATE_LIMIT_PER_MIN: "100000000", QUOTE_RATE_LIMIT_PER_MIN: "100000000", MAX_WS_PER_IP: "100000" }), port: 0 };
    const conn = new Connection("http://127.0.0.1:9", "confirmed");
    const chain = new ChainReader(conn, new TtlCache(), { solUsdFallback: 150 });
    chain.tokenBalances = async () => {
      throw new Error("no rpc in load test");
    };
    const { app, deps } = await buildServer(cfg, { db, conn, chain, cache: args.cache ? new TtlCache() : new NoCache(), pool: null });
    await deps.live.start();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

    // Shape check: /v1/coins keys (compared across runs).
    const list = (await (await fetch(`${base}/v1/coins?sort=trending&limit=50`)).json()) as Record<string, unknown>[];
    results.coinsShape = Object.keys(list[0] ?? {}).sort();
    results.coinsSample = list.slice(0, 3);

    const endpoints: [string, () => string][] = [
      ["coins trending", () => "/v1/coins?sort=trending&limit=50"],
      ["coins new", () => "/v1/coins?sort=new&limit=50"],
      ["coins mcap", () => "/v1/coins?sort=mcap&limit=50"],
      ["coins closest", () => "/v1/coins?sort=closest&limit=50"],
      ["coins graduating curve", () => "/v1/coins?sort=graduating&status=curve&limit=50"],
      ["coins graduated 200", () => "/v1/coins?sort=trending&status=graduated&limit=200"],
      ["board lane new curve 150", () => "/v1/coins?sort=new&status=curve&limit=150"],
      ["board lane grad trend 80", () => "/v1/coins?sort=trending&status=graduated&limit=80"],
      ["feed trending 6", () => "/v1/coins?sort=trending&limit=6"],
      ["coin detail", () => `/v1/coins/${coin()}`],
      ["coin by symbol", () => `/v1/coins/${pick(hot).symbol}`],
      ["coin trades", () => `/v1/coins/${coin()}/trades?limit=30`],
      ["coin prices 1d", () => `/v1/coins/${coin()}/prices?range=1d`],
      ["coin prices all", () => `/v1/coins/${coin()}/prices?range=all`],
      ["coin holders", () => `/v1/coins/${coin()}/holders`],
      ["coin fumbles", () => `/v1/coins/${coin()}/fumbles`],
      ["coin queue", () => `/v1/coins/${pick(grads).mint}/queue`],
      ["feed all", () => "/v1/feed?limit=30"],
      ["feed claims", () => "/v1/feed?kind=claim&limit=30"],
      ["feed page 2", () => `/v1/feed?limit=30&before=${(Date.now() - 86_400_000 * 3) | 0}`],
      ["closest", () => `/v1/closest?limit=5&viewer=${wallet()}`],
      ["stats", () => "/v1/stats"],
      ["wallet tickets", () => `/v1/wallets/${wallet()}/tickets`],
      ["ticket detail", () => `/v1/tickets/${pick(tix)}`],
      ["wallet positions", () => `/v1/wallets/${wallet()}/positions`],
      ["wallet closed", () => `/v1/wallets/${wallet()}/closed`],
      ["wallet created", () => `/v1/wallets/${pick(creators)}/created`],
      ["board fumbles", () => "/v1/leaderboards/fumbles"],
      ["board claimers", () => "/v1/leaderboards/claimers"],
      ["board diamond", () => "/v1/leaderboards/diamond"],
      ["profile", () => `/v1/profiles/${wallet()}`],
    ];
    const only = args.only ? new RegExp(args.only) : null;
    const http: Record<string, Awaited<ReturnType<typeof bench>>> = {};
    console.log(`\nHTTP (${args.cache ? "cache ON" : "cache OFF: every request hits Postgres"}), ${args.requests} req @ ${args.concurrency} concurrent`);
    console.log(`${"endpoint".padEnd(24)} ${"p50".padStart(8)} ${"p95".padStart(8)} ${"p99".padStart(8)} ${"max".padStart(8)}`);
    for (const [name, path] of endpoints) {
      if (only && !only.test(name)) continue;
      const r = await bench(base, path, Number(args.requests), Number(args.concurrency));
      http[name] = r;
      console.log(`${name.padEnd(24)} ${r.p50.toFixed(1).padStart(8)} ${r.p95.toFixed(1).padStart(8)} ${r.p99.toFixed(1).padStart(8)} ${r.max.toFixed(1).padStart(8)}${r.errors ? `  errors=${r.errors}` : ""}`);
    }
    results.http = http;

    if (!args["no-ws"]) results.ws = await wsBurst(base, db, deps.live, hot.slice(0, Number(args["burst-coins"])).map((h) => h.mint));

    await app.close();
  } finally {
    await db.end().catch(() => {});
    pg.stop();
  }
  const out = args.out ?? join(SERVICES, ".local", `loadtest-${args.label}.json`);
  writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`\nwrote ${out}`);
}

// ── WebSocket burst ───────────────────────────────────────────────────────────
async function wsBurst(base: string, db: Db, live: { stats: Record<string, number> }, mints: string[]) {
  const clients = Number(args["ws-clients"]);
  const rate = Number(args["burst-rate"]);
  const secs = Number(args["burst-secs"]);
  const wsUrl = base.replace("http", "ws") + "/v1/ws";
  const sent = new Map<string, number>();
  const lat: number[] = [];
  const perType: Record<string, number> = {};
  const coinMsgsPerMint = new Map<string, number>();
  let lastRecv = 0;
  const socks: WebSocket[] = [];
  for (let i = 0; i < clients; i++) {
    const ws = new WebSocket(wsUrl);
    const primary = i === 0;
    ws.onmessage = (ev) => {
      lastRecv = performance.now();
      const m = JSON.parse(String(ev.data)) as { type: string; coin?: { mint: string }; trades?: { signature: string }[] };
      perType[m.type] = (perType[m.type] ?? 0) + 1;
      if (!primary || m.type !== "coin") return;
      coinMsgsPerMint.set(m.coin!.mint, (coinMsgsPerMint.get(m.coin!.mint) ?? 0) + 1);
      for (const t of m.trades ?? []) {
        const s = sent.get(t.signature);
        if (s !== undefined) lat.push(performance.now() - s);
      }
    };
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("ws connect failed"));
    });
    socks.push(ws);
  }
  const before = { ...live.stats };
  const cpu0 = process.cpuUsage();
  const total = rate * secs;
  const t0 = performance.now();
  const writer = createPool((db as unknown as { options: { connectionString: string } }).options.connectionString, 8);
  const now = Math.floor(Date.now() / 1000);
  let seq = 0;
  const one = async (k: number) => {
    const mint = mints[k % mints.length];
    const sig = `B${Date.now()}x${k}`;
    const c = await writer.connect();
    try {
      await c.query("BEGIN");
      await c.query("INSERT INTO transactions (signature, slot, block_time, commitment, source, kind, event_count) VALUES ($1, $2, $3, 'confirmed', 'rpc', 'fumpad', 1)", [sig, 20_000_000_000 + k, now]);
      await c.query(
        `INSERT INTO trades (signature, idx, slot, ts, mint, wallet, is_buy, on_amm, token_amount, sol_amount, fee_pool, fee_platform, fee_creator, pool_tokens_bought, price_q64, virtual_sol, virtual_tokens)
         SELECT $1, 0, $2, $3, mint, lt_addr('Wa', 7), true, false, 1000000000, 100000000, 500000, 300000, 100000, 0, price_q64, virtual_sol, virtual_tokens FROM coins WHERE mint = $4`,
        [sig, 20_000_000_000 + k, now, mint],
      );
      await c.query("SELECT pg_notify($1, $2)", [NOTIFY_CHANNEL, JSON.stringify({ type: "coins", mints: [mint], wallets: [lt7], sig })]);
      sent.set(sig, performance.now());
      await c.query("COMMIT");
    } finally {
      c.release();
    }
  };
  const lt7 = (await db.query<{ a: string }>("SELECT lt_addr('Wa', 7) AS a")).rows[0].a;
  const inflight: Promise<void>[] = [];
  while (seq < total) {
    const due = Math.floor(((performance.now() - t0) / 1000) * rate);
    while (seq < Math.min(due, total)) inflight.push(one(seq++));
    await new Promise((r) => setTimeout(r, 5));
  }
  await Promise.all(inflight);
  const sendDone = performance.now();
  // Drain: wait until messages stop arriving for 2 s (or 120 s cap).
  while (performance.now() - lastRecv < 2_000 && performance.now() - sendDone < 120_000) await new Promise((r) => setTimeout(r, 200));
  const drainMs = Math.max(0, lastRecv - sendDone);
  const cpu = process.cpuUsage(cpu0);
  const elapsed = (lastRecv - t0) / 1000;
  for (const s of socks) s.close();
  await writer.end();
  const after = live.stats;
  const coinMsgs = [...coinMsgsPerMint.values()];
  const res = {
    clients,
    tradesPerSec: rate,
    coins: mints.length,
    seconds: secs,
    notifications: (after.notifications ?? 0) - (before.notifications ?? 0),
    coinMsgsResolved: (after.coinMsgs ?? 0) - (before.coinMsgs ?? 0),
    coinMsgsPerCoinPerSec: coinMsgs.length ? coinMsgs.reduce((a, b) => a + b, 0) / coinMsgs.length / elapsed : 0,
    msgsPerClient: Object.fromEntries(Object.entries(perType).map(([k, v]) => [k, Math.round(v / clients)])),
    tradeToClientMs: lat.length ? { p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: Math.max(...lat) } : null,
    tradesDelivered: lat.length,
    backlogDrainMs: drainMs,
    processCpuSecs: (cpu.user + cpu.system) / 1e6,
  };
  console.log("\nWS burst", res);
  return res;
}

await main();
process.exit(0);
