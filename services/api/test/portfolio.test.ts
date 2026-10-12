import { describe, expect, it } from "vitest";

import { assemble, buildBooks, evaluate, isClosed, type LedgerEntry, type PortfolioCoinRow } from "../src/portfolio.js";

const T = 1_000_000n; // one whole token in base units
const S = 1_000_000_000n; // one SOL in lamports
let slot = 0;
const e = (kind: LedgerEntry["kind"], tokens: bigint, lamports: bigint, mint = "M1", ts = ++slot): LedgerEntry => ({ kind, mint, tokens, lamports, ts, slot: ts, idx: 0 });
const coin = (mint: string, price: number): PortfolioCoinRow => ({ mint, symbol: mint, name: mint, tile: 0, status: "graduated", curveSol: 85, graduationSol: 85, price });

describe("average-cost books", () => {
  it("buys average, sells realize against the running average", () => {
    const b = buildBooks([e("buy", 100n * T, 1n * S), e("buy", 100n * T, 3n * S), e("sell", 50n * T, 2n * S)]).get("M1")!;
    // avg 0.02 SOL/token; 50 sold cost 1 SOL, received 2 → +1 realized
    expect(b.held).toBe(150n * T);
    expect(b.cost).toBe(3n * S);
    expect(b.realized).toBe(1n * S);
    expect(b.costOfSold).toBe(1n * S);
    expect(b.oversold).toBe(false);
  });

  it("orders by chain position, not input order", () => {
    const sell = { ...e("sell", 10n * T, 1n * S), slot: 50, ts: 50 };
    const buy = { ...e("buy", 10n * T, 2n * S), slot: 10, ts: 10 };
    const b = buildBooks([sell, buy]).get("M1")!;
    expect(b.held).toBe(0n);
    expect(b.realized).toBe(-1n * S);
  });

  it("fumble payouts arrive at zero cost and lower the average", () => {
    const b = buildBooks([e("buy", 100n * T, 2n * S), e("payout", 100n * T, 0n)]).get("M1")!;
    expect(b.held).toBe(200n * T);
    expect(b.cost).toBe(2n * S);
    expect(b.payout).toBe(100n * T);
  });

  it("a sell beyond the tracked tokens books only the tracked part and marks the book", () => {
    const b = buildBooks([e("buy", 10n * T, 1n * S), e("sell", 20n * T, 4n * S)]).get("M1")!;
    expect(b.held).toBe(0n);
    expect(b.realized).toBe(1n * S); // half the proceeds (2 SOL) − cost 1 SOL
    expect(b.oversold).toBe(true);
  });
});

describe("chain balance vs books", () => {
  const book = buildBooks([e("buy", 100n * T, 1n * S)]).get("M1")!;
  it("covers min(balance, tracked); more than tracked is partial", () => {
    expect(evaluate(book, 150n * T)).toEqual({ covered: 100n * T, coveredCost: 1n * S, partial: true });
    expect(evaluate(book, 40n * T)).toEqual({ covered: 40n * T, coveredCost: (4n * S) / 10n, partial: false });
    expect(evaluate(undefined, 5n * T)).toEqual({ covered: 0n, coveredCost: 0n, partial: true });
  });
  it("dust counts as closed", () => {
    expect(isClosed(book, 0n)).toBe(true);
    expect(isClosed(book, T / 2n)).toBe(true);
    expect(isClosed(book, 5n * T)).toBe(false);
  });
});

describe("assemble", () => {
  it("splits open and closed, values at spot, sorts by value / last trade", () => {
    const books = buildBooks([
      e("buy", 100n * T, 1n * S, "A", 1),
      e("buy", 100n * T, 1n * S, "B", 2),
      e("sell", 100n * T, 3n * S, "B", 3),
      e("buy", 10n * T, 1n * S, "C", 4),
    ]);
    const balances = new Map([
      ["A", 100n * T],
      ["C", 10n * T],
      ["X", 7n * T], // transferred in, never traded through FUMPAD
      ["NOTFUMPAD", 1n * T],
    ]);
    const coins = new Map([
      ["A", coin("A", 0.02)],
      ["B", coin("B", 0.05)],
      ["C", coin("C", 0.05)],
      ["X", coin("X", 1)],
    ]);
    const tickets = new Map([
      ["A", { earned: 2, open: 1, best: 4.2 }],
      ["B", { earned: 1, open: 0, best: null }],
    ]);
    const { positions, closed } = assemble(books, balances, coins, tickets);
    expect(positions.map((p) => p.mint)).toEqual(["X", "A", "C"]);
    const a = positions.find((p) => p.mint === "A")!;
    expect(a.valueSol).toBeCloseTo(2);
    expect(a.costSol).toBeCloseTo(1);
    expect(a.unrealizedSol).toBeCloseTo(1);
    expect(a.unrealizedPct).toBeCloseTo(100);
    expect(a.avgCost).toBeCloseTo(0.01);
    expect(a.bestMultiple).toBe(4.2);
    const x = positions.find((p) => p.mint === "X")!;
    expect(x.partialBasis).toBe(true);
    expect(x.unrealizedSol).toBeUndefined();
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ mint: "B", boughtSol: 1, soldSol: 3, realizedSol: 2, realizedPct: 200, ticketsEarned: 1, partialBasis: false });
  });

  it("without chain balances falls back to the tracked amounts", () => {
    const books = buildBooks([e("buy", 100n * T, 1n * S, "A", 1)]);
    const { positions } = assemble(books, null, new Map([["A", coin("A", 0.01)]]), new Map());
    expect(positions[0]).toMatchObject({ balance: 100, partialBasis: false });
  });

  it("a payout-only position has value but no P&L percentage", () => {
    const books = buildBooks([e("payout", 50n * T, 0n, "A", 1)]);
    const { positions } = assemble(books, new Map([["A", 50n * T]]), new Map([["A", coin("A", 0.1)]]), new Map());
    expect(positions[0]).toMatchObject({ valueSol: 5, costSol: 0, unrealizedSol: 5, payoutTokens: 50 });
    expect(positions[0].unrealizedPct).toBeUndefined();
  });
});
