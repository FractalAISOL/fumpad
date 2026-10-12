/**
 * Wallet portfolio math (average-cost method), in exact chain units: token base units
 * (6 decimals) and lamports, as bigint. Pure, so it is unit tested without a database.
 *
 *   buy     tokens += t, cost += SOL paid (fee included)
 *   payout  tokens += t at zero cost (a fumble claim)
 *   sell    the sold tokens leave at the running average cost; realized += SOL received
 *           (after the fee) − that cost. A sell larger than the tracked tokens (bought
 *           elsewhere, transferred in) only books the tracked part and marks the book partial.
 *
 * The chain balance then decides what is open: `evaluate` covers min(balance, tracked)
 * tokens with the average cost and marks the rest (balance beyond what FUMPAD explains)
 * as partial basis.
 */
import type { ClosedPosition, PortfolioCoin, WalletPosition } from "./generated/app-types.js";

export type LedgerKind = "buy" | "sell" | "payout";

export interface LedgerEntry {
  kind: LedgerKind;
  mint: string;
  /** Token base units. */
  tokens: bigint;
  /** Lamports: paid (buy, fee included) or received (sell, after fee); 0 for payouts. */
  lamports: bigint;
  /** Unix seconds. */
  ts: number;
  /** Chain order: slot, then the event index inside the transaction. */
  slot: number;
  idx: number;
}

export interface Book {
  mint: string;
  /** Tokens FUMPAD trades + payouts account for right now. */
  held: bigint;
  /** Cost of `held`, lamports. */
  cost: bigint;
  bought: bigint;
  boughtLamports: bigint;
  sold: bigint;
  soldLamports: bigint;
  payout: bigint;
  /** Realized P&L on the tracked part of sells, lamports (signed). */
  realized: bigint;
  /** Average cost of the tokens sold so far (tracked part), lamports. */
  costOfSold: bigint;
  /** A sell exceeded the tracked tokens. */
  oversold: boolean;
  buys: number;
  sells: number;
  firstTs: number;
  lastTs: number;
}

const byChainOrder = (a: LedgerEntry, b: LedgerEntry) => a.slot - b.slot || a.idx - b.idx || a.ts - b.ts;

/** Fold a wallet's ledger (any order) into one book per mint. */
export function buildBooks(entries: LedgerEntry[]): Map<string, Book> {
  const books = new Map<string, Book>();
  for (const e of [...entries].sort(byChainOrder)) {
    let b = books.get(e.mint);
    if (!b) {
      b = { mint: e.mint, held: 0n, cost: 0n, bought: 0n, boughtLamports: 0n, sold: 0n, soldLamports: 0n, payout: 0n, realized: 0n, costOfSold: 0n, oversold: false, buys: 0, sells: 0, firstTs: e.ts, lastTs: e.ts };
      books.set(e.mint, b);
    }
    b.firstTs = Math.min(b.firstTs, e.ts);
    b.lastTs = Math.max(b.lastTs, e.ts);
    if (e.tokens <= 0n) continue;
    if (e.kind === "buy") {
      b.held += e.tokens;
      b.cost += e.lamports;
      b.bought += e.tokens;
      b.boughtLamports += e.lamports;
      b.buys++;
    } else if (e.kind === "payout") {
      b.held += e.tokens;
      b.payout += e.tokens;
    } else {
      b.sells++;
      b.sold += e.tokens;
      b.soldLamports += e.lamports;
      const covered = e.tokens < b.held ? e.tokens : b.held;
      if (covered < e.tokens) b.oversold = true;
      if (covered === 0n) continue;
      const costOut = (b.cost * covered) / b.held;
      const proceeds = (e.lamports * covered) / e.tokens;
      b.realized += proceeds - costOut;
      b.costOfSold += costOut;
      b.cost -= costOut;
      b.held -= covered;
    }
  }
  return books;
}

export interface Evaluated {
  /** min(balance, held). */
  covered: bigint;
  /** Cost of the covered tokens, lamports. */
  coveredCost: bigint;
  /** The balance holds more than FUMPAD explains. */
  partial: boolean;
}

/** What the chain balance means for a book (no book: nothing covered, all partial). */
export function evaluate(book: Book | undefined, balance: bigint): Evaluated {
  if (!book || book.held <= 0n) return { covered: 0n, coveredCost: 0n, partial: balance > 0n };
  const covered = balance < book.held ? balance : book.held;
  return { covered, coveredCost: (book.cost * covered) / book.held, partial: balance > book.held };
}

/**
 * Fully exited: the chain balance is dust next to what went through the wallet
 * (< 1 whole token, or < 0.01% of bought + payouts).
 */
export function isClosed(book: Book, balance: bigint): boolean {
  if (book.buys === 0 && book.payout === 0n) return false;
  const through = book.bought + book.payout;
  return balance < 1_000_000n || balance * 10_000n < through;
}

/* ── Assembly into the app's types ─────────────────────────────────────────── */


export interface PortfolioCoinRow extends PortfolioCoin {
  /** Spot, SOL per token. */
  price: number;
}

export interface TicketStat {
  earned: number;
  open: number;
  best: number | null;
}

const TOK = 1e6;
const LAM = 1e9;

/**
 * Open positions and closed ones from a wallet's books, its chain balances (base units;
 * null = chain unavailable, fall back to what FUMPAD explains) and coin rows.
 */
export function assemble(
  books: Map<string, Book>,
  balances: Map<string, bigint> | null,
  coins: Map<string, PortfolioCoinRow>,
  tickets: Map<string, TicketStat>,
): { positions: WalletPosition[]; closed: ClosedPosition[] } {
  const positions: WalletPosition[] = [];
  const closed: ClosedPosition[] = [];
  const mints = new Set([...books.keys(), ...(balances?.keys() ?? [])]);
  for (const mint of mints) {
    const coin = coins.get(mint);
    if (!coin) continue; // not a FUMPAD coin
    const book = books.get(mint);
    const bal = balances ? (balances.get(mint) ?? 0n) : (book?.held ?? 0n);
    const t = tickets.get(mint);
    const ref: PortfolioCoin = {
      mint,
      symbol: coin.symbol,
      name: coin.name,
      tile: coin.tile,
      imageUrl: coin.imageUrl,
      status: coin.status,
      curveSol: coin.curveSol,
      graduationSol: coin.graduationSol,
    };
    if (book && isClosed(book, bal)) {
      const cost = Number(book.costOfSold) / LAM;
      const realized = Number(book.realized) / LAM;
      closed.push({
        ...ref,
        boughtTokens: Number(book.bought) / TOK,
        boughtSol: Number(book.boughtLamports) / LAM,
        soldTokens: Number(book.sold) / TOK,
        soldSol: Number(book.soldLamports) / LAM,
        payoutTokens: Number(book.payout) / TOK,
        realizedSol: realized,
        realizedPct: cost > 0 ? (realized / cost) * 100 : undefined,
        partialBasis: book.oversold,
        firstTs: book.firstTs * 1000,
        lastTs: book.lastTs * 1000,
        ticketsEarned: t?.earned ?? 0,
      });
      continue;
    }
    if (bal <= 0n) continue;
    const ev = evaluate(book, bal);
    const balance = Number(bal) / TOK;
    const covered = Number(ev.covered) / TOK;
    const cost = Number(ev.coveredCost) / LAM;
    const unrealized = covered > 0 ? covered * coin.price - cost : undefined;
    positions.push({
      ...ref,
      balance,
      price: coin.price,
      valueSol: balance * coin.price,
      trackedTokens: book ? Number(book.held) / TOK : 0,
      avgCost: book && book.held > 0n ? Number(book.cost) / LAM / (Number(book.held) / TOK) : 0,
      coveredTokens: covered,
      costSol: cost,
      unrealizedSol: unrealized,
      unrealizedPct: unrealized !== undefined && cost > 0 ? (unrealized / cost) * 100 : undefined,
      realizedSol: book ? Number(book.realized) / LAM : 0,
      partialBasis: ev.partial || !!book?.oversold,
      boughtTokens: book ? Number(book.bought) / TOK : 0,
      payoutTokens: book ? Number(book.payout) / TOK : 0,
      firstTs: book ? book.firstTs * 1000 : undefined,
      lastTs: book ? book.lastTs * 1000 : undefined,
      openTickets: t?.open ?? 0,
      bestMultiple: t && t.open > 0 && t.best !== null ? t.best : undefined,
    });
  }
  positions.sort((a, b) => b.valueSol - a.valueSol || a.symbol.localeCompare(b.symbol));
  closed.sort((a, b) => b.lastTs - a.lastTs);
  return { positions, closed };
}
