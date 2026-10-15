/**
 * Anime effect primitives (web): sparkles, "!!", "?", sweat drop, speed lines, pop-in. Anime kit —
 * LOCKED for phase-2 agents. Ink only (they flip with the theme); orange is money, never decoration.
 * Never place them over prices, charts, forms or buttons. All motion is CSS and collapses under
 * prefers-reduced-motion to the final, static frame.
 */
import type { CSSProperties, ReactNode } from "react";
import { cx } from "../cx";
import { FUMI_POSES, REF_HEAD, type FumiPose } from "./poses";
import s from "./Anime.module.css";

/** 4-point sparkle ✦ of radius 1. */
const SPARK = "M0,-1 C0.12,-0.12 0.12,-0.12 1,0 C0.12,0.12 0.12,0.12 0,1 C-0.12,0.12 -0.12,0.12 0,-1Z";
const SWEAT = "M0,-22 C7,-10 13,-2 13,7 A13,13 0 0 1 -13,7 C-13,-2 -7,-10 0,-22Z";

const Spark = ({ x, y, r, i }: { x: number; y: number; r: number; i: number }) => (
  <g transform={`translate(${x} ${y}) scale(${r})`}>
    <path className={s.spark} d={SPARK} style={{ animationDelay: `${(i * 0.37) % 1.4}s` }} />
  </g>
);

/** Effects for a pose, in the same 300×400 overlay box as the videos (head ≈ (165, 95)). */
export function FumiFxLayer({ pose, drawn }: { pose: FumiPose; drawn: FumiPose }) {
  const fx = FUMI_POSES[pose].fx;
  // Poses framed differently move the overlay with their head.
  const h = FUMI_POSES[drawn].head;
  const k = h ? h[2] / REF_HEAD[2] : 1;
  const tr = h ? `translate(${(300 * (h[0] - REF_HEAD[0] * k)).toFixed(1)} ${(400 * (h[1] - REF_HEAD[1] * k)).toFixed(1)}) scale(${k.toFixed(3)})` : undefined;
  return (
    <svg className={s.fx} viewBox="0 0 300 400" preserveAspectRatio="none" aria-hidden="true">
      <g transform={tr}>
        {fx.includes("sparkles") &&
          [
            [60, 22, 15],
            [262, 34, 11],
            [276, 120, 8],
            [34, 108, 9],
            [240, -8, 7],
          ].map(([x, y, r], i) => <Spark key={i} x={x} y={y} r={r} i={i} />)}
        {fx.includes("glow") &&
          [
            [0, -70, 12],
            [44, -30, 9],
            [-46, 6, 10],
            [30, 56, 8],
          ].map(([x, y, r], i) => <Spark key={i} x={76 + x} y={95 + y} r={r} i={i} />)}
        {fx.includes("bang") && (
          <g transform="translate(222 150) rotate(14)">
            <text className={cx(s.glyph, s.jiggle)} x="0" y="0">
              !!
            </text>
          </g>
        )}
        {fx.includes("think") && (
          <g transform="translate(236 40) rotate(10)">
            <text className={cx(s.glyph, s.jiggle)} x="0" y="0" style={{ fontSize: 56 }}>
              ?
            </text>
          </g>
        )}
        {fx.includes("shock") && (
          <g className={s.shock}>
            {[
              [-2.6, 24],
              [-2.25, 22],
              [-0.85, 22],
              [-0.5, 24],
            ].map(([a, l], i) => (
              <line key={i} x1={168 + Math.cos(a) * 92} y1={92 + Math.sin(a) * 92} x2={168 + Math.cos(a) * (92 + l)} y2={92 + Math.sin(a) * (92 + l)} />
            ))}
          </g>
        )}
        {fx.includes("sweat") && (
          <g transform="translate(236 70) rotate(18)">
            <path className={s.sweat} d={SWEAT} />
          </g>
        )}
        {fx.includes("dash") && (
          <g className={s.dash}>
            {[150, 200, 250, 300, 350].map((y, i) => (
              <line key={y} x1={60} y1={y} x2={60 - 28 - 16 * (i % 3)} y2={y} style={{ animationDelay: `${i * 0.11}s` }} />
            ))}
          </g>
        )}
      </g>
    </svg>
  );
}

interface FxProps {
  /** px, square. */
  size?: number;
  className?: string;
  style?: CSSProperties;
}

/** A cluster of twinkling sparkles. Celebrate next to a result, never on top of a number. */
export function Sparkles({ size = 64, className, style }: FxProps) {
  return (
    <svg className={cx(s.prim, className)} style={style} width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      {[
        [26, 30, 18],
        [72, 22, 11],
        [62, 66, 22],
        [20, 76, 9],
        [88, 58, 7],
      ].map(([x, y, r], i) => (
        <Spark key={i} x={x} y={y} r={r} i={i} />
      ))}
    </svg>
  );
}

/** Comic "!!" (or "?") with a canvas-coloured outline so it reads on her hair in both themes. */
export function Bang({ size = 48, glyph = "!!", className, style }: FxProps & { glyph?: "!!" | "?" }) {
  return (
    <svg className={cx(s.prim, className)} style={style} width={size} height={size} viewBox="0 0 60 60" aria-hidden="true">
      <g transform="translate(30 46) rotate(14)">
        <text className={cx(s.glyph, s.jiggle)} x="0" y="0" textAnchor="middle" style={{ fontSize: 48 }}>
          {glyph}
        </text>
      </g>
    </svg>
  );
}

/** Anime sweat drop (nervous, "oops"). Slides down once. */
export function SweatDrop({ size = 32, className, style }: FxProps) {
  return (
    <svg className={cx(s.prim, className)} style={style} width={size} height={size} viewBox="-20 -28 40 48" aria-hidden="true">
      <g transform="rotate(18)">
        <path className={s.sweat} d={SWEAT} />
      </g>
    </svg>
  );
}

/** Radial speed lines (a burst). Behind a pop-in, never behind text. */
export function SpeedLines({ size = 120, className, style }: FxProps) {
  const lines = Array.from({ length: 14 }, (_, i) => {
    const a = (i / 14) * Math.PI * 2;
    return [50 + Math.cos(a) * 34, 50 + Math.sin(a) * 34, 50 + Math.cos(a) * (46 - (i % 3) * 3), 50 + Math.sin(a) * (46 - (i % 3) * 3)];
  });
  return (
    <svg className={cx(s.prim, s.burst, className)} style={style} width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      {lines.map(([x1, y1, x2, y2], i) => (
        <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={i % 2 ? 1.6 : 2.6} />
      ))}
    </svg>
  );
}

/** Pops its child in once (stamp overshoot), e.g. a badge Fumi is reacting to. */
export function PopIn({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <span className={cx(s.popIn, className)} style={{ animationDelay: `${delay}ms` }}>
      {children}
    </span>
  );
}
