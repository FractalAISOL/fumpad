"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  keepSnapshot,
  type ChartRange,
  type CoinDetail,
  type FumbleRow,
  type Holder,
  type PricePoint,
  type ProtocolParams,
  type QueueEntry,
  type Ticket,
  type TradeRow,
  getFumpadData,
} from "@/data";
import { graduationSolOf } from "@/data/chain";
import {
  Address,
  Badge,
  Change,
  CoinTile,
  type Column,
  CurveMeter,
  EmptyState,
  Gauge,
  IconGlobe,
  IconTelegram,
  IconX,
  KV,
  Loading,
  Multiple,
  Panel,
  PanelBody,
  PanelHead,
  PanelNote,
  PoolMeter,
  Price,
  PriceChart,
  Segmented,
  Skeleton,
  Sol,
  SplitBar,
  Stat,
  Table,
  Tokens,
  Usd,
  cx,
} from "@/design";
import { Fumi, SpeechBubble } from "@/design/anime";
import * as f from "@/design/format";
import { useLiveMessages, useRefresh } from "../shell/live";
import { useNow, useProtocolParams, useViewer } from "../shell/Providers";
import s from "./Coin.module.css";
import { TradePanel } from "./TradePanel";
import { coinFeeView } from "@/data/fees";
import { hasLookalikeChars } from "./ident";
import { MintTag } from "./MintTag";

const RANGES: { value: ChartRange; label: string }[] = [
  { value: "1h", label: "1h" },
  { value: "1d", label: "1d" },
  { value: "7d", label: "7d" },
  { value: "all", label: "All" },
];
const RANGE_LABEL: Record<ChartRange, string> = { "1h": "last hour", "1d": "last day", "7d": "last 7 days", all: "since launch" };
const RANGE_MS: Record<ChartRange, number> = { "1h": 3_600_000, "1d": 86_400_000, "7d": 7 * 86_400_000, all: Infinity };
/** Live points kept on top of a fetched series before the oldest are dropped. */
const MAX_POINTS = 1_500;

/** Append pushed points (strictly newer than the last; same timestamp replaces) and drop what fell out of the range. */
function extend(points: PricePoint[], add: PricePoint[], range: ChartRange, now: number): PricePoint[] {
  if (!add.length) return points;
  const out = points.slice();
  for (const p of add) {
    const last = out[out.length - 1];
    if (!last || p.t > last.t) out.push(p);
    else if (p.t === last.t) out[out.length - 1] = p;
  }
  const from = now - RANGE_MS[range];
  let cut = 0;
  // Keep one point before the window so the line still starts at the left edge.
  while (cut < out.length - 2 && out[cut + 1].t < from) cut++;
  const trimmed = cut ? out.slice(cut) : out;
  return trimmed.length > MAX_POINTS ? trimmed.slice(trimmed.length - MAX_POINTS) : trimmed;
}

type CoinLink = { href: string; label: string; icon: typeof IconX };

/** Only http(s) links from creator metadata are ever rendered. */
function safeHref(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** The coin's X / Telegram / website from its metadata socials, else its labelled links; deduplicated. */
function coinLinks(coin: CoinDetail): CoinLink[] {
  const out: CoinLink[] = [];
  const add = (raw: string | undefined, label: string, icon: CoinLink["icon"]) => {
    const href = safeHref(raw);
    if (href && !out.some((l) => l.href === href)) out.push({ href, label, icon });
  };
  const so = coin.socials;
  add(so?.x, "X", IconX);
  add(so?.telegram, "Telegram", IconTelegram);
  if (so?.website) add(so.website, hostOf(so.website), IconGlobe);
  for (const l of coin.links ?? []) {
    const k = l.label.toLowerCase();
    if (k === "x" || k === "twitter") add(l.href, "X", IconX);
    else if (k === "telegram") add(l.href, "Telegram", IconTelegram);
    else add(l.href, l.label || hostOf(l.href), IconGlobe);
  }
  return out;
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./, "");
  } catch {
    return "Website";
  }
}

/**
 * Keeps the side column in view from 1000 px: it sticks under the header when it fits the
 * viewport; when it's taller, its top goes negative so it scrolls until its last panel is in
 * view and then holds (no gap opens beside the main column).
 */
function useStickySide() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = () => {
      const header = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-h")) || 58;
      const top = Math.min(header + 16, window.innerHeight - el.offsetHeight - 16);
      el.style.setProperty("--side-top", `${Math.round(top)}px`);
    };
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    window.addEventListener("resize", set);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", set);
    };
  }, []);
  return ref;
}

export function CoinView({
  coin: initialCoin,
  series: initialSeries,
  holders: initialHolders,
  fumbles: initialFumbles,
  queue: initialQueue,
  solUsd,
}: {
  coin: CoinDetail;
  series: PricePoint[];
  holders: { total: number; top: Holder[] };
  fumbles: FumbleRow[];
  queue: { pool: number; owed: number; entries: QueueEntry[] };
  solUsd: number;
}) {
  const data = getFumpadData();
  const { address } = useViewer();
  const now = useNow();
  const params = useProtocolParams();
  const [coin, setCoin] = useState(initialCoin);
  const [holders, setHolders] = useState(initialHolders);
  const [fumbles, setFumbles] = useState(initialFumbles);
  const [queue, setQueue] = useState(initialQueue);
  const [trades, setTrades] = useState<TradeRow[] | null>(null);
  const [freshTrades, setFreshTrades] = useState<Set<string>>(new Set());
  const [range, setRange] = useState<ChartRange>("7d");
  const [series, setSeries] = useState<{ range: ChartRange; points: PricePoint[] }>({ range: "7d", points: initialSeries });
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const grad = coin.status === "graduated";
  const target = graduationSolOf(coin);
  const mint = coin.mint;
  const rangeRef = useRef(range);
  useEffect(() => {
    rangeRef.current = range;
  }, [range]);

  // A new coin page (client navigation between coins) starts from its own server snapshot.
  const [shownMint, setShownMint] = useState(initialCoin.mint);
  if (shownMint !== initialCoin.mint) {
    setShownMint(initialCoin.mint);
    setCoin(initialCoin);
    setHolders(initialHolders);
    setFumbles(initialFumbles);
    setQueue(initialQueue);
    setTrades(null);
    setSeries({ range: "7d", points: initialSeries });
    setRange("7d");
    setTickets([]);
  }

  /** (Re)load the series for the shown range: on mount (the server snapshot may be minutes old), on range change, after a reconnect. */
  const loadSeries = useCallback(() => {
    const want = rangeRef.current;
    data
      .getPriceSeries(mint, want)
      .then((points) => {
        if (rangeRef.current === want) setSeries({ range: want, points });
      })
      .catch(keepSnapshot);
  }, [data, mint]);
  useEffect(() => {
    if (series.range !== range) loadSeries();
  }, [range, series.range, loadSeries]);
  useEffect(loadSeries, [loadSeries]);

  // Panels that change when anything touches this coin or the viewer's wallet.
  const loadPanels = useCallback(() => {
    data.getCoin(mint).then((c) => c && c.mint === mint && setCoin(c)).catch(keepSnapshot);
    data.getHolders(mint, address).then(setHolders).catch(keepSnapshot);
    data.getRecentFumbles(mint, address).then(setFumbles).catch(keepSnapshot);
    data.getClaimQueue(mint, address).then(setQueue).catch(keepSnapshot);
    data.getRecentTrades(mint, 30).then((ts) => setTrades((prev) => mergeTrades(ts, prev))).catch(keepSnapshot);
    data.getTickets(address).then((ts) => setTickets(ts.filter((t) => t.mint === mint))).catch(keepSnapshot);
  }, [data, mint, address]);
  useRefresh(loadPanels, { mints: [mint], wallets: [address], pollMs: 30_000, debounceMs: 800 });

  // Pushed state: price, market cap, curve, pool and the chart move with every message.
  useLiveMessages((m) => {
    if (m.type === "resync") return loadSeries();
    if (m.type !== "coin" || m.coin.mint !== mint) return;
    setCoin(m.coin);
    if (m.points.length) setSeries((sr) => (sr.range === rangeRef.current ? { ...sr, points: extend(sr.points, m.points, sr.range, data.now()) } : sr));
    if (m.trades.length) {
      setTrades((prev) => mergeTrades(m.trades, prev));
      setFreshTrades(new Set(m.trades.map((t) => t.signature + t.wallet + t.ts)));
    }
  });

  const mine = useMemo(() => {
    const open = tickets.filter((t) => t.state !== "expired" && t.state !== "voided" && t.state !== "claimed");
    return open.sort((a, b) => b.sellTs - a.sellTs)[0];
  }, [tickets]);

  const others = useMemo(() => fumbles.filter((r) => !r.isYou && r.owner !== address).map((r) => ({ t: r.ts, p: r.sol / r.tokens })), [fumbles, address]);
  const loading = series.range !== range;
  const sideRef = useStickySide();
  const description = coin.description?.trim();
  const links = useMemo(() => coinLinks(coin), [coin]);

  const head = (
    <header className={s.head}>
      <CoinTile symbol={coin.symbol} variant={coin.tile} size="lg" />
      <div className={s.headText}>
        <h1 className={s.name}>{coin.name}</h1>
        <div className={s.sub}>
          <span className="ticker">${coin.symbol}</span>
          <MintTag mint={coin.mint} />
          {(hasLookalikeChars(coin.symbol) || hasLookalikeChars(coin.name)) && (
            <Badge tone="ink">
              <span title="The name or symbol uses characters outside plain A–Z, 0–9 (e.g. Cyrillic letters that look Latin). Check the mint.">Look-alike characters</span>
            </Badge>
          )}
          <span>
            by <Address address={coin.creator} avatar={false} />
          </span>
          <span>launched {f.date(coin.createdAt)}</span>
          <span>
            {grad
              ? `graduated${coin.graduatedAt ? ` ${f.date(coin.graduatedAt)}` : ""}, trading on Meteora`
              : `on the bonding curve, ${f.fixed((coin.curveSol / target) * 100, 1)}%`}
          </span>
        </div>
      </div>
      <div className={s.prices}>
        <Stat label={grad ? `Price, ${f.durationShort(params.oracleWindowSecs)} median` : "Price"}>
          <Price value={coin.median ?? coin.price} unit size="xl" />
        </Stat>
        <Stat label="Market cap">
          <Usd value={coin.marketCapSol * solUsd} size="lg" />
        </Stat>
        <Stat label="24h">
          <Change pct={coin.change24h} size="lg" />
        </Stat>
      </div>
    </header>
  );

  const chart = (
    <Panel className={cx(s.chartPanel, s.oChart)} aria-labelledby="chart-h">
      <PanelHead id="chart-h" title="Price">
        <Segmented size="sm" label="Chart range" value={range} onChange={setRange} items={RANGES} />
      </PanelHead>
      <div className={s.chartBox}>
        {loading ? (
          <div className={s.chartSkel}>
            <Skeleton h="100%" />
          </div>
        ) : (
          <PriceChart
            points={series.points}
            sell={mine ? { t: mine.sellTs, p: mine.sellPrice } : undefined}
            trigger={mine ? mine.sellPrice * 10 : undefined}
            others={others}
            rangeLabel={RANGE_LABEL[range]}
            symbol={coin.symbol}
            live
          />
        )}
      </div>
      <div className={s.legend}>
        <span>
          <i className={s.lgLine} />
          Price, log scale
        </span>
        {mine && (
          <>
            <span>
              <i className={s.lgTen} />
              10× of your sell
            </span>
            <span>
              <i className={s.lgRing} />
              Your sell
            </span>
          </>
        )}
        <span>
          <i className={s.lgSq} />
          Other fumbles
        </span>
      </div>
      {mine && range !== "all" && series.points.length > 0 && mine.sellTs < series.points[0].t && (
        <p className={s.outOfRange}>
          Your sell on {f.date(mine.sellTs)} is before this range.{" "}
          <button type="button" className={s.linkBtn} onClick={() => setRange("all")}>
            Show all
          </button>
        </p>
      )}
    </Panel>
  );

  const fumbleCols: Column<FumbleRow>[] = [
    { key: "who", header: "Seller", render: (r) => <Address address={r.owner} name={r.ownerName} you={r.isYou || r.owner === address} /> },
    { key: "when", header: "When", render: (r) => <span className="muted">{f.ago(r.ts, now)}</span>, sortValue: (r) => r.ts, hideBelow: "sm" },
    {
      key: "where",
      header: "Sold on",
      hideBelow: "md",
      render: (r) =>
        r.verifying ? (
          <Badge tone="muted" dot>
            verifying
          </Badge>
        ) : (
          <span className="muted">{r.source === "router" ? "FUMPAD" : (f.appName(r.app) ?? "elsewhere")}</span>
        ),
    },
    { key: "sold", header: "Sold", align: "end", render: (r) => <Tokens value={r.tokens} compact />, sortValue: (r) => r.tokens },
    { key: "for", header: "For", align: "end", render: (r) => <Sol value={r.sol} />, sortValue: (r) => r.sol, hideBelow: "md" },
    {
      key: "x",
      header: "Progress to 10×",
      width: "34%",
      sortValue: (r) => r.multiple,
      render: (r) => (
        <div className={s.progress}>
          <Gauge value={r.multiple} size="mini" label={`Ticket at ${f.multiple(r.multiple)}`} />
          <Multiple x={r.multiple} size="xs" className={s.progressX} />
        </div>
      ),
    },
  ];

  const queueCols: Column<QueueEntry>[] = [
    { key: "pos", header: "#", render: (q) => <span className={cx("num", s.qpos, (q.isYou || q.owner === address) && s.qposMe)}>{q.position}</span> },
    { key: "who", header: "Wallet", render: (q) => <Address address={q.owner} name={q.ownerName} you={q.isYou || q.owner === address} /> },
    { key: "amt", header: "Claim", align: "end", render: (q) => <Tokens value={q.amount} compact /> },
    { key: "sold", header: "Sold", align: "end", render: (q) => <span className="num muted">{f.dateTime(q.sellTs)}</span>, hideBelow: "md" },
    {
      key: "st",
      header: "Status",
      render: (q) =>
        q.fits ? (
          <Badge tone="flare">Fits now, pays next crank</Badge>
        ) : (
          <Badge>
            Waits for a {f.compact(q.needsPool)} pool{q.eta ? `, ${f.eta(q.eta)}` : ""}
          </Badge>
        ),
    },
  ];

  // Fumi's one reaction on a coin: the finished result (graduation). Its own row between the header
  // and the columns, never inside or beside the chart, prices or trade panel (STYLE-ANIME.md).
  const gradMoment = grad && (
    <div className={s.gradMoment}>
      <Fumi pose="cheering" size={48} crop="bust" />
      <SpeechBubble tail="left" className={s.gradQuip}>
        It graduated!
      </SpeechBubble>
      <p className={s.gradText}>
        Curve filled{coin.graduatedAt ? ` ${f.date(coin.graduatedAt)}` : ""}. Now on Meteora; tickets that reach 10× can claim.
      </p>
    </div>
  );

  return (
    <div className="wrap">
      {head}
      {gradMoment}
      <div className={s.cols}>
        <div className={s.colMain}>
          {chart}
          {grad ? (
            <Panel className={s.oCurve} aria-labelledby="queue-h">
              <PanelHead id="queue-h" title="Claim queue" aside="ordered by sell time, small claims skip ahead" />
              <Table
                caption={`${coin.symbol} claim queue`}
                columns={queueCols}
                rows={queue.entries}
                rowKey={(q) => q.ticket}
                highlight={(q) => !!q.isYou || q.owner === address}
                empty={
                  <EmptyState title="No one is waiting" compact>
                    Every claim on ${coin.symbol} fits the pool right now, so claims pay in the same transaction.
                  </EmptyState>
                }
              />
              <PanelNote>
                Queued claims don&apos;t expire while they wait. A claim can take at most 10% of the pool, so the pool grows into the big ones; smaller claims
                that fit pay first.
              </PanelNote>
            </Panel>
          ) : (
            <Panel className={s.oCurve} aria-labelledby="curve-h">
              <PanelHead id="curve-h" title="Bonding curve" aside={`Meteora DBC, graduates at ${f.fixed(target, target < 10 ? 2 : 0)} SOL`} />
              <div className={s.curveBox}>
                <div className={s.curveStats}>
                  <Stat label={`${f.fixed(Math.max(0, target - coin.curveSol), 2)} SOL to go. Claims on this coin open at graduation.`}>
                    <span className={s.curveBig}>
                      <Sol value={coin.curveSol} unit={false} size="xl" /> <span className="muted">of {f.fixed(target, target < 10 ? 2 : 0)} SOL</span>
                    </span>
                  </Stat>
                  <Stat label={`+${f.fixed(coin.curveSol1h, 1)} SOL in the last hour`} align="end">
                    <span className="num">{f.fixed((coin.curveSol / target) * 100, 1)}%</span>
                  </Stat>
                </div>
                <CurveMeter raised={coin.curveSol} target={target} />
              </div>
              <PanelNote>
                At {f.fixed(target, target < 10 ? 2 : 0)} SOL the curve completes and its liquidity moves to a Meteora DAMM v2 pool, 100% locked for good. Sells on the
                curve, on any app, still count: they file tickets toward 10× right away, and you can claim once the coin graduates and the{" "}
                {f.durationShort(params.oracleWindowSecs)} median holds there.
              </PanelNote>
            </Panel>
          )}
          <Panel className={s.oFumbles} aria-labelledby="fumbles-h">
            <PanelHead id="fumbles-h" title="Recent fumbles" aside={`sells over ${f.usd(params.minSellUsd)}, any app`} />
            <Table
              caption={`Recent ${coin.symbol} fumbles`}
              columns={fumbleCols}
              rows={fumbles}
              rowKey={(r) => r.ticket}
              highlight={(r) => !!r.isYou || r.owner === address}
              empty={
                <EmptyState title="No fumbles yet" compact>
                  Nobody has sold ${coin.symbol} for {f.usd(params.minSellUsd)} or more yet, on any app. The first ticket starts the board.
                </EmptyState>
              }
            />
          </Panel>

          <Panel className={s.oTrades} aria-labelledby="trades-h">
            <PanelHead id="trades-h" title="Recent trades" aside="every app, live" />
            {trades === null ? (
              <Loading label="Loading trades">
                <div className={s.tradesSkel}>
                  {[0, 1, 2, 3].map((i) => (
                    <Skeleton key={i} h={14} />
                  ))}
                </div>
              </Loading>
            ) : trades.length ? (
              <ul className={s.trades} aria-live="polite" aria-relevant="additions">
                {trades.slice(0, 12).map((t) => {
                  const k = t.signature + t.wallet + t.ts;
                  return (
                    <li key={k} className={cx(freshTrades.has(k) && s.fresh)}>
                      <span className={cx(s.side, t.side === "sell" && s.sideSell)}>
                        <span aria-hidden="true">{t.side === "buy" ? "▲" : "▼"}</span> {t.side === "buy" ? "Buy" : "Sell"}
                      </span>
                      <span className={s.who}>
                        <Address address={t.wallet} you={t.wallet === address} />
                        {t.snipeTaxSol !== undefined && t.snipeTaxBps !== undefined ? (
                          <span title={`Traded in the launch window: a ${f.fixed(t.snipeTaxBps / 100, 1)}% fee instead of ${f.fixed(coinFeeView(params, coin).feeBps / 100, 2)}%. FUMPAD's share goes to ${coin.fees?.policy === "wallet_split" ? "a designated wallet" : "the reward pool"}.`}>
                            <Badge tone="muted" className={s.taxTag}>
                              snipe fee {f.fixed(t.snipeTaxBps / 100, 0)}%
                            </Badge>
                          </span>
                        ) : (
                          f.appName(t.app) && <span className={s.via}>via {f.appName(t.app)}</span>
                        )}
                      </span>
                      <Tokens value={t.tokens} compact />
                      <Sol value={t.sol} />
                      <span className={cx("num muted", s.tradeAgo)}>{f.ago(t.ts, now)}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState title="No trades yet" compact>
                The first buy of ${coin.symbol} shows up here as it happens.
              </EmptyState>
            )}
          </Panel>

          <Panel className={s.oAbout} aria-labelledby="about-h">
            <PanelHead id="about-h" title="About" />
            <PanelBody>
              {description && <p className={s.about}>{description}</p>}
              {links.length > 0 && (
                <ul className={s.links} aria-label={`${coin.symbol} links`}>
                  {links.map((l) => (
                    <li key={l.href}>
                      <a href={l.href} target="_blank" rel="noopener noreferrer nofollow">
                        <l.icon width={14} height={14} aria-hidden="true" />
                        <span>{l.label}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
              <KV
                className={description || links.length ? s.kvGap : undefined}
                rows={[
                  { k: "Mint", v: <Address address={coin.mint} avatar={false} link={false} copy /> },
                  ...(coin.dbcPool ? [{ k: "Curve, Meteora DBC", v: <Address address={coin.dbcPool} avatar={false} link={false} copy /> }] : []),
                  ...(coin.dammPool ? [{ k: "Pool, Meteora DAMM v2", v: <Address address={coin.dammPool} avatar={false} link={false} copy /> }] : []),
                  { k: "Tickets filed", v: <span className="num">{f.int(coin.ticketsCreated)}</span> },
                  { k: "Volume, 24h", v: <Sol value={coin.volume24hSol} /> },
                ]}
              />
            </PanelBody>
          </Panel>
        </div>
        <div className={s.colSide} ref={sideRef}>
          <Panel className={cx(s.tradePanel, s.oTrade)}>
            <PanelBody>
              <TradePanel coin={coin} myTicket={mine} />
            </PanelBody>
          </Panel>

          {grad ? (
            <Panel className={s.oPool} aria-labelledby="pool-h">
              <PanelHead id="pool-h" title="Reward pool" aside={`${coin.symbol} held for claims`} />
              <PanelBody>
                <Stat label={`≈ ${f.sol(coin.poolTokens * (coin.median ?? coin.price))} SOL at the median price`}>
                  <Tokens value={coin.poolTokens} size="xl" symbol={coin.symbol} />
                </Stat>
                {queue.entries.length > 0 && (
                  <PoolMeter pool={coin.poolTokens} needed={Math.max(...queue.entries.map((q) => q.needsPool))} symbol={coin.symbol} />
                )}
                <KV
                  className={s.kvGap}
                  rows={[
                    { k: "Largest single claim, 10% of pool", v: <Tokens value={coin.poolTokens * 0.1} /> },
                    { k: "Bought back, 24h", v: <Tokens value={coin.poolBought24h} signed /> },
                    { k: "Paid out, all time", v: <Tokens value={coin.poolPaidOut} /> },
                    { k: `Arrived at graduation, ${f.fixed((params.rewardPoolSupply / params.totalSupply) * 100, 0)}%`, v: <Tokens value={coin.poolSeeded} /> },
                    ...(coin.snipeTaxSol
                      ? [{ k: `Launch-window fees, ${f.int(coin.snipeTaxedTrades ?? 0)} ${coin.snipeTaxedTrades === 1 ? "trade" : "trades"}`, v: <Sol value={coin.snipeTaxSol} /> }]
                      : []),
                  ]}
                />
                <FeeSplit params={params} coin={coin} />
              </PanelBody>
              <PanelNote>
                The liquidity is a Meteora DAMM v2 position owned by FUMPAD&apos;s fee claimer, 100% permanently locked: nobody can withdraw it, including us. Its fees
                are claimed in SOL and split like every trade fee.
              </PanelNote>
            </Panel>
          ) : (
            <Panel className={s.oPool} aria-labelledby="pool-h">
              <PanelHead id="pool-h" title="Reward pool" aside="filling" />
              <PanelBody>
                <Stat label="Bought back from trade fees so far">
                  <Tokens value={coin.poolTokens} size="xl" symbol={coin.symbol} />
                </Stat>
                <KV
                  className={s.kvGap}
                  rows={[
                    {
                      k: `Arrives at graduation, ${f.fixed((params.rewardPoolSupply / params.totalSupply) * 100, 0)}% of supply`,
                      v: <Tokens value={params.rewardPoolSupply} compact />,
                    },
                    { k: "Tickets waiting on graduation", v: <span className="num">{f.int(coin.ticketsOpen)}</span> },
                    { k: "Already past 10×", v: <span className="num">{coin.ticketsPast10x}</span> },
                    ...(coin.snipeTaxSol
                      ? [{ k: `Launch-window fees, ${f.int(coin.snipeTaxedTrades ?? 0)} ${coin.snipeTaxedTrades === 1 ? "trade" : "trades"}`, v: <Sol value={coin.snipeTaxSol} /> }]
                      : []),
                  ]}
                />
                <FeeSplit params={params} coin={coin} />
              </PanelBody>
            </Panel>
          )}

          <Panel className={s.oHolders} aria-labelledby="holders-h">
            <PanelHead id="holders-h" title="Holders" aside={<span className="num">{f.int(holders.total)}</span>} />
            <ul className={s.holders}>
              {holders.top.map((h) => (
                <li key={h.address + h.kind}>
                  <Address
                    address={h.address}
                    name={h.label}
                    you={h.kind === "you" || h.address === address}
                    link={h.kind === "holder" || h.kind === "you" || h.kind === "creator"}
                  />
                  <span className="num">{f.fixed(h.share, 2)}%</span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}

/**
 * Where each trade fee goes (D32): Meteora keeps its protocol share, FUMPAD's share splits
 * 50 / 30 / 20 (the bar), whichever app the trade came from. The coin's OWN fee and split (`coinFeeView`): the
 * one-off first-coin config trades at 3% and splits FUMPAD's share pool / a designated wallet (INTERFACE §5.9).
 */
function FeeSplit({ params, coin }: { params: ProtocolParams; coin: CoinDetail }) {
  const pct = (bps: number) => f.fixed(bps / 100, bps % 100 ? 2 : 0);
  const v = coinFeeView(params, coin);
  const ours = (v.feeBps * (10_000 - v.venueFeeShareBps)) / 10_000;
  return (
    <>
      <p className={s.splitLabel}>
        Of each {pct(v.feeBps)}% trade fee, on any app, Meteora keeps {pct(v.feeBps - ours)}%. FUMPAD&apos;s {pct(ours)}% goes:
      </p>
      <SplitBar label="Fee split" parts={v.parts} />
      {v.wallet && (
        <p className={s.splitLabel}>
          First-coin launch config: {f.fixed(v.wallet.poolPctOfVolume, 1)}% of volume buys ${coin.symbol} into its reward pool, {f.fixed(v.wallet.walletPctOfVolume, 1)}% goes to{" "}
          {f.shortAddr(v.wallet.address)} (plus FUMPAD&apos;s launch-window share). No creator share.
        </p>
      )}
    </>
  );
}

/** Newest first, no duplicates (a pushed trade can also arrive in the next refetch). */
function mergeTrades(add: TradeRow[], prev: TradeRow[] | null): TradeRow[] {
  const seen = new Set<string>();
  const out: TradeRow[] = [];
  for (const t of [...add, ...(prev ?? [])]) {
    const k = t.signature + t.wallet + t.ts;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, 50);
}
