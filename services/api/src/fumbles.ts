/**
 * Fumble Checker (`GET /v1/wallets/:wallet/fumbles`): a wallet's sells of a coin, each with its ticket conditions
 * (≥ the USD minimum at the trade-time SOL price, held ≥ the hold time, not the creator), its ticket when the
 * keepers attested one, and the claim target (the market cap at `triggerMultiple` × the ticket price).
 *
 * The keepers' engine (`@fumpad/engine`, complete history incl. wallet transfers and the Pyth price at the block)
 * decides tickets. A sell WITH a ticket is reported as attested (every condition met, the attested USD value).
 * For a sell WITHOUT one, this module re-derives the usual reasons from indexed trades with the engine's own hold
 * rules (`observeBuy` / `planSell`); what indexed data can't decide (tokens that arrived by transfer) is "unknown".
 * Pure: no DB, unit-tested in `test/fumbles.test.ts`.
 */
import { newHold, observeBuy, planSell } from "@fumpad/engine";

import type { ClaimTarget, FumbleSell, SellCheck, SellNoTicketReason, Ticket, Venue } from "./generated/app-types.js";

/** One indexed trade (or payout) of the wallet on the coin, in chain order. */
export interface WalletEvent {
  kind: "buy" | "sell" | "inflow";
  signature: string;
  /** trades.idx = the swap's ix_key; payouts: the event index. */
  ixKey: number;
  slot: number;
  /** unix seconds */
  ts: number;
  /** base units (6 decimals) */
  base: bigint;
  /** lamports (sells: SOL out before the fee) */
  lamports: bigint;
  venue?: string | null;
  app?: string | null;
  routed?: boolean | null;
}

/** A ticket of the wallet on the coin, with the keys of the sell it was attested for. */
export interface AttestedTicket {
  ticket: Ticket;
  sellSignature: string | null;
  sellIxKey: number | null;
  /** The ticket's own sell size (attestation fields), base units / lamports, for tickets whose trade isn't indexed. */
  baseAmount?: bigint;
}

export interface AssessParams {
  minSellUsd: number;
  minHoldSecs: bigint;
  maxOpenTickets: number;
  triggerMultiple: number;
  claimBps: number;
  totalSupply: number;
  /** A sell older than this without a ticket can no longer be attested (Params.max_attest_age_secs). */
  maxAttestAgeSecs: number;
}

export interface AssessInput {
  isCreator: boolean;
  events: readonly WalletEvent[];
  tickets: readonly AttestedTicket[];
  params: AssessParams;
  /** USD per SOL at a unix second, and where it came from (an attested sell within an hour, else today's price). */
  usdPerSol: (ts: number) => { rate: number; basis: "nearby" | "current" };
  /** unix seconds */
  now: number;
}

const tok = (v: bigint) => Number(v) / 1e6;
const lam = (v: bigint) => Number(v) / 1e9;
const key = (sig: string, ix: number) => `${sig}:${ix}`;
const venueOf = (v: string | null | undefined): Venue | undefined => (v === "damm_v2" || v === "damm" ? "damm" : v === "dbc" ? "dbc" : undefined);

export function claimTarget(sellPrice: number, claimTokens: number, estimated: boolean, p: Pick<AssessParams, "triggerMultiple" | "totalSupply">): ClaimTarget {
  const targetPrice = sellPrice * p.triggerMultiple;
  return {
    sellPrice,
    estimated,
    targetPrice,
    targetMarketCapSol: targetPrice * p.totalSupply,
    claimTokens,
    claimValueSolAtTarget: claimTokens * targetPrice,
  };
}

/** The wallet's sells of one coin, newest first. */
export function assessSells(input: AssessInput): FumbleSell[] {
  const { params: p, now } = input;
  const byKey = new Map<string, AttestedTicket>();
  const unmatched = new Set<AttestedTicket>();
  for (const t of input.tickets) {
    if (t.sellSignature !== null && t.sellIxKey !== null) byKey.set(key(t.sellSignature, t.sellIxKey), t);
    unmatched.add(t);
  }
  const buysInTx = new Set(input.events.filter((e) => e.kind === "buy").map((e) => e.signature));
  const ordered = [...input.events].sort((a, b) => a.slot - b.slot || (a.kind === "sell" ? 1 : 0) - (b.kind === "sell" ? 1 : 0) || a.ixKey - b.ixKey);
  const hold = newHold();
  const holdParams = { minHoldSecs: p.minHoldSecs, maxOpenTickets: Number.MAX_SAFE_INTEGER };
  let balance = 0n;
  /** Tickets the wallet had open on the coin before each sell (attested ones count from their sell). */
  let openTickets = 0;
  const out: FumbleSell[] = [];

  for (const e of ordered) {
    const now_ = BigInt(e.ts);
    if (e.kind !== "sell") {
      observeBuy(hold, holdParams, e.base, balance, now_);
      balance += e.base;
      continue;
    }
    // Tokens sold beyond what indexed trades explain arrived some other way (a transfer): the keepers see it,
    // this view doesn't, so those tokens never count here (planSell treats them as unseen).
    const unseen = e.base > balance;
    const plan = planSell(hold, holdParams, false, e.base, unseen ? e.base : balance, now_);
    balance = balance > e.base ? balance - e.base : 0n;
    const counted = plan.ok ? plan.tokens : 0n;
    const attested = byKey.get(key(e.signature, e.ixKey));
    if (attested) unmatched.delete(attested);
    const base: Omit<FumbleSell, "usd" | "usdBasis" | "countedTokens" | "checks" | "outcome"> = {
      signature: e.signature,
      ixKey: e.ixKey,
      ts: e.ts * 1000,
      venue: venueOf(e.venue),
      app: e.routed ? "fumpad" : (e.app ?? undefined),
      tokens: tok(e.base),
      sol: lam(e.lamports),
    };
    if (attested) {
      out.push(fromTicket(base, attested.ticket, p));
      if (isOpen(attested.ticket)) openTickets++;
      continue;
    }
    const { rate, basis } = input.usdPerSol(e.ts);
    const countedLamports = counted > 0n ? (e.lamports * counted) / e.base : e.lamports;
    const usd = lam(countedLamports) * rate;
    const holdCheck: SellCheck = counted > 0n ? "ok" : unseen ? "unknown" : "fail";
    const usdCheck: SellCheck = usd >= p.minSellUsd ? "ok" : "fail";
    const creatorCheck: SellCheck = input.isCreator ? "fail" : "ok";
    let reason: SellNoTicketReason | undefined;
    if (input.isCreator) reason = "creator";
    else if (buysInTx.has(e.signature)) reason = "same_tx_buy";
    else if (holdCheck === "fail") reason = "not_matured";
    else if (usdCheck === "fail" && holdCheck === "ok") reason = "below_minimum_usd";
    else if (holdCheck === "ok" && openTickets >= p.maxOpenTickets) reason = "too_many_open_tickets";
    const sell: FumbleSell = { ...base, usd, usdBasis: basis, countedTokens: tok(counted), checks: { usd: usdCheck, hold: holdCheck, creator: creatorCheck }, outcome: "no-ticket" };
    if (!reason && usdCheck === "fail") reason = "below_minimum_usd";
    if (reason) {
      out.push({ ...sell, reason });
      continue;
    }
    // Every condition met (or the hold is undecidable here): the keepers attest it within the attestation window.
    if (now - e.ts <= p.maxAttestAgeSecs) {
      const priceEst = counted > 0n || e.base > 0n ? lam(e.lamports) / tok(e.base) : 0;
      const claimTokens = (tok(counted > 0n ? counted : e.base) * p.claimBps) / 10_000;
      out.push({ ...sell, outcome: "verifying", target: priceEst > 0 ? claimTarget(priceEst, claimTokens, true, p) : undefined });
    } else out.push({ ...sell, reason: "not_attested" });
  }

  // Tickets whose sell trade isn't indexed (yet): shown from the attestation alone.
  for (const t of unmatched) {
    const tk = t.ticket;
    out.push(
      fromTicket(
        {
          signature: tk.sellSignature ?? t.sellSignature ?? "",
          ixKey: t.sellIxKey ?? undefined,
          ts: tk.sellTs,
          venue: undefined,
          app: tk.source === "router" ? "fumpad" : tk.app,
          tokens: t.baseAmount !== undefined ? tok(t.baseAmount) : tk.originalTokens,
          sol: tk.sellSol,
        },
        tk,
        p,
      ),
    );
  }
  return out.sort((a, b) => b.ts - a.ts || (b.ixKey ?? 0) - (a.ixKey ?? 0));
}

const isOpen = (t: Ticket) => t.chainStatus === "open" || t.chainStatus === "queued";

function fromTicket(base: Omit<FumbleSell, "usd" | "usdBasis" | "countedTokens" | "checks" | "outcome">, t: Ticket, p: AssessParams): FumbleSell {
  // Fixed at queue entry / payout; otherwise claimBps of what the ticket holds now (after rebuy debits).
  const claimTokens = t.claimAmount;
  return {
    ...base,
    usd: t.sellUsd,
    usdBasis: "attested",
    countedTokens: t.originalTokens,
    checks: { usd: "ok", hold: "ok", creator: "ok" },
    outcome: "ticket",
    ticket: t,
    target: claimTarget(t.sellPrice, claimTokens, false, p),
  };
}

/** Nearest attested USD/SOL rate (ticket usd_cents ÷ lamports) within `windowSecs`, else the current SOL price. */
export function usdRateFrom(samples: readonly { ts: number; rate: number }[], current: number, windowSecs = 3_600) {
  return (ts: number): { rate: number; basis: "nearby" | "current" } => {
    let best: { ts: number; rate: number } | undefined;
    for (const s of samples) {
      if (!(s.rate > 0) || Math.abs(s.ts - ts) > windowSecs) continue;
      if (!best || Math.abs(s.ts - ts) < Math.abs(best.ts - ts)) best = s;
    }
    return best ? { rate: best.rate, basis: "nearby" } : { rate: current, basis: "current" };
  };
}
