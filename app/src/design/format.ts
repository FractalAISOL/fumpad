/**
 * Number and time formatting. Pure functions, locale pinned to en-US so server and client
 * render identical strings (no hydration mismatch). Components in `components/Num.tsx`
 * wrap these with the right markup (subscript zeros, accessible labels).
 */

import { gauge } from "./tokens";

const nf = (min: number, max: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: min, maximumFractionDigits: max });
const cache = new Map<string, Intl.NumberFormat>();
function fmt(n: number, min: number, max = min): string {
  const k = `${min}:${max}`;
  let f = cache.get(k);
  if (!f) {
    f = nf(min, max);
    cache.set(k, f);
  }
  return f.format(n);
}

/** Thousands separators, fixed decimals. `int(4200000)` → "4,200,000". */
export function int(n: number): string {
  return fmt(Math.round(n), 0);
}
export function fixed(n: number, d: number): string {
  return fmt(n, d);
}

/** Compact: 1.63M, 412K, 9.62B. Below 10,000 prints in full. */
export function compact(n: number, digits = 2): string {
  const a = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (a >= 1e9) return sign + trimZeros((a / 1e9).toFixed(digits)) + "B";
  if (a >= 1e6) return sign + trimZeros((a / 1e6).toFixed(digits)) + "M";
  if (a >= 1e4) return sign + trimZeros((a / 1e3).toFixed(a >= 1e5 ? 0 : 1)) + "K";
  return sign + int(a);
}
function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** SOL amounts. ≥ 1,000 compact-ish; ≥ 1 two decimals; < 1 three; dust 4 significant. */
export function sol(n: number): string {
  const a = Math.abs(n);
  if (a >= 100_000) return compact(n);
  if (a >= 1) return fmt(n, 2);
  if (a >= 0.001 || a === 0) return fmt(n, 3);
  return n.toPrecision(2);
}

export function usd(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return "$" + compact(n, 2);
  if (a >= 1e4) return "$" + compact(n, 1);
  if (a >= 1) return "$" + fmt(n, 2);
  return "$" + fmt(n, 4);
}

/** A dollar threshold quoted in copy: "$50", "$5", "$2.50". */
export function usdRule(n: number): string {
  return Number.isInteger(n) ? "$" + int(n) : usd(n);
}

/** Token counts: full below 10M, compact above. */
export function tokens(n: number): string {
  return Math.abs(n) >= 1e7 ? compact(n, 2) : int(n);
}

/** Multiple of sell price: "11.4×"; "<0.1×" for a coin that went nowhere (never "0.0×"). */
export function multiple(x: number): string {
  if (x > 0 && x < 0.1) return "<0.1×";
  if (x >= 100) return int(x) + "×";
  return fmt(x, 1) + "×";
}

/** Percent change with a true minus sign. */
export function pct(n: number, digits = 1, signed = true): string {
  const s = fmt(Math.abs(n), digits) + "%";
  if (!signed) return s;
  return (n > 0 ? "+" : n < 0 ? "−" : "") + s;
}

/* ── Prices with subscript zeros (DEX convention) ─────────────────────────── */

export interface PriceParts {
  /** e.g. "0.0" */
  lead: string;
  /** Number of zeros collapsed into the subscript, or 0 when none. */
  zeros: number;
  /** Significant digits after the zeros, e.g. "94". */
  sig: string;
}

/**
 * Splits a small price into DEX-style parts: 0.00000094 → { lead: "0.0", zeros: 6, sig: "94" }
 * rendered as 0.0₆94. Prices ≥ 0.001 are printed plainly.
 */
export function priceParts(p: number, sigDigits = 4): PriceParts {
  if (!isFinite(p) || p <= 0) return { lead: "0", zeros: 0, sig: "" };
  if (p >= 1) return { lead: fmt(p, 2, 4), zeros: 0, sig: "" };
  if (p >= 0.001) return { lead: p.toFixed(5).replace(/0+$/, ""), zeros: 0, sig: "" };
  const s = p.toFixed(20).slice(2); // digits after "0."
  const z = s.match(/^0*/)![0].length;
  const sig = s.slice(z, z + sigDigits).replace(/0+$/, "") || "0";
  return { lead: "0.0", zeros: z, sig };
}

const SUB = "₀₁₂₃₄₅₆₇₈₉";
/** Plain-text price with Unicode subscript digits, for copy text and images. */
export function priceText(p: number, sigDigits = 4): string {
  const { lead, zeros, sig } = priceParts(p, sigDigits);
  if (!zeros) return lead;
  return (
    lead +
    String(zeros)
      .split("")
      .map((d) => SUB[+d])
      .join("") +
    sig
  );
}
/** Long-form price for screen readers: "0.00000094". */
export function priceSpoken(p: number): string {
  if (p >= 0.001) return priceText(p);
  const { zeros, sig } = priceParts(p, 4);
  return "0." + "0".repeat(zeros) + sig;
}

/* ── Gauge math ────────────────────────────────────────────────────────────── */

const LOG_MAX = Math.log(gauge.max);
/** Position 0..1 on the log ruler from 1× to 30×. Below 1× pins to 0. */
export function gaugePos(x: number): number {
  if (!(x > 1)) return 0;
  return Math.min(1, Math.log(x) / LOG_MAX);
}
export const Z10 = Math.log(gauge.trigger) / LOG_MAX;

/* ── Time ──────────────────────────────────────────────────────────────────── */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "now", "4m", "3h", "2d", then "Aug 19". */
export function ago(ts: number, now: number): string {
  const d = Math.max(0, now - ts);
  if (d < 45_000) return "now";
  if (d < HOUR) return Math.round(d / MIN) + "m";
  if (d < DAY) return Math.round(d / HOUR) + "h";
  if (d < 7 * DAY) return Math.round(d / DAY) + "d";
  return date(ts);
}

const dFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const dtFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});
const tFmt = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "UTC",
});
/** "Aug 19" (UTC). */
export function date(ts: number): string {
  return dFmt.format(ts);
}
/** "Aug 19, 22:51" (UTC). */
export function dateTime(ts: number): string {
  return dtFmt.format(ts).replace(" at ", ", ");
}
/** "14:02:11" (UTC). */
export function clock(ts: number): string {
  return tFmt.format(ts);
}
/** Whole days remaining until `until`, never negative. */
export function daysLeft(until: number, now: number): number {
  return Math.max(0, Math.ceil((until - now) / DAY));
}
/** "~6 days", "~10 hours", "~25 min". */
export function eta(ms: number): string {
  if (ms < HOUR) return `~${Math.max(1, Math.round(ms / MIN))} min`;
  if (ms < 2 * DAY) return `~${Math.round(ms / HOUR)} hours`;
  return `~${Math.round(ms / DAY)} days`;
}

/** A protocol window in its largest whole unit, e.g. seconds 30 → [30, "second"], 600 → [10, "minute"]. */
function durationParts(secs: number): [number, string] {
  const s = Math.max(0, Math.round(secs));
  if (s >= 86_400 && s % 86_400 === 0) return [s / 86_400, "day"];
  if (s >= 3_600 && s % 3_600 === 0) return [s / 3_600, "hour"];
  if (s >= 60 && s % 60 === 0) return [s / 60, "minute"];
  return [s, "second"];
}
/** "30 seconds", "1 minute", "10 minutes", "7 days" (protocol windows quoted in copy). */
export function duration(secs: number): string {
  const [n, unit] = durationParts(secs);
  return `${int(n)} ${unit}${n === 1 ? "" : "s"}`;
}
/** As an adjective: "30-second", "10-minute", "30-minute". */
export function durationAdj(secs: number): string {
  const [n, unit] = durationParts(secs);
  return `${int(n)}-${unit}`;
}
/** Short adjective for labels: "30-sec", "5-min", "30-min", "1-hour", "7-day". */
export function durationShort(secs: number): string {
  const [n, unit] = durationParts(secs);
  return `${int(n)}-${unit === "second" ? "sec" : unit === "minute" ? "min" : unit}`;
}

/* ── Addresses ─────────────────────────────────────────────────────────────── */

/** "7xKp…3fQe". */
export function shortAddr(a: string, head = 4, tail = 4): string {
  if (a.length <= head + tail + 1) return a;
  return `${a.slice(0, head)}…${a.slice(-tail)}`;
}

/* ── Apps and venues ───────────────────────────────────────────────────────── */

/**
 * Display names for the indexer's app labels (`@fumpad/meteora` `appLabel`). Labels are
 * best-effort and display only; anything not listed (direct swaps, bots, unlabelled programs)
 * shows as "elsewhere". Naming an app states where a trade came from; it isn't an endorsement.
 */
const APP_NAMES: Record<string, string> = {
  fumpad: "FUMPAD",
  axiom: "Axiom",
  jupiter: "Jupiter",
  okx: "OKX",
  dflow: "DFlow",
  padre: "Padre",
};
/** "Axiom", "FUMPAD"…, or undefined when the label is unknown or generic. */
export function appName(app: string | undefined): string | undefined {
  return app ? APP_NAMES[app] : undefined;
}
/** "sold on Axiom", "sold on FUMPAD", else "sold elsewhere". */
export function soldOn(t: { source?: "router" | "outside"; app?: string }): string {
  const name = t.source === "router" ? "FUMPAD" : appName(t.app);
  return name ? `sold on ${name}` : "sold elsewhere";
}
