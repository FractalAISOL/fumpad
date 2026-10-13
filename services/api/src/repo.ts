/**
 * Postgres → app types (`generated/app-types.ts`, a verbatim copy of
 * app/src/data/types.ts). Units follow app/src/data/chain.ts: SOL, whole tokens,
 * SOL-per-token prices, unix MILLISECONDS.
 */
import { poolNeededFor, q64ToSolPerToken } from "@fumpad/sdk";
import { type ApiParams, apiParams, curveFromStored, fromStored, getMeta, type Queryable } from "@fumpad/indexer";
import { DEFAULT_PARAMS } from "@fumpad/sdk";

type Params = ApiParams;
/** Typical sell → attestation latency (finality ≈ 13 s + derivation + 2-of-3 exchange + landing). Display only. */
export const ATTEST_DELAY_SECS = 60;

import type {
  Achievement,
  Board,
  ChartRange,
  CloseCall,
  CoinDetail,
  CoinSummary,
  CreatedCoin,
  FeedEvent,
  FeedKind,
  FumbleRow,
  Holder,
  LeaderRow,
  PlatformStats,
  PricePoint,
  Profile,
  ProtocolParams,
  QueueEntry,
  Ticket,
  TicketState,
  TradeRow,
} from "./generated/app-types.js";
import type { CoinSort } from "./generated/app-interface.js";
import { assemble, buildBooks, type LedgerEntry, type PortfolioCoinRow, type TicketStat } from "./portfolio.js";

const Q64 = 1n << 64n;
const lam = (v: string | number | bigint | null | undefined) => (v === null || v === undefined ? 0 : Number(v) / 1e9);
const tok = (v: string | number | bigint | null | undefined) => (v === null || v === undefined ? 0 : Number(v) / 1e6);
const px = (q: string | bigint | null | undefined) => (q === null || q === undefined ? 0 : q64ToSolPerToken(BigInt(q)));
const ms = (secs: string | number | null | undefined) => (secs === null || secs === undefined ? undefined : Number(secs) * 1000);
const nowSecs = () => Math.floor(Date.now() / 1000);
const spotQ64 = (vsol: string, vtok: string) => (BigInt(vtok) === 0n ? 0n : (BigInt(vsol) << 64n) / BigInt(vtok));

/** Deterministic monogram style from the mint. */
export function tileOf(mint: string): 0 | 1 | 2 {
  let h = 0;
  for (let i = 0; i < mint.length; i++) h = (h * 31 + mint.charCodeAt(i)) >>> 0;
  return (h % 3) as 0 | 1 | 2;
}

export interface CoinRow {
  mint: string;
  creator: string;
  name: string;
  symbol: string;
  uri: string;
  created_at: string;
  status: "curve" | "complete" | "graduated";
  graduated_at: string | null;
  dbc_pool: string | null;
  damm_pool: string | null;
  raised_lamports: string;
  virtual_sol: string;
  virtual_tokens: string;
  real_sol: string;
  real_tokens: string;
  amm_base: string | null;
  amm_quote: string | null;
  price_q64: string;
  reference_q64: string | null;
  median_q64: string | null;
  volume_lamports: string;
  pool_seeded: string;
  pool_tokens: string;
  pool_paid_out: string;
  queue_owed: string;
  tickets_created: string;
  tickets_open: string;
  metadata: Record<string, string | undefined> | null;
  vol24: string | null;
  trades24: string | null;
  price24: string | null;
  holders: string | null;
  creator_flagged: boolean;
  closest_multiple: number | null;
  snipe_tax_lamports: string | null;
  snipe_taxed_buys: number | null;
  pool_inflow_lamports: string | null;
}

/**
 * One coin row plus its 24 h activity, holders, creator flag and the open ticket nearest the
 * trigger. Every subquery is an index lookup on the coin (coin_hourly + the edge hour of trades_mint_recent,
 * samples_mint_ts, coin_holders, wallet_flags PK, tickets_open_price; migration 006). Callers select the
 * few rows they need first (`WHERE c.mint = ANY(...)`), so this runs per shown coin only.
 * `trigBps` comes from Global.params (an integer).
 */
const coinSelect = (trigBps: number) => `
  SELECT c.*, act.vol24, act.trades24,
    -- Newest point at or before now − 24 h: one backward index probe per source (the price is
    -- computed for the winner only, not for every older trade).
    (SELECT COALESCE(x.pq, (x.vs * 18446744073709551616 / NULLIF(x.vt,0))::numeric(40,0)) FROM (
        (SELECT ts, virtual_sol AS vs, virtual_tokens AS vt, NULL::numeric AS pq FROM trades WHERE mint = c.mint AND ts <= $1 - 86400 ORDER BY ts DESC LIMIT 1)
        UNION ALL
        (SELECT ts, NULL, NULL, price_q64 FROM samples WHERE mint = c.mint AND ts <= $1 - 86400 AND NOT fallback ORDER BY ts DESC LIMIT 1)
      ) x ORDER BY x.ts DESC LIMIT 1) AS price24,
    COALESCE((SELECT h.n FROM coin_holders h WHERE h.mint = c.mint), 0) AS holders,
    EXISTS (SELECT 1 FROM wallet_flags f WHERE f.wallet = c.creator) AS creator_flagged,
    (SELECT (cur.q / min(t.sell_price_q64))::float8 FROM tickets t
      WHERE t.mint = c.mint AND t.status = 'open'
        -- q·10000 < s·trig  ⇔  s > ⌊q·10000 / trig⌋ (integers): the index range bound, kept exact by the filter.
        AND t.sell_price_q64 > div(cur.q * 10000, ${Math.trunc(trigBps)}) AND cur.q * 10000 < t.sell_price_q64 * ${Math.trunc(trigBps)}) AS closest_multiple
  FROM coins c
  CROSS JOIN LATERAL (SELECT CASE WHEN c.status = 'graduated' AND c.median_q64 IS NOT NULL THEN c.median_q64 ELSE c.price_q64 END AS q) cur
  CROSS JOIN LATERAL (SELECT COALESCE(sum(x.v),0) AS vol24, COALESCE(sum(x.n),0) AS trades24 FROM (${VOL24_ROWS("c.mint", "$1")}) x) act`;

/**
 * The rows whose sum is a coin's FUMPAD volume over (now − 24 h, ∞): whole hours from the
 * trigger-maintained `coin_hourly`, plus the partial edge hour straight from `trades`.
 * `mint` filters one coin (or pass null for every coin, with a `mint` column); `now` is a bigint param.
 */
const VOL24_ROWS = (mint: string | null, now: string) => {
  const w = `(${now}::bigint - 86400)`;
  return `SELECT h.mint, h.volume AS v, h.trades AS n FROM coin_hourly h WHERE ${mint ? `h.mint = ${mint} AND ` : ""}h.hour > ${w} / 3600
    UNION ALL
    SELECT t.mint, t.sol_amount, 1 FROM trades t WHERE ${mint ? `t.mint = ${mint} AND ` : ""}t.ts > ${w} AND t.ts < (${w} / 3600 + 1) * 3600`;
};

/** Creator links from the metadata JSON: http(s) only, so a crafted `javascript:` never reaches an href. */
export function socialsOf(md: Record<string, unknown> | null): CoinSummary["socials"] {
  if (!md) return undefined;
  const ok = (v: unknown) => {
    if (typeof v !== "string" || v.length > 300) return undefined;
    try {
      const u = new URL(v.trim());
      return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
    } catch {
      return undefined;
    }
  };
  const handle = (v: unknown, base: string) => (typeof v === "string" && /^@?[A-Za-z0-9_]{1,32}$/.test(v.trim()) ? base + v.trim().replace(/^@/, "") : ok(v));
  const out = { x: handle(md.twitter ?? md.x, "https://x.com/"), telegram: handle(md.telegram, "https://t.me/"), website: ok(md.website) };
  return out.x || out.telegram || out.website ? Object.fromEntries(Object.entries(out).filter(([, v]) => v)) : undefined;
}

/** Above this many points in 24 h a coin's sparkline is probed instead of scanned. */
const SPARK_SCAN_MAX_POINTS = 200;
/**
 * Sparklines (24 hourly points) are memoized per coin for this long per instance, and not
 * dropped on every trade like the response cache: list endpoints stay cheap under constant
 * trading. Price, change and volume fields are always fresh.
 */
const SPARK_MEMO_MS = 15_000;
/** Busy coins per probe query. */
const SPARK_PROBE_CHUNK = 40;
/** The trending order (24 h volume of every coin) is recomputed at most this often per instance. */
const TRENDING_RANK_MS = 5_000;

/** A symbol shared by several coins: the caller must choose by mint. */
export class AmbiguousSymbolError extends Error {
  constructor(
    readonly symbol: string,
    readonly mints: string[],
  ) {
    super(`ambiguous symbol ${symbol}`);
  }
}

export class Repo {
  private paramsCache?: { at: number; p: Params };
  private trendRank?: { at: number; rows: Promise<{ mint: string; status: CoinRow["status"] }[]> };
  private sparkMemo = new Map<string, { at: number; v: number[] }>();
  constructor(private db: Queryable) {}

  async params(): Promise<Params> {
    if (this.paramsCache && Date.now() - this.paramsCache.at < 30_000) return this.paramsCache.p;
    const g = await getMeta<{ params: Parameters<typeof fromStored>[0]; curve?: Record<string, string | number> }>(this.db, "global");
    const p = apiParams(g ? fromStored(g.params) : DEFAULT_PARAMS, curveFromStored(g?.curve));
    this.paramsCache = { at: Date.now(), p };
    return p;
  }

  /** Current price used for multiples: graduated → oracle median (claims use it), else spot. */
  private currentQ64(c: Pick<CoinRow, "status" | "median_q64" | "price_q64">): bigint {
    return c.status === "graduated" && c.median_q64 ? BigInt(c.median_q64) : BigInt(c.price_q64);
  }

  private async initialPriceQ64(): Promise<bigint> {
    const p = await this.params();
    return (p.sqrtStartPrice * p.sqrtStartPrice) >> 64n;
  }

  private async summary(c: CoinRow, spark?: number[]): Promise<CoinSummary> {
    const p = await this.params();
    const price = px(c.price_q64);
    const p24 = c.price24 ? px(c.price24) : px(await this.initialPriceQ64());
    return {
      mint: c.mint,
      symbol: c.symbol,
      name: c.name,
      creator: c.creator,
      tile: tileOf(c.mint),
      imageUrl: c.metadata?.image || undefined,
      status: c.status,
      createdAt: ms(c.created_at)!,
      graduatedAt: ms(c.graduated_at),
      price,
      median: c.status === "graduated" && c.median_q64 ? px(c.median_q64) : undefined,
      change24h: p24 > 0 ? (price / p24 - 1) * 100 : 0,
      volume24hSol: lam(c.vol24),
      marketCapSol: price * tok(p.totalSupply),
      holders: Number(c.holders ?? 0),
      curveSol: c.status === "graduated" ? lam(c.raised_lamports) : lam(c.real_sol),
      graduationSol: lam(p.graduationLamports),
      poolTokens: tok(c.pool_tokens),
      ticketsOpen: Number(c.tickets_open),
      spark: spark ?? (await this.sparks([c])).get(c.mint)!,
      trades24h: Number(c.trades24 ?? 0),
      socials: socialsOf(c.metadata),
      closestMultiple: c.closest_multiple ?? undefined,
      creatorFlagged: !!c.creator_flagged,
      ...(c.snipe_tax_lamports && BigInt(c.snipe_tax_lamports) > 0n
        ? { snipeTaxSol: lam(c.snipe_tax_lamports), snipeTaxedTrades: Number(c.snipe_taxed_buys ?? 0) }
        : {}),
    };
  }

  /** 24 hourly closes over the last 24 h (carry-forward), oldest first. */
  async spark(c: CoinRow): Promise<number[]> {
    return (await this.sparks([c])).get(c.mint)!;
  }

  /**
   * Sparklines for many coins in at most two queries: point k (0 = oldest) is the last trade
   * spot or keeper sample in [now − 24 h, now − (23 − k) h], else the price 24 h ago (`price24`)
   * or the launch price (the old per-coin carry-forward, exactly). Busy coins cost 24 × 2 index
   * probes (trades_mint_recent, samples_mint_ts) however many trades they had.
   */
  async sparks(coins: Pick<CoinRow, "mint" | "price24" | "status" | "trades24">[]): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    const t = Date.now();
    const todo = coins.filter((c) => {
      const hit = this.sparkMemo.get(c.mint);
      if (hit && t - hit.at < SPARK_MEMO_MS) out.set(c.mint, hit.v);
      return !out.has(c.mint);
    });
    if (todo.length) {
      const fresh = await this.computeSparks(todo);
      if (this.sparkMemo.size > 10_000) this.sparkMemo.clear();
      for (const [m, v] of fresh) {
        out.set(m, v);
        this.sparkMemo.set(m, { at: t, v });
      }
    }
    return out;
  }

  private async computeSparks(coins: Pick<CoinRow, "mint" | "price24" | "status" | "trades24">[]): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    if (!coins.length) return out;
    const now = nowSecs();
    const init = px(await this.initialPriceQ64());
    for (const c of coins) out.set(c.mint, Array<number>(24).fill(c.price24 ? px(c.price24) : init));
    // Quiet coins: read their few points and carry forward in JS. Busy coins: 48 index probes
    // each, whatever their volume. (A graduated coin also has ~180 keeper samples a day.)
    const points = (c: (typeof coins)[number]) => Number(c.trades24 ?? 0) + (c.status === "graduated" ? 200 : 0);
    const quiet = coins.filter((c) => points(c) <= SPARK_SCAN_MAX_POINTS).map((c) => c.mint);
    const busy = coins.filter((c) => points(c) > SPARK_SCAN_MAX_POINTS);
    // Probe chunks run on separate pool connections, so a 150-coin board isn't one long query.
    const chunks: (typeof busy)[] = [];
    for (let i = 0; i < busy.length; i += SPARK_PROBE_CHUNK) chunks.push(busy.slice(i, i + SPARK_PROBE_CHUNK));
    await Promise.all([this.sparksByScan(quiet, now, out), ...chunks.map((ch) => this.sparksByProbe(ch, now, out))]);
    return out;
  }

  private async sparksByScan(mints: string[], now: number, out: Map<string, number[]>) {
    if (!mints.length) return;
    const r = await this.db.query<{ mint: string; ts: string; vs: string | null; vt: string | null; pq: string | null }>(
      `SELECT mint, ts, virtual_sol AS vs, virtual_tokens AS vt, NULL::numeric AS pq FROM trades WHERE mint = ANY($1::text[]) AND ts >= $2
       UNION ALL SELECT mint, ts, NULL, NULL, price_q64 FROM samples WHERE mint = ANY($1::text[]) AND ts >= $2 AND NOT fallback
       ORDER BY mint, ts`,
      [mints, now - 86_400],
    );
    let i = 0;
    while (i < r.rows.length) {
      const mint = r.rows[i].mint;
      const arr = out.get(mint)!;
      let last = arr[0];
      for (let k = 0; k < 24; k++) {
        const end = now - (23 - k) * 3600;
        for (; i < r.rows.length && r.rows[i].mint === mint && Number(r.rows[i].ts) <= end; i++) {
          const x = r.rows[i];
          last = x.pq ? px(x.pq) : px(spotQ64(x.vs!, x.vt!));
        }
        arr[k] = last;
      }
      while (i < r.rows.length && r.rows[i].mint === mint) i++; // points after now (clock skew)
    }
  }

  /** Keeper samples exist only for graduated coins (the oracle starts at graduation), so only they probe samples. */
  private async sparksByProbe(coins: Pick<CoinRow, "mint" | "status">[], now: number, out: Map<string, number[]>) {
    if (!coins.length) return;
    const r = await this.db.query<{ mint: string; k: number; vs: string | null; vt: string | null; pq: string | null }>(
      `SELECT m.mint, k.k, p.vs, p.vt, p.pq
         FROM unnest($1::text[], $4::boolean[]) m(mint, grad) CROSS JOIN generate_series(0, 23) k(k)
         CROSS JOIN LATERAL (
           SELECT u.vs, u.vt, u.pq FROM (
             (SELECT ts, virtual_sol AS vs, virtual_tokens AS vt, NULL::numeric AS pq FROM trades
               WHERE mint = m.mint AND ts >= $2 AND ts <= $3 + k.k * 3600 ORDER BY ts DESC LIMIT 1)
             UNION ALL
             (SELECT ts, NULL, NULL, price_q64 FROM samples
               WHERE m.grad AND mint = m.mint AND ts >= $2 AND ts <= $3 + k.k * 3600 AND NOT fallback ORDER BY ts DESC LIMIT 1)
           ) u ORDER BY u.ts DESC LIMIT 1) p`,
      [coins.map((c) => c.mint), now - 86_400, now - 23 * 3600, coins.map((c) => c.status === "graduated")],
    );
    for (const x of r.rows) {
      const arr = out.get(x.mint);
      if (arr) arr[x.k] = x.pq ? px(x.pq) : px(spotQ64(x.vs!, x.vt!));
    }
  }

  /** Full rows (coinSelect) for these mints, in the given order. */
  private async coinRows(mints: string[]): Promise<CoinRow[]> {
    if (!mints.length) return [];
    const trig = (await this.params()).triggerMultipleBps;
    const r = await this.db.query<CoinRow>(`${coinSelect(trig)} WHERE c.mint = ANY($2::text[])`, [nowSecs(), mints]);
    const by = new Map(r.rows.map((c) => [c.mint, c]));
    return mints.map((m) => by.get(m)).filter((c): c is CoinRow => !!c);
  }

  private async summaries(rows: CoinRow[]): Promise<CoinSummary[]> {
    const sp = await this.sparks(rows);
    return Promise.all(rows.map((c) => this.summary(c, sp.get(c.mint))));
  }

  private async rawPrices(mint: string, since: number, limit?: number): Promise<{ t: number; p: number }[]> {
    const r = await this.db.query<{ ts: string; vs: string | null; vt: string | null; pq: string | null }>(
      `SELECT ts, virtual_sol AS vs, virtual_tokens AS vt, NULL AS pq FROM trades WHERE mint = $1 AND ts >= $2
       UNION ALL SELECT ts, NULL, NULL, price_q64 FROM samples WHERE mint = $1 AND ts >= $2 AND NOT fallback
       ORDER BY ts ${limit ? "LIMIT $3" : ""}`,
      limit ? [mint, since, limit] : [mint, since],
    );
    return r.rows.map((x) => ({ t: Number(x.ts), p: x.pq ? px(x.pq) : px(spotQ64(x.vs!, x.vt!)) }));
  }

  async listCoins(opts: { sort?: CoinSort; status?: "curve" | "graduated" | "all"; limit?: number } = {}): Promise<CoinSummary[]> {
    const { sort = "trending", status = "all" } = opts;
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const where = status === "all" ? "" : status === "curve" ? "WHERE c.status <> 'graduated'" : "WHERE c.status = 'graduated'";
    // Pick the page first from plain columns (trending: a shared rank, see trendingRank), then
    // build only those rows.
    const order = {
      trending: "", // trendingRank()
      new: "c.created_at DESC",
      mcap: "c.price_q64 DESC",
      closest: "c.tickets_open DESC, c.created_at DESC",
      graduating: "(CASE WHEN c.status = 'curve' THEN c.real_sol ELSE -1 END) DESC",
    }[sort];
    if (sort === "trending") {
      const ranked = (await this.trendingRank()).filter((c) => status === "all" || (status === "curve" ? c.status !== "graduated" : c.status === "graduated"));
      return this.summaries(await this.coinRows(ranked.slice(0, limit).map((c) => c.mint)));
    }
    const ids = await this.db.query<{ mint: string }>(`SELECT c.mint FROM coins c ${where} ORDER BY ${order} LIMIT $1`, [limit]);
    return this.summaries(await this.coinRows(ids.rows.map((x) => x.mint)));
  }

  /**
   * Every coin by 24 h volume, then newest. Ranking needs every coin's volume (one pass over
   * the hourly rollup), so it is shared for TRENDING_RANK_MS and NOT dropped on each trade the
   * way the response cache is; each listed row's numbers are still read fresh. A coin's place
   * can lag its volume by a few seconds.
   */
  private trendingRank() {
    if (!this.trendRank || Date.now() - this.trendRank.at > TRENDING_RANK_MS) {
      const rows = this.db
        .query<{ mint: string; status: CoinRow["status"] }>(
          `SELECT c.mint, c.status FROM coins c
             LEFT JOIN (SELECT y.mint, sum(y.v) AS v FROM (${VOL24_ROWS(null, "$1")}) y GROUP BY y.mint) a USING (mint)
            ORDER BY COALESCE(a.v, 0) DESC, c.created_at DESC`,
          [nowSecs()],
        )
        .then((r) => r.rows);
      this.trendRank = { at: Date.now(), rows };
      rows.catch(() => (this.trendRank = undefined));
    }
    return this.trendRank.rows;
  }

  /** The coin's own columns only (no derived subqueries), by exact mint (H-3: never by symbol). */
  private async coinBase(mint: string): Promise<CoinBase | null> {
    const r = await this.db.query<CoinBase>(
      `SELECT mint, creator, created_at, status, damm_pool, amm_base, real_tokens, price_q64, median_q64, pool_tokens, queue_owed
         FROM coins c WHERE c.mint = $1`,
      [mint],
    );
    return r.rows[0] ?? null;
  }

  /** Full row by exact mint. */
  async coinRow(mint: string): Promise<CoinRow | null> {
    return (await this.coinRows([mint]))[0] ?? null;
  }

  /**
   * Every coin whose symbol matches case-insensitively (a leading `$` is ignored), NEWEST
   * first (H-3: symbols are not unique; callers must not silently pick one).
   */
  async symbolMints(symbol: string, limit = 20): Promise<string[]> {
    const r = await this.db.query<{ mint: string }>(
      "SELECT mint FROM coins WHERE upper(symbol) = upper($1) ORDER BY created_at DESC, mint LIMIT $2",
      [symbol.replace(/^\$/, ""), Math.min(Math.max(limit, 1), 50)],
    );
    return r.rows.map((x) => x.mint);
  }

  /** `GET /v1/coins/by-symbol/:symbol`: all matches, newest first. */
  async coinsBySymbol(symbol: string, limit = 20): Promise<CoinSummary[]> {
    return this.summaries(await this.coinRows(await this.symbolMints(symbol, limit)));
  }

  /**
   * Legacy `GET /v1/coins/:id` resolution: an exact mint wins; otherwise a symbol that
   * matches exactly ONE coin. Several matches throw `AmbiguousSymbolError` (with the
   * candidates, newest first) instead of picking one.
   */
  async resolveCoinId(symbolOrMint: string): Promise<string | null> {
    // A mint-shaped id is answered only by that exact mint (symbols are ≤ 10 bytes, never 32+ base58).
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(symbolOrMint)) return (await this.coinBase(symbolOrMint)) ? symbolOrMint : null;
    const mints = await this.symbolMints(symbolOrMint, 20);
    if (mints.length > 1) throw new AmbiguousSymbolError(symbolOrMint.replace(/^\$/, ""), mints);
    return mints[0] ?? null;
  }

  /** Detail by exact mint (`GET /v1/coins/by-mint/:mint`, and everything internal). */
  async getCoinByMint(mint: string): Promise<CoinDetail | null> {
    const c = await this.coinRow(mint);
    return c ? this.detail(c) : null;
  }

  /** FumpadData.getCoin: exact mint, else a unique symbol (see resolveCoinId). */
  async getCoin(symbolOrMint: string): Promise<CoinDetail | null> {
    const mint = await this.resolveCoinId(symbolOrMint);
    return mint ? this.getCoinByMint(mint) : null;
  }

  private async detail(c: CoinRow): Promise<CoinDetail> {
    const p = await this.params();
    const now = nowSecs();
    const [s, extra] = await Promise.all([
      this.summary(c),
      this.db.query<{ bought24: string; past10x: string; sol1h: string }>(
        `SELECT
           (SELECT COALESCE(sum(pool_tokens_bought),0) FROM trades WHERE mint = $1 AND ts > $2 - 86400)
             + (SELECT COALESCE(sum(tokens_out),0) FROM buybacks WHERE mint = $1 AND ts > $2 - 86400) AS bought24,
           (SELECT count(*) FROM tickets WHERE mint = $1 AND status IN ('open','queued') AND $3::numeric * 10000 >= sell_price_q64 * $4) AS past10x,
           (SELECT COALESCE(sum(CASE WHEN is_buy THEN sol_amount ELSE -sol_amount END),0) FROM trades WHERE mint = $1 AND NOT on_amm AND ts > $2 - 3600) AS sol1h`,
        [c.mint, now, this.currentQ64(c).toString(), p.triggerMultipleBps],
      ),
    ]);
    const md = c.metadata ?? {};
    const links: { label: string; href: string }[] = [];
    if (s.socials?.website) links.push({ label: "Website", href: s.socials.website });
    if (s.socials?.x) links.push({ label: "X", href: s.socials.x });
    if (s.socials?.telegram) links.push({ label: "Telegram", href: s.socials.telegram });
    const e = extra.rows[0];
    return {
      ...s,
      description: md.description ?? "",
      links,
      poolSeeded: tok(c.pool_seeded),
      poolBought24h: tok(e.bought24),
      poolPaidOut: tok(c.pool_paid_out),
      queueOwed: tok(c.queue_owed),
      ticketsCreated: Number(c.tickets_created),
      ticketsPast10x: Number(e.past10x),
      referencePrice: px(c.reference_q64 ?? c.price_q64),
      dbcPool: c.dbc_pool ?? undefined,
      dammPool: c.damm_pool ?? undefined,
      virtualSol: lam(c.virtual_sol),
      virtualTokens: tok(c.virtual_tokens),
      curveTokensLeft: c.status === "graduated" ? 0 : tok(c.real_tokens),
      ammSol: c.status === "graduated" ? lam(c.virtual_sol) : undefined,
      ammTokens: c.status === "graduated" ? tok(c.virtual_tokens) : undefined,
      curveSol1h: lam(e.sol1h),
      poolInflowSol: lam(c.pool_inflow_lamports ?? "0"),
    };
  }

  async getPriceSeries(mint: string, range: ChartRange): Promise<PricePoint[]> {
    const c = await this.coinBase(mint);
    if (!c) return [];
    const now = nowSecs();
    const since = range === "1h" ? now - 3600 : range === "1d" ? now - 86_400 : range === "7d" ? now - 7 * 86_400 : Number(c.created_at);
    const start = Number(c.created_at) >= since ? [{ t: Number(c.created_at), p: px(await this.initialPriceQ64()) }] : [];
    // Downsample to ≤ 240 points (last value per bucket). Small series come back raw; a busy
    // coin's series is bucketed in Postgres (DISTINCT ON bucket) instead of shipping every trade.
    const maxPts = 240;
    const head = await this.rawPrices(c.mint, since, maxPts + 1);
    const all = [...start, ...head];
    if (all.length <= maxPts) return all.map((x) => ({ t: x.t * 1000, p: x.p }));
    const span = Math.max(1, now - since);
    const bucket = span / maxPts;
    const out = new Map<number, { t: number; p: number }>();
    for (const x of [...start, ...(await this.bucketedPrices(c.mint, since, bucket))]) out.set(Math.floor((x.t - since) / bucket), x);
    return [...out.values()].map((x) => ({ t: x.t * 1000, p: x.p }));
  }

  /** The last price point per `bucket`-second bucket since `since`, oldest first (same float bucket rule as the JS). */
  private async bucketedPrices(mint: string, since: number, bucket: number): Promise<{ t: number; p: number }[]> {
    const r = await this.db.query<{ ts: string; vs: string | null; vt: string | null; pq: string | null }>(
      `SELECT DISTINCT ON (b) ts, vs, vt, pq FROM (
         SELECT ts, virtual_sol AS vs, virtual_tokens AS vt, NULL::numeric AS pq FROM trades WHERE mint = $1 AND ts >= $2
         UNION ALL SELECT ts, NULL, NULL, price_q64 FROM samples WHERE mint = $1 AND ts >= $2 AND NOT fallback
       ) x CROSS JOIN LATERAL (SELECT floor((x.ts - $2)::float8 / $3::float8) AS b) k
       ORDER BY b, ts DESC`,
      [mint, since, bucket],
    );
    return r.rows.map((x) => ({ t: Number(x.ts), p: x.pq ? px(x.pq) : px(spotQ64(x.vs!, x.vt!)) }));
  }

  /** Base units the wallet acquired on the coin's pools since `sinceTs` (buys + payouts). */
  async recentAcquired(wallet: string, mint: string, sinceTs: number): Promise<bigint> {
    const r = await this.db.query<{ v: string }>(
      `SELECT (SELECT COALESCE(sum(token_amount),0) FROM trades WHERE wallet = $1 AND mint = $2 AND is_buy AND ts > $3)
            + (SELECT COALESCE(sum(amount),0) FROM claims WHERE owner = $1 AND mint = $2 AND ts > $3) AS v`,
      [wallet, mint, sinceTs],
    );
    return BigInt(r.rows[0]?.v ?? "0");
  }

  /** Global.params in display units (getParams). */
  async getParams(): Promise<ProtocolParams> {
    const p = await this.params();
    return {
      totalSupply: tok(p.totalSupply),
      rewardPoolSupply: tok(p.rewardPoolSupply),
      curveSupply: tok(p.curveSupply),
      lpSupply: tok(p.lpSupply),
      initialVirtualSol: lam(p.initialVirtualSol),
      initialVirtualTokens: tok(p.initialVirtualToken),
      graduationSol: lam(p.graduationLamports),
      feeBps: p.feeBps,
      feePoolShareBps: p.feePoolShareBps,
      feePlatformShareBps: p.feePlatformShareBps,
      feeCreatorShareBps: p.feeCreatorShareBps,
      triggerMultiple: p.triggerMultipleBps / 10_000,
      claimBps: p.claimBps,
      maxClaimPoolBps: p.maxClaimPoolBps,
      minSellUsd: Number(p.minSellUsdCents) / 100,
      minHoldSecs: Number(p.minHoldSecs),
      rebuyWindowSecs: Number(p.rebuyWindowSecs),
      claimWindowSecs: Number(p.claimWindowSecs),
      maxOpenTickets: p.maxOpenTickets,
      oracleWindowSecs: Number(p.oracleWindowSecs),
      oracleMinSamples: p.oracleMinSamples,
      snipeWindowSlots: p.snipeWindowSlots ?? 0,
      snipeStartBps: p.snipeStartBps ?? 0,
      graduationFeeSol: lam(p.graduationFeeLamports),
      venueFeeShareBps: p.venueFeeShareBps,
      ticketChallengeSecs: Number(p.ticketChallengeSecs),
      attestDelaySecs: ATTEST_DELAY_SECS,
    };
  }

  private tradeRows(r: { signature: string; mint: string; wallet: string; is_buy: boolean; token_amount: string; sol_amount: string; virtual_sol: string; virtual_tokens: string; ts: string; snipe_tax: string; snipe_tax_bps: number; venue: string | null; app: string | null; routed: boolean | null }[]): TradeRow[] {
    return r.map((x) => ({
      signature: x.signature,
      mint: x.mint,
      wallet: x.wallet,
      side: x.is_buy ? "buy" : "sell",
      tokens: tok(x.token_amount),
      sol: lam(x.sol_amount),
      price: px(spotQ64(x.virtual_sol, x.virtual_tokens)),
      ts: Number(x.ts) * 1000,
      ...(BigInt(x.snipe_tax) > 0n ? { snipeTaxSol: lam(x.snipe_tax), snipeTaxBps: Number(x.snipe_tax_bps) } : {}),
      ...(x.venue ? { venue: x.venue === "damm_v2" ? ("damm" as const) : ("dbc" as const) } : {}),
      ...(x.routed ? { app: "fumpad" } : x.app ? { app: x.app } : {}),
    }));
  }

  /** Latest FUMPAD trades on a coin, newest first (getRecentTrades). */
  async getRecentTrades(mint: string, limit = 30): Promise<TradeRow[]> {
    const r = await this.db.query<Parameters<Repo["tradeRows"]>[0][number]>(
      `SELECT signature, mint, wallet, is_buy, token_amount, sol_amount, virtual_sol, virtual_tokens, ts, snipe_tax, snipe_tax_bps, venue, app, routed FROM trades
       WHERE mint = $1 ORDER BY ts DESC, slot DESC, idx DESC LIMIT $2`,
      [mint, Math.min(Math.max(limit, 1), 100)],
    );
    return this.tradeRows(r.rows);
  }

  /**
   * The live `coin` message for one touched mint: fresh detail, the trades of transaction
   * `sig` on it, and the chart points they add (same rule as getPriceSeries: trade spots
   * and keeper samples).
   */
  async liveCoin(mint: string, sig?: string | string[]): Promise<{ coin: CoinDetail; trades: TradeRow[]; points: PricePoint[] } | null> {
    const sigs = sig === undefined ? [] : Array.isArray(sig) ? sig : [sig];
    const [coin, tr, sm] = await Promise.all([
      this.getCoinByMint(mint),
      sigs.length
        ? this.db.query<Parameters<Repo["tradeRows"]>[0][number]>(
            `SELECT signature, mint, wallet, is_buy, token_amount, sol_amount, virtual_sol, virtual_tokens, ts, snipe_tax, snipe_tax_bps, venue, app, routed FROM trades
              WHERE signature = ANY($1::text[]) AND mint = $2 ORDER BY slot, idx`,
            [sigs, mint],
          )
        : null,
      sigs.length
        ? this.db.query<{ ts: string; price_q64: string }>("SELECT ts, price_q64 FROM samples WHERE signature = ANY($1::text[]) AND mint = $2 AND NOT fallback ORDER BY ts, idx", [sigs, mint])
        : null,
    ]);
    if (!coin) return null;
    if (!tr || !sm) return { coin, trades: [], points: [] };
    const trades = this.tradeRows(tr.rows);
    const points = [...trades.map((t) => ({ t: t.ts, p: t.price })), ...sm.rows.map((x) => ({ t: Number(x.ts) * 1000, p: px(x.price_q64) }))].sort((a, b) => a.t - b.t);
    return { coin, trades: trades.reverse(), points };
  }

  async getHolders(mint: string, viewer?: string): Promise<{ total: number; top: Holder[] }> {
    const c = await this.coinBase(mint);
    if (!c) return { total: 0, top: [] };
    const p = await this.params();
    const supply = tok(p.totalSupply);
    const [r, n] = await Promise.all([
      this.db.query<{ wallet: string; balance: string }>("SELECT wallet, balance FROM positions WHERE mint = $1 AND balance > 0 ORDER BY balance DESC LIMIT 20", [c.mint]),
      this.db.query<{ n: string }>("SELECT COALESCE((SELECT n FROM coin_holders WHERE mint = $1), 0) AS n", [c.mint]),
    ]);
    const top: Holder[] = [{ address: "reward-pool", label: "Reward pool", kind: "pool", share: (tok(c.pool_tokens) / supply) * 100 }];
    if (c.status === "graduated" && c.damm_pool && c.amm_base) top.push({ address: c.damm_pool, label: "Meteora DAMM v2 pool (LP locked)", kind: "amm", share: (tok(c.amm_base) / supply) * 100 });
    else top.push({ address: "bonding-curve", label: "Bonding curve (Meteora DBC)", kind: "amm", share: ((tok(c.real_tokens) + tok(p.lpSupply)) / supply) * 100 });
    for (const h of r.rows) {
      top.push({
        address: h.wallet,
        kind: h.wallet === viewer ? "you" : h.wallet === c.creator ? "creator" : "holder",
        label: h.wallet === c.creator ? "Creator" : undefined,
        share: (tok(h.balance) / supply) * 100,
      });
    }
    return { total: Number(n.rows[0].n), top: top.sort((a, b) => b.share - a.share) };
  }

  async getRecentFumbles(mint: string, viewer?: string): Promise<FumbleRow[]> {
    const c = await this.coinBase(mint);
    if (!c) return [];
    const cur = this.currentQ64(c);
    const r = await this.db.query<{ ticket: string; owner: string; original_tokens: string; sell_lamports: string; sell_ts: string; sell_price_q64: string; source: "router" | "outside"; app: string | null; name: string | null }>(
      `SELECT t.ticket, t.owner, t.original_tokens, t.sell_lamports, t.sell_ts, t.sell_price_q64, t.source, t.app, u.name
         FROM tickets t LEFT JOIN users u ON u.address = t.owner WHERE t.mint = $1 ORDER BY t.sell_ts DESC LIMIT 30`,
      [c.mint],
    );
    return r.rows.map((t) => ({
      ticket: t.ticket,
      owner: t.owner,
      ownerName: t.name ?? undefined,
      tokens: tok(t.original_tokens),
      sol: lam(t.sell_lamports),
      ts: ms(t.sell_ts)!,
      multiple: mult(cur, BigInt(t.sell_price_q64)),
      isYou: viewer ? t.owner === viewer : undefined,
      source: t.source,
      app: t.app ?? undefined,
    }));
  }

  /** Average reward-pool inflow (base units/sec) over 24 h, for queue ETAs. */
  private async poolInflowPerSec(mint: string): Promise<number> {
    return (await this.poolInflows([mint])).get(mint) ?? 0;
  }

  /** `poolInflowPerSec` for many mints in one query. */
  private async poolInflows(mints: string[]): Promise<Map<string, number>> {
    if (!mints.length) return new Map();
    const r = await this.db.query<{ mint: string; v: string }>(
      `SELECT m.mint,
              (SELECT COALESCE(sum(pool_tokens_bought),0) FROM trades WHERE mint = m.mint AND ts > $2 - 86400)
            + (SELECT COALESCE(sum(tokens_out),0) FROM buybacks WHERE mint = m.mint AND ts > $2 - 86400) AS v
         FROM unnest($1::text[]) m(mint)`,
      [mints, nowSecs()],
    );
    return new Map(r.rows.map((x) => [x.mint, Number(x.v) / 86_400]));
  }

  async getClaimQueue(mint: string, viewer?: string): Promise<{ pool: number; owed: number; entries: QueueEntry[] }> {
    const c = await this.coinBase(mint);
    if (!c) return { pool: 0, owed: 0, entries: [] };
    const p = await this.params();
    const r = await this.db.query<{ ticket: string; owner: string; amount: string; sell_ts: string; name: string | null }>(
      "SELECT q.ticket, q.owner, q.amount, q.sell_ts, u.name FROM queue_entries q LEFT JOIN users u ON u.address = q.owner WHERE q.mint = $1 ORDER BY q.sell_ts, q.ticket",
      [c.mint],
    );
    const pool = BigInt(c.pool_tokens);
    const inflow = r.rows.length ? await this.poolInflowPerSec(c.mint) : 0;
    const entries = r.rows.map((e, i) => {
      const amount = BigInt(e.amount);
      const needs = poolNeededFor(amount, p.maxClaimPoolBps);
      const fitsNow = amount > 0n && amount <= (pool * BigInt(p.maxClaimPoolBps)) / 10_000n && amount <= pool;
      return {
        position: i + 1,
        ticket: e.ticket,
        owner: e.owner,
        ownerName: e.name ?? undefined,
        amount: tok(amount),
        sellTs: ms(e.sell_ts)!,
        fits: fitsNow,
        needsPool: tok(needs),
        eta: fitsNow ? 0 : inflow > 0 ? Math.round((Number(needs - pool) / inflow) * 1000) : undefined,
        isYou: viewer ? e.owner === viewer : undefined,
      };
    });
    return { pool: tok(pool), owed: tok(c.queue_owed), entries };
  }

  async getFeed(opts: { kind?: FeedKind | "all"; before?: number; limit?: number } = {}): Promise<FeedEvent[]> {
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
    const before = opts.before && Number.isFinite(opts.before) ? Math.floor(opts.before / 1000) : null;
    const r = await this.db.query<FeedRow>(
      `${FEED_SELECT} WHERE ($1::text IS NULL OR f.kind = $1) AND ($2::bigint IS NULL OR f.ts < $2) ORDER BY f.ts DESC, f.seq DESC LIMIT $3`,
      [opts.kind && opts.kind !== "all" ? opts.kind : null, before, limit],
    );
    return r.rows.map(feedEvent);
  }

  async feedById(id: string): Promise<FeedEvent | null> {
    const r = await this.db.query<FeedRow>(`${FEED_SELECT} WHERE f.id = $1`, [id]);
    return r.rows[0] ? feedEvent(r.rows[0]) : null;
  }

  async getClosestTo10x(limit = 5, viewer?: string): Promise<CloseCall[]> {
    const p = await this.params();
    const trig = p.triggerMultipleBps / 10_000;
    const r = await this.db.query<{ ticket: string; symbol: string; mint: string; owner: string; name: string | null; m: number }>(
      `SELECT t.ticket, c.symbol, c.mint, t.owner, u.name, t.last_multiple AS m
         FROM tickets t JOIN coins c USING (mint) LEFT JOIN users u ON u.address = t.owner
        WHERE t.status = 'open' AND c.status = 'graduated' AND t.last_multiple < $1
          AND NOT EXISTS (SELECT 1 FROM wallet_flags f WHERE f.wallet = t.owner)
        ORDER BY t.last_multiple DESC LIMIT $2`,
      [trig, Math.min(limit, 50)],
    );
    const rows: CloseCall[] = r.rows.map((x) => ({ ticket: x.ticket, symbol: x.symbol, mint: x.mint, owner: x.owner, ownerName: x.name ?? undefined, multiple: x.m, isYou: viewer ? x.owner === viewer : undefined }));
    if (viewer && !rows.some((x) => x.owner === viewer)) {
      const mine = await this.db.query<{ ticket: string; symbol: string; mint: string; m: number }>(
        `SELECT t.ticket, c.symbol, c.mint, t.last_multiple AS m FROM tickets t JOIN coins c USING (mint)
          WHERE t.owner = $1 AND t.status = 'open' AND c.status = 'graduated' AND t.last_multiple < $2 ORDER BY t.last_multiple DESC LIMIT 1`,
        [viewer, trig],
      );
      if (mine.rows[0]) rows.push({ ...mine.rows[0], multiple: mine.rows[0].m, owner: viewer, isYou: true });
    }
    return rows.sort((a, b) => b.multiple - a.multiple).slice(0, limit);
  }

  async getTickets(owner: string): Promise<Ticket[]> {
    const r = await this.db.query<TicketRow>(`${TICKET_SELECT} WHERE t.owner = $1 ORDER BY t.sell_ts DESC LIMIT 500`, [owner]);
    return this.tickets(r.rows);
  }

  async getTicket(id: string): Promise<Ticket | null> {
    const r = await this.db.query<TicketRow>(`${TICKET_SELECT} WHERE t.ticket = $1`, [id]);
    return r.rows[0] ? (await this.tickets(r.rows))[0] : null;
  }

  /** Map ticket rows; queue positions and pool inflows of the queued ones in two queries total. */
  private async tickets(rows: TicketRow[]): Promise<Ticket[]> {
    const queued = rows.filter((t) => t.status === "queued");
    const [pos, inflow] = queued.length
      ? await Promise.all([
          this.db.query<{ ticket: string; pos: string }>(
            `SELECT u.ticket, (SELECT count(*) + 1 FROM queue_entries q
                                 WHERE q.mint = u.mint AND (q.sell_ts < u.sell_ts OR (q.sell_ts = u.sell_ts AND q.ticket < u.ticket))) AS pos
               FROM unnest($1::text[], $2::text[], $3::bigint[]) u(ticket, mint, sell_ts)`,
            [queued.map((t) => t.ticket), queued.map((t) => t.mint), queued.map((t) => t.sell_ts)],
          ),
          this.poolInflows([...new Set(queued.map((t) => t.mint))]),
        ])
      : [null, new Map<string, number>()];
    const positions = new Map((pos?.rows ?? []).map((x) => [x.ticket, Number(x.pos)]));
    return Promise.all(rows.map((t) => this.ticket(t, positions.get(t.ticket), inflow.get(t.mint) ?? 0)));
  }

  private async ticket(t: TicketRow, queuePos?: number, inflowPerSec = 0): Promise<Ticket> {
    const p = await this.params();
    const now = nowSecs();
    const cur = this.currentQ64({ status: t.coin_status, median_q64: t.median_q64, price_q64: t.price_q64 });
    const sell = BigInt(t.sell_price_q64);
    const multiple = mult(cur, sell);
    const expired = t.status === "expired" || (t.status === "open" && Number(t.sell_ts) + Number(p.claimWindowSecs) < now);
    const meets = cur * 10_000n >= sell * BigInt(p.triggerMultipleBps);
    const chainStatus = expired && t.status === "open" ? "expired" : (t.status as Ticket["chainStatus"]);
    const inChallenge = t.status === "open" && !!t.attested_at && Number(t.attested_at) + Number(p.ticketChallengeSecs) > now;
    let state: TicketState;
    if (t.status === "claimed" || t.status === "escrowed") state = "claimed";
    else if (t.status === "voided") state = "voided";
    else if (expired) state = "expired";
    else if (t.status === "queued") state = "queued";
    else if (inChallenge) state = "challenge";
    else if (t.coin_status !== "graduated") state = "awaiting-graduation";
    else state = meets && t.median_q64 ? "claimable" : "tracking";
    const claimAmount = t.status === "queued" || t.status === "claimed" || t.status === "escrowed" ? BigInt(t.claim_amount) : (BigInt(t.tokens) * BigInt(p.claimBps)) / 10_000n;
    let queuePosition: number | undefined;
    let needs: bigint | undefined;
    let eta: number | undefined;
    if (t.status === "queued") {
      queuePosition = queuePos;
      needs = poolNeededFor(claimAmount, p.maxClaimPoolBps);
      const pool = BigInt(t.pool_tokens);
      if (needs <= pool) eta = 0;
      else if (inflowPerSec > 0) eta = Math.round((Number(needs - pool) / inflowPerSec) * 1000);
    }
    return {
      id: t.ticket,
      seq: Number(t.seq),
      owner: t.owner,
      mint: t.mint,
      symbol: t.symbol,
      coinName: t.coin_name,
      tile: tileOf(t.mint),
      coinStatus: t.coin_status,
      tokens: tok(t.tokens),
      originalTokens: tok(t.original_tokens),
      sellPrice: px(sell),
      execPrice: px(t.exec_price_q64),
      sellUsd: Number(t.sell_usd_cents) / 100,
      sellSol: lam(t.sell_lamports),
      sellTs: ms(t.sell_ts)!,
      expiresAt: t.status === "open" && !expired ? (Number(t.sell_ts) + Number(p.claimWindowSecs)) * 1000 : undefined,
      chainStatus,
      state,
      multiple,
      peakMultiple: Math.max(t.peak_multiple, multiple),
      claimAmount: tok(claimAmount),
      claimValueSol: tok(claimAmount) * px(cur),
      queuedAt: ms(t.queued_at),
      queuePosition,
      queueNeedsPool: needs !== undefined ? tok(needs) : undefined,
      queueEta: eta,
      claimedAt: ms(t.claimed_at),
      claimTx: t.claim_sig ?? undefined,
      crossedAt: ms(t.crossed_at),
      crossedMultiple: t.crossed_multiple ?? undefined,
      claimMultiple: t.paid_median_q64 ? mult(BigInt(t.paid_median_q64), sell) : undefined,
      escrowed: t.status === "escrowed" || undefined,
      rebuyDebited: tok(t.debited),
      autoClaim: !t.auto_claim_opt_out,
      autoClaimed: t.auto_claimed || undefined,
      source: t.source,
      app: t.app ?? undefined,
      sellSignature: t.sell_signature ?? undefined,
      attestedAt: ms(t.attested_at),
      claimableFrom: t.attested_at ? (Number(t.attested_at) + Number(p.ticketChallengeSecs)) * 1000 : undefined,
      voidReason: t.status === "voided" ? (t.void_reason ?? "rebuy") : undefined,
    };
  }

  async getLeaderboard(board: Board, viewer?: string): Promise<LeaderRow[]> {
    const notFlagged = "NOT EXISTS (SELECT 1 FROM wallet_flags f WHERE f.wallet = x.address)";
    let rows: Omit<LeaderRow, "rank">[] = [];
    if (board === "fumbles") {
      // Rank every ticket by a float8 estimate of its worth (cheap), keep a margin, then rank
      // the survivors exactly in numeric and join names only for them.
      const r = await this.db.query<{ address: string; name: string | null; symbol: string; mint: string; sold: string; worth: string; m: number }>(
        `WITH cur AS (SELECT mint, symbol, COALESCE(median_q64, price_q64) AS q FROM coins),
         top AS (
           SELECT t.owner AS address, t.original_tokens, t.sell_lamports, t.sell_price_q64, cur.symbol, cur.mint, cur.q
             FROM tickets t JOIN cur USING (mint)
            WHERE NOT EXISTS (SELECT 1 FROM wallet_flags f WHERE f.wallet = t.owner)
            ORDER BY t.original_tokens::float8 * cur.q::float8 DESC LIMIT 80)
         SELECT x.address, u.name, x.symbol, x.mint, x.sell_lamports AS sold,
                (x.original_tokens * x.q / 18446744073709551616)::numeric(40,0) AS worth,
                CASE WHEN x.sell_price_q64 > 0 THEN (x.q / x.sell_price_q64)::float8 ELSE 0 END AS m
           FROM top x LEFT JOIN users u ON u.address = x.address
          ORDER BY worth DESC LIMIT 50`,
      );
      rows = r.rows.map((x) => ({ address: x.address, name: x.name ?? undefined, symbol: x.symbol, mint: x.mint, soldForSol: lam(x.sold), worthNowSol: lam(x.worth), multiple: x.m }));
    } else if (board === "claimers") {
      const r = await this.db.query<{ address: string; name: string | null; claims: string; claimed: string; symbol: string; mint: string; m: number }>(
        `SELECT * FROM (
           SELECT cl.owner AS address, u.name, count(*) AS claims,
                  sum(cl.amount * cl.median_q64 / 18446744073709551616)::numeric(40,0) AS claimed,
                  (array_agg(c.symbol ORDER BY cl.amount * cl.median_q64 DESC))[1] AS symbol,
                  (array_agg(c.mint ORDER BY cl.amount * cl.median_q64 DESC))[1] AS mint,
                  max(CASE WHEN cl.sell_price_q64 > 0 THEN (cl.median_q64 / cl.sell_price_q64)::float8 ELSE 0 END) AS m
             FROM claims cl JOIN coins c USING (mint) LEFT JOIN users u ON u.address = cl.owner
            WHERE NOT cl.escrowed GROUP BY cl.owner, u.name) x
         WHERE ${notFlagged} ORDER BY claimed DESC LIMIT 50`,
      );
      rows = r.rows.map((x) => ({ address: x.address, name: x.name ?? undefined, claims: Number(x.claims), symbol: x.symbol, mint: x.mint, claimedSol: lam(x.claimed), multiple: x.m }));
    } else {
      const r = await this.db.query<{ address: string; name: string | null; symbol: string; mint: string; unlocked: number | null; at: number; waited: number }>(
        `SELECT * FROM (
           SELECT cl.owner AS address, u.name, c.symbol, c.mint, t.crossed_multiple AS unlocked,
                  CASE WHEN cl.sell_price_q64 > 0 THEN (cl.median_q64 / cl.sell_price_q64)::float8 ELSE 0 END AS at,
                  GREATEST(cl.ts - COALESCE(t.crossed_at, cl.ts), 0) / 86400.0 AS waited
             FROM claims cl JOIN tickets t USING (ticket) JOIN coins c ON c.mint = cl.mint LEFT JOIN users u ON u.address = cl.owner
            WHERE NOT cl.escrowed) x
         WHERE ${notFlagged} ORDER BY at DESC, waited DESC LIMIT 50`,
      );
      rows = r.rows.map((x) => ({ address: x.address, name: x.name ?? undefined, symbol: x.symbol, mint: x.mint, unlockedAt: x.unlocked ?? undefined, claimedAtMultiple: x.at, waitedDays: Math.round(Number(x.waited)) }));
    }
    return rows.map((row, i) => ({ ...row, rank: i + 1, isYou: viewer ? row.address === viewer : false }));
  }

  async getProfile(addressOrName: string): Promise<Profile | null> {
    const u = await this.db.query<{ address: string; name: string | null }>("SELECT address, name FROM users WHERE address = $1 OR lower(name) = lower($1) LIMIT 1", [addressOrName]);
    const address = u.rows[0]?.address ?? (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addressOrName) ? addressOrName : null);
    if (!address) return null;
    const s = await this.db.query<UserStatsRow>(
      `SELECT s.*, c.symbol AS worst_symbol FROM user_stats s LEFT JOIN coins c ON c.mint = s.worst_mint WHERE s.address = $1`,
      [address],
    );
    const flagged = (await this.db.query("SELECT 1 FROM wallet_flags WHERE wallet = $1 LIMIT 1", [address])).rowCount! > 0;
    const st = s.rows[0];
    const xp = st ? Number(st.xp) : 0;
    const lv = levelOf(xp);
    const earned = (st?.achievements ?? {}) as Record<string, boolean>;
    return {
      address,
      name: u.rows[0]?.name ?? undefined,
      level: lv.level,
      levelTitle: lv.title,
      xp,
      xpNext: lv.xpNext,
      fumbleRank: st?.fumble_rank ?? undefined,
      ticketsFiled: st?.tickets_filed ?? 0,
      crossed10x: st?.crossed ?? 0,
      claimedSol: lam(st?.claimed_lamports ?? 0),
      worst: st?.worst_symbol && st.worst_multiple ? { symbol: st.worst_symbol, multiple: st.worst_multiple } : undefined,
      flagged: flagged || !!st?.flagged,
      achievements: ACHIEVEMENTS.map((a) => ({ ...a, earned: a.id === "clean" ? !flagged && !!earned.clean : !!earned[a.id] })),
    };
  }

  /* ── Wallet portfolio ─────────────────────────────────────────────────────── */

  /**
   * The wallet's FUMPAD ledger: its trades (curve + router; SOL paid with the fee on buys,
   * received after the fee on sells) and the fumble payouts it received (claims paid to the
   * wallet, and escrowed ones once withdrawn), in chain order. Index lookups on
   * trades_wallet and claims_owner.
   */
  async ledger(wallet: string): Promise<LedgerEntry[]> {
    const r = await this.db.query<{ kind: "buy" | "sell" | "payout"; mint: string; tokens: string; lamports: string; ts: string; slot: string; idx: number }>(
      `SELECT CASE WHEN t.is_buy THEN 'buy' ELSE 'sell' END AS kind, t.mint, t.token_amount AS tokens,
              CASE WHEN t.is_buy THEN t.sol_amount + t.fee_pool + t.fee_platform + t.fee_creator + t.snipe_tax
                   ELSE GREATEST(t.sol_amount - t.fee_pool - t.fee_platform - t.fee_creator, 0) END AS lamports,
              t.ts, t.slot, t.idx
         FROM trades t WHERE t.wallet = $1
       UNION ALL
       SELECT 'payout', cl.mint, cl.amount, 0, cl.ts, x.slot, cl.idx
         FROM claims cl JOIN transactions x ON x.signature = cl.signature
        WHERE cl.owner = $1 AND (NOT cl.escrowed OR EXISTS (SELECT 1 FROM tickets k WHERE k.ticket = cl.ticket AND k.status = 'claimed'))
       LIMIT 50000`,
      [wallet],
    );
    return r.rows.map((x) => ({ kind: x.kind, mint: x.mint, tokens: BigInt(x.tokens), lamports: BigInt(x.lamports), ts: Number(x.ts), slot: Number(x.slot), idx: Number(x.idx) }));
  }

  /** Per coin: tickets the wallet filed, how many are still open, and the best open multiple. */
  async walletTicketStats(wallet: string): Promise<Map<string, TicketStat>> {
    const p = await this.params();
    const r = await this.db.query<{ mint: string; earned: number; open: number; best: number | null }>(
      `SELECT t.mint, count(*)::int AS earned,
              count(*) FILTER (WHERE t.status = 'queued' OR (t.status = 'open' AND t.sell_ts + $2 >= $3))::int AS open,
              max(CASE WHEN (t.status = 'queued' OR (t.status = 'open' AND t.sell_ts + $2 >= $3)) AND t.sell_price_q64 > 0
                       THEN ((CASE WHEN c.status = 'graduated' AND c.median_q64 IS NOT NULL THEN c.median_q64 ELSE c.price_q64 END) / t.sell_price_q64)::float8 END) AS best
         FROM tickets t JOIN coins c USING (mint) WHERE t.owner = $1 GROUP BY t.mint`,
      [wallet, Number(p.claimWindowSecs), nowSecs()],
    );
    return new Map(r.rows.map((x) => [x.mint, { earned: x.earned, open: x.open, best: x.best }]));
  }

  /** The few coin fields a portfolio row shows, for a set of mints (non-FUMPAD mints drop out). */
  async portfolioCoins(mints: string[]): Promise<Map<string, PortfolioCoinRow>> {
    if (!mints.length) return new Map();
    const p = await this.params();
    const r = await this.db.query<{ mint: string; symbol: string; name: string; status: CoinRow["status"]; price_q64: string; real_sol: string; raised_lamports: string; metadata: CoinRow["metadata"] }>(
      "SELECT mint, symbol, name, status, price_q64, real_sol, raised_lamports, metadata FROM coins WHERE mint = ANY($1::text[])",
      [mints],
    );
    return new Map(
      r.rows.map((c) => [
        c.mint,
        {
          mint: c.mint,
          symbol: c.symbol,
          name: c.name,
          tile: tileOf(c.mint),
          imageUrl: c.metadata?.image || undefined,
          status: c.status,
          curveSol: c.status === "graduated" ? lam(c.raised_lamports) : lam(c.real_sol),
          graduationSol: lam(p.graduationLamports),
          price: px(c.price_q64),
        },
      ]),
    );
  }

  /**
   * Open and closed positions. `balances` are the wallet's canonical Token-2022 balances
   * (base units) from the chain; null when the RPC is unavailable (positions then fall back
   * to what FUMPAD trades explain).
   */
  async getPortfolio(wallet: string, balances: Map<string, bigint> | null) {
    const [ledger, tickets] = await Promise.all([this.ledger(wallet), this.walletTicketStats(wallet)]);
    const books = buildBooks(ledger);
    const coins = await this.portfolioCoins([...new Set([...books.keys(), ...(balances?.keys() ?? [])])]);
    return assemble(books, balances, coins, tickets);
  }

  /** Coins the wallet launched (coins_creator), newest first, with creator fees. */
  async getCreatedCoins(wallet: string): Promise<CreatedCoin[]> {
    const ids = await this.db.query<{ mint: string }>("SELECT mint FROM coins WHERE creator = $1 ORDER BY created_at DESC LIMIT 100", [wallet]);
    const rows = (await this.coinRows(ids.rows.map((x) => x.mint))) as (CoinRow & { creator_fees_unclaimed: string })[];
    if (!rows.length) return [];
    const r = { rows };
    const w = await this.db.query<{ mint: string; withdrawn: string }>(
      "SELECT mint, sum(lamports) AS withdrawn FROM fee_withdrawals WHERE mint = ANY($1::text[]) AND is_creator GROUP BY mint",
      [r.rows.map((c) => c.mint)],
    );
    const withdrawn = new Map(w.rows.map((x) => [x.mint, lam(x.withdrawn)]));
    const sums = await this.summaries(r.rows);
    return r.rows.map((c, i) => {
      const out = withdrawn.get(c.mint) ?? 0;
      const now = lam(c.creator_fees_unclaimed);
      // Every creator fee (curve, router, settled LP fees) accrues in Coin.creator_fees_unclaimed
      // until withdrawn, so earned = withdrawn + unclaimed, exactly.
      return { ...sums[i], feesEarnedSol: out + now, feesWithdrawnSol: out, feesWithdrawableSol: now };
    });
  }

  async getStats(solUsd: number): Promise<PlatformStats> {
    const now = nowSecs();
    const r = await this.db.query<{ paid: string; crossings: string; grads: string; open: string }>(
      `SELECT
         (SELECT COALESCE(sum(amount * median_q64 / 18446744073709551616),0) FROM claims WHERE ts > $1 - 86400 AND NOT escrowed) AS paid,
         (SELECT count(*) FROM tickets WHERE crossed_at > $1 - 86400) AS crossings,
         (SELECT count(*) FROM coins WHERE graduated_at > $1 - 86400) AS grads,
         (SELECT COALESCE(sum(tickets_open),0) FROM coins) AS open`,
      [now],
    );
    const x = r.rows[0];
    return { paidBack24hSol: lam(x.paid), crossings24h: Number(x.crossings), graduated24h: Number(x.grads), openTickets: Number(x.open), solUsd };
  }
}

// ── rows + helpers ───────────────────────────────────────────────────────────

export const mult = (cur: bigint, sell: bigint) => (sell === 0n ? 0 : Number((cur * 1_000_000n) / sell) / 1_000_000);

export const ACHIEVEMENTS: Omit<Achievement, "earned">[] = [
  { id: "first", title: "First fumble", detail: "Filed a ticket", glyph: "ring" },
  { id: "tenbagger", title: "Ten-bagger regret", detail: "Ticket crossed 10×", glyph: "ring-dot" },
  { id: "thirty", title: "Waited for 30×", detail: "Claimed past 30×", glyph: "bar" },
  { id: "jumper", title: "Queue jumper", detail: "Small claim, paid first", glyph: "queue" },
  { id: "clean", title: "Clean wallet", detail: "90 days, zero flags", glyph: "check" },
  { id: "top", title: "Sold the top", detail: "Ticket expired below 1×", glyph: "down" },
];

const TITLES = ["fresh exit", "early leaver", "certified early exit", "paper-handed professional", "regret connoisseur"];
export function levelOf(xp: number) {
  const level = Math.floor(Math.sqrt(xp / 250)) + 1;
  return { level, xpNext: 250 * level * level, title: TITLES[Math.min(TITLES.length - 1, Math.floor(level / 4.5))] };
}

/** The coin's own columns (`coinBase`). */
type CoinBase = Pick<
  CoinRow,
  "mint" | "creator" | "created_at" | "status" | "damm_pool" | "amm_base" | "real_tokens" | "price_q64" | "median_q64" | "pool_tokens" | "queue_owed"
>;

interface UserStatsRow {
  xp: string;
  level: number;
  tickets_filed: number;
  crossed: number;
  claims: number;
  claimed_lamports: string;
  worst_symbol: string | null;
  worst_multiple: number | null;
  fumble_rank: number | null;
  achievements: Record<string, boolean>;
  flagged: boolean;
}

interface TicketRow {
  ticket: string;
  mint: string;
  owner: string;
  seq: string;
  tokens: string;
  original_tokens: string;
  sell_price_q64: string;
  exec_price_q64: string;
  sell_usd_cents: string;
  sell_lamports: string;
  sell_ts: string;
  status: "open" | "queued" | "claimed" | "expired" | "voided" | "escrowed";
  queued_at: string | null;
  claim_amount: string;
  claimed_at: string | null;
  claim_sig: string | null;
  debited: string;
  peak_multiple: number;
  symbol: string;
  coin_name: string;
  coin_status: "curve" | "complete" | "graduated";
  median_q64: string | null;
  price_q64: string;
  pool_tokens: string;
  auto_claimed: boolean;
  auto_claim_opt_out: boolean | null;
  crossed_at: string | null;
  crossed_multiple: number | null;
  /** Median at payout: the ticket's own column, or the claim row (escrowed payouts don't set the column). */
  paid_median_q64: string | null;
  source: "router" | "outside";
  app: string | null;
  sell_signature: string | null;
  attested_at: string | null;
  void_reason: "rebuy" | "guardian" | null;
}
const TICKET_SELECT = `
  SELECT t.*, c.symbol, c.name AS coin_name, c.status AS coin_status, c.median_q64, c.price_q64, c.pool_tokens, p.auto_claim_opt_out,
         CASE WHEN t.status IN ('claimed','escrowed') THEN COALESCE(t.claim_median_q64,
           (SELECT cl.median_q64 FROM claims cl WHERE cl.ticket = t.ticket ORDER BY cl.ts DESC LIMIT 1)) END AS paid_median_q64
    FROM tickets t JOIN coins c USING (mint) LEFT JOIN positions p ON p.mint = t.mint AND p.wallet = t.owner`;

interface FeedRow {
  id: string;
  kind: FeedKind;
  ts: string;
  actor: string;
  mint: string;
  payload: Record<string, unknown>;
  symbol: string;
  coin_name: string;
  name: string | null;
  snipe_tax_lamports: string | null;
}
const FEED_SELECT = `
  SELECT f.id, f.kind, f.ts, f.actor, f.mint, f.payload, c.symbol, c.name AS coin_name, u.name, c.snipe_tax_lamports
    FROM feed_events f JOIN coins c ON c.mint = f.mint LEFT JOIN users u ON u.address = f.actor`;

function feedEvent(r: FeedRow): FeedEvent {
  const base = {
    id: r.id,
    ts: Number(r.ts) * 1000,
    actor: r.actor,
    actorName: r.name ?? undefined,
    mint: r.mint,
    symbol: r.symbol,
    coinName: r.coin_name,
    tile: tileOf(r.mint),
    replies: 0,
    reposts: 0,
  };
  const p = r.payload as Record<string, number & boolean>;
  switch (r.kind) {
    case "launch":
      return {
        ...base,
        kind: "launch",
        poolTokens: p.poolTokens,
        ...(r.snipe_tax_lamports && BigInt(r.snipe_tax_lamports) > 0n ? { snipeTaxSol: lam(r.snipe_tax_lamports) } : {}),
      };
    case "fumble":
      return { ...base, kind: "fumble", tokens: p.tokens, sol: p.sol, ticketPrice: p.ticketPrice };
    case "cross":
      return { ...base, kind: "cross", multiple: p.multiple, claimTokens: p.claimTokens, claimSol: p.claimSol };
    case "graduation":
      return { ...base, kind: "graduation", raisedSol: p.raisedSol, ticketsUnlocked: p.ticketsUnlocked };
    case "claim":
      return { ...base, kind: "claim", multiple: p.multiple, tokens: p.tokens, sol: p.sol, fromQueue: p.fromQueue, skippedAhead: p.skippedAhead, auto: p.auto === true || undefined };
  }
}

export { Q64 };
