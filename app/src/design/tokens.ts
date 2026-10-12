/**
 * FUMPAD design tokens — the single source of truth.
 *
 * Everything visual derives from this file:
 *  - `tokensToCss()` renders it into CSS custom properties, inlined once in the root
 *    layout, so every CSS module reads `var(--…)` and theme switching costs no re-render.
 *  - Code that can't read CSS (the next/og share image, canvas, SVG export) imports the
 *    raw values from here.
 * CSS media queries can't read custom properties, so `breakpoint` values are repeated
 * literally in `@media` rules; search for the number when changing one.
 */

/* ── Colour ─────────────────────────────────────────────────────────────────── */

export type ColorToken =
  | "canvas"
  | "surface"
  | "sunken"
  | "ink"
  | "ink-2"
  | "ink-3"
  | "rule"
  | "rule-2"
  | "on-ink"
  | "flare"
  | "flare-soft"
  | "flare-text"
  | "on-flare"
  | "hatch"
  | "scrim"
  | "focus";

/** Light is the default theme. International Orange (`flare`) only ever means money. */
export const colorLight: Record<ColorToken, string> = {
  canvas: "#ECEDEF", // instrument grey: cool, so the orange reads hotter
  surface: "#FFFFFF", // paper: panels and cards
  sunken: "#F5F6F7", // inputs, tracks, inset areas
  ink: "#000000", // text, fills, the needle — pure black, never tinted
  "ink-2": "#44474E", // secondary text
  "ink-3": "#64676F", // graphite: tertiary text, losses, down moves (5.6:1 on paper)
  rule: "#D5D7DB", // hairlines
  "rule-2": "#B4B7BD", // stronger hairlines, control outlines
  "on-ink": "#FFFFFF",
  flare: "#FF4F00", // International Orange: 10× crossings, claims, payouts. Never decoration.
  "flare-soft": "#FFE3D6", // tinted rows that hold money ("you", claimable)
  "flare-text": "#B93A00", // flare at text size on light (5.6:1)
  "on-flare": "#000000",
  hatch: "rgba(0,0,0,.07)",
  scrim: "rgba(0,0,0,.55)",
  focus: "#000000", // keyboard focus ring: ink, not orange (orange is money only)
};

/** Dark is pure black, not a tinted near-black. */
export const colorDark: Record<ColorToken, string> = {
  canvas: "#000000",
  surface: "#0E0F11",
  sunken: "#16171A",
  ink: "#F2F2EF",
  "ink-2": "#B7B9BF",
  "ink-3": "#8F929A",
  rule: "#25272B",
  "rule-2": "#3B3E44",
  "on-ink": "#000000",
  flare: "#FF5A14",
  "flare-soft": "#2A1206",
  "flare-text": "#FF8248",
  "on-flare": "#000000",
  hatch: "rgba(255,255,255,.06)",
  scrim: "rgba(0,0,0,.7)",
  focus: "#F2F2EF",
};

/* ── Type ───────────────────────────────────────────────────────────────────── */

/** Font stacks. `--font-archivo` / `--font-martian` are set by next/font in the root layout. */
export const font = {
  sans: 'var(--font-archivo), "Helvetica Neue", Arial, sans-serif',
  num: "var(--font-martian), ui-monospace, Menlo, monospace",
} as const;

/** Archivo's width axis carries hierarchy; Martian Mono's width axis carries density. */
export const width = {
  display: 125, // wordmark, cinematic titles
  title: 118, // page and coin titles
  ticker: 108, // $TICKER
  body: 100,
  tile: 62, // coin tile monograms
  num: 85, // every number
  readout: 75, // giant multiples (11.4×)
  numTight: 80, // chart and gauge labels
} as const;

export const weight = {
  regular: 420,
  medium: 520,
  semibold: 620,
  bold: 700,
  heavy: 800,
  black: 900,
} as const;

/** Size / line-height pairs. Body is 15/22. */
export const typeScale = {
  "2xs": ["11px", "14px"],
  xs: ["12px", "16px"],
  sm: ["13px", "18px"],
  md: ["14px", "20px"],
  base: ["15px", "22px"],
  lg: ["18px", "24px"],
  xl: ["22px", "26px"],
  "2xl": ["30px", "32px"],
  "3xl": ["40px", "41px"],
  display: ["clamp(44px, 9vw, 92px)", "0.88"],
} as const;

export const tracking = {
  display: "-0.05em",
  title: "-0.035em",
  num: "-0.02em",
  readout: "-0.07em",
  tight: "-0.005em",
} as const;

/* ── Space, radius, layout ──────────────────────────────────────────────────── */

/** 4px base. Index = step name: --s-1 = 4px … --s-16 = 64px. */
export const space = {
  "0": "0px",
  "0-5": "2px",
  "1": "4px",
  "1-5": "6px",
  "2": "8px",
  "2-5": "10px",
  "3": "12px",
  "4": "16px",
  "5": "20px",
  "6": "24px",
  "7": "28px",
  "8": "32px",
  "10": "40px",
  "12": "48px",
  "14": "56px",
  "16": "64px",
} as const;

/** Three radii only. Hierarchy: 3 = tiles/tags, 6 = controls, 12 = panels. */
export const radius = {
  "1": "3px",
  "2": "6px",
  "3": "12px",
  pill: "999px",
} as const;

export const layout = {
  maxWidth: "1320px",
  gutter: "16px",
  gutterWide: "32px",
  header: "58px",
  tabbar: "60px",
} as const;

/** Mobile-first breakpoints (min-width). Repeated literally in @media rules. */
export const breakpoint = {
  sm: 600,
  md: 760,
  lg: 900,
  xl: 1000,
} as const;

/* ── Motion ─────────────────────────────────────────────────────────────────── */

export const duration = {
  instant: "80ms",
  fast: "120ms",
  base: "200ms",
  slow: "350ms",
  gauge: "1100ms", // needle travel
  curve: "1400ms", // bonding-curve fill
} as const;

export const easing = {
  /** Default: fast out, long settle. Instruments, panels, needles. */
  out: "cubic-bezier(.2,.7,0,1)",
  inOut: "cubic-bezier(.6,0,.2,1)",
  /** Overshoot. Reserved for the PAID stamp. */
  stamp: "cubic-bezier(.3,1.6,.5,1)",
} as const;

/* ── Elevation ──────────────────────────────────────────────────────────────── */

export const zIndex = {
  base: 0,
  raised: 10,
  sticky: 30,
  tabbar: 40,
  sheet: 90,
  moment: 100,
  toast: 120,
  tooltip: 130,
} as const;

/** Hairlines do the structural work; shadows are reserved for floating layers. */
export const shadow = {
  float: "0 1px 0 rgba(0,0,0,.04), 0 12px 32px -12px rgba(0,0,0,.28)",
  card: "0 1px 0 rgba(0,0,0,.04), 0 20px 50px -24px rgba(0,0,0,.4)",
} as const;

/* ── The 10× gauge ──────────────────────────────────────────────────────────── */

export const gauge = {
  min: 1,
  max: 30,
  trigger: 10,
  ticks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30],
  major: [1, 2, 5, 10, 20, 30],
} as const;

/* ── CSS rendering ──────────────────────────────────────────────────────────── */

function colorVars(c: Record<ColorToken, string>): string {
  return (Object.keys(c) as ColorToken[]).map((k) => `--${k}:${c[k]};`).join("");
}

/** Renders every token as CSS custom properties. Inlined once by the root layout. */
export function tokensToCss(): string {
  const base: string[] = [];
  base.push(`--f-sans:${font.sans};`, `--f-num:${font.num};`);
  for (const [k, v] of Object.entries(width)) base.push(`--wdth-${k}:${v};`);
  for (const [k, v] of Object.entries(weight)) base.push(`--w-${k}:${v};`);
  for (const [k, [fs, lh]] of Object.entries(typeScale)) base.push(`--fs-${k}:${fs};--lh-${k}:${lh};`);
  for (const [k, v] of Object.entries(tracking)) base.push(`--tr-${k}:${v};`);
  for (const [k, v] of Object.entries(space)) base.push(`--s-${k}:${v};`);
  for (const [k, v] of Object.entries(radius)) base.push(`--r-${k}:${v};`);
  for (const [k, v] of Object.entries(duration)) base.push(`--dur-${k}:${v};`);
  for (const [k, v] of Object.entries(easing)) base.push(`--ease-${k}:${v};`);
  for (const [k, v] of Object.entries(zIndex)) base.push(`--z-${k}:${v};`);
  for (const [k, v] of Object.entries(shadow)) base.push(`--shadow-${k}:${v};`);
  base.push(
    `--max-w:${layout.maxWidth};`,
    `--gut:${layout.gutter};`,
    `--header-h:${layout.header};`,
    `--tabbar-h:${layout.tabbar};`,
    `--g-z10:${Math.log(gauge.trigger) / Math.log(gauge.max)};`,
  );

  const light = colorVars(colorLight);
  const dark = colorVars(colorDark);
  return [
    `:root{${base.join("")}${light}color-scheme:light;}`,
    `@media (min-width:${breakpoint.md}px){:root{--gut:${layout.gutterWide};}}`,
    `@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${dark}color-scheme:dark;}}`,
    `:root[data-theme="dark"]{${dark}color-scheme:dark;}`,
    // Scoped themes, for rendering both side by side (the /design route).
    `.theme-light{${light}color-scheme:light;background:var(--canvas);color:var(--ink);}`,
    `.theme-dark{${dark}color-scheme:dark;background:var(--canvas);color:var(--ink);}`,
    `@media (prefers-reduced-motion:reduce){:root{--dur-gauge:1ms;--dur-curve:1ms;--dur-slow:1ms;--dur-base:1ms;--dur-fast:1ms;}}`,
  ].join("\n");
}
