/**
 * Coin chart candles (trading-terminal style: 1m / 5m / 30m buttons set the candle size). Pure, tested by
 * `candles.test.ts`.
 *
 * The API (`GET /v1/coins/:mint/candles`, services/api `Repo.getCandles`) aggregates the coin's price points (every
 * trade's post-trade price on its DBC / DAMM v2 pool, plus the pool's oracle samples, the same points as the old line
 * chart) into OHLC buckets aligned to UTC interval boundaries, and returns only buckets that saw a point. Here:
 *  - `candlesFromPoints`: the same bucketing in JS (the mock, and the reference the API is tested against);
 *  - `mergePoints`: live points pushed over the WebSocket go into the latest candle, or open the next one;
 *  - `fillCandles`: the display list, empty buckets filled flat at the previous close (`n: 0`), up to the bucket
 *    holding "now", so the time axis stays even and a quiet coin reads as a flat line rather than a gap.
 */
import type { Candle, CandleInterval, CandleSeries, Millis, PricePoint } from "./types";

export const CANDLE_INTERVALS: readonly CandleInterval[] = ["1m", "5m", "30m"];
export const INTERVAL_MS: Record<CandleInterval, number> = { "1m": 60_000, "5m": 300_000, "30m": 1_800_000 };
/** Candles per window (the API's and the live trim's). The chart shows as many as fit its width. */
export const CANDLE_WINDOW = 150;

export const bucketOf = (t: Millis, ms: number): Millis => Math.floor(t / ms) * ms;
const okPrice = (p: number) => Number.isFinite(p) && p > 0;

/**
 * Sparse OHLC candles from time-ordered price points (equal times keep their order). Candles are continuous, as on
 * DEX terminals: each opens at the previous close (the previous candle's, or `open` for the first), so the move into
 * a bucket's first trade shows in its body; only a candle with nothing before it opens at its first point.
 * Non-positive prices are skipped.
 */
export function candlesFromPoints(points: readonly PricePoint[], interval: CandleInterval, open?: number): Candle[] {
  const ms = INTERVAL_MS[interval];
  const out: Candle[] = [];
  for (const { t, p } of points) {
    if (!okPrice(p)) continue;
    const b = bucketOf(t, ms);
    const last = out[out.length - 1];
    if (last && last.t === b) {
      last.h = Math.max(last.h, p);
      last.l = Math.min(last.l, p);
      last.c = p;
      last.n++;
    } else if (!last || b > last.t) {
      const o = last ? last.c : (open !== undefined && okPrice(open) ? open : p);
      out.push({ t: b, o, h: Math.max(o, p), l: Math.min(o, p), c: p, n: 1 });
    }
    // a point older than the last bucket: out of order input, ignored (inputs are sorted)
  }
  return out;
}

/**
 * The same continuity rule for buckets aggregated elsewhere (the API's SQL gives each bucket its first / high / low /
 * last point): each opens at the previous close, `open` for the first.
 */
export function chainCandles(buckets: readonly Candle[], open?: number): Candle[] {
  let prev = open !== undefined && okPrice(open) ? open : undefined;
  return buckets.map((b) => {
    const o = prev ?? b.o;
    prev = b.c;
    return { ...b, o, h: Math.max(b.h, o), l: Math.min(b.l, o) };
  });
}

/** The window's first bucket at `now`: `CANDLE_WINDOW` buckets back, or the launch's bucket when that's later. */
export function windowStart(interval: CandleInterval, now: Millis, createdAt?: Millis): Millis {
  const ms = INTERVAL_MS[interval];
  const from = bucketOf(now, ms) - (CANDLE_WINDOW - 1) * ms;
  return createdAt !== undefined ? Math.max(from, bucketOf(createdAt, ms)) : from;
}

/**
 * Live points into a series: a point in the latest candle's bucket updates its high / low / close, a later one opens a
 * new candle (the gap between is left to `fillCandles`), one in an earlier bucket only widens that candle's high / low
 * (its close is already known), one before the window is dropped. The window then slides to the last `CANDLE_WINDOW`
 * buckets; what falls off the left becomes the series' `open`.
 */
export function mergePoints(series: CandleSeries, points: readonly PricePoint[]): CandleSeries {
  if (!points.length) return series;
  const ms = INTERVAL_MS[series.interval];
  const candles = series.candles.map((c) => ({ ...c }));
  for (const { t, p } of points) {
    if (!okPrice(p)) continue;
    const b = bucketOf(t, ms);
    if (b < series.from) continue;
    const last = candles[candles.length - 1];
    if (!last || b > last.t) {
      candles.push({ t: b, o: last ? last.c : (series.open ?? p), h: p, l: p, c: p, n: 1 });
      const nc = candles[candles.length - 1];
      nc.h = Math.max(nc.h, nc.o);
      nc.l = Math.min(nc.l, nc.o);
      continue;
    }
    const i = candles.findIndex((c) => c.t === b);
    if (i < 0) {
      // an earlier bucket that had no candle yet: insert it in order, opening at the previous close
      const at = candles.findIndex((c) => c.t > b);
      const prev = at > 0 ? candles[at - 1].c : series.open;
      const o = prev ?? p;
      candles.splice(at, 0, { t: b, o, h: Math.max(o, p), l: Math.min(o, p), c: p, n: 1 });
      continue;
    }
    const c = candles[i];
    c.h = Math.max(c.h, p);
    c.l = Math.min(c.l, p);
    c.n++;
    if (i === candles.length - 1) c.c = p;
  }
  const latest = candles[candles.length - 1];
  let from = series.from;
  let open = series.open;
  if (latest) {
    const min = latest.t - (CANDLE_WINDOW - 1) * ms;
    if (min > from) {
      from = min;
      let cut = 0;
      while (cut < candles.length && candles[cut].t < from) open = candles[cut++].c;
      candles.splice(0, cut);
    }
  }
  return { ...series, from, open, candles };
}

/**
 * The candles to draw: from the window's start (or `max` buckets back from now, whichever is later) to the bucket
 * holding `now`, every empty bucket a flat filler at the previous close (`n: 0`). Before the first real candle there
 * is no filler unless the series has an `open` price (a fresh coin's chart starts at its launch candle).
 */
export function fillCandles(series: CandleSeries, now: Millis, max = CANDLE_WINDOW): Candle[] {
  const ms = INTERVAL_MS[series.interval];
  const real = series.candles;
  const lastReal = real.length ? real[real.length - 1].t : -Infinity;
  const end = Math.max(bucketOf(now, ms), lastReal);
  const start = Math.max(series.from, end - (Math.max(1, max) - 1) * ms);
  let prev = series.open;
  let i = 0;
  // carry the close of every real candle before the shown window
  while (i < real.length && real[i].t < start) prev = real[i++].c;
  const out: Candle[] = [];
  for (let b = start; b <= end; b += ms) {
    if (i < real.length && real[i].t === b) {
      out.push(real[i]);
      prev = real[i++].c;
    } else if (prev !== undefined) out.push({ t: b, o: prev, h: prev, l: prev, c: prev, n: 0 });
  }
  return out;
}

/**
 * The interval a coin's chart opens on. A coin under ~2.5 h old fits its whole life in 150 one-minute candles, and a
 * fresh launch moves by the minute, so 1m; older coins open on 5m (12.5 h of candles, the usual terminal view).
 */
export function defaultInterval(createdAt: Millis, now: Millis): CandleInterval {
  return now - createdAt < CANDLE_WINDOW * INTERVAL_MS["1m"] ? "1m" : "5m";
}

/** "1-minute candles": the chart's spoken label. */
export function intervalLabel(interval: CandleInterval): string {
  return { "1m": "1-minute candles", "5m": "5-minute candles", "30m": "30-minute candles" }[interval];
}
