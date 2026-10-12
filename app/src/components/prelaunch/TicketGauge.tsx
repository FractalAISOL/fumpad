"use client";

import { useRef, useState } from "react";
import { GAUGE_MAJOR, GAUGE_TICKS, HERO_EXAMPLE, clamp, fix, gaugePos, gaugeValue, int, solAmount } from "./math";
import s from "./Ticket.module.css";

/**
 * The brand gauge (log 1×–30×, hatched past 10×) as a scrubber: hover, drag or use the
 * arrow keys to try a price. Below 10× the ticket tracks; at 10× and up it shows the claim.
 */
export function TicketGauge() {
  const [v, setV] = useState(6.2);
  const track = useRef<HTMLDivElement>(null);
  const down = useRef(false);
  const at = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r) return;
    setV(gaugeValue((clientX - r.left) / r.width));
  };
  const hit = v >= 10;
  const pos = gaugePos(v);
  const claim = HERO_EXAMPLE.tokens / 10;
  const worth = claim * HERO_EXAMPLE.price * v;
  const onKey = (e: React.KeyboardEvent) => {
    const k = e.shiftKey ? 0.1 : 0.02;
    const d: Record<string, number> = { ArrowRight: k, ArrowUp: k, ArrowLeft: -k, ArrowDown: -k };
    if (e.key in d) setV((x) => gaugeValue(clamp(gaugePos(x) + d[e.key])));
    else if (e.key === "Home") setV(1);
    else if (e.key === "End") setV(30);
    else return;
    e.preventDefault();
  };
  return (
    <div className={s.gauge} data-hit={hit ? "1" : undefined}>
      <div className={s.gHead}>
        <span className={s.gLabel}>Ticket progress</span>
        <span className={s.gValue}>{fix(v, 1)}×</span>
      </div>
      <div
        ref={track}
        className={s.gTrackWrap}
        onPointerMove={(e) => (e.pointerType === "mouse" || down.current) && at(e.clientX)}
        onPointerDown={(e) => {
          down.current = true;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          at(e.clientX);
        }}
        onPointerUp={() => (down.current = false)}
        onPointerCancel={() => (down.current = false)}
        role="slider"
        tabIndex={0}
        aria-label="Try a price, as a multiple of the ticket price"
        aria-valuemin={1}
        aria-valuemax={30}
        aria-valuenow={Math.round(v * 10) / 10}
        aria-valuetext={`${fix(v, 1)} times the ticket price. ${hit ? `Past 10×: the claim is ${int(claim)} ${HERO_EXAMPLE.symbol}.` : "Still tracking."}`}
        onKeyDown={onKey}
      >
        <div className={s.gTrack}>
          <div className={s.gFill} style={{ width: `${(Math.min(pos, gaugePos(10)) * 100).toFixed(2)}%` }} />
          {hit && <div className={s.gFillX} style={{ left: `${(gaugePos(10) * 100).toFixed(2)}%`, width: `${((pos - gaugePos(10)) * 100).toFixed(2)}%` }} />}
          <div className={s.gNeedle} style={{ left: `${(pos * 100).toFixed(2)}%` }} />
        </div>
        <div className={s.gTicks} aria-hidden="true">
          {GAUGE_TICKS.map((t) => (
            <span key={t} className={s.gTick} data-major={GAUGE_MAJOR.includes(t) ? "1" : undefined} data-ten={t === 10 ? "1" : undefined} style={{ left: `${(gaugePos(t) * 100).toFixed(2)}%` }} />
          ))}
          {GAUGE_MAJOR.map((t) => (
            <span key={`l${t}`} className={s.gTickLbl} data-ten={t === 10 ? "1" : undefined} data-edge={t === 1 ? "start" : t === 30 ? "end" : undefined} style={{ left: `${(gaugePos(t) * 100).toFixed(2)}%` }}>
              {t}×
            </span>
          ))}
        </div>
      </div>
      <p className={s.gStatus} aria-live="polite">
        {hit ? (
          <>
            <strong>Past 10×.</strong> Held here on a 30-minute median, the claim unlocks: 10% of what you sold, {int(claim)} {HERO_EXAMPLE.symbol}, worth {solAmount(worth)} SOL at {fix(v, 1)}×.
          </>
        ) : (
          <>
            <strong>Tracking.</strong> It pays when the coin holds 10× your ticket price on a 30-minute median.
          </>
        )}
      </p>
    </div>
  );
}
