// Port of instructions/rewards/logic.rs + hooks.rs::evaluate_sell (pure parts).
import { BPS_DENOM } from "../constants.js";
import { priceQ64 } from "./price.js";
import { ticketPriceQ64 } from "./reference.js";

export interface PositionLite {
  matured: bigint;
  pending: bigint;
  pendingSince: bigint;
  openCount: number;
  /** v0.3 R-L2: canonical-ATA balance at FUMPAD's last observation (0 on legacy positions). */
  lastBalance: bigint;
}

/** Position::observed_balance — never below what is tracked. */
export const observedBalance = (p: PositionLite) => max(p.lastBalance, p.matured + p.pending);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

export type NoTicket = "creator" | "not-matured" | "max-open" | "under-min" | "no-oracle" | "zero-price";

export function settle(pos: PositionLite, now: bigint, minHoldSecs: bigint): PositionLite {
  if (pos.pending > 0n && now - pos.pendingSince >= minHoldSecs) {
    return { ...pos, matured: pos.matured + pos.pending, pending: 0n };
  }
  return { ...pos };
}

/**
 * Ticket-eligible tokens if the wallet sold its whole `balance` now: unseen arrivals are
 * sold first (R-L2), the rest draws on matured credit.
 */
export function maturedNow(pos: PositionLite, balance: bigint, now: bigint, minHoldSecs: bigint): bigint {
  const r = planSell(pos, { minHoldSecs, maxOpenTickets: 255 }, false, balance, balance, now);
  return "tokens" in r ? r.tokens : 0n;
}

export function capTracked(pos: PositionLite, balance: bigint): PositionLite {
  const tracked = pos.matured + pos.pending;
  if (tracked <= balance) return { ...pos };
  let excess = tracked - balance;
  const fromMatured = excess < pos.matured ? excess : pos.matured;
  excess -= fromMatured;
  const pending = pos.pending > excess ? pos.pending - excess : 0n;
  return { ...pos, matured: pos.matured - fromMatured, pending };
}

/** logic::plan_sell — ticket candidate tokens or the reason there is none. */
export function planSell(
  pos: PositionLite,
  p: { minHoldSecs: bigint; maxOpenTickets: number },
  isCreator: boolean,
  tokensSold: bigint,
  balanceBefore: bigint,
  now: bigint,
): { tokens: bigint } | { reason: NoTicket } {
  const settled = settle(pos, now, p.minHoldSecs);
  const ob = observedBalance(settled);
  const unseen = balanceBefore > ob ? balanceBefore - ob : 0n;
  const s = capTracked(settled, balanceBefore);
  const trackedSold = tokensSold - (tokensSold < unseen ? tokensSold : unseen);
  const ticketTokens = trackedSold < s.matured ? trackedSold : s.matured;
  if (isCreator) return { reason: "creator" };
  if (ticketTokens === 0n) return { reason: "not-matured" };
  if (pos.openCount >= p.maxOpenTickets) return { reason: "max-open" };
  return { tokens: ticketTokens };
}

export interface RebuyView {
  sellTs: bigint;
  seq: bigint;
  tokens: bigint;
  /** "open" | "queued" | … */
  status: string;
}

/** logic::plan_rebuy — debit per ticket (input order), newest sell first. */
export function planRebuy(tickets: RebuyView[], amount: bigint, now: bigint, windowSecs: bigint): bigint[] {
  const debits = tickets.map(() => 0n);
  const order = tickets
    .map((t, i) => ({ t, i }))
    .filter(
      ({ t }) =>
        (t.status === "open" || t.status === "queued") && t.tokens > 0n && now >= t.sellTs && now - t.sellTs <= windowSecs,
    )
    .sort((a, b) => {
      if (a.t.sellTs !== b.t.sellTs) return a.t.sellTs > b.t.sellTs ? -1 : 1;
      if (a.t.seq !== b.t.seq) return a.t.seq > b.t.seq ? -1 : 1;
      return 0;
    });
  let left = amount;
  for (const { t, i } of order) {
    if (left === 0n) break;
    const d = left < t.tokens ? left : t.tokens;
    debits[i] = d;
    left -= d;
  }
  return debits;
}

export const claimAmount = (tokens: bigint, claimBps: number | bigint) => (tokens * BigInt(claimBps)) / BPS_DENOM;
export const claimCap = (pool: bigint, maxClaimPoolBps: number | bigint) => (pool * BigInt(maxClaimPoolBps)) / BPS_DENOM;
export const fits = (amount: bigint, pool: bigint, maxClaimPoolBps: number | bigint) =>
  amount > 0n && amount <= claimCap(pool, maxClaimPoolBps) && amount <= pool;

/** Smallest pool balance at which `amount` fits (amount ≤ pool × bps / 10_000). */
export function poolNeededFor(amount: bigint, maxClaimPoolBps: number | bigint): bigint {
  const bps = BigInt(maxClaimPoolBps);
  if (bps === 0n) return amount === 0n ? 0n : -1n;
  // smallest P with floor(P·bps/1e4) ≥ amount  ⇔  P ≥ ceil(amount·1e4 / bps)
  const need = (amount * BPS_DENOM + bps - 1n) / bps;
  return need > amount ? need : amount;
}

/** Pyth USD conversion (external/pyth.rs::lamports_to_usd_cents), rounded down. */
export function lamportsToUsdCents(lamports: bigint, price: bigint, exponent: number): bigint {
  const v = lamports * price;
  const e = exponent + 2 - 9;
  return e >= 0 ? v * 10n ** BigInt(e) : v / 10n ** BigInt(-e);
}

/** hooks::evaluate_sell ticket plan (oracle price passed in; `null` = oracle unusable). */
export function evaluateSell(args: {
  position: PositionLite;
  params: { minHoldSecs: bigint; maxOpenTickets: number; minSellUsdCents: bigint };
  isCreator: boolean;
  tokensSold: bigint;
  grossLamportsOut: bigint;
  balanceBefore: bigint;
  referencePriceQ64: bigint;
  preTradeSpotQ64: bigint;
  now: bigint;
  solUsd: { price: bigint; exponent: number } | null;
}):
  | { tokens: bigint; sellPriceQ64: bigint; sellUsdCents: bigint; executionQ64: bigint }
  | { reason: NoTicket; executionQ64: bigint | null; sellPriceQ64: bigint | null; usdCents: bigint | null; tokens: bigint } {
  const plan = planSell(args.position, args.params, args.isCreator, args.tokensSold, args.balanceBefore, args.now);
  const executionQ64 = priceQ64(args.grossLamportsOut, args.tokensSold);
  const sellPriceQ64 =
    executionQ64 && executionQ64 > 0n ? ticketPriceQ64(executionQ64, args.referencePriceQ64, args.preTradeSpotQ64) : null;
  const tokens = "tokens" in plan ? plan.tokens : 0n;
  const ticketLamports = args.tokensSold > 0n ? (args.grossLamportsOut * tokens) / args.tokensSold : 0n;
  const usdCents = args.solUsd ? lamportsToUsdCents(ticketLamports, args.solUsd.price, args.solUsd.exponent) : null;
  if ("reason" in plan) return { reason: plan.reason, executionQ64, sellPriceQ64, usdCents, tokens };
  if (!executionQ64 || !sellPriceQ64) return { reason: "zero-price", executionQ64, sellPriceQ64, usdCents, tokens };
  if (usdCents === null) return { reason: "no-oracle", executionQ64, sellPriceQ64, usdCents, tokens };
  if (usdCents < args.params.minSellUsdCents) return { reason: "under-min", executionQ64, sellPriceQ64, usdCents, tokens };
  return { tokens, sellPriceQ64, sellUsdCents: usdCents, executionQ64 };
}
