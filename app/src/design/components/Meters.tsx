import type { CSSProperties } from "react";
import { cx } from "../cx";
import * as f from "../format";
import s from "./Meters.module.css";

/**
 * Bonding-curve progress toward graduation (Global.params: 85 SOL on mainnet, scaled down
 * on devnet). 17 cells (5 SOL each at 85); the orange post at the end is graduation, the
 * moment claims open.
 */
export function CurveMeter({ raised, target = 85, size = "md", className }: { raised: number; target?: number; size?: "sm" | "md"; className?: string }) {
  const pct = Math.min(100, (raised / target) * 100);
  const style = { "--pct": `${pct}%`, "--cells": 17 } as CSSProperties;
  const sol = (n: number) => (target < 10 ? f.fixed(n, n === 0 ? 0 : 2) : f.fixed(n, Number.isInteger(n) ? 0 : 1));
  return (
    <div
      className={cx(s.curve, s[size], className)}
      style={style}
      role="progressbar"
      aria-label="Bonding curve"
      aria-valuemin={0}
      aria-valuemax={target}
      aria-valuenow={Math.round(raised * 100) / 100}
      aria-valuetext={`${f.fixed(raised, 2)} of ${sol(target)} SOL, ${f.fixed(pct, 1)}%`}
    >
      <div className={s.cTrack} />
      <div className={s.cFill} />
      <div className={s.cEnd} aria-hidden="true" />
      {size === "md" && (
        <div aria-hidden="true">
          <span className={s.cLbl} style={{ left: 0 }}>
            0
          </span>
          <span className={s.cLbl} style={{ left: "50%", transform: "translateX(-50%)" }}>
            {sol(target / 2)}
          </span>
          <span className={s.cLbl} style={{ right: 0 }}>
            {sol(target)} SOL
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Reward pool versus what the queue needs. The hatched orange band is the next
 * claim's size relative to the pool cap (a claim may take at most 10% of the pool).
 */
export function PoolMeter({ pool, needed, symbol }: { pool: number; needed: number; symbol: string }) {
  const max = Math.max(pool, needed) || 1;
  const have = (pool / max) * 100;
  const short = needed > pool;
  return (
    <div
      className={s.pool}
      role="meter"
      aria-label={`${symbol} reward pool versus the largest queued claim's requirement`}
      aria-valuemin={0}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(pool)}
      aria-valuetext={short ? `Pool holds ${f.compact(pool)}; the largest queued claim needs a ${f.compact(needed)} pool.` : `Pool covers every queued claim.`}
    >
      <div className={s.pBar} />
      <div className={s.pHave} style={{ width: `${have}%` }} />
      {short && <div className={s.pGap} style={{ left: `${have}%`, right: 0 }} />}
      <div className={s.pMark} style={{ left: `${have}%` }} aria-hidden="true">
        <span style={have > 70 ? { transform: "translateX(-100%)" } : undefined}>pool {f.compact(pool)}</span>
      </div>
      {short && (
        <div className={s.pMark} style={{ left: "100%" }} aria-hidden="true">
          <span style={{ transform: "translateX(-100%)" }}>{f.compact(needed)} needed</span>
        </div>
      )}
    </div>
  );
}

/** Thin level bar (profile XP). */
export function LevelBar({ value, max, label }: { value: number; max: number; label: string }) {
  return (
    <div className={s.lvl} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <i style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
    </div>
  );
}
