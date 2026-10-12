"use client";

import { useCallback, useState } from "react";
import { keepSnapshot, type CoinSummary, getFumpadData } from "@/data";
import { graduationSolOf } from "@/data/chain";
import { Badge, Change, CoinTile, type Column, CurveMeter, EmptyState, Panel, Price, Segmented, Sparkline, Table, Tokens, Usd } from "@/design";
import * as f from "@/design/format";
import { useLiveMessages, useRefresh } from "../shell/live";
import { useNow } from "../shell/Providers";
import s from "./Coins.module.css";

type Filter = "all" | "curve" | "graduated";

export function CoinsView({ coins: initialCoins, solUsd }: { coins: CoinSummary[]; solUsd: number }) {
  const now = useNow();
  const [filter, setFilter] = useState<Filter>("all");
  const [coins, setCoins] = useState(initialCoins);

  // New launches and graduations arrive as feed events; a light poll is the floor.
  const load = useCallback(() => {
    getFumpadData().listCoins({ sort: "mcap" }).then(setCoins).catch(keepSnapshot);
  }, []);
  useRefresh(load, { onFeed: true, pollMs: 30_000, debounceMs: 2_000 });
  // Prices, market caps and curve progress move with every pushed coin.
  useLiveMessages((m) => {
    if (m.type !== "coin") return;
    const c = m.coin;
    setCoins((cs) =>
      cs.some((x) => x.mint === c.mint)
        ? cs.map((x) =>
            x.mint === c.mint
              ? {
                  ...x,
                  price: c.price,
                  median: c.median,
                  change24h: c.change24h,
                  marketCapSol: c.marketCapSol,
                  volume24hSol: c.volume24hSol,
                  curveSol: c.curveSol,
                  status: c.status,
                  poolTokens: c.poolTokens,
                  ticketsOpen: c.ticketsOpen,
                  holders: c.holders,
                  spark: c.spark,
                }
              : x,
          )
        : cs,
    );
  });
  const rows = coins.filter((c) => filter === "all" || (filter === "curve" ? c.status !== "graduated" : c.status === "graduated"));

  const cols: Column<CoinSummary>[] = [
    {
      key: "coin",
      header: "Coin",
      render: (c) => (
        <span className={s.coin}>
          <CoinTile symbol={c.symbol} variant={c.tile} size="sm" />
          <span className={s.coinText}>
            <span className="ticker">${c.symbol}</span>
            <small>{c.name}</small>
          </span>
        </span>
      ),
      sortValue: (c) => c.symbol,
    },
    {
      key: "stage",
      header: "Stage",
      hideBelow: "md",
      width: "150px",
      render: (c) =>
        c.status === "graduated" ? (
          <Badge tone="ink">Graduated</Badge>
        ) : (
          <span className={s.stage}>
            <CurveMeter raised={c.curveSol} target={graduationSolOf(c)} size="sm" />
            <span className="num">{f.fixed((c.curveSol / graduationSolOf(c)) * 100, 0)}%</span>
          </span>
        ),
      sortValue: (c) => (c.status === "graduated" ? 100 : (c.curveSol / graduationSolOf(c)) * 99),
    },
    { key: "price", header: "Price, SOL", align: "end", hideBelow: "lg", render: (c) => <Price value={c.median ?? c.price} />, sortValue: (c) => c.price },
    { key: "chg", header: "24h", align: "end", render: (c) => <Change pct={c.change24h} />, sortValue: (c) => c.change24h },
    {
      key: "spark",
      header: <span className="sr-only">Last 24 hours</span>,
      hideBelow: "sm",
      render: (c) => <Sparkline values={c.spark} width={64} height={20} />,
    },
    { key: "mcap", header: "Market cap", align: "end", render: (c) => <Usd value={c.marketCapSol * solUsd} />, sortValue: (c) => c.marketCapSol },
    {
      key: "vol",
      header: "Volume, 24h",
      align: "end",
      hideBelow: "lg",
      render: (c) => <Usd value={c.volume24hSol * solUsd} />,
      sortValue: (c) => c.volume24hSol,
    },
    {
      key: "pool",
      header: "Reward pool",
      align: "end",
      hideBelow: "lg",
      render: (c) => <Tokens value={c.poolTokens} compact />,
      sortValue: (c) => c.poolTokens,
    },
    {
      key: "tk",
      header: "Open tickets",
      align: "end",
      hideBelow: "md",
      render: (c) => <span className="num">{f.int(c.ticketsOpen)}</span>,
      sortValue: (c) => c.ticketsOpen,
    },
    {
      key: "age",
      header: "Age",
      align: "end",
      hideBelow: "lg",
      render: (c) => <span className="num muted">{f.ago(c.createdAt, now)}</span>,
      sortValue: (c) => -c.createdAt,
    },
  ];

  return (
    <div className="wrap">
      <div className={s.head}>
        <div>
          <h1 className={s.h1}>Coins</h1>
          <p className={s.lede}>Every coin launched on FUMPAD. Each one keeps its own reward pool for the people who sell it too early.</p>
        </div>
        <Segmented
          label="Stage"
          value={filter}
          onChange={setFilter}
          items={[
            { value: "all", label: "All", count: coins.length },
            { value: "curve", label: "On the curve", count: coins.filter((c) => c.status !== "graduated").length },
            { value: "graduated", label: "Graduated", count: coins.filter((c) => c.status === "graduated").length },
          ]}
        />
      </div>
      <Panel>
        <Table
          caption="Coins"
          columns={cols}
          rows={rows}
          rowKey={(c) => c.mint}
          rowHref={(c) => `/coin/${c.symbol}`}
          rowLabel={(c) => `${c.name}, $${c.symbol}`}
          initialSort={{ key: "mcap", dir: "desc" }}
          empty={<EmptyState title="No coins here yet">Launch one and it shows up here.</EmptyState>}
        />
      </Panel>
    </div>
  );
}
