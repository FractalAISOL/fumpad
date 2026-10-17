"use client";

import { type KeyboardEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../cx";
import * as f from "../format";
import s from "./CandleChart.module.css";

/** One OHLC candle (same shape as the data layer's `Candle`; `n: 0` = no trade, a flat filler). */
export interface ChartCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  n: number;
}

/** Narrowest slot per candle (px): the chart shows as many of the newest candles as fit at this width. */
const MIN_SLOT = 5;
/** A short history (a fresh coin) is drawn at most this wide per candle, left-aligned, growing to the right. */
const MIN_SLOTS = 30;

/**
 * Candlestick price chart (terminal style; the interval buttons live with the caller). Log price axis, so "10× your
 * sell" is always the same visual distance above the ring, as on the gauge. Up candles are solid ink, down candles
 * hollow graphite (shape and tone, never colour), a bucket without a trade is a short flat tick at the previous close.
 * The latest close carries a price tag in the right gutter. Marks as before: ring = your sell, dashed orange = 10× of
 * it, orange line = the candle that crossed it, grey squares = other people's fumbles.
 */
export function CandleChart({
  candles,
  intervalMs,
  intervalLabel,
  sell,
  trigger,
  others = [],
  symbol,
  height = 300,
  live = false,
}: {
  /** Oldest first, one per bucket (empty buckets filled flat). */
  candles: ChartCandle[];
  intervalMs: number;
  /** Spoken, e.g. "1-minute candles". */
  intervalLabel: string;
  sell?: { t: number; p: number };
  trigger?: number;
  others?: { t: number; p: number }[];
  symbol: string;
  height?: number;
  /** The latest candle is still forming (it moves with every pushed trade). */
  live?: boolean;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  const [cursor, setCursor] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = height;
  const geo = useMemo(() => {
    if (!candles.length) return null;
    const pad = { t: 22, r: 62, b: 26, l: 8 };
    const plotW = w - pad.l - pad.r;
    const fit = Math.max(12, Math.floor(plotW / MIN_SLOT));
    const shown = candles.slice(-fit);
    const slot = plotW / Math.max(shown.length, Math.min(fit, MIN_SLOTS));
    const t0 = shown[0].t;
    const t1 = shown[shown.length - 1].t + intervalMs;
    const ps: number[] = [];
    for (const c of shown) ps.push(c.h, c.l);
    if (sell && sell.t >= t0 && sell.t < t1) ps.push(sell.p);
    if (trigger) ps.push(trigger);
    const pos = ps.filter((p) => p > 0);
    let lo = Math.log(Math.min(...pos));
    let hi = Math.log(Math.max(...pos));
    const span = Math.max(hi - lo, 0.05);
    lo -= span * 0.08;
    hi += span * 0.12;
    const XT = (t: number) => pad.l + ((t - t0) / intervalMs) * slot;
    const XC = (i: number) => pad.l + (i + 0.5) * slot;
    const Y = (p: number) => pad.t + (1 - (Math.log(p) - lo) / (hi - lo)) * (H - pad.t - pad.b);
    const grid = [0.2, 0.45, 0.7, 0.95].map((k) => {
      const lp = hi - (hi - lo) * k;
      return { y: Y(Math.exp(lp)), p: Math.exp(lp) };
    });
    // time labels on candle boundaries, spread over the drawn candles
    const n = shown.length;
    const ticks = (n < 4 ? [0] : [Math.round(n * 0.1), Math.round(n * 0.5), Math.round(n * 0.9) - 1]).map((i) => ({ x: XC(i), t: shown[i].t }));
    let cross: number | null = null;
    if (trigger && sell) {
      const i = shown.findIndex((c) => c.t + intervalMs > sell.t && c.h >= trigger);
      if (i >= 0) cross = i;
    }
    const body = Math.max(1, Math.min(slot * 0.7, 18));
    return { pad, shown, slot, body, t0, t1, XT, XC, Y, grid, ticks, cross };
  }, [candles, intervalMs, sell, trigger, w, H]);

  if (!geo) return <div className={s.wrap} style={{ height: H }} ref={wrap} />;
  const { pad, shown, XT, XC, Y } = geo;
  const last = shown[shown.length - 1];
  const hitNow = trigger ? last.c >= trigger : false;
  const sellVisible = sell && sell.t >= geo.t0 && sell.t < geo.t1;
  const spanMs = geo.t1 - geo.t0;
  const tickFmt = (t: number) => (spanMs <= 20 * 3_600_000 ? f.clock(t).slice(0, 5) : f.dateTime(t));
  const plotR = w - pad.r;

  const move = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - r.left - pad.l) / geo.slot);
    setCursor(i >= 0 && i < shown.length ? i : null);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowLeft") setCursor((c) => Math.max(0, (c ?? shown.length - 1) - step));
    else if (e.key === "ArrowRight") setCursor((c) => Math.min(shown.length - 1, (c ?? shown.length - 1) + step));
    else if (e.key === "Home") setCursor(0);
    else if (e.key === "End") setCursor(shown.length - 1);
    else if (e.key === "Escape") setCursor(null);
    else return;
    e.preventDefault();
  };

  const cc = cursor !== null ? shown[cursor] : null;
  const summary = `${symbol} price, ${intervalLabel}, ${shown.length} candles: from ${f.priceText(shown[0].o)} to ${f.priceText(last.c)} SOL.${sellVisible ? ` You sold at ${f.priceText(sell!.p)}.` : ""}${trigger ? ` 10× of your sell is ${f.priceText(trigger)}.` : ""} Use arrow keys to read candles.`;
  const tagY = Math.min(H - pad.b - 9, Math.max(pad.t - 2, Y(last.c)));

  return (
    <div
      ref={wrap}
      className={s.wrap}
      style={{ height: H }}
      tabIndex={0}
      role="img"
      aria-label={summary}
      onPointerMove={move}
      onPointerLeave={() => setCursor(null)}
      onKeyDown={key}
      onBlur={() => setCursor(null)}
    >
      <svg width={w} height={H} className={s.svg} aria-hidden="true">
        {geo.grid.map((g) => (
          <g key={g.y}>
            <line x1={0} x2={plotR} y1={g.y} y2={g.y} className={s.grid} />
            <SvgPrice x={w - 6} y={g.y + 3.5} p={g.p} className={s.axis} />
          </g>
        ))}
        <line x1={plotR} x2={plotR} y1={pad.t - 10} y2={H - pad.b} className={s.grid} />
        {geo.ticks.map((t) => (
          <text key={t.t} x={t.x} y={H - 8} className={s.axis} textAnchor="middle">
            {tickFmt(t.t)}
          </text>
        ))}

        {trigger && (
          <>
            <rect x={0} y={pad.t} width={plotR} height={Math.max(0, Y(trigger) - pad.t)} className={s.zone} />
            <line x1={0} x2={plotR} y1={Y(trigger)} y2={Y(trigger)} className={s.ten} />
          </>
        )}

        {cc && <rect x={pad.l + cursor! * geo.slot} y={pad.t - 6} width={geo.slot} height={H - pad.b - pad.t + 6} className={s.xband} />}

        {shown.map((c, i) => {
          const x = XC(i);
          if (c.n === 0) {
            const hw = Math.max(1, geo.body / 2);
            return <line key={c.t} x1={x - hw} x2={x + hw} y1={Y(c.c)} y2={Y(c.c)} className={s.flat} />;
          }
          const up = c.c >= c.o;
          const yTop = Y(Math.max(c.o, c.c));
          const yBot = Y(Math.min(c.o, c.c));
          const bh = Math.max(1, yBot - yTop);
          const forming = live && i === shown.length - 1;
          return (
            <g key={c.t} className={cx(up ? s.up : s.down, forming && s.forming)}>
              <line x1={x} x2={x} y1={Y(c.h)} y2={Y(c.l)} className={s.wick} />
              <rect x={x - geo.body / 2} y={bh === 1 ? yTop - 0.5 : yTop} width={geo.body} height={bh} className={s.body} />
            </g>
          );
        })}

        {geo.cross !== null && <line x1={XC(geo.cross)} x2={XC(geo.cross)} y1={pad.t} y2={H - pad.b} className={s.crossLine} />}

        {others
          .filter((o) => o.t >= geo.t0 && o.t < geo.t1 && o.p > 0)
          .map((o) => (
            <rect key={o.t} x={XT(o.t) - 3} y={Y(o.p) - 3} width={6} height={6} className={s.other} />
          ))}

        {sellVisible && <circle cx={XT(sell!.t)} cy={Y(sell!.p)} r={6.5} className={s.ring} />}

        <line x1={pad.l} x2={plotR} y1={Y(last.c)} y2={Y(last.c)} className={cx(s.lastLine, hitNow && s.lastLineHit)} />
      </svg>

      <span className={cx(s.lastTag, hitNow && s.lastTagHit)} style={{ top: tagY - 9, right: 2 }}>
        <Sub p={last.c} />
      </span>
      {trigger && (
        <span className={cx(s.lbl, s.lblTen)} style={{ right: pad.r + 4, top: Math.max(2, Y(trigger) - 22) }}>
          10× your sell, <Sub p={trigger} />
        </span>
      )}
      {sellVisible && (
        <span className={cx(s.lbl, s.lblMe)} style={{ left: Math.min(plotR - 150, Math.max(4, XT(sell!.t) - 24)), top: Math.min(H - pad.b - 22, Y(sell!.p) + 12) }}>
          you sold, <Sub p={sell!.p} />
        </span>
      )}
      {cc && (
        <span className={s.tip} style={{ left: Math.max(84, Math.min(plotR - 84, XC(cursor!))) }}>
          {cc.n === 0 ? (
            <>
              <Sub p={cc.c} /> SOL, no trades
            </>
          ) : (
            <span className={s.ohlc}>
              <span>
                O <Sub p={cc.o} />
              </span>
              <span>
                H <Sub p={cc.h} />
              </span>
              <span>
                L <Sub p={cc.l} />
              </span>
              <span>
                C <Sub p={cc.c} />
              </span>
            </span>
          )}
          {sell && cc.n > 0 && <span className={s.tipT}>close {f.multiple(cc.c / sell.p)} your sell</span>}
          <span className={s.tipT}>{f.dateTime(cc.t)} UTC</span>
        </span>
      )}
    </div>
  );
}

function Sub({ p }: { p: number }) {
  const { lead, zeros, sig } = f.priceParts(p, 3);
  return (
    <span className="num">
      {lead}
      {zeros > 0 && (
        <>
          <sub>{zeros}</sub>
          {sig}
        </>
      )}
    </span>
  );
}

function SvgPrice({ x, y, p, className }: { x: number; y: number; p: number; className: string }) {
  const { lead, zeros, sig } = f.priceParts(p, 3);
  return (
    <text x={x} y={y} className={className} textAnchor="end">
      {lead}
      {zeros > 0 && (
        <>
          <tspan dy={2.5} fontSize="0.75em">
            {zeros}
          </tspan>
          <tspan dy={-2.5}>{sig}</tspan>
        </>
      )}
    </text>
  );
}
