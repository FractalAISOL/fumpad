"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { r1, LAB_SPIKE_X, LAB_GRAD_X, LAB_HOURS, LAB_P0, clamp, int, labMultiple, labOutcome, lerp, smooth, solAmount, solPrice } from "./math";
import s from "./SellLab.module.css";

/**
 * "Pick your worst sell": drag the ring along an example coin's 48 hours. The 10× line
 * follows your price; the result applies the real rule (claim 10% of the tokens sold once a
 * 30-minute median after graduation holds 10× the ticket price). Example data only.
 */

const AMOUNTS = [20_000_000, 40_000_000, 80_000_000];
const SYMBOL = "PIGN";
const LO = Math.log(0.75);
const HI = Math.log(130);
const START = 0.04;

export function SellLab() {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 900, h: 420 });
  const [x, setX] = useState(START);
  const [amount, setAmount] = useState(AMOUNTS[1]);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      if (width > 0) setSize((o) => (Math.abs(o.w - width) < 1 && Math.abs(o.h - height) < 1 ? o : { w: width, h: height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const compact = size.w < 600;
  const pad = { l: 0, r: compact ? 52 : 92, t: 18, b: compact ? 28 : 34 };
  const X = useCallback((v: number) => r1(lerp(pad.l, size.w - pad.r, v)), [pad.l, pad.r, size.w]);
  const Y = useCallback((m: number) => r1(pad.t + (1 - (clamp(Math.log(m), LO, HI) - LO) / (HI - LO)) * (size.h - pad.t - pad.b)), [pad.t, pad.b, size.h]);
  const path = useMemo(() => {
    // Uniform samples plus a dense run through the few-minute spike, so it isn't sampled away.
    const n = Math.round(clamp(size.w / 2.2, 160, 600));
    const xs = [...Array.from({ length: n + 1 }, (_, i) => i / n), ...Array.from({ length: 41 }, (_, i) => LAB_SPIKE_X - 0.004 + (i / 40) * 0.008)].sort((a, b) => a - b);
    return smooth(xs.map((v) => [X(v), Y(labMultiple(v))]));
  }, [X, Y, size.w]);

  const o = useMemo(() => labOutcome(x), [x]);
  const sellM = o.sell / LAB_P0;
  const targetM = sellM * 10;
  const offChart = Math.log(targetM) > HI;
  const sx = X(x);
  const sy = Y(sellM);
  const ty = Y(targetM);
  const hours = x * LAB_HOURS;
  const tokens = amount;
  const claim = tokens / 10;
  const got = tokens * o.sell;
  const touched = !o.holdAt && o.peakMultiple >= 10;
  const status = o.holdAt ? "claim" : touched ? "touched" : "none";

  const fromPointer = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    setX(clamp((clientX - r.left - pad.l) / (r.width - pad.l - pad.r), 0, 0.985));
  };
  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 2 / LAB_HOURS : 0.25 / LAB_HOURS;
    const map: Record<string, number> = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step, PageUp: 6 / LAB_HOURS, PageDown: -6 / LAB_HOURS };
    if (e.key in map) setX((v) => clamp(v + map[e.key], 0, 0.985));
    else if (e.key === "Home") setX(0);
    else if (e.key === "End") setX(0.985);
    else return;
    e.preventDefault();
  };

  const hh = (h: number) => `${Math.floor(h)}h ${String(Math.round((h % 1) * 60)).padStart(2, "0")}m`;
  const valueText = `Sell at hour ${hh(hours)}, ${solPrice(o.sell)} SOL. ${status === "claim" ? `It held 10×: claim ${int(claim)} ${SYMBOL}.` : touched ? "It touched 10× but didn't hold it." : "It never reached 10× after this sell."}`;
  const fontAxis = compact ? 10.5 : 12.5 * clamp(size.w / 900, 1, 1.6);

  return (
    <div className={s.lab} data-status={status}>
      <div
        ref={box}
        className={s.chart}
        data-dragging={dragging ? "1" : undefined}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          setDragging(true);
          fromPointer(e.clientX);
        }}
        onPointerMove={(e) => dragging && fromPointer(e.clientX)}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
      >
        <svg width={size.w} height={size.h} viewBox={`0 0 ${size.w} ${size.h}`} className={s.svg} aria-hidden="true">
          <defs>
            <pattern id="lab-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="2" height="7" className={s.hatchMark} />
            </pattern>
            <clipPath id="lab-before">
              <rect x={-4} y={0} width={Math.max(0, sx + 4)} height={size.h} />
            </clipPath>
            <clipPath id="lab-after">
              <rect x={sx} y={0} width={Math.max(0, size.w - sx)} height={size.h} />
            </clipPath>
          </defs>
          {/* Grid: launch price multiples, and time. */}
          {[1, 10, 100].map((m) => (
            <g key={m}>
              <line x1={0} x2={size.w - pad.r} y1={Y(m)} y2={Y(m)} className={s.grid} />
              <text x={size.w} y={Y(m) + 4} textAnchor="end" className={s.axis} fontSize={fontAxis}>
                {solPrice(LAB_P0 * m)}
              </text>
            </g>
          ))}
          {[0, 12, 24, 36, 48].map((h) => (
            <text key={h} x={X(h / LAB_HOURS)} y={size.h - 8} textAnchor={h === 0 ? "start" : h === 48 ? "end" : "middle"} className={s.axis} fontSize={fontAxis}>
              {h}h
            </text>
          ))}
          {/* Graduation. */}
          <line x1={X(LAB_GRAD_X)} x2={X(LAB_GRAD_X)} y1={pad.t} y2={size.h - pad.b} className={s.grad} />
          <text x={X(LAB_GRAD_X) + 6} y={pad.t + 12} className={s.gradText} fontSize={fontAxis}>
            graduates
          </text>
          {/* The 10× zone and line from your sell on. */}
          {!offChart && <rect x={sx} y={pad.t} width={Math.max(0, size.w - pad.r - sx)} height={Math.max(0, ty - pad.t)} className={s.zone} fill="url(#lab-hatch)" />}
          <line x1={sx} x2={size.w - pad.r} y1={offChart ? pad.t : ty} y2={offChart ? pad.t : ty} className={s.ten} />
          <text x={size.w - pad.r - 4} y={(offChart ? pad.t : ty) - 7} textAnchor="end" className={s.tenText} fontSize={fontAxis + 0.5}>
            {offChart ? "10× is above this chart" : `10× = ${solPrice(o.target)}`}
          </text>
          {/* Price: solid up to your sell, dotted after (the run you'd miss). */}
          <path d={path} className={s.line} clipPath="url(#lab-before)" />
          <path d={path} className={s.run} clipPath="url(#lab-after)" />
          {o.holdAt !== null && <circle cx={X(o.holdAt)} cy={ty} r={compact ? 6 : 8} className={s.dot} />}
        </svg>
        <div
          className={s.handle}
          style={{ transform: `translate3d(${sx}px, ${sy}px, 0)` }}
          role="slider"
          tabIndex={0}
          aria-label="Your sell: move it along the chart"
          aria-valuemin={0}
          aria-valuemax={LAB_HOURS}
          aria-valuenow={Math.round(hours * 10) / 10}
          aria-valuetext={valueText}
          onKeyDown={onKey}
        >
          <span className={s.ring} />
          <span className={s.handleLbl}>your sell</span>
        </div>
        {x === START && !dragging && (
          <span className={s.hint} aria-hidden="true">
            Drag the ring
          </span>
        )}
      </div>

      <div className={s.controls}>
        <fieldset className={s.amounts}>
          <legend>You sell</legend>
          {AMOUNTS.map((a) => (
            <label key={a} className={s.amount}>
              <input type="radio" name="lab-amount" value={a} checked={amount === a} onChange={() => setAmount(a)} />
              <span>
                {int(a / 1e6)}M {SYMBOL}
              </span>
            </label>
          ))}
        </fieldset>
      </div>

      <dl className={s.readouts}>
        <div>
          <dt>Your sell</dt>
          <dd className={s.num}>
            {int(tokens)} {SYMBOL}
          </dd>
          <dd className={s.small}>
            at {solPrice(o.sell)} SOL, hour {hh(hours)}. You get {solAmount(got)} SOL.
          </dd>
        </div>
        <div>
          <dt>Pays at</dt>
          <dd className={s.num}>{solPrice(o.target)} SOL</dd>
          <dd className={s.small}>10× your price, held on a 30-minute median.</dd>
        </div>
        <div className={s.result} aria-live="polite">
          <dt>Result</dt>
          {status === "claim" ? (
            <>
              <dd className={`${s.num} ${s.money}`}>
                Claim {int(claim)} {SYMBOL}
              </dd>
              <dd className={s.small}>
                10% of what you sold. It held 10× from hour {hh((o.holdAt ?? 0) * LAB_HOURS)}. At exactly 10× that&rsquo;s {solAmount(claim * o.target)} SOL, the same SOL your sell brought in.
              </dd>
            </>
          ) : (
            <>
              <dd className={s.num}>No claim</dd>
              <dd className={s.small}>
                {touched
                  ? `It spiked to ${o.peakMultiple.toFixed(1)}× your price but never held 10× for 30 minutes.`
                  : `The best it did after this sell was ${o.peakMultiple.toFixed(1)}× your price.`}{" "}
                The ticket expires after 90 days.
              </dd>
            </>
          )}
        </div>
      </dl>
      <p className={s.note}>
        Example coin and prices, not live data. The ticket price here is your fill; the real one is your fill or the 10-minute average, whichever is higher. Claims open
        after the coin graduates, and sells under $50 don&rsquo;t file a ticket.
      </p>
    </div>
  );
}
