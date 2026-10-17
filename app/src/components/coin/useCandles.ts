"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type CandleInterval, type CandleSeries, type PricePoint, getFumpadData, keepSnapshot } from "@/data";
import { CANDLE_INTERVALS, fillCandles, INTERVAL_MS, intervalLabel, mergePoints } from "@/data/candles";

/** The chart's interval buttons (trading-terminal style: each sets the candle size). */
export const INTERVAL_ITEMS: { value: CandleInterval; label: string }[] = CANDLE_INTERVALS.map((v) => ({ value: v, label: v }));

/**
 * The coin chart's candles (coin page and launch-window panel): the interval the user picked, its series (fetched on
 * mount, on an interval change and on `reload`), live points merged into the forming candle (`push`), and the display
 * list with empty buckets filled flat up to now. The clock is the data source's (mock: its frozen epoch), ticking
 * every 10 s so a new bucket opens on time even without a trade; it starts at the server's `now` for hydration.
 */
export function useCandles(mint: string, initial: CandleSeries, serverNow: number) {
  const data = getFumpadData();
  const [interval, setIntervalState] = useState<CandleInterval>(initial.interval);
  const [series, setSeries] = useState<CandleSeries>(initial);
  const want = useRef<CandleInterval>(initial.interval);
  const [now, setNow] = useState(serverNow);

  // A different coin (client navigation) starts from its own server snapshot.
  const [shownMint, setShownMint] = useState(mint);
  if (shownMint !== mint) {
    setShownMint(mint);
    setSeries(initial);
    setIntervalState(initial.interval);
  }
  useEffect(() => {
    want.current = interval;
  }, [interval]);

  useEffect(() => {
    const tick = () => setNow(data.now());
    tick();
    const id = setInterval(tick, 10_000);
    return () => clearInterval(id);
  }, [data]);

  const reload = useCallback(() => {
    const iv = want.current;
    data
      .getCandles(mint, iv)
      .then((sr) => {
        if (want.current === iv) setSeries(sr);
      })
      .catch(keepSnapshot);
  }, [data, mint]);
  useEffect(() => {
    if (series.interval !== interval) reload();
  }, [interval, series.interval, reload]);
  // on mount: the server snapshot may be minutes old
  useEffect(reload, [reload]);

  const setInterval_ = useCallback((iv: CandleInterval) => {
    want.current = iv;
    setIntervalState(iv);
  }, []);
  const push = useCallback((points: PricePoint[]) => {
    if (points.length) setSeries((sr) => (sr.interval === want.current ? mergePoints(sr, points) : sr));
  }, []);

  const candles = useMemo(() => fillCandles(series, now), [series, now]);
  return {
    interval,
    setInterval: setInterval_,
    loading: series.interval !== interval,
    candles,
    intervalMs: INTERVAL_MS[interval],
    label: intervalLabel(interval),
    /** The window's first bucket (for "your sell is before this window"). */
    from: series.from,
    reload,
    push,
  };
}
