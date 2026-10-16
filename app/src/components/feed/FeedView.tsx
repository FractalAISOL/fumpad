"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { keepSnapshot, type CloseCall, type CoinDetail, type CoinSummary, type FeedEvent, type FeedKind, type PlatformStats, getFumpadData } from "@/data";
import { Avatar, Button, Change, Chips, CoinTile, Gauge, Multiple, Panel, PanelHead, Sparkline, cx } from "@/design";
import { Fumi, FumiEmptyState, SpeechBubble } from "@/design/anime";
import * as f from "@/design/format";
import { useLiveMessages, useRefresh } from "../shell/live";
import { useProtocolParams, useViewer } from "../shell/Providers";
import s from "./Feed.module.css";
import { FeedPost } from "./FeedPost";
import { coinHref } from "@/components/coin/ident";

type Filter = FeedKind | "all";
const FILTERS: { value: Filter; label: React.ReactNode }[] = [
  {
    value: "all",
    label: (
      <>
        <span className={s.liveDot} aria-hidden="true" />
        Everything
      </>
    ),
  },
  { value: "cross", label: "10× crossings" },
  { value: "claim", label: "Claims" },
  { value: "fumble", label: "Fumbles" },
  { value: "graduation", label: "Graduations" },
  { value: "launch", label: "Launches" },
];

export function FeedView({
  initial,
  stats: initialStats,
  closest: initialClosest,
  trending: initialTrending,
}: {
  initial: FeedEvent[];
  stats: PlatformStats;
  closest: CloseCall[];
  trending: CoinSummary[];
}) {
  const data = getFumpadData();
  const { address } = useViewer();
  const [filter, setFilter] = useState<Filter>("all");
  const [events, setEvents] = useState(initial);
  const [pending, setPending] = useState<FeedEvent[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [stats, setStats] = useState(initialStats);
  const [closest, setClosest] = useState(initialClosest);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [announce, setAnnounce] = useState("");
  const atTop = useRef(true);

  useEffect(() => {
    const onScroll = () => {
      atTop.current = window.scrollY < 240;
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const params = useProtocolParams();
  const [trending, setTrending] = useState(initialTrending);
  /** Every id shown or waiting, so a catch-up fetch and the socket never double-post. */
  const seen = useRef(new Set(initial.map((e) => e.id)));

  // The server snapshot is cached for up to a few minutes: catch up on what happened since
  // (on mount and after a reconnect), then the socket carries everything newer.
  const catchUp = useCallback(() => {
    data
      .getFeed({ limit: 24 })
      .then((latest) => {
        const missed = latest.filter((e) => !seen.current.has(e.id));
        if (!missed.length) return;
        missed.forEach((e) => seen.current.add(e.id));
        setEvents((xs) => [...missed, ...xs].sort((a, b) => b.ts - a.ts));
      })
      // Keep the snapshot; the socket still delivers new events.
      .catch(keepSnapshot);
  }, [data]);
  useEffect(catchUp, [catchUp]);

  // Side panels: totals, closest to 10× and trending follow the feed and coin activity.
  const loadSide = useCallback(() => {
    data.getStats().then(setStats).catch(keepSnapshot);
    data.getClosestTo10x(5, address).then(setClosest).catch(keepSnapshot);
    data.listCoins({ sort: "trending", limit: 6 }).then(setTrending).catch(keepSnapshot);
  }, [data, address]);
  useRefresh(loadSide, { wallets: [address], onFeed: true, pollMs: 30_000, debounceMs: 2_000 });

  // Live events. Prepend while the reader is at the top; otherwise hold them behind a
  // "new posts" button so the page never jumps under someone's thumb.
  useLiveMessages((m) => {
    if (m.type === "resync") return catchUp();
    if (m.type === "coin") {
      // Trending rows move with their coins (price, market cap, 24h).
      setTrending((ts) => (ts.some((c) => c.mint === m.coin.mint) ? ts.map((c) => (c.mint === m.coin.mint ? { ...c, ...summaryOf(m.coin) } : c)) : ts));
      return;
    }
    if (m.type !== "feed") return;
    const e = m.event;
    if (seen.current.has(e.id)) return;
    seen.current.add(e.id);
    setStats((st) => ({
      ...st,
      paidBack24hSol: st.paidBack24hSol + (e.kind === "claim" ? e.sol : 0),
      crossings24h: st.crossings24h + (e.kind === "cross" ? 1 : 0),
      openTickets: st.openTickets + (e.kind === "fumble" ? 1 : 0),
    }));
    if (atTop.current) {
      setEvents((xs) => [e, ...xs]);
      setFresh((x) => new Set(x).add(e.id));
    } else {
      setPending((xs) => [e, ...xs]);
    }
  });

  const flush = useCallback(() => {
    setEvents((xs) => [...pending, ...xs]);
    setFresh(new Set(pending.map((p) => p.id)));
    setAnnounce(`${pending.length} new ${pending.length === 1 ? "post" : "posts"} shown`);
    setPending([]);
    window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [pending]);

  const visible = events.filter((e) => filter === "all" || e.kind === filter);

  const more = async () => {
    setLoadingMore(true);
    try {
      const last = events[events.length - 1];
      const next = await data.getFeed({ before: last?.ts ?? Infinity, limit: 20 });
      setEvents((xs) => [...xs, ...next.filter((n) => !xs.some((x) => x.id === n.id))]);
      if (next.length < 20) setExhausted(true);
    } catch {
      /* the button stays; the reader can try again */
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className={cx("wrap", s.grid)}>
      <div className={s.mainCol}>
        <h1 className="sr-only">Live feed</h1>
        {/* Fumi hosts the feed (anime kit): above the totals, never beside a number. One Fumi per screen, so she
            steps out while the empty state below has her. Fixed height: no layout shift either way. */}
        <div className={s.host}>
          {visible.length > 0 && (
            <span className={s.hostArt}>
              <Fumi pose="waving" size={56} crop="bust" />
              <SpeechBubble tail="left" pop={false} className={s.hostBubble}>
                Hi, fumbler!
              </SpeechBubble>
            </span>
          )}
          <p className={s.hostLine}>
            Trade FUMPAD coins anywhere: every sell over {f.usdRule(params.minSellUsd)} counts. <Link href="/how-it-works">How it works</Link>
          </p>
        </div>
        <div className={s.wire} aria-label="Live totals, last 24 hours" role="group">
          <div>
            <div className={s.k}>Paid back to fumblers, 24h</div>
            <div className={cx("num", s.v, s.vMoney)}>{f.sol(stats.paidBack24hSol)} SOL</div>
          </div>
          <div>
            <div className={s.k}>Tickets crossing 10×, 24h</div>
            <div className={cx("num", s.v)}>{f.int(stats.crossings24h)}</div>
          </div>
          <div>
            <div className={s.k}>Graduated today</div>
            <div className={cx("num", s.v)}>{stats.graduated24h}</div>
          </div>
          <div>
            <div className={s.k}>Open tickets</div>
            <div className={cx("num", s.v)}>{f.int(stats.openTickets)}</div>
          </div>
        </div>

        <Panel className={s.feedPanel} aria-labelledby="feed-h">
          <h2 id="feed-h" className="sr-only">
            Posts
          </h2>
          <div className={s.composer}>
            <Avatar address={address} />
            <Link href="/fumbles" className={s.composerPh}>
              Post your worst sell. We&apos;ll keep the receipt.
            </Link>
            <Button variant="line" size="sm" href="/fumbles">
              Share a ticket
            </Button>
          </div>
          <div className={s.filters}>
            <Chips items={FILTERS} value={filter} onChange={setFilter} label="Filter the feed" />
          </div>
          {pending.length > 0 && (
            <div className={s.newWrap}>
              <button type="button" className={s.newBtn} onClick={flush}>
                Show {pending.length} new {pending.length === 1 ? "post" : "posts"}
              </button>
            </div>
          )}
          <div className="sr-only" aria-live="polite">
            {announce}
          </div>
          <div>
            {visible.length ? (
              visible.map((e) => <FeedPost key={e.id} e={e} fresh={fresh.has(e.id)} />)
            ) : (
              <FumiEmptyState title="Quiet for now" pose="thinking" quip="Nothing yet. Hmm." compact>
                Nothing of this kind in the last few hours. Live events land here the moment they happen.
              </FumiEmptyState>
            )}
          </div>
          {!exhausted && filter === "all" && (
            <div className={s.moreRow}>
              <Button variant="ghost" onClick={more} loading={loadingMore}>
                Load older posts
              </Button>
            </div>
          )}
        </Panel>
      </div>

      <aside className={s.side} aria-label="Launches">
        <Panel aria-labelledby="closest-h">
          <PanelHead id="closest-h" title="Closest to 10×" aside={`open tickets, ${f.durationShort(params.oracleWindowSecs)} median`} />
          <ul className={s.list}>
            {closest.map((c) => (
              <li key={c.ticket} className={s.closeRow}>
                <div className={s.closeTop}>
                  <span className={s.closeWho}>
                    <Link href={coinHref(c)} className="ticker">
                      ${c.symbol}
                    </Link>{" "}
                    <span className="muted">
                      {c.isYou ? <b className={s.yours}>your ticket</b> : (c.ownerName ?? <span className="num">{f.shortAddr(c.owner)}</span>)}
                    </span>
                  </span>
                  <Multiple x={c.multiple} size="sm" />
                </div>
                <Gauge value={c.multiple} size="mini" label={`$${c.symbol} ticket at ${f.multiple(c.multiple)}`} />
              </li>
            ))}
          </ul>
        </Panel>

        <Panel aria-labelledby="trend-h">
          <PanelHead id="trend-h" title="Trending" aside="by volume, 24h" />
          <ul className={s.list}>
            {trending.map((c) => (
              <li key={c.mint}>
                <Link href={coinHref(c)} className={s.trow}>
                  <CoinTile symbol={c.symbol} variant={c.tile} size="sm" />
                  <span className={s.nm}>
                    <span className="ticker">${c.symbol}</span>
                    <small>{c.name}</small>
                  </span>
                  <Sparkline values={c.spark} width={48} height={18} className={s.spark} />
                  <span className={s.r}>
                    <span className="num">{f.usd(c.marketCapSol * stats.solUsd)}</span>
                    <Change pct={c.change24h} size="xs" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <div className={s.sideFoot}>
            <Button variant="quiet" href="/launches">
              All launches
            </Button>
          </div>
        </Panel>
      </aside>
    </div>
  );
}

/** The list fields of a pushed CoinDetail. */
function summaryOf(c: CoinDetail): Partial<CoinSummary> {
  return { price: c.price, median: c.median, change24h: c.change24h, marketCapSol: c.marketCapSol, volume24hSol: c.volume24hSol, spark: c.spark, status: c.status, curveSol: c.curveSol };
}
