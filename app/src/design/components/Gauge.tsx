import type { CSSProperties } from "react";
import { cx } from "../cx";
import { Z10, gaugePos, multiple } from "../format";
import { gauge as G } from "../tokens";
import s from "./Gauge.module.css";

/**
 * The 10× gauge — the instrument the whole brand is built around.
 * Log ruler from 1× to 30×; the zone past 10× is hatched; the fill is ink up to 10× and
 * turns orange past it. `dead` greys it out (expired, voided). Pure CSS: the needle
 * sweeps in on mount via keyframes and glides on updates via transitions, and both
 * collapse to instant under prefers-reduced-motion.
 */
export function Gauge({
  value,
  size = "md",
  dead,
  label,
  animate = true,
  className,
}: {
  /** Current multiple of the sell price (30-min median ÷ ticket price). */
  value: number;
  size?: "mini" | "md" | "lg";
  dead?: boolean;
  /** Accessible name. Defaults to "Progress to 10×". */
  label?: string;
  animate?: boolean;
  className?: string;
}) {
  const pos = gaugePos(value);
  const hit = value >= G.trigger && !dead;
  const style = { "--pos": pos, "--z10": Z10 } as CSSProperties;
  return (
    <div
      className={cx(s.gauge, s[size], hit && s.hit, dead && s.dead, animate && s.animate, className)}
      style={style}
      role="meter"
      aria-label={label ?? "Progress to 10×"}
      aria-valuemin={0}
      aria-valuemax={G.max}
      aria-valuenow={Math.round(value * 10) / 10}
      aria-valuetext={`${multiple(value)} of the sell price. ${hit ? "Past 10×, claim unlocked." : dead ? "Closed." : `${multiple(Math.max(0, G.trigger / Math.max(value, 0.01)))} more to unlock.`}`}
    >
      <div className={s.track}>
        <div className={s.zone} />
        <div className={s.fill} />
        <div className={s.fillX} />
      </div>
      {size !== "mini" && (
        <>
          <div className={s.ticks} aria-hidden="true">
            {G.ticks.map((t) => (
              <i key={t} className={cx(t === G.trigger ? s.ten : (G.major as readonly number[]).includes(t) && s.maj)} style={{ left: `${gaugePos(t) * 100}%` }} />
            ))}
          </div>
          <div aria-hidden="true">
            {G.major.map((t, i) => (
              <span
                key={t}
                className={cx(s.lbl, t === G.trigger && s.lblTen, t === 20 && s.l20, i === 0 && s.first, i === G.major.length - 1 && s.last)}
                style={{ left: `${gaugePos(t) * 100}%` }}
              >
                {t}×
              </span>
            ))}
          </div>
        </>
      )}
      <div className={s.needle} aria-hidden="true" />
    </div>
  );
}
