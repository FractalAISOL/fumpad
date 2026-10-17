/**
 * Coin chart candles (`GET /v1/coins/:mint/candles`, `Repo.getCandles`). The bucketing itself runs in Postgres; these
 * are the constants and the continuity rule it shares with the app (app/src/data/candles.ts: `CANDLE_WINDOW`,
 * `INTERVAL_MS`, `chainCandles`), kept identical so the API's candles and the app's live updates agree.
 */
import type { Candle, CandleInterval } from "./generated/app-types.js";

export const CANDLE_INTERVALS: readonly CandleInterval[] = ["1m", "5m", "30m"];
export const CANDLE_SECS: Record<CandleInterval, number> = { "1m": 60, "5m": 300, "30m": 1_800 };
/** Candles per window. */
export const CANDLE_WINDOW = 150;

/** Each candle opens at the previous close (`open` for the first), its high / low widened to include it. */
export function chainCandles(buckets: readonly Candle[], open?: number): Candle[] {
  let prev = open !== undefined && Number.isFinite(open) && open > 0 ? open : undefined;
  return buckets.map((b) => {
    const o = prev ?? b.o;
    prev = b.c;
    return { ...b, o, h: Math.max(b.h, o), l: Math.min(b.l, o) };
  });
}
