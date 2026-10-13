// Hand-checked engine cases: one per rule of SPEC v0.7 §5.4 / v0.6 §5.3.
import { describe, expect, it } from "vitest";

import { canonicalJson, constantPythSource, DEFAULT_ENGINE_PARAMS, runEngine, runEngineWithPrices, StaticPythSource, ticketPriceQ64 } from "../src/index.js";
import { A, B, coin, CREATOR, DAMM, SOL, SPOT0, SQRT0, Tape, usd150 } from "./helpers.js";

const one = (o: ReturnType<Tape["run"]>) => {
  expect(o.sells.length).toBeGreaterThan(0);
  return o.sells[o.sells.length - 1];
};

describe("hold time (10 min, pending/matured buckets)", () => {
  it("9:59 → no ticket, 10:00 → ticket for the whole sell", () => {
    const t = new Tape();
    t.buy(A, SOL);
    t.wait(599).sell(A, SOL / 2n);
    t.wait(1).sell(A, SOL / 2n);
    const o = t.run();
    expect(o.sells[0].reason).toBe("not_matured");
    // the first sell debited 512e9 pending; the rest matured at +600 s
    expect(o.sells[1].reason).toBe(null);
    expect(o.sells[1].ticket!.ticketTokens).toBe((SOL / 2n) * 1024n);
  });
  it("a new buy restarts the clock of the pending bucket only", () => {
    const t = new Tape();
    t.buy(A, SOL);
    t.wait(700).buy(A, SOL); // first lot matured at +600; second pending since +700
    t.wait(100).sell(A, 2n * SOL); // only the matured lot makes the ticket
    const s = one(t.run());
    expect(s.ticket!.ticketTokens).toBe(SOL * 1024n);
    expect(s.ticket!.usdCents).toBe(15_000n); // pro-rata: half of 2 SOL at $150
  });
});

describe("$50 minimum on the ticket's value (Pyth price − conf)", () => {
  it("exactly $50.00 qualifies, $49.95 doesn't", () => {
    const t = new Tape();
    t.buy(A, 10n * SOL);
    t.wait(600).sell(A, 333_333_334n);
    t.wait(1).sell(A, 333_000_000n);
    const o = t.run();
    expect(o.sells[0].ticket!.usdCents).toBe(5_000n);
    expect(o.sells[1].reason).toBe("below_minimum_usd");
  });
  it("uses the lower confidence bound", () => {
    const t = new Tape();
    t.buy(A, 10n * SOL);
    t.wait(600).sell(A, 333_333_334n);
    const s = one(t.run({}, (x) => ({ price: 150_00000000n, conf: 1_00000000n, expo: -8, publishTime: x - 5 })));
    expect(s.reason).toBe("below_minimum_usd"); // $149 × 0.3333 = $49.66
  });
  it("Pyth: greatest publish_time ≤ block time within 60 s, else no ticket", () => {
    const mk = (lag: number) => {
      const t = new Tape();
      t.buy(A, SOL);
      t.wait(600).sell(A, SOL);
      return one(t.run({}, (x) => ({ price: 150_00000000n, conf: 0n, expo: -8, publishTime: x - lag })));
    };
    expect(mk(60).reason).toBe(null);
    expect(mk(61).reason).toBe("oracle_unavailable");
    expect(mk(61).oracleIssue).toBe("stale");
    expect(mk(-1).oracleIssue).toBe("future");
    const t = new Tape();
    t.buy(A, SOL);
    t.wait(600).sell(A, SOL);
    expect(one(t.run({}, () => null)).oracleIssue).toBe("missing");
  });
  it("StaticPythSource picks the greatest publish_time ≤ block time", () => {
    const src = new StaticPythSource([
      { price: 1n, conf: 0n, expo: 0, publishTime: 100 },
      { price: 2n, conf: 0n, expo: 0, publishTime: 110 },
      { price: 3n, conf: 0n, expo: 0, publishTime: 120 },
    ]);
    expect(src.lookup(119)!.price).toBe(2n);
    expect(src.lookup(120)!.price).toBe(3n);
    expect(src.lookup(99)).toBe(null);
  });
});

describe("exclusions", () => {
  it("the creator never gets a ticket (position still debited)", () => {
    const t = new Tape();
    t.buy(CREATOR, SOL);
    t.wait(600).sell(CREATOR, SOL);
    expect(one(t.run()).reason).toBe("creator");
  });
  it("weak trader attribution → no ticket", () => {
    for (const src of ["base_owner_unsigned", "unknown"] as const) {
      const t = new Tape();
      t.buy(A, SOL);
      t.wait(600).sell(A, SOL, { traderSource: src });
      expect(one(t.run()).reason).toBe("trader_unverified");
    }
  });
  it("same-tx buy + sell by one wallet → no ticket", () => {
    const t = new Tape();
    t.buy(A, SOL);
    t.wait(600);
    t.sell(A, SOL / 2n, { signature: "bundle", ix: 0 });
    t.buy(A, SOL / 2n, { signature: "bundle", ix: 1 << 16 });
    const o = t.run();
    expect(o.sells[0].reason).toBe("same_tx_inflow");
  });
  it("a transfer IN in the same tx as a sell → no ticket", () => {
    const t = new Tape();
    t.buy(A, SOL);
    t.wait(600);
    t.transfer(A, 5n, { signature: "x" });
    t.sell(A, SOL, { signature: "x" });
    expect(one(t.run()).reason).toBe("same_tx_inflow");
  });
  it("non-WSOL quote → no ticket", () => {
    const t = new Tape();
    t.buy(A, SOL);
    t.wait(600).sell(A, SOL, { quoteMint: "EPjFWdd5AufqSSqeM2qiYZhq6tUykyLqVTsH3UAVebPq" });
    expect(one(t.run()).reason).toBe("quote_not_wsol");
  });
  it("swaps on third-party pools are not trades (they arrive as transfers)", () => {
    const t = new Tape();
    t.buy(A, SOL);
    t.wait(600).sell(A, SOL, { pool: "SomeOtherPoo11111111111111111111111111111111" });
    expect(t.run().sells).toEqual([]);
  });
});

describe("max open tickets", () => {
  it("5 open → the 6th sell gets none; a closed ticket frees a slot", () => {
    const t = new Tape();
    t.buy(A, 10n * SOL);
    t.wait(600);
    const refs: string[] = [];
    for (let i = 0; i < 6; i++) refs.push(t.wait(1).sell(A, SOL));
    const o = t.run();
    expect(o.sells.map((s) => s.reason)).toEqual([null, null, null, null, null, "too_many_open_tickets"]);
    t.wait(5);
    t.events.push({ kind: "ticket_status", key: { slot: t.slot, txIndex: -1, phase: 4, ixKey: 0 }, signature: "claim1", blockTime: t.t, ticket: { signature: refs[0], ixKey: 0 }, status: "claimed" });
    t.wait(1).sell(A, SOL);
    expect(t.run().sells.at(-1)!.reason).toBe(null);
  });
});

describe("rebuy rule (7 days, newest first, buys and transfers in)", () => {
  const twoTickets = () => {
    const t = new Tape();
    t.buy(A, 10n * SOL);
    t.wait(600);
    const s1 = t.sell(A, SOL);
    t.wait(10);
    const s2 = t.sell(A, SOL);
    return { t, s1, s2 };
  };
  it("a buy debits the newest ticket first and voids at 0", () => {
    const { t, s1, s2 } = twoTickets();
    t.wait(60).buy(A, SOL + SOL / 2n);
    const o = t.run();
    expect(o.rebuys.map((r) => [r.ticket.signature, r.debit, r.remaining, r.voided])).toEqual([
      [s1, 512n * SOL, 512n * SOL, false], // listed in ticket order; s2 (newest) was debited first
      [s2, 1024n * SOL, 0n, true],
    ]);
    expect(o.rebuys[0].kind).toBe("buy");
  });
  it("transfers in debit like buys; FUMPAD payouts don't", () => {
    const { t, s2 } = twoTickets();
    t.wait(60).transfer(A, 1000n, { payout: true });
    t.wait(60).transfer(A, 7n);
    const o = t.run();
    expect(o.rebuys.map((r) => [r.ticket.signature, r.debit, r.kind])).toEqual([[s2, 7n, "transfer_in"]]);
  });
  it("exactly 7 days later still debits, 7 days + 1 s doesn't", () => {
    const mk = (after: number) => {
      const t = new Tape();
      t.buy(A, 10n * SOL);
      t.wait(600).sell(A, SOL);
      t.wait(after).buy(A, SOL);
      return t.run().rebuys.length;
    };
    expect(mk(7 * 86_400)).toBe(1);
    expect(mk(7 * 86_400 + 1)).toBe(0);
  });
  it("a ticket voids when its claim amount rounds to 0 (apply_rebuy)", () => {
    const t = new Tape();
    t.buy(A, 10n * SOL);
    t.wait(600).sell(A, SOL);
    t.wait(5).buy(A, 0n, { signature: "zero" }); // no-op
    t.wait(5).swap("buy", A, 1024n * SOL - 9n, 1n);
    const o = t.run();
    expect(o.rebuys.at(-1)!.remaining).toBe(9n);
    expect(o.rebuys.at(-1)!.voided).toBe(true); // claim_amount(9) = 0
  });
});

describe("transfers out", () => {
  it("remove matured credit first", () => {
    const t = new Tape();
    t.buy(A, SOL); // matures at +600
    t.wait(600).buy(A, SOL); // pending
    t.wait(1).transfer(A, -1024n * SOL); // removes the matured lot
    t.wait(1).sell(A, SOL);
    expect(one(t.run()).reason).toBe("not_matured");
  });
  it("received tokens become pending: no ticket on an immediate sell, a ticket after 10 min", () => {
    const t = new Tape();
    t.transfer(B, 1024n * SOL);
    t.wait(10).sell(B, SOL / 2n);
    t.wait(600).sell(B, SOL / 2n);
    const o = t.run();
    expect(o.sells.map((s) => s.reason)).toEqual(["not_matured", null]);
  });
  it("negative balance (missing history) fails closed", () => {
    const t = new Tape();
    t.buy(A, SOL);
    t.wait(600).transfer(A, -2048n * SOL);
    t.wait(1).sell(A, SOL);
    const o = t.run();
    expect(o.issues[0].kind).toBe("negative_balance");
    expect(one(o).reason).toBe("history_inconsistent");
  });
  it("parser issue on our pool fails closed for the rest of the history", () => {
    const t = new Tape();
    t.buy(A, SOL);
    t.wait(600);
    t.events.push({ kind: "parse_issue", key: { slot: t.slot, txIndex: -1, phase: 2, ixKey: 0 }, signature: "bad", blockTime: t.t, code: "vault_mismatch", message: "x" });
    t.wait(1).sell(A, SOL);
    expect(one(t.run()).reason).toBe("history_inconsistent");
  });
});

describe("D10 reference + D12 floor", () => {
  it("flat market: ticket price = execution price", () => {
    const t = new Tape();
    t.buy(A, SOL);
    t.wait(600).sell(A, SOL);
    const s = one(t.run());
    expect(s.ticket!.executionQ64).toBe(SPOT0);
    expect(s.ticket!.ticketPriceQ64).toBe(SPOT0);
  });
  it("crash staged inside one bundle can't lower the price (zero weight, floor ≈ reference)", () => {
    const t = new Tape();
    t.buy(A, SOL);
    t.buy(B, 100n * SOL);
    t.wait(1200);
    // B dumps (spot → 1/20), A sells 1% under the crashed spot, B rebuys — all in one slot / second.
    const crashSqrt = SQRT0 / 4n; // spot ÷ 16 (≈ the 20x crash of the Rust test)
    t.swap("sell", B, 100n * 1024n * SOL, 50n * SOL, { nextSqrtPrice: crashSqrt, ix: 0, signature: "bundle1" });
    const crashed = SPOT0 / 16n;
    const sellBase = 1024n * SOL;
    const sellQuote = ((sellBase * crashed) >> 64n) * 99n / 100n;
    t.swap("sell", A, sellBase, sellQuote, { nextSqrtPrice: crashSqrt, ix: 0, signature: "bundle2", txIndex: 1 });
    const s = t.run({}, (x) => ({ price: 3000_00000000n, conf: 0n, expo: -8, publishTime: x }));
    const a = s.sells.find((x) => x.signature === "bundle2")!;
    expect(a.ticket!.referenceQ64).toBe(SPOT0); // the crash got zero weight
    expect(a.ticket!.ticketPriceQ64).toBe(ticketPriceQ64(a.ticket!.executionQ64, SPOT0, crashed));
    expect(a.ticket!.ticketPriceQ64 * 100n >= SPOT0 * 98n).toBe(true);
  });
  it("first DAMM v2 swap's pre-trade spot = the pool's opening price", () => {
    const t = new Tape();
    t.buy(A, SOL);
    t.wait(600);
    t.events.push({ kind: "pool_init", key: { slot: t.slot, txIndex: -1, phase: 2, ixKey: 0 }, signature: "mig", blockTime: t.t, pool: DAMM, sqrtPrice: SQRT0 * 2n });
    t.wait(30).sell(A, SOL, { pool: DAMM, venue: "damm_v2", nextSqrtPrice: SQRT0 * 2n });
    const s = one(t.run());
    expect(s.ticket!.preSpotQ64).toBe(SPOT0 * 4n);
    expect(s.venue).toBe("damm_v2");
  });
});

describe("prices on demand and determinism", () => {
  it("asks for missing prices, then completes", async () => {
    const t = new Tape();
    t.buy(A, SOL);
    t.wait(600).sell(A, SOL);
    const r = runEngine(coin(), t.events, DEFAULT_ENGINE_PARAMS, () => undefined);
    expect(r.done).toBe(false);
    if (!r.done) expect(r.missingPrices).toEqual([t.t]);
    const src = constantPythSource(150_00000000n, 0n, -8);
    const o = await runEngineWithPrices(coin(), t.events, DEFAULT_ENGINE_PARAMS, (x) => src.priceAt(x, 60));
    expect(o.sells[0].ticket!.usdCents).toBe(15_000n);
  });
  it("input order doesn't matter; output is canonical", () => {
    const t = new Tape();
    t.buy(A, 3n * SOL);
    t.buy(B, 2n * SOL);
    t.wait(700).sell(A, SOL);
    t.wait(5).sell(B, SOL);
    t.wait(5).buy(A, SOL / 3n);
    const a = canonicalJson(t.run());
    t.events.reverse();
    expect(canonicalJson(t.run())).toBe(a);
    expect(canonicalJson(runEngine(coin(), t.events, DEFAULT_ENGINE_PARAMS, usd150))).toContain('"done":true');
  });
});
