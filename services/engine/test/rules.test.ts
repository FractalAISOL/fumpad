// The Rust unit tests of math/price.rs, math/reference.rs, rewards/logic.rs and external/pyth.rs,
// re-run against the TypeScript port (same inputs, same expected values).
import { describe, expect, it } from "vitest";

import {
  blend,
  capTracked,
  claimAmount,
  lamportsToUsdCents,
  meetsMultiple,
  mulDivCeil,
  newHold,
  newReference,
  observeBuy,
  planRebuy,
  planSell,
  priceQ64,
  type ReferencePrice,
  REFERENCE_MAX_UNCONFIRMED_SECS,
  settle,
  add,
  ticketPriceQ64,
  touch,
  U128_MAX,
  validateAt,
  type HoldState,
  type RebuyView,
} from "../src/index.js";

const P = 1n << 64n;
const CRASH = P / 20n;
const abs = (x: bigint) => (x < 0n ? -x : x);
const upd = (r: ReferencePrice, now: number, pre: bigint, post: bigint, exact: boolean) => touch(r, BigInt(now), pre, post, exact ? "curve" : "venue");

describe("price.rs", () => {
  it("ten_x", () => {
    const sell = priceQ64(1_000n, 1_000_000n)!;
    expect(meetsMultiple(priceQ64(9_999n, 1_000_000n)!, sell, 100_000n)).toBe(false);
    expect(meetsMultiple(priceQ64(10_000n, 1_000_000n)!, sell, 100_000n)).toBe(true);
    expect(meetsMultiple(U128_MAX, U128_MAX / 20n, 100_000n)).toBe(true);
    expect(meetsMultiple(U128_MAX / 11n, U128_MAX / 10n, 100_000n)).toBe(false);
  });
  it("mul_div_ceil_exact_and_wide", () => {
    expect(mulDivCeil(10n, 10n, 3n)).toBe(34n);
    expect(mulDivCeil(10n, 9n, 3n)).toBe(30n);
    expect(mulDivCeil(0n, 9n, 3n)).toBe(0n);
    expect(mulDivCeil(1n, 1n, 0n)).toBe(null);
    expect(mulDivCeil(U128_MAX, U128_MAX, U128_MAX)).toBe(U128_MAX);
    expect(mulDivCeil(U128_MAX, 1n << 64n, 1n << 64n)).toBe(U128_MAX);
    expect(mulDivCeil(U128_MAX, 3n, 3n)).toBe(U128_MAX);
    expect(mulDivCeil(U128_MAX, 2n, 3n)).toBe((U128_MAX / 3n) * 2n);
    expect(mulDivCeil(U128_MAX, U128_MAX, U128_MAX - 1n)).toBe(null);
    expect(mulDivCeil(1n << 100n, 1n << 100n, 1n << 90n)).toBe(1n << 110n);
    expect(mulDivCeil(1n << 100n, (1n << 100n) + 1n, 1n << 90n)).toBe((1n << 110n) + (1n << 10n));
    expect(mulDivCeil((1n << 100n) + 1n, 1n << 100n, (1n << 90n) * 3n)).toBe(((1n << 110n) + (1n << 10n)) / 3n + 1n);
  });
});

describe("reference.rs", () => {
  it("self_impact_discount_is_capped_at_10_percent", () => {
    expect(ticketPriceQ64((P * 97n) / 100n, P, P)).toBe((P * 97n) / 100n);
    let t = ticketPriceQ64((P * 49n) / 100n, P, P);
    expect(t >= (P * 9n) / 10n && t <= (P * 9n) / 10n + 1n).toBe(true);
    t = ticketPriceQ64((P * 9n) / 10n, P, P);
    expect(t >= (P * 9n) / 10n && t <= (P * 9n) / 10n + 1n).toBe(true);
    expect(ticketPriceQ64((CRASH * 99n) / 100n, P, CRASH) >= (P * 98n) / 100n).toBe(true);
  });
  it("blend_math_and_rounding", () => {
    expect(blend(100n, 200n, 0n, 600n)).toBe(100n);
    expect(blend(100n, 200n, 600n, 600n)).toBe(200n);
    expect(blend(100n, 200n, 300n, 600n)).toBe(150n);
    expect(blend(200n, 100n, 300n, 600n)).toBe(150n);
    expect(blend(100n, 0n, 1n, 600n)).toBe(100n);
    expect(blend(0n, 100n, 1n, 600n)).toBe(0n);
    expect(blend(0n, U128_MAX, 600n, 600n)).toBe(U128_MAX);
    expect(blend(U128_MAX, 0n, 600n, 600n)).toBe(0n);
    expect(abs(blend(0n, U128_MAX, 300n, 600n) - U128_MAX / 2n) <= 1n).toBe(true);
    expect(blend(5n, 7n, 10_000n, 600n)).toBe(7n);
  });
  it("same_timestamp_observation_has_zero_weight", () => {
    for (const exact of [true, false]) {
      let r = newReference(P, 1_000n);
      r = upd(r, 1_300, P, P, exact);
      const before = r.avgQ64;
      r = upd(r, 1_300, CRASH, CRASH, exact);
      expect(r.avgQ64).toBe(before);
      r = upd(r, 1_300, CRASH, CRASH, exact);
      expect(r.avgQ64).toBe(P);
    }
  });
  it("idle_coin_staged_last_spot_is_neutralized", () => {
    let r = newReference(P, 1_000n);
    r = upd(r, 2_000, CRASH, CRASH, false);
    r = upd(r, 2_000 + 86_400, P, P, false);
    expect(r.avgQ64).toBe(P);
    r = newReference(P, 1_000n);
    r = upd(r, 2_000, CRASH, CRASH, false);
    r = upd(r, 2_000 + 86_400, CRASH, CRASH, false);
    expect(abs(r.avgQ64 - (P - (P - CRASH) / 4n)) <= 1n).toBe(true);
  });
  it("dragging_to_a_tenth_needs_eleven_staged_intervals", () => {
    let t = 1_000;
    let r = upd(newReference(P, BigInt(t)), t, CRASH, CRASH, false);
    let n = 0;
    while (r.avgQ64 * 10n > P) {
      t += Number(REFERENCE_MAX_UNCONFIRMED_SECS);
      r = upd(r, t, CRASH, CRASH, false);
      n++;
    }
    expect(n).toBeGreaterThanOrEqual(11);
    t = 1_000;
    r = upd(newReference(P, BigInt(t)), t, CRASH, CRASH, false);
    while (r.avgQ64 * 10n > P) {
      t += 10;
      r = upd(r, t, CRASH, CRASH, false);
    }
    expect(t - 1_000).toBeGreaterThanOrEqual(1_500);
  });
  it("fallback_samples_are_raise_only", () => {
    let r = newReference(P, 1_000n);
    let t = 1_000n;
    for (let i = 0; i < 50; i++) {
      t += 150n;
      r = touch(r, t, CRASH, CRASH, "fallback_sample");
      expect([r.avgQ64, r.lastSpotQ64]).toEqual([P, P]);
    }
    expect(r.updatedAt).toBe(t);
    r = touch(r, t + 150n, CRASH, CRASH, "venue");
    expect(r.avgQ64).toBe(P);
    r = touch(newReference(P, 1_000n), 1_600n, 2n * P, 2n * P, "fallback_sample");
    expect(abs(r.avgQ64 - (P + P / 4n)) <= 1n).toBe(true);
  });
  it("keeper_upward_uncapped_downward_capped", () => {
    expect(touch(newReference(P, 1_000n), 1_600n, 2n * P, 2n * P, "keeper_sample").avgQ64).toBe(2n * P);
    expect(abs(touch(newReference(P, 1_000n), 1_600n, 2n * P, 2n * P, "venue").avgQ64 - (P + P / 4n)) <= 1n).toBe(true);
    let r = touch(newReference(P, 1_000n), 1_000n, CRASH, CRASH, "venue");
    r = touch(r, 1_600n, CRASH, CRASH, "keeper_sample");
    expect(abs(r.avgQ64 - (P - (P - CRASH) / 4n)) <= 1n).toBe(true);
    r = touch(newReference(P, 1_000n), 1_000n, 3n * P, 3n * P, "venue");
    expect(r.avgQ64).toBe(P);
    r = touch(r, 1_600n, P, P, "keeper_sample");
    expect(abs(r.avgQ64 - (P + (2n * P) / 4n)) <= 1n).toBe(true);
  });
  it("curve_is_an_exact_twap", () => {
    let r = newReference(P, 1_000n);
    r = upd(r, 1_600, P, P / 2n, true);
    expect(r.avgQ64).toBe(P);
    r = upd(r, 1_900, P / 2n, P / 2n, true);
    expect(r.avgQ64).toBe(P - P / 4n);
    r = upd(r, 1_900 + 3_600, P / 2n, P / 2n, true);
    expect(r.avgQ64).toBe(P / 2n);
  });
  it("genuine_slow_decline_is_tracked", () => {
    for (const exact of [true, false]) {
      let r = newReference(P, 1_000n);
      let prev = P;
      for (let i = 1; i <= 120; i++) {
        const spot = P - ((P / 2n) * BigInt(i)) / 120n;
        r = upd(r, 1_000 + i * 30, prev, spot, exact);
        prev = spot;
      }
      expect(r.avgQ64 >= prev).toBe(true);
      expect(r.avgQ64 * 100n <= prev * 120n).toBe(true);
      expect(r.avgQ64 * 100n <= P * 60n).toBe(true);
    }
  });
  it("uninitialized_and_clock_skew", () => {
    let r: ReferencePrice = { avgQ64: 0n, lastSpotQ64: 0n, updatedAt: 0n };
    r = upd(r, 50, CRASH, P, false);
    expect(r).toEqual(newReference(P, 50n));
    r = upd(r, 40, CRASH, CRASH, false);
    expect([r.avgQ64, r.updatedAt]).toEqual([P, 50n]);
  });
  it("d12_ticket_price", () => {
    expect(ticketPriceQ64(5n, 7n, 0n)).toBe(7n);
    expect(ticketPriceQ64(9n, 7n, 0n)).toBe(9n);
    for (const exec of [(P * 91n) / 100n, P - 1n, P]) expect(ticketPriceQ64(exec, P, P)).toBe(exec);
    const t = ticketPriceQ64(P / 2n, P, P);
    expect(t >= (P * 9n) / 10n && t <= (P * 9n) / 10n + 1n).toBe(true);
    expect(ticketPriceQ64((P * 99n) / 100n, P / 2n, P)).toBe((P * 99n) / 100n);
    const pre = CRASH;
    const exec = (pre * 99n) / 100n;
    const t2 = ticketPriceQ64(exec, P, pre);
    expect(t2 + P / 1_000_000n >= (P * 99n) / 100n && t2 <= P).toBe(true);
    expect(t2 > exec * 19n).toBe(true);
    expect(ticketPriceQ64(2n, 3n, 4n)).toBe(3n);
    expect(ticketPriceQ64(1n, 3n, 2n)).toBe(3n);
    expect(ticketPriceQ64(28n, 30n, 30n)).toBe(28n);
    expect(ticketPriceQ64(4n, 10n, 2n)).toBe(20n);
    expect(ticketPriceQ64(U128_MAX, U128_MAX, 1n)).toBe(U128_MAX);
    const big = U128_MAX / 3n;
    expect(ticketPriceQ64((big / 20n) * 19n, big, big)).toBe((big / 20n) * 19n);
    const t3 = ticketPriceQ64(big / 2n, big, big);
    expect(t3 >= (big / 10n) * 9n && t3 <= (big / 10n) * 9n + 10n).toBe(true);
  });
});

const withMatured = (amount: bigint): HoldState => {
  const s = newHold();
  add(s, amount, 0n, 600n);
  return s;
};
const HP = { minHoldSecs: 600n, maxOpenTickets: 5 };
const clone = (s: HoldState): HoldState => ({ ...s });

describe("logic.rs", () => {
  it("min_hold_ten_minutes", () => {
    const s = newHold();
    add(s, 1_000n, 0n, 600n);
    expect(planSell(clone(s), HP, false, 1_000n, 1_000n, 599n)).toEqual({ ok: false, reason: "not_matured" });
    const s2 = clone(s);
    planSell(s2, HP, false, 400n, 1_000n, 599n);
    expect([s2.matured, s2.pending]).toEqual([0n, 600n]);
    expect(planSell(clone(s), HP, false, 1_000n, 1_000n, 600n)).toEqual({ ok: true, tokens: 1_000n });
  });
  it("new_buy_does_not_reset_matured_clock_but_restarts_pending", () => {
    const s = newHold();
    add(s, 1_000n, 0n, 600n);
    add(s, 500n, 700n, 600n);
    expect([s.matured, s.pending, s.pendingSince]).toEqual([1_000n, 500n, 700n]);
    expect(planSell(clone(s), HP, false, 1_500n, 1_500n, 800n)).toEqual({ ok: true, tokens: 1_000n });
    add(s, 100n, 1_000n, 600n);
    expect([s.pending, s.pendingSince]).toEqual([600n, 1_000n]);
    settle(s, 1_599n, 600n);
    expect(s.pending).toBe(600n);
    settle(s, 1_600n, 600n);
    expect([s.matured, s.pending]).toEqual([1_600n, 0n]);
  });
  it("ticket_capped_by_sold_and_balance", () => {
    const s = withMatured(1_000n);
    const a = clone(s);
    expect(planSell(a, HP, false, 300n, 1_000n, 700n)).toEqual({ ok: true, tokens: 300n });
    expect(a.matured).toBe(700n);
    const b = clone(s);
    expect(planSell(b, HP, false, 500n, 200n, 700n)).toEqual({ ok: true, tokens: 200n });
    expect([b.matured, b.pending]).toEqual([0n, 0n]);
  });
  it("unseen_arrivals_sold_first", () => {
    const s = newHold();
    observeBuy(s, HP, 1_000n, 0n, 0n);
    expect([s.pending, s.lastBalance]).toEqual([1_000n, 1_000n]);
    const a = clone(s);
    expect(planSell(a, HP, false, 400n, 1_400n, 600n)).toEqual({ ok: false, reason: "not_matured" });
    expect([a.matured, a.lastBalance]).toEqual([1_000n, 1_000n]);
    const b = clone(s);
    expect(planSell(b, HP, false, 1_400n, 1_400n, 600n)).toEqual({ ok: true, tokens: 1_000n });
    expect([b.matured, b.pending, b.lastBalance]).toEqual([0n, 0n, 0n]);
    expect(planSell(clone(s), HP, false, 1_500n, 1_500n, 600n)).toEqual({ ok: true, tokens: 1_000n });
    const d = clone(s);
    observeBuy(d, HP, 50n, 200n, 700n);
    expect([d.matured, d.pending, d.lastBalance]).toEqual([200n, 50n, 250n]);
    const e = withMatured(1_000n);
    expect(planSell(e, HP, false, 1_000n, 1_000n, 600n)).toEqual({ ok: true, tokens: 1_000n });
  });
  it("cap_removes_matured_first", () => {
    const s = newHold();
    s.matured = 100n;
    s.pending = 50n;
    capTracked(s, 120n);
    expect([s.matured, s.pending]).toEqual([70n, 50n]);
    capTracked(s, 10n);
    expect([s.matured, s.pending]).toEqual([0n, 10n]);
    capTracked(s, 1_000n);
    expect([s.matured, s.pending]).toEqual([0n, 10n]);
  });
  it("creator_and_open_ticket_limit", () => {
    const s = withMatured(1_000n);
    const c = clone(s);
    expect(planSell(c, HP, true, 500n, 1_000n, 700n)).toEqual({ ok: false, reason: "creator" });
    expect(c.matured).toBe(500n);
    s.openCount = 5;
    expect(planSell(clone(s), HP, false, 500n, 1_000n, 700n)).toEqual({ ok: false, reason: "too_many_open_tickets" });
  });
  it("rebuy_newest_first_within_window", () => {
    const w = 7n * 86_400n;
    const t = (sellTs: bigint, seq: bigint, tokens: bigint, active = true): RebuyView => ({ sellTs, seq, tokens, active });
    const tickets = [t(100n, 0n, 1_000n), t(300n, 2n, 400n), t(200n, 1n, 500n), t(300n, 3n, 50n, false), t(-w, 4n, 9_999n)];
    expect(planRebuy(tickets, 600n, 1_000n, w)).toEqual([0n, 400n, 200n, 0n, 0n]);
    expect(planRebuy(tickets, 10_000n, 1_000n, w)).toEqual([1_000n, 400n, 500n, 0n, 0n]);
    expect(planRebuy([t(0n, 0n, 10n)], 5n, w, w)).toEqual([5n]);
    expect(planRebuy([t(0n, 0n, 10n)], 5n, w + 1n, w)).toEqual([0n]);
    expect(planRebuy([t(5n, 0n, 10n), t(5n, 1n, 10n)], 15n, 10n, w)).toEqual([5n, 10n]);
    // Same xorshift as the Rust test: the insertion sort matches a stable sort.
    let x = 0x9e37_79b9_7f4a_7c15n;
    const M = (1n << 64n) - 1n;
    const next = () => {
      x ^= (x << 13n) & M;
      x ^= x >> 7n;
      x ^= (x << 17n) & M;
      return x;
    };
    for (let k = 0; k < 2_000; k++) {
      const n = Number(next() % 9n);
      const ts: RebuyView[] = [];
      for (let i = 0; i < n; i++) ts.push(t(next() % 4n, next() % 3n, 1n + (next() % 50n)));
      const order = [...ts.keys()].sort((a, b) => {
        const A = ts[a];
        const B = ts[b];
        return B.sellTs !== A.sellTs ? (B.sellTs > A.sellTs ? 1 : -1) : B.seq !== A.seq ? (B.seq > A.seq ? 1 : -1) : 0;
      });
      const total = ts.reduce((s, v) => s + v.tokens, 0n);
      const amount = next() % (total + 1n);
      const want = ts.map(() => 0n);
      let left = amount;
      for (const i of order) {
        const d = left < ts[i].tokens ? left : ts[i].tokens;
        want[i] = d;
        left -= d;
      }
      expect(planRebuy(ts, amount, 10n, w)).toEqual(want);
    }
  });
  it("claim_math", () => {
    expect(claimAmount(1_000_000n, 1_000n)).toBe(100_000n);
    expect(claimAmount(9n, 1_000n)).toBe(0n);
  });
});

describe("pyth.rs / usd", () => {
  const USD_150 = { price: 150_00000000n, exponent: -8 };
  it("lamports_to_usd_cents", () => {
    expect(lamportsToUsdCents(333_333_334n, USD_150)).toBe(5_000n);
    expect(lamportsToUsdCents(333_000_000n, USD_150)).toBe(4_995n);
    expect(lamportsToUsdCents(1_000_000_000n, { price: 15n, exponent: 1 })).toBe(15_000n);
  });
  it("time and confidence rules", () => {
    const u = { price: 150_00000000n, conf: 1_0000000n, expo: -8, publishTime: 1_000 };
    expect(validateAt(u, 1_000, 60)).toEqual({ ok: true, usd: { price: 149_90000000n, exponent: -8 } });
    expect(validateAt(u, 1_060, 60).ok).toBe(true);
    expect(validateAt(u, 1_061, 60)).toEqual({ ok: false, issue: "stale" });
    expect(validateAt(u, 999, 60)).toEqual({ ok: false, issue: "future" });
    expect(validateAt(null, 999, 60)).toEqual({ ok: false, issue: "missing" });
    expect(validateAt({ ...u, conf: 3_00000001n }, 1_000, 60)).toEqual({ ok: false, issue: "confidence_too_wide" });
    expect(validateAt({ ...u, conf: 3_00000000n }, 1_000, 60).ok).toBe(true);
    expect(validateAt({ ...u, price: 0n, conf: 0n }, 1_000, 60)).toEqual({ ok: false, issue: "non_positive_price" });
  });
});
