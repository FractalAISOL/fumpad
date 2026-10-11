"use client";

import { type KeyboardEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../cx";
import * as f from "../format";
import s from "./PriceChart.module.css";

export interface ChartPoint {
  t: number;
  p: number;
}

/**
 * Hand-rolled SVG price chart. Log price axis, so "10× your sell" is always the same
 * visual distance above the ring — the chart and the gauge tell the same story.
 * Marks: ring = your sell, dashed orange = 10× of it, orange tick = where it crossed,
 * grey squares = other people's fumbles.
 */
export function PriceChart({
  points,
  sell,
  trigger,
  others = [],
  rangeLabel,
  symbol,
  height = 300,
}: {
  points: ChartPoint[];
  sell?: ChartPoint;
  trigger?: number;
  others?: ChartPoint[];
  rangeLabel: string;
  symbol: string;
  height?: number;
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

  const pad = { t: 22, r: 12, b: 26, l: 12 };
  const H = height;
  const geo = useMemo(() => {
    if (points.length < 2) return null;
    const t0 = points[0].t;
    const t1 = points[points.length - 1].t;
    const ps = points.map((p) => p.p);
    if (sell && sell.t >= t0) ps.push(sell.p);
    if (trigger) ps.push(trigger);
    let lo = Math.log(Math.min(...ps));
    let hi = Math.log(Math.max(...ps));
    const span = Math.max(hi - lo, 0.05);
    lo -= span * 0.08;
    hi += span * 0.12;
    const X = (t: number) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (w - pad.l - pad.r);
    const Y = (p: number) => pad.t + (1 - (Math.log(p) - lo) / (hi - lo)) * (H - pad.t - pad.b);
    const line = points.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.p).toFixed(1)}`).join("");
    const area = `${line}L${X(t1).toFixed(1)},${H - pad.b}L${X(t0).toFixed(1)},${H - pad.b}Z`;
    // gridlines at 4 evenly spaced log levels
    const grid = [0.2, 0.45, 0.7, 0.95].map((k) => {
      const lp = hi - (hi - lo) * k;
      return { y: Y(Math.exp(lp)), p: Math.exp(lp) };
    });
    const ticks = [0.08, 0.5, 0.92].map((k) => {
      const t = t0 + (t1 - t0) * k;
      return { x: X(t), t };
    });
    let cross: number | null = null;
    if (trigger && sell) {
      const i = points.findIndex((p) => p.t >= sell.t && p.p >= trigger);
      if (i > 0) cross = i;
    }
    return { X, Y, line, area, grid, ticks, t0, t1, cross };
  }, [points, sell, trigger, w, H, pad.l, pad.r, pad.t, pad.b]);

  if (!geo) return <div className={s.wrap} style={{ height: H }} ref={wrap} />;
  const { X, Y } = geo;
  const last = points[points.length - 1];
  const hitNow = trigger ? last.p >= trigger : false;
  const sellVisible = sell && sell.t >= geo.t0 && sell.t <= geo.t1;
  const spanMs = geo.t1 - geo.t0;
  const tickFmt = (t: number) => (spanMs <= 2 * 3_600_000 ? f.clock(t).slice(0, 5) : spanMs <= 2 * 86_400_000 ? f.dateTime(t).split(", ")[1] : f.date(t));

  const move = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - r.left - pad.l) / (r.width - pad.l - pad.r);
    setCursor(Math.max(0, Math.min(points.length - 1, Math.round(fx * (points.length - 1)))));
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowLeft") setCursor((c) => Math.max(0, (c ?? points.length - 1) - step));
    else if (e.key === "ArrowRight") setCursor((c) => Math.min(points.length - 1, (c ?? points.length - 1) + step));
    else if (e.key === "Home") setCursor(0);
    else if (e.key === "End") setCursor(points.length - 1);
    else if (e.key === "Escape") setCursor(null);
    else return;
    e.preventDefault();
  };

  const cp = cursor !== null ? points[cursor] : null;
  const summary = `${symbol} price, ${rangeLabel}: from ${f.priceText(points[0].p)} to ${f.priceText(last.p)} SOL.${sellVisible ? ` You sold at ${f.priceText(sell!.p)}.` : ""}${trigger ? ` 10× of your sell is ${f.priceText(trigger)}.` : ""} Use arrow keys to read values.`;

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
            <line x1={0} x2={w} y1={g.y} y2={g.y} className={s.grid} />
            <SvgPrice x={w - pad.r} y={g.y - 5} p={g.p} className={s.axis} anchor="end" />
          </g>
        ))}
        {geo.ticks.map((t) => (
          <text key={t.t} x={t.x} y={H - 8} className={s.axis} textAnchor="middle">
            {tickFmt(t.t)}
          </text>
        ))}

        {trigger && (
          <>
            <rect x={0} y={pad.t} width={w} height={Math.max(0, Y(trigger) - pad.t)} className={s.zone} />
            <line x1={0} x2={w} y1={Y(trigger)} y2={Y(trigger)} className={s.ten} />
          </>
        )}

        <path d={geo.area} className={s.area} />
        <path d={geo.line} className={s.line} />

        {geo.cross !== null && <line x1={X(points[geo.cross].t)} x2={X(points[geo.cross].t)} y1={pad.t} y2={H - pad.b} className={s.crossLine} />}

        {others.filter((o) => o.t >= geo.t0 && o.t <= geo.t1).map((o) => (
          <rect key={o.t} x={X(o.t) - 3} y={Y(o.p) - 3} width={6} height={6} className={s.other} />
        ))}

        {sellVisible && <circle cx={X(sell!.t)} cy={Y(sell!.p)} r={6.5} className={s.ring} />}
        <circle cx={X(last.t)} cy={Y(last.p)} r={4.5} className={hitNow ? s.nowHit : s.now} />

        {cp && (
          <g>
            <line x1={X(cp.t)} x2={X(cp.t)} y1={pad.t - 6} y2={H - pad.b} className={s.xhair} />
            <circle cx={X(cp.t)} cy={Y(cp.p)} r={3.5} className={s.xdot} />
          </g>
        )}
      </svg>

      {trigger && (
        <span className={cx(s.lbl, s.lblTen)} style={{ right: pad.r, top: Math.max(2, Y(trigger) - 22) }}>
          10× your sell, <Sub p={trigger} />
        </span>
      )}
      {sellVisible && (
        <span className={cx(s.lbl, s.lblMe)} style={{ left: Math.min(w - 150, Math.max(4, X(sell!.t) - 24)), top: Math.min(H - pad.b - 22, Y(sell!.p) + 12) }}>
          you sold, <Sub p={sell!.p} />
        </span>
      )}
      {cp && (
        <span className={s.tip} style={{ left: Math.max(70, Math.min(w - 70, X(cp.t))) }}>
          <Sub p={cp.p} /> SOL
          {sell && <>, {f.multiple(cp.p / sell.p)} your sell</>}
          <span className={s.tipT}>{f.dateTime(cp.t)} UTC</span>
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

function SvgPrice({ x, y, p, className, anchor }: { x: number; y: number; p: number; className: string; anchor: "end" | "start" }) {
  const { lead, zeros, sig } = f.priceParts(p, 3);
  return (
    <text x={x} y={y} className={className} textAnchor={anchor}>
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

/* ── Sparkline ────────────────────────────────────────────────────────────── */

/** 24-hour sparkline. Ink when up, graphite when down; never coloured. */
export function Sparkline({ values, width = 72, height = 22, className }: { values: number[]; width?: number; height?: number; className?: string }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * (width - 2) + 1).toFixed(1)},${(height - 2 - ((v - lo) / span) * (height - 4)).toFixed(1)}`).join(" ");
  const up = values[values.length - 1] >= values[0];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={cx(s.spark, !up && s.sparkDown, className)} aria-hidden="true">
      <polyline points={pts} />
    </svg>
  );
}
