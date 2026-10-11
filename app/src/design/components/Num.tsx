import type { ReactNode } from "react";
import { cx } from "../cx";
import * as f from "../format";
import s from "./Num.module.css";

/**
 * Number primitives. Every figure in the product goes through one of these so the
 * typeface, tabular figures, subscript zeros and screen-reader text stay consistent.
 */

type Size = "xs" | "sm" | "md" | "lg" | "xl" | "readout";
interface Common {
  size?: Size;
  className?: string;
}

function Wrap({ size, className, label, children, tone }: Common & { label?: string; children: ReactNode; tone?: "money" | "muted" }) {
  return (
    <span className={cx("num", s.num, size && s[size], tone && s[tone], className)}>
      {label ? (
        <>
          <span aria-hidden="true">{children}</span>
          <span className="sr-only">{label}</span>
        </>
      ) : (
        children
      )}
    </span>
  );
}

/** SOL-per-token price with DEX subscript zeros: 0.0₅1071. */
export function Price({ value, unit, ...c }: Common & { value: number; unit?: boolean }) {
  const { lead, zeros, sig } = f.priceParts(value);
  return (
    <Wrap {...c} label={`${f.priceSpoken(value)}${unit ? " SOL" : ""}`}>
      {lead}
      {zeros > 0 && (
        <>
          <sub>{zeros}</sub>
          {sig}
        </>
      )}
      {unit && <span className={s.unit}> SOL</span>}
    </Wrap>
  );
}

export function Sol({ value, unit = true, signed, ...c }: Common & { value: number; unit?: boolean; signed?: boolean; tone?: "money" | "muted" }) {
  const sign = signed && value > 0 ? "+" : value < 0 ? "−" : "";
  return (
    <Wrap {...c}>
      {sign}
      {f.sol(Math.abs(value))}
      {unit && <span className={s.unit}> SOL</span>}
    </Wrap>
  );
}

export function Usd({ value, ...c }: Common & { value: number; tone?: "money" | "muted" }) {
  return <Wrap {...c}>{f.usd(value)}</Wrap>;
}

export function Tokens({
  value,
  symbol,
  compact,
  signed,
  ...c
}: Common & { value: number; symbol?: string; compact?: boolean; signed?: boolean; tone?: "money" | "muted" }) {
  const v = compact ? f.compact(value) : f.tokens(value);
  return (
    <Wrap {...c}>
      {signed && value > 0 ? "+" : ""}
      {v}
      {symbol && <span className={s.unit}> {symbol}</span>}
    </Wrap>
  );
}

/** Multiple of the sell price. Orange once it's at or past the 10× trigger. */
export function Multiple({ x, ...c }: Common & { x: number }) {
  const hit = x >= 10;
  return (
    <Wrap {...c} tone={hit ? "money" : undefined} className={cx(s.multiple, c.className)}>
      {f.multiple(x)}
    </Wrap>
  );
}

/**
 * Price direction without red/green. Up: ▲, ink, medium weight. Down: ▼, graphite.
 * The glyph and sign carry the meaning; tone is reinforcement. Orange is never used.
 */
export function Change({ pct, ...c }: Common & { pct: number }) {
  const dir = pct > 0.05 ? "up" : pct < -0.05 ? "down" : "flat";
  const glyph = dir === "up" ? "▲" : dir === "down" ? "▼" : "–";
  const spoken = dir === "flat" ? "unchanged" : `${dir} ${f.fixed(Math.abs(pct), 1)} percent`;
  return (
    <span className={cx("num", s.num, s.change, s[dir], c.size && s[c.size], c.className)}>
      <span aria-hidden="true" className={s.glyph}>
        {glyph}
      </span>
      <span aria-hidden="true">{f.pct(Math.abs(pct), 1, false)}</span>
      <span className="sr-only">{spoken}</span>
    </span>
  );
}

export function Pct({ value, digits = 1, ...c }: Common & { value: number; digits?: number }) {
  return <Wrap {...c}>{f.pct(value, digits, false)}</Wrap>;
}

export function Int({ value, ...c }: Common & { value: number; tone?: "money" | "muted" }) {
  return <Wrap {...c}>{f.int(value)}</Wrap>;
}
