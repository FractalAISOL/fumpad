import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { bucketOf, CANDLE_WINDOW, candlesFromPoints, chainCandles, defaultInterval, fillCandles, INTERVAL_MS, mergePoints, windowStart } from "./candles";
import type { CandleSeries } from "./types";

const M = 60_000;
const T0 = Date.UTC(2026, 9, 17, 12, 0, 0); // a UTC hour: every interval's boundary

describe("candlesFromPoints (bucketing)", () => {
  it("buckets on UTC interval boundaries: open, high, low, close and the point count", () => {
    const pts = [
      { t: T0 + 5_000, p: 10 },
      { t: T0 + 20_000, p: 14 },
      { t: T0 + 40_000, p: 9 },
      { t: T0 + 59_999, p: 12 },
      { t: T0 + M, p: 13 },
    ];
    assert.deepEqual(candlesFromPoints(pts, "1m"), [
      { t: T0, o: 10, h: 14, l: 9, c: 12, n: 4 },
      { t: T0 + M, o: 12, h: 13, l: 12, c: 13, n: 1 }, // opens at the previous close
    ]);
    assert.deepEqual(candlesFromPoints(pts, "5m"), [{ t: T0, o: 10, h: 14, l: 9, c: 13, n: 5 }]);
  });

  it("5m and 30m buckets start on their own boundaries (12:05, 12:30), not at the first trade", () => {
    const pts = [
      { t: T0 + 7 * M, p: 1 },
      { t: T0 + 9 * M + 59_000, p: 2 },
      { t: T0 + 10 * M, p: 3 },
      { t: T0 + 31 * M, p: 4 },
    ];
    assert.deepEqual(
      candlesFromPoints(pts, "5m").map((c) => [c.t - T0, c.n]),
      [
        [5 * M, 2],
        [10 * M, 1],
        [30 * M, 1],
      ],
    );
    assert.deepEqual(
      candlesFromPoints(pts, "30m").map((c) => [c.t - T0, c.o, c.c]),
      [
        [0, 1, 3],
        [30 * M, 3, 4],
      ],
    );
  });

  it("sparse data: buckets without a trade are left out; the next candle still opens at the last close", () => {
    const c = candlesFromPoints(
      [
        { t: T0, p: 2 },
        { t: T0 + 10 * M, p: 3 },
      ],
      "1m",
    );
    assert.deepEqual(
      c.map((x) => [x.t - T0, x.o, x.c]),
      [
        [0, 2, 2],
        [10 * M, 2, 3],
      ],
    );
  });

  it("the first candle opens at the price carried into the window, when there is one", () => {
    assert.deepEqual(candlesFromPoints([{ t: T0 + 1_000, p: 5 }], "1m", 4), [{ t: T0, o: 4, h: 5, l: 4, c: 5, n: 1 }]);
    assert.deepEqual(candlesFromPoints([{ t: T0 + 1_000, p: 5 }], "1m", 6), [{ t: T0, o: 6, h: 6, l: 5, c: 5, n: 1 }]);
  });

  it("skips zero / negative / non-finite prices and out-of-order points; empty input is empty", () => {
    assert.deepEqual(candlesFromPoints([], "1m"), []);
    const c = candlesFromPoints(
      [
        { t: T0 + M, p: 2 },
        { t: T0, p: 99 }, // older bucket than the last: ignored
        { t: T0 + M + 1, p: 0 },
        { t: T0 + M + 2, p: Number.NaN },
        { t: T0 + M + 3, p: -1 },
      ],
      "1m",
    );
    assert.deepEqual(c, [{ t: T0 + M, o: 2, h: 2, l: 2, c: 2, n: 1 }]);
  });

  it("chainCandles applies the same continuity to buckets aggregated elsewhere (the API's SQL)", () => {
    const raw = [
      { t: T0, o: 10, h: 11, l: 10, c: 11, n: 2 },
      { t: T0 + 2 * M, o: 9, h: 9, l: 8, c: 8, n: 2 },
    ];
    assert.deepEqual(chainCandles(raw, 12), [
      { t: T0, o: 12, h: 12, l: 10, c: 11, n: 2 },
      { t: T0 + 2 * M, o: 11, h: 11, l: 8, c: 8, n: 2 },
    ]);
    assert.equal(chainCandles(raw)[0].o, 10);
  });
});

describe("windowStart / defaultInterval", () => {
  it("the window is the last 150 buckets, or from the launch bucket when the coin is younger", () => {
    const now = T0 + 3 * 3_600_000 + 25_000;
    assert.equal(windowStart("1m", now), bucketOf(now, M) - 149 * M);
    assert.equal(windowStart("30m", now), bucketOf(now, 30 * M) - 149 * 30 * M);
    assert.equal(windowStart("1m", now, now - 5 * M), bucketOf(now - 5 * M, M));
    assert.equal(CANDLE_WINDOW, 150);
  });
  it("a fresh coin opens on 1m; one older than 150 minutes on 5m", () => {
    assert.equal(defaultInterval(T0, T0 + 30_000), "1m");
    assert.equal(defaultInterval(T0, T0 + 149 * M), "1m");
    assert.equal(defaultInterval(T0, T0 + 150 * M), "5m");
    assert.equal(defaultInterval(T0, T0 + 9 * 86_400_000), "5m");
  });
});

const series = (s: Partial<CandleSeries>): CandleSeries => ({ interval: "1m", from: T0, candles: [], ...s });

describe("fillCandles (display list)", () => {
  it("fills empty buckets flat at the previous close (n: 0), up to the bucket holding now", () => {
    const s = series({ candles: [{ t: T0, o: 1, h: 2, l: 1, c: 2, n: 3 }, { t: T0 + 3 * M, o: 2, h: 4, l: 2, c: 3, n: 1 }] });
    const out = fillCandles(s, T0 + 5 * M + 10_000);
    assert.deepEqual(
      out.map((c) => [(c.t - T0) / M, c.o, c.c, c.n]),
      [
        [0, 1, 2, 3],
        [1, 2, 2, 0],
        [2, 2, 2, 0],
        [3, 2, 3, 1],
        [4, 3, 3, 0],
        [5, 3, 3, 0],
      ],
    );
    for (const c of out.filter((x) => x.n === 0)) assert.ok(c.o === c.h && c.h === c.l && c.l === c.c);
  });

  it("a fresh coin starts at its launch candle; with an open price, the window starts flat", () => {
    const fresh = series({ from: T0, candles: [{ t: T0 + 2 * M, o: 1, h: 1, l: 1, c: 1, n: 1 }] });
    assert.equal(fillCandles(fresh, T0 + 2 * M)[0].t, T0 + 2 * M);
    const carried = series({ from: T0, open: 0.5, candles: [{ t: T0 + 2 * M, o: 0.5, h: 1, l: 0.5, c: 1, n: 1 }] });
    assert.deepEqual(
      fillCandles(carried, T0 + 2 * M).map((c) => [c.c, c.n]),
      [
        [0.5, 0],
        [0.5, 0],
        [1, 1],
      ],
    );
  });

  it("no trades in the window: a flat line at the carried price; nothing at all without one", () => {
    assert.equal(fillCandles(series({ open: 3 }), T0 + 9 * M).length, 10);
    assert.deepEqual(fillCandles(series({}), T0 + 9 * M), []);
  });

  it("shows at most `max` buckets (the newest), carrying the close of the ones cut off", () => {
    const s = series({ candles: [{ t: T0, o: 1, h: 1, l: 1, c: 7, n: 1 }] });
    const out = fillCandles(s, T0 + 400 * M, 50);
    assert.equal(out.length, 50);
    assert.equal(out[49].t, T0 + 400 * M);
    assert.ok(out.every((c) => c.c === 7 && c.n === 0));
  });

  it("each interval: a full window of 150 candles ends at now's bucket", () => {
    for (const iv of ["1m", "5m", "30m"] as const) {
      const ms = INTERVAL_MS[iv];
      const now = T0 + 1_000 * ms + 123;
      const out = fillCandles({ interval: iv, from: windowStart(iv, now), open: 1, candles: [] }, now);
      assert.equal(out.length, 150);
      assert.equal(out[149].t, bucketOf(now, ms));
      assert.equal(out[1].t - out[0].t, ms);
    }
  });
});

describe("mergePoints (live updates)", () => {
  const base = series({ candles: [{ t: T0, o: 1, h: 2, l: 1, c: 2, n: 2 }] });

  it("a point in the latest bucket moves its high / low / close", () => {
    const s = mergePoints(base, [
      { t: T0 + 30_000, p: 3 },
      { t: T0 + 40_000, p: 0.5 },
    ]);
    assert.deepEqual(s.candles, [{ t: T0, o: 1, h: 3, l: 0.5, c: 0.5, n: 4 }]);
    assert.deepEqual(base.candles[0], { t: T0, o: 1, h: 2, l: 1, c: 2, n: 2 }, "the input is not mutated");
  });

  it("a later point opens the next candle at the last close (gaps are left to fillCandles)", () => {
    const s = mergePoints(base, [{ t: T0 + 4 * M + 1, p: 5 }]);
    assert.deepEqual(s.candles[1], { t: T0 + 4 * M, o: 2, h: 5, l: 2, c: 5, n: 1 });
  });

  it("an earlier bucket only widens high / low; an earlier empty bucket is inserted in order; pre-window points drop", () => {
    const two = mergePoints(base, [{ t: T0 + 3 * M, p: 4 }]);
    const s = mergePoints(two, [
      { t: T0 + 10_000, p: 9 },
      { t: T0 + M + 5, p: 3 },
      { t: T0 - 1, p: 100 },
    ]);
    assert.deepEqual(
      s.candles.map((c) => [(c.t - T0) / M, c.o, c.h, c.c]),
      [
        [0, 1, 9, 2],
        [1, 2, 3, 3],
        [3, 2, 4, 4],
      ],
    );
  });

  it("the first point of an empty series opens at the carried price, or at itself", () => {
    assert.deepEqual(mergePoints(series({ open: 2 }), [{ t: T0 + 5, p: 3 }]).candles, [{ t: T0, o: 2, h: 3, l: 2, c: 3, n: 1 }]);
    assert.deepEqual(mergePoints(series({}), [{ t: T0 + 5, p: 3 }]).candles, [{ t: T0, o: 3, h: 3, l: 3, c: 3, n: 1 }]);
  });

  it("the window slides: candles older than 150 buckets fall off and their close becomes `open`", () => {
    const s = mergePoints(base, [{ t: T0 + 200 * M, p: 8 }]);
    assert.equal(s.from, T0 + 51 * M);
    assert.equal(s.open, 2);
    assert.deepEqual(
      s.candles.map((c) => c.t),
      [T0 + 200 * M],
    );
    assert.equal(mergePoints(base, []), base);
  });
});
