/**
 * Waiting-room maths and drawing helpers. Ported from the explainer engine
 * (marketing/animations/src/engine.js) so the page and the X videos draw the same charts.
 * Every price here is an EXAMPLE; nothing reads live data.
 */

export const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
export const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
/** Rounds a coordinate to 0.1 px so server and client render identical attributes. */
export const r1 = (v: number) => Math.round(v * 10) / 10;

function bezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1,
    bx = 3 * (x2 - x1) - cx,
    ax = 1 - cx - bx;
  const cy = 3 * y1,
    by = 3 * (y2 - y1) - cy,
    ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      if (Math.abs(e) < 1e-6) break;
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    return sy(t);
  };
}
/** Same curves as src/design/tokens.ts. */
export const ease = { out: bezier(0.2, 0.7, 0, 1), inOut: bezier(0.6, 0, 0.2, 1), stamp: bezier(0.3, 1.6, 0.5, 1) };

/** Progress of t through [a, b], clamped, optionally eased. */
export const prog = (t: number, a: number, b: number, e?: (x: number) => number) => {
  const v = clamp((t - a) / (b - a));
  return e ? e(v) : v;
};

/** Deterministic pseudo-noise in [-1, 1]. */
export function noise(x: number, seed = 1) {
  const s = Math.sin(x * 12.9898 + seed * 78.233) * 43758.5453;
  const a = s - Math.floor(s);
  const s2 = Math.sin(x * 4.1414 + seed * 17.17) * 24634.6345;
  const b = s2 - Math.floor(s2);
  return a + b - 1;
}
/** Smooth value noise. */
export function snoise(x: number, freq = 8, seed = 1) {
  const X = x * freq,
    i = Math.floor(X),
    f = X - i;
  const u = f * f * (3 - 2 * f);
  return lerp(noise(i, seed), noise(i + 1, seed), u);
}

/** Smoothstep interpolation of log values through [[x, m], …]. */
export const logPath =
  (keys: [number, number][]) =>
  (x: number): number => {
    if (x <= keys[0][0]) return keys[0][1];
    for (let i = 0; i < keys.length - 1; i++) {
      const [x0, m0] = keys[i],
        [x1, m1] = keys[i + 1];
      if (x <= x1) {
        const k = (x - x0) / (x1 - x0);
        const s = k * k * (3 - 2 * k);
        return Math.exp(lerp(Math.log(m0), Math.log(m1), s));
      }
    }
    return keys[keys.length - 1][1];
  };

/** Catmull-Rom through points, as cubic Béziers. */
export function smooth(pts: [number, number][]) {
  if (pts.length < 2) return "";
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i],
      p1 = pts[i],
      p2 = pts[i + 1],
      p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6,
      c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6,
      c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

/** Samples fn over [a, b] (n steps) into points. */
export function sample(fn: (x: number) => [number, number], a: number, b: number, n: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) pts.push(fn(lerp(a, b, i / n)));
  return pts;
}

/* ── Gauge (log 1×–30×, as in the app's Gauge) ─────────────────────────────── */

export const gaugePos = (m: number) => clamp(Math.log(Math.max(m, 1)) / Math.log(30));
export const gaugeValue = (pos: number) => Math.exp(clamp(pos) * Math.log(30));
export const GAUGE_TICKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30];
export const GAUGE_MAJOR = [1, 2, 5, 10, 20, 30];

/* ── Formatting ────────────────────────────────────────────────────────────── */

export const int = (n: number) => Math.round(n).toLocaleString("en-US");
export const fix = (n: number, d: number) => n.toFixed(d);
/** SOL price with enough decimals to show 2–3 significant digits (example prices are tiny). */
export function solPrice(p: number) {
  if (p >= 1) return p.toFixed(2);
  const lead = Math.max(0, -Math.floor(Math.log10(p)) - 1);
  return p.toFixed(Math.min(12, lead + 2));
}
export function solAmount(v: number) {
  return v >= 100 ? int(v) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
}

/* ── The hero's story (scene 1 of the explainer) ───────────────────────────── */

/** Price in multiples of the sell price, over x ∈ [0, 1]. The sell is at x = HERO_SELL. */
const heroBase = logPath([
  [0, 0.5],
  [0.08, 0.78],
  [0.17, 1.0],
  [0.26, 0.7],
  [0.4, 0.95],
  [0.5, 1.5],
  [0.6, 3.1],
  [0.69, 6.6],
  [0.77, 11.4],
  [0.85, 13.6],
  [0.92, 12.2],
  [1, 14.2],
]);
export const HERO_SELL = 0.17;
export function heroPrice(x: number) {
  const nearSell = Math.abs(x - HERO_SELL) < 0.02 ? Math.abs(x - HERO_SELL) / 0.02 : 1;
  const tail = x > 0.97 ? (1 - x) / 0.03 : 1;
  return heroBase(x) * Math.exp(0.045 * snoise(x, 26, 3) * nearSell * tail);
}
/** First x after the sell where the run reaches 10×. */
export const HERO_CROSS = (() => {
  for (let x = HERO_SELL; x <= 1; x += 0.0005) if (heroPrice(x) >= 10) return x;
  return 1;
})();
export const HERO_EXAMPLE = { symbol: "PIGN", tokens: 2_400_000, price: 0.0000008 } as const;

/* ── The draggable lab (an example coin over 48 hours) ─────────────────────── */

/** Launch price of the lab's example coin, in SOL (curve start = 30 SOL / 988.7M tokens). */
export const LAB_P0 = 0.0000000303;
const labBase = logPath([
  [0, 1],
  [0.05, 1.7],
  [0.1, 1.25],
  [0.17, 2.6],
  [0.24, 1.9],
  [0.32, 4.2],
  [0.38, 3.1],
  [0.46, 7.5],
  [0.52, 5.8],
  [0.58, 13],
  [0.64, 10.5],
  [0.72, 24],
  [0.78, 19],
  [0.86, 31],
  [0.92, 26],
  [1, 29],
]);
/** One few-minute spike at hour ~34, after graduation: it touches 10× for the mid-chart sells but can't hold a 30-minute median. */
export const LAB_SPIKE_X = 0.7;
const spike = (x: number) => 1 + 3.2 * Math.exp(-(((x - LAB_SPIKE_X) / 0.0009) ** 2));
export const labMultiple = (x: number) => labBase(x) * spike(x) * Math.exp(0.06 * snoise(x, 34, 7) + 0.025 * snoise(x, 120, 11));
export const labPrice = (x: number) => LAB_P0 * labMultiple(x);
/** Graduation (85 SOL raised) is ≈14.7× the curve's start price: the first time the lab coin gets there. */
export const LAB_GRAD_MULTIPLE = 14.7;
export const LAB_GRAD_X = (() => {
  for (let x = 0; x <= 1; x += 0.0002) if (labMultiple(x) >= LAB_GRAD_MULTIPLE) return x;
  return 1;
})();

/** 48 hours on the x axis, sampled every 15 s like the keeper; the claim median spans 30 minutes. */
export const LAB_HOURS = 48;
const PER_HOUR = 240;
const WIN = PER_HOUR / 2;
const N = LAB_HOURS * PER_HOUR;

let table: { price: Float64Array; median: Float64Array; suffixMax: Float64Array } | null = null;
/** Prices, the rolling 30-minute median (window ending at i) and the max from i on, built once. */
function labTable() {
  if (table) return table;
  const price = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) price[i] = labPrice(i / N);
  const median = new Float64Array(N + 1);
  const win: number[] = [];
  for (let i = 0; i <= N; i++) {
    // Sorted window, insert/remove by binary search: O(N · WIN) worst case, ~1 ms.
    const v = price[i];
    let lo = 0,
      hi = win.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (win[m] < v) lo = m + 1;
      else hi = m;
    }
    win.splice(lo, 0, v);
    if (i >= WIN) {
      const old = price[i - WIN];
      let a = 0,
        b = win.length;
      while (a < b) {
        const m = (a + b) >> 1;
        if (win[m] < old) a = m + 1;
        else b = m;
      }
      win.splice(a, 1);
    }
    median[i] = win.length >= WIN ? win[win.length >> 1] : 0;
  }
  const suffixMax = new Float64Array(N + 1);
  let mx = 0;
  for (let i = N; i >= 0; i--) suffixMax[i] = mx = Math.max(mx, price[i]);
  table = { price, median, suffixMax };
  return table;
}

/**
 * A sell at `x`: its price, the 10× target, the best multiple it saw afterwards, and the first
 * moment a 30-minute median entirely after the sell held 10× (null if it never did).
 */
export function labOutcome(x: number) {
  const t = labTable();
  const s = Math.round(clamp(x) * N);
  const sell = t.price[s];
  const target = sell * 10;
  let holdAt: number | null = null;
  // Claims open once the coin has graduated.
  for (let i = Math.max(s + WIN, Math.round(LAB_GRAD_X * N)); i <= N; i++) {
    if (t.median[i] >= target) {
      holdAt = i / N;
      break;
    }
  }
  return { sell, target, peakMultiple: t.suffixMax[s] / sell, holdAt };
}
