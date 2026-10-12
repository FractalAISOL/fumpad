/**
 * Mock wallet ledgers for the portfolio tabs: the FUMPAD trades and fumble payouts each
 * wallet made, and what its token accounts hold. The demo wallet's ledger is hand-authored
 * around its tickets (every ticket's sell is a trade here, at the ticket's fill), so the
 * Positions, Closed and Tickets tabs tell one story. Other wallets get a deterministic
 * ledger built around their generated tickets.
 *
 * The math mirrors services/api/src/portfolio.ts (average cost; payouts at zero cost)
 * in floats, which is fine for display.
 */
import { PARAMS } from "../chain";
import { mintAddress } from "./rng";
import {
  COIN_SPECS,
  type CoinSpec,
  DAY,
  DEMO_TICKETS,
  DEMO_WALLET,
  EPOCH,
  HOUR,
  SPEC_BY_SYMBOL,
  between,
  creatorOf,
  generatedTickets,
  medianOf,
  priceAt,
  rng,
  ticketSellPrice,
} from "./world";

const FEE = PARAMS.feeBps / 10_000;

export interface MockEntry {
  kind: "buy" | "sell" | "payout";
  symbol: string;
  tokens: number;
  /** SOL paid (buy, fee included) or received (sell, after fee). */
  sol: number;
  ts: number;
}

const buyAt = (symbol: string, tokens: number, ts: number, price = priceAt(symbol, ts)): MockEntry => ({ kind: "buy", symbol, tokens, sol: tokens * price * (1 + FEE), ts });
const sellAt = (symbol: string, tokens: number, ts: number, price = priceAt(symbol, ts)): MockEntry => ({ kind: "sell", symbol, tokens, sol: tokens * price * (1 - FEE), ts });

const d = (month: number, day: number, h = 12, m = 0) => Date.UTC(2026, month - 1, day, h, m);

/** The demo wallet: every DEMO_TICKETS sell, the buys that funded them, a payout and a few holds. */
function demoLedger(): MockEntry[] {
  const t = (sym: string) => DEMO_TICKETS.find((x) => x.symbol === sym)!;
  const fill = (sym: string) => {
    const tk = t(sym);
    const p = ticketSellPrice(tk);
    return tk.floorApplied ? p * 0.94 : p;
  };
  return [
    // MIDC: bought twice, sold 4.2M into a ticket that's now claimable; still holding 6.12M.
    buyAt("MIDC", 8_000_000, d(8, 15, 10, 5)),
    buyAt("MIDC", 2_320_000, d(8, 17, 16, 40)),
    sellAt("MIDC", 4_200_000, t("MIDC").sellTs, fill("MIDC")),
    // COPE: partly sold (the ticket's floor applied, so the fill sits under the ticket price).
    buyAt("COPE", 3_000_000, d(8, 22, 9, 12)),
    sellAt("COPE", 1_850_000, t("COPE").sellTs, fill("COPE")),
    // GOBT: in and out, ticket queued.
    buyAt("GOBT", 2_600_000, d(8, 3, 14, 20)),
    sellAt("GOBT", 2_600_000, t("GOBT").sellTs, fill("GOBT")),
    // CRNE (curve): sold most of it; a ticket waits for graduation.
    buyAt("CRNE", 6_100_000, d(10, 2, 18, 30)),
    sellAt("CRNE", 5_100_000, t("CRNE").sellTs, fill("CRNE")),
    // FRGA: closed.
    buyAt("FRGA", 900_000, d(7, 20, 11, 0)),
    sellAt("FRGA", 900_000, t("FRGA").sellTs, fill("FRGA")),
    // PIGN (curve): bought, sold most.
    buyAt("PIGN", 4_000_000, d(10, 9, 8, 15)),
    sellAt("PIGN", 3_300_000, t("PIGN").sellTs, fill("PIGN")),
    // WBSC: sold 3M, rebought 1.2M inside the rebuy window (the ticket shows the debit).
    buyAt("WBSC", 3_000_000, d(9, 24, 13, 0)),
    sellAt("WBSC", 3_000_000, t("WBSC").sellTs, fill("WBSC")),
    buyAt("WBSC", 1_200_000, d(10, 3, 9, 45)),
    // TOAD: sold, then the ticket paid out 10% — the payout is still in the wallet.
    buyAt("TOAD", 1_500_000, d(7, 30, 12, 0)),
    sellAt("TOAD", 1_500_000, t("TOAD").sellTs, fill("TOAD")),
    { kind: "payout", symbol: "TOAD", tokens: Math.round(1_500_000 * (PARAMS.claimBps / 10_000)), sol: 0, ts: t("TOAD").claimedAt! },
    // LGRN: closed; the coin faded afterwards (the ticket expired).
    buyAt("LGRN", 7_400_000, d(7, 8, 16, 0)),
    sellAt("LGRN", 7_400_000, t("LGRN").sellTs, fill("LGRN")),
    // CWCT: a plain hold.
    buyAt("CWCT", 800_000, d(9, 12, 20, 10)),
  ];
}

/** Tokens that reached the demo wallet outside FUMPAD (a transfer in). */
const DEMO_EXTERNAL: Record<string, number> = { WBSC: 500_000 };

/** Any other wallet: a buy before each generated ticket's sell, plus a few holds and round trips. */
function generatedLedger(owner: string): { entries: MockEntry[]; external: Record<string, number> } {
  const r = rng("ledger:" + owner);
  const entries: MockEntry[] = [];
  const external: Record<string, number> = {};
  const used = new Set<string>();
  for (const tk of generatedTickets(owner)) {
    const c = SPEC_BY_SYMBOL.get(tk.symbol)!;
    used.add(tk.symbol);
    const sellPrice = medianOf(c) / tk.multiple;
    const extra = r() < 0.5 ? Math.round((tk.originalTokens * between(r, 0.1, 0.9)) / 1e4) * 1e4 : 0;
    const buyTs = Math.floor(between(r, Math.max(c.createdAt, tk.sellTs - 20 * DAY), tk.sellTs - HOUR));
    entries.push(buyAt(tk.symbol, tk.originalTokens + extra, buyTs), sellAt(tk.symbol, tk.originalTokens, tk.sellTs, sellPrice));
  }
  const others = COIN_SPECS.filter((c) => !used.has(c.symbol) && c.createdAt < EPOCH - 2 * HOUR && creatorOf(c) !== owner);
  const n = 2 + Math.floor(r() * 3);
  for (let i = 0; i < n && others.length; i++) {
    const c = others.splice(Math.floor(r() * others.length), 1)[0];
    const tokens = Math.round((between(r, 0.3, 5) * 1e6) / 1e4) * 1e4;
    const t0 = Math.floor(between(r, c.createdAt + 10 * 60_000, EPOCH - HOUR));
    entries.push(buyAt(c.symbol, tokens, t0));
    if (r() < 0.45) entries.push(sellAt(c.symbol, tokens, Math.floor(between(r, t0 + 10 * 60_000, EPOCH - 10 * 60_000))));
    else if (r() < 0.25) external[c.symbol] = Math.round((tokens * between(r, 0.2, 1)) / 1e4) * 1e4;
  }
  return { entries, external };
}

const cache = new Map<string, { entries: MockEntry[]; external: Record<string, number> }>();

/** The wallet's authored or generated ledger (without this session's trades). */
export function baseLedger(owner: string): { entries: MockEntry[]; external: Record<string, number> } {
  let hit = cache.get(owner);
  if (!hit) {
    hit = owner === DEMO_WALLET ? { entries: demoLedger(), external: DEMO_EXTERNAL } : generatedLedger(owner);
    cache.set(owner, hit);
  }
  return hit;
}

export interface MockBook {
  symbol: string;
  held: number;
  cost: number;
  bought: number;
  boughtSol: number;
  sold: number;
  soldSol: number;
  payout: number;
  realized: number;
  costOfSold: number;
  oversold: boolean;
  firstTs: number;
  lastTs: number;
}

/** Average-cost books per coin (services/api/src/portfolio.ts `buildBooks`, in floats). */
export function foldBooks(entries: MockEntry[]): Map<string, MockBook> {
  const books = new Map<string, MockBook>();
  for (const e of [...entries].sort((a, b) => a.ts - b.ts)) {
    let b = books.get(e.symbol);
    if (!b) {
      b = { symbol: e.symbol, held: 0, cost: 0, bought: 0, boughtSol: 0, sold: 0, soldSol: 0, payout: 0, realized: 0, costOfSold: 0, oversold: false, firstTs: e.ts, lastTs: e.ts };
      books.set(e.symbol, b);
    }
    b.firstTs = Math.min(b.firstTs, e.ts);
    b.lastTs = Math.max(b.lastTs, e.ts);
    if (e.tokens <= 0) continue;
    if (e.kind === "buy") {
      b.held += e.tokens;
      b.cost += e.sol;
      b.bought += e.tokens;
      b.boughtSol += e.sol;
    } else if (e.kind === "payout") {
      b.held += e.tokens;
      b.payout += e.tokens;
    } else {
      b.sold += e.tokens;
      b.soldSol += e.sol;
      const covered = Math.min(e.tokens, b.held);
      if (covered < e.tokens - 1e-6) b.oversold = true;
      if (covered <= 0) continue;
      const costOut = (b.cost * covered) / b.held;
      b.realized += (e.sol * covered) / e.tokens - costOut;
      b.costOfSold += costOut;
      b.cost -= costOut;
      b.held -= covered;
    }
  }
  return books;
}

/** `isClosed` from the API: dust next to what went through the wallet. */
export function isClosedBook(b: MockBook, balance: number): boolean {
  if (b.bought === 0 && b.payout === 0) return false;
  return balance < 1 || balance * 10_000 < b.bought + b.payout;
}

/** Creator fees for the mock's launched coins: 20% of the 1% fee on the coin's lifetime volume. */
export function mockCreatorFees(c: CoinSpec): { earned: number; withdrawn: number } {
  const r = rng("fees:" + c.symbol);
  const days = Math.max(0.05, (EPOCH - c.createdAt) / DAY);
  const lifetimeSol = (c.volume24hUsd / 152.4) * Math.min(Math.max(days, 1), 30) * between(r, 0.4, 0.9);
  const earned = lifetimeSol * (PARAMS.feeBps / 10_000) * (PARAMS.feeCreatorShareBps / 10_000);
  const withdrawn = c.status === "graduated" ? earned * between(r, 0.5, 0.8) : 0;
  return { earned, withdrawn };
}

export { mintAddress };
