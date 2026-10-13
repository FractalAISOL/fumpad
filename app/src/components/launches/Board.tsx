"use client";

import Link from "next/link";
import { type CSSProperties, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { useFumpadTx } from "@/chain/tx";
import { type CoinSummary, getFumpadData, keepSnapshot } from "@/data";
import { graduationSolOf } from "@/data/chain";
import { CoinTile, CopyButton, EmptyState, Gauge, IconBolt, IconFilter, IconGlobe, IconSearch, IconTelegram, IconX, Segmented, cx, useToast } from "@/design";
import * as f from "@/design/format";
import { useLiveMessages, useRefresh } from "../shell/live";
import { useNow, useProtocolParams, useViewer } from "../shell/Providers";
import { requestWalletConnect } from "../shell/Wallet";
import { useInstantSettings } from "../wallet/store";
import { FilterPanel } from "./Filters";
import {
  type BoardFilters,
  type GradSort,
  type LaneFilter,
  type LaneId,
  LANES,
  LANE_NAME,
  NO_FILTERS,
  activeCount,
  age,
  ageSpoken,
  cleanFilters,
  curveFraction,
  laneOf,
  matches,
  sortLane,
} from "./model";
import { usePersisted } from "./persist";
import s from "./Board.module.css";
import { coinHref, hasLookalikeChars } from "@/components/coin/ident";
import { MintTag } from "@/components/coin/MintTag";
import { minOutFromQuote } from "@/chain/build";
import { FIRST_TIME_RENT, solLamports } from "@/chain/limits";

/** Live data, and whether quick-buys go on chain (else they are simulated by the mock). */
const LIVE_API = !!process.env.NEXT_PUBLIC_FUMPAD_API;
const CURVE_LIMIT = 150;
const GRAD_LIMIT = 80;

const DEFAULT_BUY = 0.1;
const cleanAmount = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1000 ? v : DEFAULT_BUY);
const cleanSort = (v: unknown): GradSort => (v === "recent" ? "recent" : "volume");

const LANE_HINT: Record<LaneId, string> = {
  new: "Under half the curve, newest first",
  final: "Past half the curve, closest to graduating first",
  graduated: "Trading on Meteora, LP locked. Tickets can pay out here.",
};

/* ── A one-second clock for ages ("12s") ─────────────────────────────────── */

let sec: number | null = null;
const secListeners = new Set<() => void>();
let secTimer: ReturnType<typeof setInterval> | undefined;
function subscribeSec(cb: () => void) {
  secListeners.add(cb);
  secTimer ??= setInterval(() => {
    sec = Math.floor(getFumpadData().now() / 1000) * 1000;
    secListeners.forEach((l) => l());
  }, 1000);
  return () => {
    secListeners.delete(cb);
    if (!secListeners.size && secTimer) {
      clearInterval(secTimer);
      secTimer = undefined;
      sec = null;
    }
  };
}
const secSnapshot = () => (sec ??= Math.floor(getFumpadData().now() / 1000) * 1000);

function Age({ ts }: { ts: number }) {
  const serverNow = useNow();
  const now = useSyncExternalStore(subscribeSec, secSnapshot, () => serverNow);
  return (
    <span className={cx("num", s.age)} title={f.dateTime(ts) + " UTC"}>
      <span aria-hidden="true">{age(ts, now)}</span>
      <span className="sr-only">{ageSpoken(ts, now)}</span>
    </span>
  );
}

/* ── Formatting ───────────────────────────────────────────────────────────── */

const usd = (n: number) => (n >= 1e4 ? f.usd(n) : "$" + f.int(n));
/** Never shows 100% before the curve is actually full (99.6 → "99"). */
const pctLabel = (p: number) => (p < 10 ? f.fixed(Math.floor(p * 10) / 10, 1) : f.fixed(Math.floor(p), 0));
const solShort = (n: number, target: number) => f.fixed(n, target < 10 ? 2 : n >= 10 ? 1 : 2);

/* ── Row ──────────────────────────────────────────────────────────────────── */

type Arrival = { kind: "crossed" | "graduated"; at: number };

interface RowProps {
  coin: CoinSummary;
  lane: LaneId;
  solUsd: number;
  graduationSol: number;
  buyLabel: string;
  /** The buy signs with no popup (Trading wallet, Instant trading on, amount within the limit). */
  instant: boolean;
  busy: boolean;
  /** Another quick-buy is in flight (one signature at a time). */
  locked: boolean;
  arrival?: Arrival;
  onBuy: (c: CoinSummary) => void;
}

const Row = memo(function Row({ coin: c, lane, solUsd, graduationSol, buyLabel, instant, busy, locked, arrival, onBuy }: RowProps) {
  const pct = curveFraction(c, graduationSol) * 100;
  const target = graduationSol || graduationSolOf(c);
  const raised = c.status === "curve" ? c.curveSol : target;
  const href = coinHref(c);
  const so = c.socials;
  return (
    <article className={cx(s.row, arrival && s.arrived)} data-mint={c.mint}>
      <CoinTile symbol={c.symbol} variant={c.tile} imageUrl={c.imageUrl} size="md" className={s.tile} />
      <div className={s.top}>
        <Link href={href} className={s.name} prefetch={false}>
          <span className={cx("ticker", s.tk)}>${c.symbol}</span>
          <span className={s.full}>{c.name}</span>
        </Link>
        {/* H-3: a symbol or name with non-ASCII look-alikes shows its mint right in the row. */}
        {(hasLookalikeChars(c.symbol) || hasLookalikeChars(c.name)) && <MintTag mint={c.mint} />}
        {arrival && <span className={s.tag}>{arrival.kind === "graduated" ? "Graduated" : "Past 50%"}</span>}
        <Age ts={c.createdAt} />
      </div>
      <button
        type="button"
        className={cx(s.buy, instant && s.buyInstant)}
        onClick={() => onBuy(c)}
        disabled={locked && !busy}
        aria-busy={busy || undefined}
        aria-label={busy ? `Buying $${c.symbol}` : `${instant ? "Instant quick-buy" : "Quick-buy"} ${buyLabel} SOL of $${c.symbol}`}
      >
        {busy ? (
          <span className={s.dots} aria-hidden="true" />
        ) : (
          <>
            <IconBolt width={13} height={13} />
            <span className="num">{buyLabel}</span>
            {instant && (
              <span className={s.instantTag} aria-hidden="true">
                Instant
              </span>
            )}
          </>
        )}
      </button>
      <div className={s.meta}>
        <span className={cx("num", s.addr)} title={c.mint}>
          <span className="sr-only">Mint address ending </span>…{c.mint.slice(-4)}
        </span>
        <CopyButton value={c.mint} label={`Copy $${c.symbol} mint address`} />
        {so?.x && (
          <a className={s.social} href={so.x} target="_blank" rel="noopener noreferrer nofollow" aria-label={`$${c.symbol} on X`}>
            <IconX width={13} height={13} />
          </a>
        )}
        {so?.telegram && (
          <a className={s.social} href={so.telegram} target="_blank" rel="noopener noreferrer nofollow" aria-label={`$${c.symbol} on Telegram`}>
            <IconTelegram width={14} height={14} />
          </a>
        )}
        {so?.website && (
          <a className={s.social} href={so.website} target="_blank" rel="noopener noreferrer nofollow" aria-label={`$${c.symbol} website`}>
            <IconGlobe width={14} height={14} />
          </a>
        )}
        {c.creatorFlagged && (
          <span className={s.flag} title="The indexer flagged this coin's creator wallet (linked wallets or rebuys elsewhere).">
            Flagged creator
          </span>
        )}
      </div>
      <dl className={s.stats}>
        <div>
          <dt>MC</dt>
          <dd className="num">{usd(c.marketCapSol * solUsd)}</dd>
        </div>
        <div>
          <dt>Vol</dt>
          <dd className="num">{usd(c.volume24hSol * solUsd)}</dd>
        </div>
        <div>
          <dt>Txns</dt>
          <dd className="num">{f.compact(c.trades24h)}</dd>
        </div>
        <div>
          <dt>Holders</dt>
          <dd className="num">{f.compact(c.holders)}</dd>
        </div>
        <div>
          <dt>Pool</dt>
          <dd className="num" title={`${f.tokens(c.poolTokens)} ${c.symbol} in the reward pool`}>
            {f.compact(c.poolTokens)}
          </dd>
        </div>
        <div>
          <dt>Tickets</dt>
          <dd className="num">{f.compact(c.ticketsOpen)}</dd>
        </div>
      </dl>
      {lane === "graduated" ? (
        <div className={s.meter}>
          {c.closestMultiple !== undefined ? (
            <>
              <Gauge value={c.closestMultiple} size="mini" animate={false} className={s.gauge} label={`Closest open ticket on $${c.symbol}`} />
              <span className={cx("num", s.meterVal)}>
                {f.multiple(c.closestMultiple)}
                <span className={s.meterOf}> / 10×</span>
              </span>
              <span className={s.meterNote}>closest ticket</span>
            </>
          ) : (
            <span className={s.meterNote}>No open tickets below 10×</span>
          )}
        </div>
      ) : (
        <div className={s.meter}>
          <span
            className={s.curve}
            role="progressbar"
            aria-label={`$${c.symbol} bonding curve`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pct)}
            aria-valuetext={`${pctLabel(pct)}%, ${f.fixed(raised, 2)} of ${f.fixed(target, 2)} SOL`}
            style={{ "--pct": `${pct}%` } as CSSProperties}
          >
            <i className={s.curveFill} />
            <i className={s.curveHalf} />
          </span>
          <span className={cx("num", s.meterVal)}>{pctLabel(pct)}%</span>
          <span className={cx("num", s.meterNote)}>
            {solShort(raised, target)}/{solShort(target, target)} SOL
          </span>
        </div>
      )}
    </article>
  );
});

/* ── Lane ─────────────────────────────────────────────────────────────────── */

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * One column. Moves are animated in place with FLIP (rows glide to their new slot) and new
 * rows fade in; both skip under reduced motion and while the lane is hidden (mobile tabs).
 * Positions are compared in screen space after accounting for scrolling since the last
 * commit, so the browser's scroll anchoring (which keeps a scrolled lane still when a row
 * lands above) never reads as movement.
 */
function useLaneMotion(listRef: RefObject<HTMLOListElement | null>, order: string) {
  const prev = useRef(new Map<string, number>());
  const seen = useRef<Set<string> | null>(null);
  const scrolled = useRef({ at: 0, last: 0 });

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const pos = () => el.scrollTop + window.scrollY;
    scrolled.current = { at: pos(), last: pos() };
    const on = () => (scrolled.current.last = pos());
    el.addEventListener("scroll", on, { passive: true });
    window.addEventListener("scroll", on, { passive: true });
    return () => {
      el.removeEventListener("scroll", on);
      window.removeEventListener("scroll", on);
    };
  }, [listRef]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const rows = [...el.querySelectorAll<HTMLElement>(":scope > li")];
    const keys = rows.map((r) => r.dataset.key!);
    const first = seen.current === null;
    const hidden = el.offsetParent === null;
    const animate = !first && !hidden && !reducedMotion();
    const scrolledBy = scrolled.current.last - scrolled.current.at;
    const next = new Map<string, number>();
    for (const [i, row] of rows.entries()) {
      const k = keys[i];
      const top = row.getBoundingClientRect().top;
      next.set(k, top);
      if (!animate) continue;
      const old = prev.current.get(k);
      if (!seen.current!.has(k)) {
        row.animate(
          [
            { opacity: 0, transform: "translateY(-6px)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: 320, easing: "cubic-bezier(.2,.8,.2,1)" },
        );
      } else if (old !== undefined) {
        const delta = old - scrolledBy - top;
        if (Math.abs(delta) > 1 && Math.abs(delta) < 1500) {
          row.animate([{ transform: `translateY(${delta}px)` }, { transform: "none" }], { duration: 300, easing: "cubic-bezier(.2,.8,.2,1)" });
        }
      }
    }
    prev.current = hidden ? new Map() : next;
    seen.current = new Set(keys);
    const p = el.scrollTop + window.scrollY;
    scrolled.current = { at: p, last: p };
  }, [listRef, order]);
}

interface LaneProps {
  lane: LaneId;
  rows: CoinSummary[];
  total: number;
  filter: LaneFilter;
  onFilter: (lane: LaneId, f: LaneFilter) => void;
  gradSort: GradSort;
  onGradSort: (v: GradSort) => void;
  active: boolean;
  solUsd: number;
  graduationSol: number;
  buyLabel: string;
  instant: boolean;
  busyMint: string | null;
  arrivals: Record<string, Arrival>;
  onBuy: (c: CoinSummary) => void;
  searching: boolean;
}

function Lane({ lane, rows, total, filter, onFilter, gradSort, onGradSort, active, solUsd, graduationSol, buyLabel, instant, busyMint, arrivals, onBuy, searching }: LaneProps) {
  const id = useId();
  const popId = `${id}-filters`;
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const n = activeCount(filter);
  useLaneMotion(listRef, rows.map((r) => r.mint).join(","));
  const close = useCallback(() => {
    setOpen(false);
    btnRef.current?.focus();
  }, []);
  const filtered = n > 0 || searching;

  return (
    <section className={cx(s.lane, active && s.laneOn)} aria-labelledby={`${id}-h`} data-lane={lane}>
      <header className={s.laneHead}>
        <div className={s.laneTitle}>
          <h2 id={`${id}-h`} className={s.laneH}>
            {LANE_NAME[lane]}
          </h2>
          <span className={cx("num", s.count)} aria-label={filtered ? `${rows.length} of ${total} coins` : `${total} coins`}>
            {filtered ? `${rows.length}/${total}` : total}
          </span>
          {lane === "graduated" && (
            <Segmented
              size="sm"
              label="Sort graduated coins"
              value={gradSort}
              onChange={onGradSort}
              items={[
                { value: "volume", label: "Volume" },
                { value: "recent", label: "Recent" },
              ]}
              className={s.sort}
            />
          )}
          <button
            ref={btnRef}
            type="button"
            className={cx(s.filterBtn, n > 0 && s.filterOn)}
            aria-expanded={open}
            aria-controls={popId}
            aria-label={n > 0 ? `Filter ${LANE_NAME[lane]}, ${n} active` : `Filter ${LANE_NAME[lane]}`}
            onClick={() => setOpen((o) => !o)}
          >
            <IconFilter width={16} height={16} />
            {n > 0 && <span className={cx("num", s.filterN)}>{n}</span>}
          </button>
        </div>
        <p className={s.laneHint}>{LANE_HINT[lane]}</p>
        {open && <FilterPanel id={popId} lane={lane} filter={filter} onChange={(f) => onFilter(lane, f)} onClose={close} />}
      </header>
      <ol ref={listRef} className={s.list} aria-label={`${LANE_NAME[lane]} coins`}>
        {rows.map((c) => (
          <li key={c.mint} data-key={c.mint}>
            <Row
              coin={c}
              lane={lane}
              solUsd={solUsd}
              graduationSol={graduationSol}
              buyLabel={buyLabel}
              instant={instant}
              busy={busyMint === c.mint}
              locked={busyMint !== null}
              arrival={arrivals[c.mint]}
              onBuy={onBuy}
            />
          </li>
        ))}
      </ol>
      {rows.length === 0 && (
        <div className={s.empty}>
          {filtered ? (
            <EmptyState title="Nothing matches">
              {total > 0 ? `${total} ${total === 1 ? "coin is" : "coins are"} hidden by your filters or search.` : "No coins here yet."}
            </EmptyState>
          ) : lane === "new" ? (
            <EmptyState title="No new launches yet">Launch one and it lands here first.</EmptyState>
          ) : lane === "final" ? (
            <EmptyState title="Nothing in the final stretch">Coins show up here once they are past half the curve.</EmptyState>
          ) : (
            <EmptyState title="No graduates yet">A coin graduates when its curve fills. Claims open after that.</EmptyState>
          )}
        </div>
      )}
    </section>
  );
}

/* ── Board ────────────────────────────────────────────────────────────────── */

const index = (list: CoinSummary[]) => Object.fromEntries(list.map((c) => [c.mint, c]));

export function LaunchesBoard({ curve, graduated, solUsd }: { curve: CoinSummary[]; graduated: CoinSummary[]; solUsd: number }) {
  const data = getFumpadData();
  const params = useProtocolParams();
  const graduationSol = params.graduationSol;
  const now = useNow();
  const toast = useToast();
  const { address, connected } = useViewer();
  const { buy, reset, lastError, status: txStatus, instant } = useFumpadTx();
  const { maxSol } = useInstantSettings();

  const [coins, setCoins] = useState<Record<string, CoinSummary>>(() => index([...curve, ...graduated]));
  const [arrivals, setArrivals] = useState<Record<string, Arrival>>({});
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<LaneId>("new");
  const [busyMint, setBusyMint] = useState<string | null>(null);
  const [filters, setFilters] = usePersisted<BoardFilters>("fumpad.launches.filters.v1", NO_FILTERS, cleanFilters);
  const [gradSort, setGradSort] = usePersisted<GradSort>("fumpad.launches.gradSort.v1", "volume", cleanSort);
  const [amount, setAmount] = usePersisted<number>("fumpad.quickbuy.sol.v1", DEFAULT_BUY, cleanAmount);
  const [amountRaw, setAmountRaw] = useState<string | null>(null);
  const amountShown = amountRaw ?? String(amount);
  const amountBad = amountRaw !== null && !(Number(amountRaw) > 0 && Number(amountRaw) <= 1000);
  const amountRef = useRef<HTMLInputElement>(null);

  // Snapshot refresh: launches and graduations arrive as feed events; a light poll is the floor.
  const req = useRef(0);
  const load = useCallback(() => {
    const id = ++req.current;
    Promise.all([data.listCoins({ sort: "new", status: "curve", limit: CURVE_LIMIT }), data.listCoins({ sort: "trending", status: "graduated", limit: GRAD_LIMIT })])
      .then(([c, g]) => {
        if (id === req.current) setCoins(index([...c, ...g]));
      })
      .catch(keepSnapshot);
  }, [data]);
  useRefresh(load, { onFeed: true, pollMs: 20_000, debounceMs: 1_500 });

  // Per-coin pushes apply in place. A coin whose curve crosses 50% or that graduates is
  // tagged for a few seconds in its new lane.
  const coinsRef = useRef(coins);
  useEffect(() => {
    coinsRef.current = coins;
  });
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const t = timers.current;
    return () => t.forEach(clearTimeout);
  }, []);
  useLiveMessages((m) => {
    if (m.type !== "coin") return;
    const c = m.coin;
    const before = coinsRef.current[c.mint];
    if (before) {
      const from = laneOf(before, graduationSol);
      const to = laneOf(c, graduationSol);
      if (from !== to && to !== "new") {
        setArrivals((a) => ({ ...a, [c.mint]: { kind: to === "graduated" ? "graduated" : "crossed", at: Date.now() } }));
        const t = setTimeout(() => {
          timers.current.delete(t);
          setArrivals((a) => {
            const rest = { ...a };
            delete rest[c.mint];
            return rest;
          });
        }, 4_000);
        timers.current.add(t);
      }
    }
    setCoins((cs) => ({ ...cs, [c.mint]: c }));
  });

  const q = query.trim().toLowerCase();
  const lanes = useMemo(() => {
    const by: Record<LaneId, CoinSummary[]> = { new: [], final: [], graduated: [] };
    for (const c of Object.values(coins)) by[laneOf(c, graduationSol)].push(c);
    const ctx = { solUsd, now, graduationSol, query: q };
    return Object.fromEntries(
      LANES.map((l) => {
        const sorted = sortLane(l, by[l], { gradSort, graduationSol });
        return [l, { total: sorted.length, rows: sorted.filter((c) => matches(c, filters[l], ctx)) }];
      }),
    ) as Record<LaneId, { total: number; rows: CoinSummary[] }>;
  }, [coins, graduationSol, solUsd, now, q, filters, gradSort]);

  const onFilter = useCallback((lane: LaneId, f: LaneFilter) => setFilters({ ...filters, [lane]: f }), [filters, setFilters]);

  /* Quick-buy: one preset, the trade panel's transaction flow, one signature at a time. */
  const busyRef = useRef<string | null>(null);
  const onBuy = useCallback(
    async (c: CoinSummary) => {
      if (busyRef.current) return;
      if (LIVE_API && !connected) {
        toast("Log in to quick-buy.");
        requestWalletConnect();
        return;
      }
      if (!(amount > 0)) {
        amountRef.current?.focus();
        return;
      }
      busyRef.current = c.mint;
      setBusyMint(c.mint);
      try {
        const quote = await data.quoteTrade({ mint: c.mint, side: "buy", amount, wallet: address });
        // M-9: the bound is this quote (fetched on click) minus the slippage, not a later re-quote.
        const res = await buy({ mint: c.mint, solIn: amount, minTokensOut: minOutFromQuote(quote.amountOut), expectedOut: quote.amountOut });
        if (res) toast(quote.partialFill ? `Bought the last ${f.tokens(quote.amountOut)} ${c.symbol}. That completed the curve.` : `Bought ${f.tokens(quote.amountOut)} ${c.symbol}.`);
        else toast(lastError() ?? "The buy didn't go through.");
      } catch {
        toast(`Couldn't price $${c.symbol} right now. Nothing was sent. Try again.`);
      } finally {
        busyRef.current = null;
        setBusyMint(null);
        reset();
      }
    },
    [connected, amount, data, address, buy, reset, lastError, toast],
  );

  const busyCoin = busyMint ? coins[busyMint] : undefined;
  const status = !busyCoin
    ? ""
    : txStatus === "signing"
      ? instant
        ? `Buying $${busyCoin.symbol}: signing with your Trading wallet…`
        : `Buying $${busyCoin.symbol}: approve it in your wallet.`
      : txStatus === "confirming"
        ? `Buying $${busyCoin.symbol}: confirming on Solana…`
        : `Buying $${busyCoin.symbol}: preparing the transaction…`;
  const buyLabel = f.fixed(amount, amount < 1 ? (amount < 0.01 ? 3 : 2) : 1).replace(/\.?0+$/, "") || "0";
  // Instant only within the per-trade limit; above it the buy asks on screen first.
  // The limit counts the fee and first-time account rent too (M-9, chain/limits.ts); the session cap can still ask.
  const instantBuy = instant && solLamports(amount) + FIRST_TIME_RENT <= solLamports(maxSol);

  return (
    <div className={cx("wrap", s.page)}>
      <div className={s.head}>
        <div className={s.intro}>
          <h1 className={s.h1}>Launches</h1>
          <p className={s.lede}>Every coin on FUMPAD, live. Coins move right as their curve fills, and every one keeps a reward pool for the people who sell too early.</p>
        </div>
        <div className={s.tools}>
          <label className={s.search}>
            <IconSearch width={16} height={16} />
            <span className="sr-only">Search launches by ticker or name</span>
            <input type="search" placeholder="Ticker or name" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" spellCheck={false} />
          </label>
          <label className={cx(s.quick, amountBad && s.quickBad)} title="Each row's ⚡ button buys this much.">
            <IconBolt width={14} height={14} />
            <span className={s.quickLabel}>Quick buy</span>
            <input
              ref={amountRef}
              className="num"
              inputMode="decimal"
              autoComplete="off"
              value={amountShown}
              aria-invalid={amountBad || undefined}
              aria-describedby={`quick-note`}
              onChange={(e) => {
                const raw = e.target.value.replace(/[^\d.]/g, "");
                setAmountRaw(raw);
                const v = Number(raw);
                if (v > 0 && v <= 1000) setAmount(v);
              }}
              onBlur={() => setAmountRaw(null)}
            />
            <span className={s.quickUnit}>SOL</span>
          </label>
        </div>
        {/* One line for the quick-buy: its progress while a buy runs, otherwise what ⚡ does. Fixed height, so nothing shifts. */}
        <p id="quick-note" className={cx(s.note, status && s.busyNote)} role="status" aria-live="polite">
          {status ||
            (amountBad
              ? "Enter an amount between 0 and 1,000 SOL."
              : LIVE_API && !connected
                ? "Log in to use ⚡. Your amount is saved in this browser."
                : !LIVE_API
                  ? "Demo: ⚡ buys are simulated."
                  : instantBuy
                    ? `Instant: ⚡ buys this amount from your Trading wallet with no popup. Above ${f.sol(maxSol)} SOL it asks first.`
                    : instant
                      ? `Above your instant limit of ${f.sol(maxSol)} SOL, so each ⚡ buy asks first.`
                      : "⚡ buys this amount with your wallet's approval. Saved in this browser.")}
        </p>
      </div>

      <Segmented
        block
        label="Board column"
        value={tab}
        onChange={setTab}
        className={s.tabs}
        items={LANES.map((l) => ({ value: l, label: LANE_NAME[l], count: lanes[l].rows.length }))}
      />

      <div className={s.ruler} aria-hidden="true">
        <span className={s.rNew}>
          <b>0%</b>
          <b>50%</b>
        </span>
        <span className={s.rFinal}>
          <b />
          <b>Graduation</b>
        </span>
        <span className={s.rGrad}>
          <b />
          <b>Meteora pool</b>
        </span>
      </div>

      <div className={s.board}>
        {LANES.map((l) => (
          <Lane
            key={l}
            lane={l}
            rows={lanes[l].rows}
            total={lanes[l].total}
            filter={filters[l]}
            onFilter={onFilter}
            gradSort={gradSort}
            onGradSort={setGradSort}
            active={tab === l}
            solUsd={solUsd}
            graduationSol={graduationSol}
            buyLabel={buyLabel}
            instant={instantBuy}
            busyMint={busyMint}
            arrivals={arrivals}
            onBuy={onBuy}
            searching={q.length > 0}
          />
        ))}
      </div>
    </div>
  );
}
