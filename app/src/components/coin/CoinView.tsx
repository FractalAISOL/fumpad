"use client";

import { useEffect, useMemo, useState } from "react";
import { keepSnapshot, type ChartRange, type CoinDetail, type FumbleRow, type Holder, type PricePoint, type QueueEntry, type Ticket, getFumpadData } from "@/data";
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
  KV,
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
import * as f from "@/design/format";
import { useNow, useViewer } from "../shell/Providers";
import s from "./Coin.module.css";
import { TradePanel } from "./TradePanel";

const RANGES: { value: ChartRange; label: string }[] = [
  { value: "1h", label: "1h" },
  { value: "1d", label: "1d" },
  { value: "7d", label: "7d" },
  { value: "all", label: "All" },
];
const RANGE_LABEL: Record<ChartRange, string> = { "1h": "last hour", "1d": "last day", "7d": "last 7 days", all: "since launch" };

export function CoinView({
  coin,
  series: initialSeries,
  holders,
  fumbles,
  queue,
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
  const [range, setRange] = useState<ChartRange>("7d");
  const [series, setSeries] = useState<{ range: ChartRange; points: PricePoint[] }>({ range: "7d", points: initialSeries });
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const grad = coin.status === "graduated";
  const target = graduationSolOf(coin);

  useEffect(() => {
    if (series.range === range) return;
    let live = true;
    data.getPriceSeries(coin.mint, range).then((points) => live && setSeries({ range, points })).catch(keepSnapshot);
    return () => {
      live = false;
    };
  }, [data, coin.mint, range, series.range]);

  useEffect(() => {
    let live = true;
    data.getTickets(address).then((ts) => live && setTickets(ts.filter((t) => t.mint === coin.mint))).catch(keepSnapshot);
    return () => {
      live = false;
    };
  }, [data, address, coin.mint]);

  const mine = useMemo(() => {
    const open = tickets.filter((t) => t.state !== "expired" && t.state !== "voided" && t.state !== "claimed");
    return open.sort((a, b) => b.sellTs - a.sellTs)[0];
  }, [tickets]);

  const others = useMemo(() => fumbles.filter((r) => !r.isYou && r.owner !== address).map((r) => ({ t: r.ts, p: r.sol / r.tokens })), [fumbles, address]);
  const loading = series.range !== range;

  const head = (
    <header className={s.head}>
      <CoinTile symbol={coin.symbol} variant={coin.tile} size="lg" />
      <div className={s.headText}>
        <h1 className={s.name}>{coin.name}</h1>
        <div className={s.sub}>
          <span className="ticker">${coin.symbol}</span>
          <span>
            by <Address address={coin.creator} avatar={false} />
          </span>
          <span>launched {f.date(coin.createdAt)}</span>
          <span>
            {grad
              ? `graduated${coin.graduatedAt ? ` ${f.date(coin.graduatedAt)}` : ""}, PumpSwap`
              : `on the bonding curve, ${f.fixed((coin.curveSol / target) * 100, 1)}%`}
          </span>
        </div>
      </div>
      <div className={s.prices}>
        <Stat label={grad ? "Price, 30-min median" : "Price"}>
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
    <Panel className={s.chartPanel} aria-labelledby="chart-h">
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

  return (
    <div className="wrap">
      {head}
      <div className={s.grid}>
        <div className={s.leftCol}>
          {chart}
          {grad ? (
            <Panel aria-labelledby="queue-h">
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
            <Panel aria-labelledby="curve-h">
              <PanelHead id="curve-h" title="Bonding curve" aside={`graduates at ${f.fixed(target, target < 10 ? 2 : 0)} SOL, then moves to PumpSwap`} />
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
                Sells on the curve still file tickets. They count toward 10× right away; you can claim once the coin graduates and the 30-min median holds
                there.
              </PanelNote>
            </Panel>
          )}
        </div>
        <Panel className={s.tradePanel}>
          <PanelBody>
            <TradePanel coin={coin} myTicket={mine} />
          </PanelBody>
        </Panel>
      </div>

      <div className={s.lower}>
        {grad ? (
          <>
            <Panel aria-labelledby="pool-h">
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
                    { k: "Seeded at launch, 8%", v: <Tokens value={coin.poolSeeded} /> },
                  ]}
                />
                <p className={s.splitLabel}>Where each 1% trade fee goes</p>
                <SplitBar
                  label="Fee split"
                  parts={[
                    { label: "pool", share: 50 },
                    { label: "FUMPAD", share: 30 },
                    { label: "creator", share: 20 },
                  ]}
                />
              </PanelBody>
              <PanelNote>
                Liquidity is locked forever in an immutable locker. Its trading fees are skimmed: tokens go to this pool, SOL to FUMPAD and the creator.
              </PanelNote>
            </Panel>
          </>
        ) : (
          <>
            <Panel aria-labelledby="pool-h">
              <PanelHead id="pool-h" title="Reward pool" aside="filling" />
              <PanelBody>
                <Stat label="8% seeded at launch, plus curve-fee buybacks">
                  <Tokens value={coin.poolTokens} size="xl" symbol={coin.symbol} />
                </Stat>
                <KV
                  className={s.kvGap}
                  rows={[
                    { k: "Tickets waiting on graduation", v: <span className="num">{f.int(coin.ticketsOpen)}</span> },
                    { k: "Already past 10×", v: <span className="num">{coin.ticketsPast10x}</span> },
                  ]}
                />
              </PanelBody>
            </Panel>
          </>
        )}

        <Panel className={s.span2} aria-labelledby="fumbles-h">
          <PanelHead id="fumbles-h" title="Recent fumbles" aside="sells over $50 through FUMPAD" />
          <Table
            caption={`Recent ${coin.symbol} fumbles`}
            columns={fumbleCols}
            rows={fumbles}
            rowKey={(r) => r.ticket}
            highlight={(r) => !!r.isYou || r.owner === address}
            empty={
              <EmptyState title="No fumbles yet" compact>
                Nobody has sold ${coin.symbol} for $50 or more through FUMPAD. The first ticket starts the board.
              </EmptyState>
            }
          />
        </Panel>

        <Panel aria-labelledby="holders-h">
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

        <Panel aria-labelledby="about-h">
          <PanelHead id="about-h" title="About" />
          <PanelBody>
            <p className={s.about}>{coin.description}</p>
            <KV
              className={s.kvGap}
              rows={[
                { k: "Mint", v: <Address address={coin.mint} avatar={false} link={false} copy /> },
                { k: "Tickets filed", v: <span className="num">{f.int(coin.ticketsCreated)}</span> },
                { k: "Volume, 24h", v: <Sol value={coin.volume24hSol} /> },
              ]}
            />
          </PanelBody>
        </Panel>
      </div>
    </div>
  );
}
