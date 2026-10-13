/**
 * The TS math port vs numbers produced by the program's own Rust functions
 * (sdk/test/vectors.json, regenerated with `npm run vectors`).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DEFAULT_PARAMS } from "../../src/v06/params.js";
import { quoteCurveBuy } from "../../src/v06/quote.js";
import {
  claimAmount,
  claimCap,
  computeFee,
  fits,
  lamportsFor,
  lamportsToUsdCents,
  meetsMultiple,
  mulDivCeil,
  planRebuy,
  planSell,
  priceQ64,
  quoteBuy,
  quoteSell,
  solForTokens,
  solInForBudget,
  ticketPriceQ64,
  touchReference,
  medianPriceQ64,
  snipeCurveOffer,
  snipeTax,
  snipeTaxBps,
  type Touch,
  curveSpotQ64,
  type CurveReserves,
  type ReferencePrice,
} from "../../src/v06/math/index.js";

const V = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "vectors.json"), "utf8"));
const B = (x: string | null) => (x === null ? null : BigInt(x));
const res = (r: Record<string, string>): CurveReserves => ({
  virtualSol: BigInt(r.virtualSol),
  virtualToken: BigInt(r.virtualToken),
  realSol: BigInt(r.realSol),
  realToken: BigInt(r.realToken),
});

describe("curve (math/curve.rs)", () => {
  it("replays every buy/sell step exactly", () => {
    let n = 0;
    for (const s of V.curve.steps) {
      const r = res(s.before);
      expect(curveSpotQ64(r)).toBe(B(s.spotQ64));
      if (s.op === "buy") {
        const q = quoteBuy(r, BigInt(s.solIn))!;
        expect(q.solUsed).toBe(BigInt(s.solUsed));
        expect(q.tokensOut).toBe(BigInt(s.tokensOut));
        expect(q.completes).toBe(s.completes);
      } else {
        expect(quoteSell(r, BigInt(s.tokensIn))).toBe(B(s.solOut));
      }
      n++;
    }
    expect(n).toBeGreaterThan(50);
  });
  it("inverse quote (sol_for_tokens)", () => {
    for (const c of V.curve.inverse) expect(solForTokens(res(c.reserves), BigInt(c.tokensOut))).toBe(B(c.sol));
  });
});

describe("fees (math/fees.rs)", () => {
  it("compute_fee split", () => {
    for (const f of V.fees) {
      const got = computeFee(BigInt(f.amount), DEFAULT_PARAMS);
      expect(got).toEqual({ total: BigInt(f.total), pool: BigInt(f.pool), platform: BigInt(f.platform), creator: BigInt(f.creator) });
    }
  });
  it("solInForBudget never exceeds the budget and is maximal", () => {
    for (const budget of [1n, 100n, 101n, 1_000_000_000n, 85_000_000_000n, 123_456_789n]) {
      const s = solInForBudget(budget, DEFAULT_PARAMS);
      expect(s + computeFee(s, DEFAULT_PARAMS).total).toBeLessThanOrEqual(budget);
      expect(s + 1n + computeFee(s + 1n, DEFAULT_PARAMS).total).toBeGreaterThan(budget);
    }
  });
});

describe("price (math/price.rs)", () => {
  it("price_q64", () => {
    for (const c of V.price.priceQ64) expect(priceQ64(BigInt(c.lamports), BigInt(c.tokens))).toBe(B(c.q));
  });
  it("mul_div_ceil (256-bit, u128 overflow → null)", () => {
    for (const c of V.price.mulDivCeil) expect(mulDivCeil(BigInt(c.a), BigInt(c.b), BigInt(c.d))).toBe(B(c.q));
  });
  it("meets_multiple", () => {
    for (const c of V.price.meetsMultiple) expect(meetsMultiple(BigInt(c.current), BigInt(c.reference), c.bps)).toBe(c.ok);
  });
  it("lamports_for", () => {
    for (const c of V.price.lamportsFor) expect(lamportsFor(BigInt(c.tokens), BigInt(c.priceQ64))).toBe(B(c.lamports));
  });
});

describe("reference (math/reference.rs, D10/D12)", () => {
  it("update sequences match", () => {
    for (const seq of V.reference.sequences) {
      let st: ReferencePrice = { avgQ64: BigInt(seq.init.avg), lastSpotQ64: BigInt(seq.init.last), updatedAt: BigInt(seq.init.updatedAt) };
      for (const s of seq.steps) {
        st = touchReference(st, BigInt(s.now), BigInt(s.pre), BigInt(s.post), s.kind as Touch);
        expect(st).toEqual({ avgQ64: BigInt(s.avg), lastSpotQ64: BigInt(s.last), updatedAt: BigInt(s.updatedAt) });
      }
    }
  });
  it("ticket_price_q64", () => {
    for (const c of V.reference.ticketPrice) expect(ticketPriceQ64(BigInt(c.exec), BigInt(c.reference), BigInt(c.pre))).toBe(BigInt(c.ticket));
  });
});

describe("oracle median (state/observations.rs, v0.3 keeper-only + 5/6 buckets)", () => {
  it("matches Observations::median_price_q64", () => {
    let some = 0;
    for (const c of V.median) {
      const samples = c.samples.map((x: { ts: string; price: string; fallback: boolean }) => ({ ts: BigInt(x.ts), priceQ64: BigInt(x.price), fallback: x.fallback }));
      const got = medianPriceQ64(samples, BigInt(c.now), BigInt(c.window), c.min);
      expect(got).toBe(B(c.median));
      if (got !== null) some++;
    }
    expect(some).toBeGreaterThan(0);
  });
});

describe("rewards (instructions/rewards/logic.rs)", () => {
  const reasonMap: Record<string, string> = { Creator: "creator", NotMatured: "not-matured", TooManyOpenTickets: "max-open" };
  it("plan_sell", () => {
    for (const c of V.rewards.planSell) {
      const got = planSell(
        { matured: BigInt(c.matured), pending: BigInt(c.pending), pendingSince: BigInt(c.pendingSince), openCount: c.openCount, lastBalance: BigInt(c.lastBalance) },
        DEFAULT_PARAMS,
        c.isCreator,
        BigInt(c.sold),
        BigInt(c.balance),
        BigInt(c.now),
      );
      if (c.tokens !== null) expect(got).toEqual({ tokens: BigInt(c.tokens) });
      else expect(got).toEqual({ reason: reasonMap[c.reason] });
    }
  });
  it("plan_rebuy", () => {
    for (const c of V.rewards.planRebuy) {
      const tickets = c.tickets.map((t: Record<string, string>) => ({ sellTs: BigInt(t.sellTs), seq: BigInt(t.seq), tokens: BigInt(t.tokens), status: t.status }));
      expect(planRebuy(tickets, BigInt(c.amount), BigInt(c.now), BigInt(c.window))).toEqual(c.debits.map(BigInt));
    }
  });
  it("claim amount / cap / fits", () => {
    for (const c of V.rewards.claims) {
      expect(claimAmount(BigInt(c.tokens), 1_000)).toBe(BigInt(c.claimAmount));
      expect(claimCap(BigInt(c.pool), 1_000)).toBe(BigInt(c.claimCap));
      expect(fits(BigInt(c.claimAmount), BigInt(c.pool), 1_000)).toBe(c.fits);
    }
  });
  it("lamports_to_usd_cents (pyth.rs)", () => {
    for (const c of V.rewards.usdCents) expect(lamportsToUsdCents(BigInt(c.lamports), BigInt(c.price), c.exponent)).toBe(B(c.cents));
  });
});

describe("snipe tax (math/fees.rs, D19)", () => {
  it("schedule by slot", () => {
    for (const c of V.snipe.schedule) {
      const cfg = { launchSlot: BigInt(c.launchSlot), windowSlots: c.windowSlots, startBps: c.startBps };
      expect(snipeTaxBps(cfg, BigInt(c.slot))).toBe(c.bps);
    }
    const def = { launchSlot: 100n, windowSlots: DEFAULT_PARAMS.snipeWindowSlots, startBps: DEFAULT_PARAMS.snipeStartBps };
    expect([100n, 101n, 102n, 103n, 104n].map((s) => snipeTaxBps(def, s))).toEqual([9_900, 7_500, 5_000, 2_500, 0]);
  });
  it("sol_in split and tax", () => {
    for (const c of V.snipe.split) {
      expect(snipeCurveOffer(BigInt(c.solIn), c.bps)).toBe(BigInt(c.offer));
      expect(snipeTax(BigInt(c.used), c.bps)).toBe(B(c.tax));
    }
  });
  it("taxed curve buys (quoteCurveBuy) match the program", () => {
    for (const c of V.snipe.buys) {
      const r = res(c.reserves);
      // A budget whose solInForBudget is exactly c.solIn: solIn + fee(solIn).
      const budget = BigInt(c.solIn) + computeFee(BigInt(c.solIn), DEFAULT_PARAMS).total;
      const q = quoteCurveBuy(r, DEFAULT_PARAMS, budget, c.bps)!;
      expect(q.solIn).toBe(BigInt(c.solIn));
      expect([q.solUsed, q.tokensOut, q.fee.total, q.snipeTax, q.poolTokensBought]).toEqual(
        [c.solUsed, c.tokensOut, c.feeTotal, c.tax, c.poolTokensBought].map(BigInt),
      );
      expect(q.totalCost).toBeLessThanOrEqual(budget);
    }
  });
});
