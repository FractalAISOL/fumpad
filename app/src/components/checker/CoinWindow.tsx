"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type ChartRange, type CoinDetail, type PricePoint, type ProtocolParams, type TradeRow, getFumpadData, keepSnapshot } from "@/data";
import { graduationSolOf } from "@/data/chain";
import { coinFeeView } from "@/data/fees";
import {
  Badge,
  Change,
  CoinTile,
  CopyButton,
  CurveMeter,
  EmptyState,
  IconExternal,
  Loading,
  Panel,
  PanelHead,
  PanelNote,
  Price,
  PriceChart,
  Segmented,
  Skeleton,
  Sol,
  Stat,
  Tokens,
  Usd,
  cx,
} from "@/design";
import * as f from "@/design/format";
import { MintTag } from "../coin/MintTag";
import { useClock, useLatest } from "./hooks";
import { solscan, tradeLinks } from "./model";
import s from "./Checker.module.css";

const RANGES: { value: ChartRange; label: string }[] = [
  { value: "1h", label: "1h" },
  { value: "1d", label: "1d" },
  { value: "all", label: "All" },
];
const RANGE_LABEL: Record<ChartRange, string> = { "1h": "last hour", "1d": "last day", "7d": "last 7 days", all: "since launch" };

const VENUE: Record<NonNullable<TradeRow["venue"]>, string> = { dbc: "Curve", damm: "Pool" };

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
  return out.sort((a, b) => b.ts - a.ts).slice(0, 40);
}

function extend(points: PricePoint[], add: PricePoint[]): PricePoint[] {
  if (!add.length) return points;
  const out = points.slice();
  for (const p of add) {
    const last = out[out.length - 1];
    if (!last || p.t > last.t) out.push(p);
    else if (p.t === last.t) out[out.length - 1] = p;
  }
  return out.length > 1_500 ? out.slice(out.length - 1_500) : out;
}

/**
 * The launch-window coin: identity, price and market cap, curve progress (or graduated), a live chart and the
 * latest trades from every app. Pushed state comes over the API's WebSocket (`coin` messages); a light poll is the
 * floor. No wallet, no Privy, nothing to sign.
 */
export function CoinWindow({
  mint,
  initialCoin,
  initialSeries,
  params,
  solUsd: initialSolUsd,
  clusterQuery,
  onCoin,
  serverNow,
}: {
  mint: string;
  initialCoin: CoinDetail | null;
  initialSeries: PricePoint[];
  params: ProtocolParams;
  solUsd: number;
  clusterQuery: string;
  /** The latest coin state, for the checker's claim-target progress. */
  onCoin?: (c: CoinDetail) => void;
  serverNow: number;
}) {
  const data = getFumpadData();
  const now = useClock(15_000, serverNow);
  const [coin, setCoin] = useState<CoinDetail | null>(initialCoin);
  const [range, setRange] = useState<ChartRange>("all");
  const [series, setSeries] = useState<{ range: ChartRange; points: PricePoint[] }>({ range: "all", points: initialSeries });
  const [trades, setTrades] = useState<TradeRow[] | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [solUsd, setSolUsd] = useState(initialSolUsd);
  const rangeRef = useRef(range);
  const onCoinRef = useLatest(onCoin);
  useEffect(() => {
    rangeRef.current = range;
  }, [range]);
  useEffect(() => {
    if (coin) onCoinRef.current?.(coin);
  }, [coin, onCoinRef]);

  const loadSeries = useCallback(() => {
    const want = rangeRef.current;
    data
      .getPriceSeries(mint, want)
      .then((points) => rangeRef.current === want && setSeries({ range: want, points }))
      .catch(keepSnapshot);
  }, [data, mint]);
  const loadAll = useCallback(() => {
    data.getCoin(mint).then((c) => c && c.mint === mint && setCoin(c)).catch(keepSnapshot);
    data.getRecentTrades(mint, 30).then((ts) => setTrades((prev) => mergeTrades(ts, prev))).catch(keepSnapshot);
    data.getSolUsd().then(setSolUsd).catch(keepSnapshot);
  }, [data, mint]);

  useEffect(() => {
    if (series.range !== range) loadSeries();
  }, [range, series.range, loadSeries]);
  const indexed = coin !== null;
  useEffect(() => {
    loadSeries();
    loadAll();
    // Floor under the socket; faster while the coin isn't indexed yet (it registers any second).
    const id = setInterval(
      () => {
        loadAll();
        if (!indexed) loadSeries();
      },
      indexed ? 20_000 : 5_000,
    );
    return () => clearInterval(id);
  }, [loadAll, loadSeries, indexed]);

  useEffect(
    () =>
      data.subscribeLive((m) => {
        if (m.type === "resync") return loadAll();
        if (m.type !== "coin" || m.coin.mint !== mint) return;
        setCoin(m.coin);
        if (m.points.length) setSeries((sr) => (sr.range === rangeRef.current ? { ...sr, points: extend(sr.points, m.points) } : sr));
        if (m.trades.length) {
          setTrades((prev) => mergeTrades(m.trades, prev));
          setFresh(new Set(m.trades.map((t) => t.signature + t.wallet + t.ts)));
        }
      }),
    [data, mint, loadAll],
  );

  if (!coin) {
    return (
      <Panel className={s.waitPanel} aria-labelledby="coin-wait">
        <div className={s.waitBody}>
          <span className={s.liveDot} aria-hidden="true" />
          <h2 id="coin-wait" className={s.waitTitle}>
            The first coin is registering
          </h2>
          <p className={s.waitText}>
            Its mint is <span className="num">{f.shortAddr(mint, 6, 6)}</span>
            <CopyButton value={mint} label="Copy mint" />. The chart and trades appear here as soon as the indexer sees it, usually within a minute.
          </p>
        </div>
      </Panel>
    );
  }

  const grad = coin.status === "graduated";
  const target = graduationSolOf(coin);
  const price = coin.median ?? coin.price;
  const mcSol = coin.marketCapSol;
  const fee = coinFeeView(params, coin);
  const curvePct = Math.min(100, (coin.curveSol / target) * 100);

  return (
    <div className={s.window}>
      <header className={s.coinHead}>
        <CoinTile symbol={coin.symbol} variant={coin.tile} size="xl" mint={coin.mint} imageUrl={coin.imageUrl} />
        <div className={s.coinId}>
          <div className={s.coinKicker}>
            <Badge tone="ink" dot>
              Live
            </Badge>
            <span>Launched {f.ago(coin.createdAt, now) === "now" ? "just now" : `${f.ago(coin.createdAt, now)} ago`}</span>
          </div>
          <h2 className={s.coinName}>{coin.name}</h2>
          <div className={s.coinSub}>
            <span className={cx("ticker", s.ticker)}>${coin.symbol}</span>
            <span className={s.mintRow}>
              <MintTag mint={coin.mint} />
              <CopyButton value={coin.mint} label="Copy mint address" />
            </span>
            <a className={s.ext} href={solscan("token", coin.mint, clusterQuery)} target="_blank" rel="noopener noreferrer">
              Solscan <IconExternal width={12} height={12} aria-hidden="true" />
            </a>
          </div>
        </div>
      </header>

      <div className={s.stats}>
        <Stat label={grad ? `Price, ${f.durationShort(params.oracleWindowSecs)} median` : "Price"}>
          <Price value={price} unit size="xl" className={s.statBig} />
        </Stat>
        <Stat label="Market cap" hint={<Sol value={mcSol} />}>
          <Usd value={mcSol * solUsd} size="xl" className={s.statBig} />
        </Stat>
        <Stat label="24h">
          <Change pct={coin.change24h} size="lg" />
        </Stat>
        <Stat label="Trade fee" hint={fee.feeBps !== params.feeBps ? "launch-coin config" : "any app"}>
          <span className={cx("num", s.statNum)}>{f.fixed(fee.feeBps / 100, fee.feeBps % 100 ? 2 : 0)}%</span>
        </Stat>
      </div>

      <div className={s.windowGrid}>
        <Panel className={s.chartPanel} aria-labelledby="w-chart">
          <PanelHead id="w-chart" title="Price" aside={<span className={s.liveTag}>live</span>}>
            <Segmented size="sm" label="Chart range" value={range} onChange={setRange} items={RANGES} />
          </PanelHead>
          <div className={s.chartBox}>
            {series.range !== range ? (
              <div className={s.chartSkel}>
                <Skeleton h="100%" />
              </div>
            ) : series.points.length > 1 ? (
              <PriceChart points={series.points} rangeLabel={RANGE_LABEL[range]} symbol={coin.symbol} live height={280} />
            ) : (
              <EmptyState title="No trades yet" compact>
                The chart starts with the first trade.
              </EmptyState>
            )}
          </div>
        </Panel>

        <div className={s.sideCol}>
          <Panel aria-labelledby="w-curve">
            {grad ? (
              <>
                <PanelHead id="w-curve" title="Graduated" aside="Meteora DAMM v2" />
                <div className={s.curveBox}>
                  <p className={s.gradLine}>
                    The curve filled{coin.graduatedAt ? ` ${f.ago(coin.graduatedAt, now) === "now" ? "just now" : `${f.ago(coin.graduatedAt, now)} ago`}` : ""}. ${coin.symbol} now trades in a
                    Meteora pool whose liquidity is locked for good. <b>Claims are open</b> for tickets whose target holds.
                  </p>
                  <div className={s.kvLine}>
                    <span>Reward pool</span>
                    <Tokens value={coin.poolTokens} compact symbol={coin.symbol} />
                  </div>
                </div>
              </>
            ) : (
              <>
                <PanelHead id="w-curve" title="Bonding curve" aside={`${f.fixed(curvePct, 1)}% to graduation`} />
                <div className={s.curveBox}>
                  <div className={s.curveNums}>
                    <span>
                      <Sol value={coin.curveSol} unit={false} size="lg" /> <span className="muted">of {f.fixed(target, target < 10 ? 2 : 0)} SOL</span>
                    </span>
                    <span className="muted num">{f.fixed(Math.max(0, target - coin.curveSol), 2)} SOL to go</span>
                  </div>
                  <CurveMeter raised={coin.curveSol} target={target} />
                </div>
                <PanelNote>At {f.fixed(target, target < 10 ? 2 : 0)} SOL it graduates to Meteora. Tickets track from the first sell; claims open after graduation.</PanelNote>
              </>
            )}
          </Panel>

          <Panel aria-labelledby="w-trade">
            <PanelHead id="w-trade" title="Trade it now" aside="any app counts" />
            <div className={s.tradeLinks}>
              {tradeLinks(coin.mint).map((l) => (
                <a key={l.label} className={s.tradeLink} href={l.href} target="_blank" rel="noopener noreferrer nofollow">
                  <span>{l.label}</span>
                  <IconExternal width={13} height={13} aria-hidden="true" />
                </a>
              ))}
            </div>
            <PanelNote>Links open third-party apps. Sells over {f.usdRule(params.minSellUsd)} count wherever you trade.</PanelNote>
          </Panel>
        </div>

        <Panel className={s.tradesPanel} aria-labelledby="w-trades">
          <PanelHead id="w-trades" title="Recent trades" aside="every app, live" />
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
              {trades.slice(0, 14).map((t) => {
                const k = t.signature + t.wallet + t.ts;
                const app = f.appName(t.app);
                return (
                  <li key={k} className={cx(fresh.has(k) && s.fresh)}>
                    <span className={cx(s.side, t.side === "sell" && s.sideSell)}>
                      <span aria-hidden="true">{t.side === "buy" ? "▲" : "▼"}</span> {t.side === "buy" ? "Buy" : "Sell"}
                    </span>
                    <span className={s.tradeWho}>
                      <span className="num">{f.shortAddr(t.wallet)}</span>
                      <span className={s.venue}>
                        {t.venue ? VENUE[t.venue] : ""}
                        {t.venue && (app || t.snipeTaxBps) ? " · " : ""}
                        {t.snipeTaxBps ? `launch fee ${f.fixed(t.snipeTaxBps / 100, 0)}%` : app ? `via ${app}` : ""}
                      </span>
                    </span>
                    <Tokens value={t.tokens} compact />
                    <Sol value={t.sol} />
                    <a className={cx("num muted", s.tradeAgo)} href={solscan("tx", t.signature, clusterQuery)} target="_blank" rel="noopener noreferrer" title="View on Solscan">
                      {f.ago(t.ts, now)}
                    </a>
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
      </div>
    </div>
  );
}
