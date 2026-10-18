// fast-check properties of the off-chain eligibility engine's rule ports (FUZZ_RUNS, default 2000): hold/maturity,
// rebuy debit ordering, D10/D12 ticket price floor, reference blending, USD conversion.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { newHold, planRebuy, planSell, observeBuy, type RebuyView } from "../src/rules/position.js";
import { priceQ64 } from "../src/rules/price.js";
import { blend, MAX_SELF_IMPACT_DISCOUNT_BPS, newReference, ticketPriceQ64, touch } from "../src/rules/reference.js";
import { lamportsToUsdCents, validateAt } from "../src/rules/usd.js";

const RUNS = Number(process.env.FUZZ_RUNS ?? 2000);
const U64 = (1n << 64n) - 1n;
const U128 = (1n << 128n) - 1n;
const u = (bits: number) => fc.bigUint({ max: (1n << BigInt(bits)) - 1n });

describe("hold / maturity (planSell, observeBuy)", () => {
  /**
   * Over any consistent buy/sell history of one wallet, the tokens credited to tickets up to time T never exceed the
   * tokens bought at least `minHold` before T (fresh tokens can never earn a ticket), and never exceed what was sold.
   */
  it("ticket tokens ≤ tokens held ≥ minHold, ≤ tokens sold", () => {
    const ev = fc.record({ dt: fc.integer({ min: 0, max: 2_000 }), buy: fc.boolean(), amt: fc.bigUint({ max: 10n ** 12n }), pct: fc.integer({ min: 1, max: 100 }) });
    fc.assert(
      fc.property(fc.array(ev, { maxLength: 60 }), fc.integer({ min: 60, max: 3_600 }), (evs, hold) => {
        const p = newHold();
        const params = { minHoldSecs: BigInt(hold), maxOpenTickets: 1_000 };
        let now = 1_700_000_000n;
        let bal = 0n;
        let credited = 0n;
        let sold = 0n;
        const buys: [bigint, bigint][] = [];
        for (const e of evs) {
          now += BigInt(e.dt);
          if (e.buy) {
            if (e.amt === 0n) continue;
            observeBuy(p, params, e.amt, bal, now);
            buys.push([now, e.amt]);
            bal += e.amt;
          } else {
            const s = (bal * BigInt(e.pct)) / 100n;
            if (s === 0n) continue;
            const r = planSell(p, params, false, s, bal, now);
            bal -= s;
            sold += s;
            if (r.ok) credited += r.tokens;
            const matured = buys.filter(([t]) => now - t >= BigInt(hold)).reduce((a, [, x]) => a + x, 0n);
            expect(credited <= matured).toBe(true);
            expect(credited <= sold).toBe(true);
            if (r.ok) expect(r.tokens <= s).toBe(true);
          }
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("the creator never gets a ticket; nor a wallet at its open-ticket limit", () => {
    fc.assert(
      fc.property(u(40), u(40), fc.integer({ min: 0, max: 10 }), (bought, s0, open) => {
        const p = newHold();
        observeBuy(p, { minHoldSecs: 60n, maxOpenTickets: 5 }, bought, 0n, 0n);
        p.openCount = open;
        const s = bought === 0n ? 0n : s0 % (bought + 1n);
        const r = planSell(p, { minHoldSecs: 60n, maxOpenTickets: 5 }, true, s, bought, 10_000n);
        expect(r.ok).toBe(false);
        const q = newHold();
        observeBuy(q, { minHoldSecs: 60n, maxOpenTickets: 5 }, bought, 0n, 0n);
        q.openCount = open;
        const r2 = planSell(q, { minHoldSecs: 60n, maxOpenTickets: 5 }, false, s, bought, 10_000n);
        if (open >= 5) expect(r2.ok).toBe(false);
      }),
      { numRuns: RUNS },
    );
  });
});

describe("rebuy debits (planRebuy)", () => {
  const view = fc.record({ sellTs: fc.bigInt({ min: 0n, max: 2_000n }), seq: fc.bigInt({ min: 0n, max: 50n }), tokens: u(40), active: fc.boolean() });
  it("Σ debits = min(amount, eligible), each ≤ its tokens, newest-first, nothing outside the window", () => {
    fc.assert(
      fc.property(fc.array(view, { maxLength: 12 }), u(42), fc.bigInt({ min: 0n, max: 3_000n }), fc.bigInt({ min: 0n, max: 2_000n }), (ts, amount, now, win) => {
        const d = planRebuy(ts as RebuyView[], amount, now, win);
        const elig = ts.map((t) => t.active && t.tokens > 0n && now >= t.sellTs && now - t.sellTs <= win);
        const total = ts.reduce((a, t, i) => a + (elig[i] ? t.tokens : 0n), 0n);
        expect(d.reduce((a, x) => a + x, 0n)).toBe(amount < total ? amount : total);
        ts.forEach((t, i) => {
          expect(d[i] <= t.tokens).toBe(true);
          if (!elig[i]) expect(d[i]).toBe(0n);
        });
        // Newest first: a ticket not fully debited ⇒ every strictly older eligible ticket untouched.
        ts.forEach((t, i) => {
          if (!elig[i] || d[i] === t.tokens) return;
          ts.forEach((o, j) => {
            if (elig[j] && (o.sellTs < t.sellTs || (o.sellTs === t.sellTs && o.seq < t.seq))) expect(d[j]).toBe(0n);
          });
        });
      }),
      { numRuns: RUNS },
    );
  });
});

describe("D10/D12 ticket price and reference", () => {
  it("ticketPriceQ64 ≥ execution (on-chain TicketPriceBelowExecution can't fire), ≥ ⌈0.9·ref⌉ when pre > 0, ≤ u128", () => {
    fc.assert(
      fc.property(u(64), fc.bigUint({ max: U64 }).filter((x) => x > 0n), u(128), u(128), (q, b, ref, pre) => {
        const exec = priceQ64(q, b)!;
        const t = ticketPriceQ64(exec, ref, pre);
        expect(t >= exec).toBe(true);
        expect(t <= U128).toBe(true);
        if (pre > 0n) {
          const capped = (ref * (10_000n - MAX_SELF_IMPACT_DISCOUNT_BPS) + 9_999n) / 10_000n;
          expect(t >= (capped > U128 ? U128 : capped)).toBe(true);
        } else expect(t).toBe(exec > ref ? exec : ref);
      }),
      { numRuns: RUNS },
    );
  });

  it("blend stays between avg and v; w = 0 → avg; w ≥ window → v", () => {
    fc.assert(
      fc.property(u(128), u(128), fc.bigInt({ min: 0n, max: 2_000n }), (avg, v, w) => {
        const r = blend(avg, v, w, 600n);
        const lo = avg < v ? avg : v;
        const hi = avg < v ? v : avg;
        expect(r >= lo && r <= hi).toBe(true);
        if (w === 0n) expect(r).toBe(avg);
        if (w >= 600n) expect(r).toBe(v);
      }),
      { numRuns: RUNS },
    );
  });

  it("a fallback sample never lowers the reference average", () => {
    fc.assert(
      fc.property(u(100), u(100), u(100), u(100), fc.bigInt({ min: 0n, max: 5_000n }), (a, l, pre, post, dt) => {
        const r = { ...newReference(a, 1_000n), lastSpotQ64: l };
        const n = touch(r, 1_000n + dt, pre, post, "fallback_sample");
        expect(n.avgQ64 >= r.avgQ64).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });
});

describe("USD conversion ($ minimum)", () => {
  it("lamportsToUsdCents rounds down (never over-states the sell) and is monotone", () => {
    fc.assert(
      fc.property(u(64), u(64), fc.bigUint({ max: 10n ** 12n }).filter((x) => x > 0n), fc.integer({ min: -12, max: 4 }), (l1, l2, price, expo) => {
        const p = { price, exponent: expo };
        const a = lamportsToUsdCents(l1, p);
        const b = lamportsToUsdCents(l2, p);
        if (a !== null) {
          // exact: l × price × 10^(expo − 7); a ≤ exact < a + 1
          const e = expo - 7;
          const num = l1 * price * (e >= 0 ? 10n ** BigInt(e) : 1n);
          const den = e >= 0 ? 1n : 10n ** BigInt(-e);
          expect(a * den <= num && num < (a + 1n) * den).toBe(true);
        }
        if (a !== null && b !== null && l1 <= l2) expect(a <= b).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  it("validateAt: ok ⇒ conservative price > 0, publish ≤ block, age ≤ max, conf ≤ 2%", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }), u(40), fc.integer({ min: -20, max: 20 }), fc.integer({ min: 0, max: 2_000 }), fc.integer({ min: 0, max: 2_000 }), (price, conf, expo, pub, block) => {
        const r = validateAt({ price, conf, expo, publishTime: pub }, block, 60);
        if (r.ok) {
          expect(r.usd.price > 0n).toBe(true);
          expect(pub <= block && block - pub <= 60).toBe(true);
          expect(conf * 10_000n <= price * 200n).toBe(true);
        }
      }),
      { numRuns: RUNS },
    );
  });
});
