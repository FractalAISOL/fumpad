"use client";

/**
 * The wallet profile's right panel: a readout of what the wallet holds and has made, then
 * Positions, Closed, Created and Tickets. Every figure is measured: chain balances, spot
 * prices, and cost basis from the wallet's trades on each coin's pools, any app (average cost, fumble payouts at
 * zero cost). Nothing is projected.
 *
 * Live: per-coin `coin` messages reprice positions and refresh created coins in place;
 * anything that touches the wallet (and the viewer's own transactions) refetches.
 */
import { useSearchParams } from "next/navigation";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { useFumpadTx } from "@/chain/tx";
import { type ClosedPosition, type CoinDetail, type CreatedCoin, type Ticket, type WalletPosition, getFumpadData, keepSnapshot } from "@/data";
import { graduationSolOf } from "@/data/chain";
import {
  Badge,
  Button,
  CoinTile,
  type Column,
  EmptyState,
  Gauge,
  InfoTip,
  Price,
  Sol,
  Table,
  Tabs,
  Tokens,
  Tooltip,
  Multiple,
  Usd,
  cx,
  tabPanelId,
  tabId,
  useToast,
} from "@/design";
import * as f from "@/design/format";
import { LANE_NAME, curveFraction, laneOf } from "../launches/model";
import { useLiveMessages, useRefresh } from "../shell/live";
import { useNow, useSolUsd, useViewer } from "../shell/Providers";
import { ProfileTickets } from "./ProfileTickets";
import s from "./Portfolio.module.css";
import { coinHref } from "@/components/coin/ident";

export type PortfolioTab = "positions" | "closed" | "created" | "tickets";
const TABS: readonly PortfolioTab[] = ["positions", "closed", "created", "tickets"];
const ID = "pf";

export interface PortfolioData {
  positions: WalletPosition[];
  closed: ClosedPosition[];
  created: CreatedCoin[];
  tickets: Ticket[];
}

const PARTIAL_NOTE = "Includes tokens that arrived by transfer or another pool; cost basis covers trades on the coin's own pools only.";
const OPEN_STATES = new Set<Ticket["state"]>(["claimable", "tracking", "awaiting-graduation", "queued"]);

/* ── URL state ─────────────────────────────────────────────────────────────── */

const tabOf = (v: string | null): PortfolioTab => (TABS.includes(v as PortfolioTab) ? (v as PortfolioTab) : "positions");

/** Reads `?tab=` (wrap in <Suspense>; the fallback is `<PortfolioView>` on the default tab). */
export function Portfolio(props: { owner: string; initial: PortfolioData }) {
  const params = useSearchParams();
  return <PortfolioView {...props} initialTab={tabOf(params.get("tab"))} />;
}

/* ── View ──────────────────────────────────────────────────────────────────── */

export function PortfolioView({ owner, initial, initialTab = "positions" }: { owner: string; initial: PortfolioData; initialTab?: PortfolioTab }) {
  const [tab, setTab] = useState<PortfolioTab>(initialTab);
  const [data, setData] = useState(initial);
  const viewer = useViewer();
  const own = viewer.address === owner;

  // Shareable tab: the URL follows the tab without a navigation (Next syncs replaceState).
  const choose = (t: PortfolioTab) => {
    setTab(t);
    const url = new URL(window.location.href);
    if (t === "positions") url.searchParams.delete("tab");
    else url.searchParams.set("tab", t);
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  };

  const req = useRef(0);
  const load = useCallback(() => {
    const n = ++req.current;
    const d = getFumpadData();
    Promise.all([d.getPositions(owner), d.getClosedPositions(owner), d.getCreatedCoins(owner), d.getTickets(owner)])
      .then(([positions, closed, created, tickets]) => {
        if (n === req.current) setData({ positions, closed, created, tickets });
      })
      .catch(keepSnapshot);
  }, [owner]);

  // Created coins accrue fees with every trade; open tickets move with their coin's price.
  const mints = useMemo(
    () => [...new Set([...data.created.map((c) => c.mint), ...data.tickets.filter((t) => OPEN_STATES.has(t.state)).map((t) => t.mint)])].sort(),
    [data.created, data.tickets],
  );
  useRefresh(load, { wallets: [owner], mints, pollMs: 60_000, debounceMs: 1_500 });

  // Per-coin pushes: reprice positions and refresh created-coin market fields right away.
  useLiveMessages((m) => {
    if (m.type !== "coin") return;
    const c = m.coin;
    setData((d) => {
      const hitP = d.positions.some((p) => p.mint === c.mint);
      const hitC = d.created.some((x) => x.mint === c.mint);
      if (!hitP && !hitC) return d;
      return {
        ...d,
        positions: hitP ? d.positions.map((p) => (p.mint === c.mint ? reprice(p, c) : p)) : d.positions,
        created: hitC ? d.created.map((x) => (x.mint === c.mint ? { ...x, ...marketFields(c) } : x)) : d.created,
      };
    });
  });

  const items = [
    { value: "positions" as const, label: "Positions", count: data.positions.length },
    { value: "closed" as const, label: "Closed", count: data.closed.length },
    { value: "created" as const, label: "Created", count: data.created.length },
    { value: "tickets" as const, label: "Tickets", count: data.tickets.length },
  ];

  return (
    <>
      <Readout data={data} />
      <div className={s.tabsBar}>
        <Tabs items={items} value={tab} onChange={choose} label="Wallet" idBase={ID} />
      </div>
      {TABS.map((t) => (
        <div key={t} role="tabpanel" id={tabPanelId(ID, t)} aria-labelledby={tabId(ID, t)} hidden={t !== tab} tabIndex={0} className={s.panel}>
          {t === tab && t === "positions" && <Positions rows={data.positions} own={own} />}
          {t === tab && t === "closed" && <Closed rows={data.closed} own={own} />}
          {t === tab && t === "created" && <Created rows={data.created} own={own} creator={owner} onWithdrawn={load} />}
          {t === tab && t === "tickets" && <ProfileTickets tickets={data.tickets} />}
        </div>
      ))}
    </>
  );
}

/** A position at a pushed price: value and unrealized P&L follow, cost stays. */
function reprice(p: WalletPosition, c: CoinDetail): WalletPosition {
  const unrealized = p.coveredTokens > 0 ? p.coveredTokens * c.price - p.costSol : undefined;
  return {
    ...p,
    price: c.price,
    valueSol: p.balance * c.price,
    unrealizedSol: unrealized,
    unrealizedPct: unrealized !== undefined && p.costSol > 0 ? (unrealized / p.costSol) * 100 : undefined,
    status: c.status,
    curveSol: c.curveSol,
    graduationSol: c.graduationSol,
  };
}

function marketFields(c: CoinDetail): Partial<CreatedCoin> {
  return {
    price: c.price,
    status: c.status,
    marketCapSol: c.marketCapSol,
    volume24hSol: c.volume24hSol,
    holders: c.holders,
    curveSol: c.curveSol,
    poolTokens: c.poolTokens,
    ticketsOpen: c.ticketsOpen,
    graduatedAt: c.graduatedAt,
  };
}

/* ── Readout ───────────────────────────────────────────────────────────────── */

function Readout({ data }: { data: PortfolioData }) {
  const solUsd = useSolUsd();
  const value = data.positions.reduce((a, p) => a + p.valueSol, 0);
  const open = data.positions.reduce((a, p) => a + (p.unrealizedSol ?? 0), 0);
  const cost = data.positions.reduce((a, p) => a + (p.unrealizedSol !== undefined ? p.costSol : 0), 0);
  const realized = data.closed.reduce((a, p) => a + p.realizedSol, 0) + data.positions.reduce((a, p) => a + p.realizedSol, 0);
  const traded = data.closed.length + data.positions.filter((p) => p.boughtTokens > 0).length;
  const partial = data.positions.some((p) => p.partialBasis) || data.closed.some((p) => p.partialBasis);
  return (
    <div className={s.readout}>
      <dl className={s.cells}>
        <div className={cx(s.cell, s.cellValue)}>
          <dt>Holding now</dt>
          <dd>
            <Sol value={value} size="xl" className={s.big} />
            <span className={s.sub}>{solUsd > 0 ? <Usd value={value * solUsd} /> : null} at spot</span>
          </dd>
        </div>
        <div className={s.cell}>
          <dt>Unrealized</dt>
          <dd>
            <Signed value={open} size="xl" className={s.big} />
            <span className={s.sub}>{cost > 0 ? <SignedPct pct={(open / cost) * 100} /> : "No cost basis yet"}</span>
          </dd>
        </div>
        <div className={s.cell}>
          <dt>Realized</dt>
          <dd>
            <Signed value={realized} size="xl" className={s.big} />
            <span className={s.sub}>
              {traded ? `${f.int(traded)} ${traded === 1 ? "coin" : "coins"} traded` : "Nothing sold yet"}
            </span>
          </dd>
        </div>
      </dl>
      <p className={s.method}>
        Measured from your trades on each coin&apos;s pools, on any app, at average cost; fumble payouts count at zero cost.
        {partial ? " Rows marked partial hold tokens that arrived by transfer, so their P&L covers trades only." : ""}
      </p>
    </div>
  );
}

/* ── Shared cells ──────────────────────────────────────────────────────────── */

/** Signed SOL with the direction glyph: up is ink, down is graphite. Never red, green or orange. */
function Signed({ value, size = "sm", className }: { value: number; size?: "sm" | "xl"; className?: string }) {
  const dir = value > 5e-10 ? "up" : value < -5e-10 ? "down" : "flat";
  return (
    <span className={cx(s.signed, s[dir], size === "xl" ? s.sizeXl : s.sizeSm, className)}>
      <span aria-hidden="true" className={s.glyph}>
        {dir === "up" ? "▲" : dir === "down" ? "▼" : "–"}
      </span>
      <Sol value={value} signed />
      <span className="sr-only">{dir === "up" ? "gain" : dir === "down" ? "loss" : "even"}</span>
    </span>
  );
}

function SignedPct({ pct }: { pct: number }) {
  const dir = pct > 0.05 ? "up" : pct < -0.05 ? "down" : "flat";
  return (
    <span className={cx("num", s[dir])}>
      {pct > 0.05 ? "+" : pct < -0.05 ? "−" : ""}
      {f.pct(Math.abs(pct), Math.abs(pct) >= 100 ? 0 : 1, false)}
    </span>
  );
}

function PnLCell({ sol, pct, partial }: { sol?: number; pct?: number; partial?: boolean }) {
  if (sol === undefined)
    return (
      <span className={s.stack}>
        <span className="muted">No basis</span>
        {partial && <PartialTag />}
      </span>
    );
  return (
    <span className={s.stack}>
      <Signed value={sol} />
      <span className={s.subline}>{pct !== undefined ? <SignedPct pct={pct} /> : <span className="muted">at zero cost</span>}</span>
      {partial && (
        <span className={s.subline}>
          <PartialTag />
        </span>
      )}
    </span>
  );
}

function PartialTag() {
  return (
    <span className={cx(s.lift, s.partial)}>
      Partial
      <InfoTip label="Partial cost basis">{PARTIAL_NOTE}</InfoTip>
    </span>
  );
}

function CoinCell({ symbol, name, tile, mint, imageUrl, status, children }: { symbol: string; name: string; tile: 0 | 1 | 2; mint: string; imageUrl?: string; status: ReactNode; children?: ReactNode }) {
  return (
    <span className={s.coin}>
      <CoinTile symbol={symbol} variant={tile} mint={mint} imageUrl={imageUrl} size="sm" />
      <span className={s.coinText}>
        <span className={s.coinTop}>
          <span className="ticker">${symbol}</span>
          <span className={s.coinName}>{name}</span>
        </span>
        <span className={s.coinMeta}>
          {status}
          {children}
        </span>
      </span>
    </span>
  );
}

/** "Graduated", or the Launches lane with its curve percentage ("Final stretch 81%"). */
function statusText(c: { status: WalletPosition["status"]; curveSol: number; graduationSol?: number }): string {
  if (c.status === "graduated") return "Graduated";
  if (c.status === "complete") return "Curve full, graduating";
  const asSummary = { status: c.status, curveSol: c.curveSol, graduationSol: c.graduationSol } as Parameters<typeof laneOf>[0];
  const pct = curveFraction(asSummary, graduationSolOf(c)) * 100;
  return `${LANE_NAME[laneOf(asSummary, graduationSolOf(c))]} ${f.fixed(Math.floor(pct), 0)}%`;
}

/** Open fumble tickets on the coin: the brand gauge in miniature plus the best multiple. */
function TicketTag({ p }: { p: WalletPosition }) {
  if (!p.openTickets || p.bestMultiple === undefined) return null;
  const n = p.openTickets;
  const x = p.bestMultiple;
  const tip = `${n === 1 ? "Your open fumble ticket" : `Your best of ${n} open fumble tickets`} on $${p.symbol} is at ${f.multiple(x)} of its sell price. ${x >= 10 ? "Past 10×: the claim is unlocked." : "It pays out at 10×."}`;
  return (
    <Tooltip content={tip}>
      <span className={cx(s.lift, s.ticketTag)} tabIndex={0} aria-label={tip}>
        <Gauge value={x} size="mini" animate={false} className={s.miniGauge} label={`Ticket on $${p.symbol}`} />
        <Multiple x={x} size="xs" />
        {n > 1 && <span className={s.ticketN}>{n} tickets</span>}
      </span>
    </Tooltip>
  );
}

/* ── Positions ─────────────────────────────────────────────────────────────── */

function Positions({ rows, own }: { rows: WalletPosition[]; own: boolean }) {
  const solUsd = useSolUsd();
  const columns: Column<WalletPosition>[] = [
    {
      key: "coin",
      header: "Coin",
      render: (p) => (
        <CoinCell symbol={p.symbol} name={p.name} tile={p.tile} mint={p.mint} imageUrl={p.imageUrl} status={statusText(p)}>
          <TicketTag p={p} />
        </CoinCell>
      ),
    },
    {
      key: "balance",
      header: "Holding",
      align: "end",
      hideBelow: "md",
      sortValue: (p) => p.balance,
      render: (p) => (
        <span className={s.stack}>
          <Tokens value={p.balance} compact />
          {p.payoutTokens > 0 ? (
            <span className={cx(s.subline, s.lift)}>
              <Tooltip content={`${f.int(p.payoutTokens)} ${p.symbol} arrived as fumble payouts, at zero cost.`}>
                <span tabIndex={0}>
                  <Badge tone="flare-line">Fumble payout</Badge>
                </span>
              </Tooltip>
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "price",
      header: "Price / avg cost",
      align: "end",
      hideBelow: "lg",
      render: (p) => (
        <span className={s.stack}>
          <Price value={p.price} />
          <span className={s.subline}>
            {p.trackedTokens > 0 && p.avgCost > 0 ? (
              <>
                avg <Price value={p.avgCost} />
              </>
            ) : p.payoutTokens > 0 ? (
              "avg zero"
            ) : (
              "no FUMPAD buys"
            )}
          </span>
        </span>
      ),
    },
    {
      key: "value",
      header: "Value",
      align: "end",
      sortValue: (p) => p.valueSol,
      render: (p) => (
        <span className={s.stack}>
          <Sol value={p.valueSol} />
          {solUsd > 0 && (
            <span className={s.subline}>
              <Usd value={p.valueSol * solUsd} tone="muted" />
            </span>
          )}
        </span>
      ),
    },
    {
      key: "pnl",
      header: "Unrealized",
      align: "end",
      sortValue: (p) => p.unrealizedSol ?? -Infinity,
      render: (p) => <PnLCell sol={p.unrealizedSol} pct={p.unrealizedPct} partial={p.partialBasis} />,
    },
    {
      key: "trade",
      header: <span className="sr-only">Trade</span>,
      align: "end",
      hideBelow: "sm",
      render: (p) => (
        <Button href={coinHref(p)} variant="line" size="sm" className={s.lift} aria-label={`Trade $${p.symbol}`}>
          Trade
        </Button>
      ),
    },
  ];
  return (
    <Table
      columns={columns}
      rows={rows}
      rowKey={(p) => p.mint}
      rowHref={(p) => coinHref(p)}
      rowLabel={(p) => `$${p.symbol}, ${p.name}`}
      caption="Open positions, by value"
      initialSort={{ key: "value", dir: "desc" }}
      className={s.table}
      empty={
        <EmptyState title="No open positions" compact action={own ? <Button href="/launches" variant="line" size="sm">Browse launches</Button> : undefined}>
          {own ? "Buy any FUMPAD coin, here or on any app, and it shows up here with what you paid for it." : "This wallet holds no FUMPAD coins right now."}
        </EmptyState>
      }
    />
  );
}

/* ── Closed ────────────────────────────────────────────────────────────────── */

function Closed({ rows, own }: { rows: ClosedPosition[]; own: boolean }) {
  const columns: Column<ClosedPosition>[] = [
    {
      key: "coin",
      header: "Coin",
      render: (p) => (
        <CoinCell symbol={p.symbol} name={p.name} tile={p.tile} mint={p.mint} imageUrl={p.imageUrl} status={statusText(p)}>
          {p.ticketsEarned > 0 && (
            <span className={s.earned}>
              {p.ticketsEarned} {p.ticketsEarned === 1 ? "ticket" : "tickets"}
            </span>
          )}
        </CoinCell>
      ),
    },
    {
      key: "bought",
      header: "Bought",
      align: "end",
      hideBelow: "md",
      sortValue: (p) => p.boughtSol,
      render: (p) => (
        <span className={s.stack}>
          <Sol value={p.boughtSol} />
          <span className={s.subline}>
            <Tokens value={p.boughtTokens} compact tone="muted" />
            {p.payoutTokens > 0 && (
              <span className={s.lift}>
                <Tooltip content={`Plus ${f.int(p.payoutTokens)} ${p.symbol} from fumble payouts, at zero cost.`}>
                  <span tabIndex={0}>
                    <Badge tone="flare-line">+ payout</Badge>
                  </span>
                </Tooltip>
              </span>
            )}
          </span>
        </span>
      ),
    },
    {
      key: "sold",
      header: "Sold",
      align: "end",
      hideBelow: "md",
      sortValue: (p) => p.soldSol,
      render: (p) => (
        <span className={s.stack}>
          <Sol value={p.soldSol} />
          <span className={s.subline}>
            <Tokens value={p.soldTokens} compact tone="muted" />
          </span>
        </span>
      ),
    },
    {
      key: "pnl",
      header: "Realized",
      align: "end",
      sortValue: (p) => p.realizedSol,
      render: (p) => <PnLCell sol={p.realizedSol} pct={p.realizedPct} partial={p.partialBasis} />,
    },
    {
      key: "when",
      header: "Traded",
      align: "end",
      hideBelow: "lg",
      sortValue: (p) => p.lastTs,
      render: (p) => (
        <span className={s.stack}>
          <span className="num">{f.date(p.lastTs)}</span>
          <span className={s.subline}>{f.date(p.firstTs) === f.date(p.lastTs) ? "same day" : `from ${f.date(p.firstTs)}`}</span>
        </span>
      ),
    },
  ];
  return (
    <Table
      columns={columns}
      rows={rows}
      rowKey={(p) => p.mint}
      rowHref={(p) => coinHref(p)}
      rowLabel={(p) => `$${p.symbol}, ${p.name}`}
      caption="Closed positions, last trade first"
      initialSort={{ key: "when", dir: "desc" }}
      className={s.table}
      empty={
        <EmptyState title="Nothing closed yet" compact>
          {own ? "Coins you sell out of completely land here with what you made or lost." : "This wallet hasn't fully exited a FUMPAD coin."}
        </EmptyState>
      }
    />
  );
}

/* ── Created ───────────────────────────────────────────────────────────────── */

function Created({ rows, own, creator, onWithdrawn }: { rows: CreatedCoin[]; own: boolean; creator: string; onWithdrawn: () => void }) {
  const solUsd = useSolUsd();
  const now = useNow();
  const columns: Column<CreatedCoin>[] = [
    {
      key: "coin",
      header: "Coin",
      render: (c) => (
        <CoinCell symbol={c.symbol} name={c.name} tile={c.tile} mint={c.mint} imageUrl={c.imageUrl} status={statusText(c)}>
          <span className={s.earned}>launched {f.ago(c.createdAt, now)}</span>
        </CoinCell>
      ),
    },
    {
      key: "mcap",
      header: "Market cap",
      align: "end",
      // The creator's own view keeps fees and the withdraw action on a phone.
      hideBelow: own ? "sm" : undefined,
      sortValue: (c) => c.marketCapSol,
      render: (c) => (
        <span className={s.stack}>
          <Sol value={c.marketCapSol} />
          {solUsd > 0 && (
            <span className={s.subline}>
              <Usd value={c.marketCapSol * solUsd} tone="muted" />
            </span>
          )}
        </span>
      ),
    },
    { key: "vol", header: "24h volume", align: "end", hideBelow: "lg", sortValue: (c) => c.volume24hSol, render: (c) => <Sol value={c.volume24hSol} /> },
    { key: "holders", header: "Holders", align: "end", hideBelow: "lg", sortValue: (c) => c.holders, render: (c) => <span className="num">{f.int(c.holders)}</span> },
    { key: "pool", header: "Reward pool", align: "end", hideBelow: "md", render: (c) => <Tokens value={c.poolTokens} compact /> },
    {
      key: "fees",
      header: "Creator fees",
      align: "end",
      sortValue: (c) => c.feesEarnedSol,
      render: (c) => (
        <span className={s.stack}>
          <Sol value={c.feesEarnedSol} />
          <span className={s.subline}>
            {c.feesWithdrawableSol <= 0 ? (
              <span className="muted">all withdrawn</span>
            ) : own && c.creator === creator ? (
              <WithdrawButton coin={c} onDone={onWithdrawn} />
            ) : (
              <>
                <Sol value={c.feesWithdrawableSol} tone="money" size="xs" /> <span className="muted">unwithdrawn</span>
              </>
            )}
          </span>
        </span>
      ),
    },
  ];
  return (
    <>
      <Table
        columns={columns}
        rows={rows}
        rowKey={(c) => c.mint}
        rowHref={(c) => coinHref(c)}
        rowLabel={(c) => `$${c.symbol}, ${c.name}`}
        caption="Coins this wallet launched, newest first"
        className={s.table}
        empty={
          <EmptyState title={own ? "You haven't launched a coin" : "No launches"} compact action={own ? <Button href="/launch" variant="line" size="sm">Launch a coin</Button> : undefined}>
            {own ? "Launch one and its creator fees collect here, ready to withdraw." : "This wallet hasn't launched a coin on FUMPAD."}
          </EmptyState>
        }
      />
      {rows.length > 0 && (
        <p className={s.method}>
          The creator gets a share of every trade&apos;s fee on their coin. It sits in the coin&apos;s account until the creator withdraws it.
        </p>
      )}
    </>
  );
}

function WithdrawButton({ coin, onDone }: { coin: CreatedCoin; onDone: () => void }) {
  const tx = useFumpadTx();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const amount = f.sol(coin.feesWithdrawableSol);
  const go = async () => {
    setBusy(true);
    const ok = await tx.withdrawCreatorFees({ mint: coin.mint });
    setBusy(false);
    if (ok) {
      toast(`Withdrew ${amount} SOL of $${coin.symbol} creator fees${ok.simulated ? " (simulated)" : ""}.`, "money");
      onDone();
    } else {
      toast(tx.lastError() ?? "The withdrawal didn't go through.");
    }
  };
  return (
    <Button variant="flare" size="sm" className={cx(s.lift, s.withdraw)} loading={busy} onClick={go} aria-label={`Withdraw ${amount} SOL of creator fees from $${coin.symbol}`}>
      Withdraw {amount} SOL
    </Button>
  );
}
