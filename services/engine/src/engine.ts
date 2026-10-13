/**
 * The deterministic eligibility engine (SPEC v0.7 §5.4). Pure and synchronous: the same events, coin
 * facts, params and prices always give byte-identical output (see canonical.ts).
 *
 * Model. With every finalized balance change of the mint known (our-pool swaps from @fumpad/meteora +
 * wallet transfers from token-balance metadata), each wallet's v0.6 `Position` is replayed with the
 * v0.6 rules ported bit-exact (rules/position.ts):
 *   buy on our pool        → rebuy debits on the wallet's tickets (apply_rebuy), then observe_buy
 *   transfer in            → same as a buy (v0.6: an acquisition outside FUMPAD needed
 *                            register_holdings = observe_buy + rebuy); FUMPAD payouts: observe_buy only
 *   transfer out           → settle, then cap_tracked to the new balance (matured removed first)
 *   sell on our pool       → plan_sell with the exact balance → ticket candidate; then D10/D12 price,
 *                            USD value (Pyth at block time) and the $ minimum (hooks::evaluate_sell)
 * D10 reference: one per coin, touched by every swap on the coin's DBC and DAMM v2 pools (any venue) as
 * an exact ("curve") touch — every price move of those pools is a swap we see. Spot = the swap's
 * post-swap sqrt price; pre-trade spot = the pool's previous post-swap spot (or its initial price).
 */
import { WSOL_MINT } from "@fumpad/meteora";

import { type HoldState, newHold, observeBuy, planRebuy, planSell, capTracked, settle, claimAmount } from "./rules/position.js";
import { priceQ64, spotFromSqrtQ64 } from "./rules/price.js";
import { newReference, type ReferencePrice, ticketPriceQ64, touch } from "./rules/reference.js";
import { lamportsToUsdCents, validateAt } from "./rules/usd.js";
import {
  type CoinFacts,
  type EngineEvent,
  type EngineIssue,
  type EngineOutput,
  type EngineParams,
  type NoTicketReason,
  type OrderKey,
  type PythLookup,
  type RebuyDebit,
  refKey,
  type SellDecision,
  type SwapEvent,
  type TicketRef,
  TRANSFER_IX_KEY,
} from "./types.js";

/** Trader attributions strong enough to attest (ATTESTATION.md §2.6). */
export const STRONG_TRADER_SOURCES: ReadonlySet<string> = new Set(["base_owner_signer", "signer_net_base"]);

export interface EngineOptions {
  /** Program-owned holders that are never wallets (buyback PDA, reward pool PDA, …). Swaps by them don't touch positions. */
  protocolOwners?: ReadonlySet<string>;
}

interface EngineTicket {
  ref: TicketRef;
  owner: string;
  seq: bigint;
  sellTs: bigint;
  tokens: bigint;
  active: boolean;
}

interface Wallet {
  hold: HoldState;
  balance: bigint;
  /** Engine tickets of this wallet, creation order. */
  tickets: EngineTicket[];
  nextSeq: bigint;
}

export function compareKeys(a: OrderKey, b: OrderKey): number {
  return a.slot - b.slot || a.txIndex - b.txIndex || a.phase - b.phase || a.ixKey - b.ixKey;
}

/** Sort events into the engine's total order (stable for equal keys, e.g. several transfers of one tx: by owner). */
export function sortEvents(events: readonly EngineEvent[]): EngineEvent[] {
  const tie = (e: EngineEvent) => (e.kind === "transfer" ? e.owner : e.kind === "ticket_status" ? refKey(e.ticket) : "");
  return [...events].sort((a, b) => compareKeys(a.key, b.key) || (tie(a) < tie(b) ? -1 : tie(a) > tie(b) ? 1 : 0));
}

export type EngineResult = { done: true; output: EngineOutput } | { done: false; missingPrices: number[] };

/**
 * Run the engine over a coin's complete, ordered history. If a sell needs a SOL/USD price that `pyth`
 * hasn't fetched yet (`undefined`), the result lists the block times to fetch; call again after.
 */
export function runEngine(coin: CoinFacts, events: readonly EngineEvent[], params: EngineParams, pyth: PythLookup, opts: EngineOptions = {}): EngineResult {
  const protocol = opts.protocolOwners ?? new Set<string>();
  const sorted = sortEvents(events);
  const holdParams = { minHoldSecs: params.minHoldSecs, maxOpenTickets: params.maxOpenTickets };

  // Same-tx rule: wallets with any acquisition (buy or non-payout transfer in) in a tx get no ticket
  // for their sells in that tx.
  const inflows = new Map<string, Set<string>>();
  const parseIssueTxs = new Set<string>();
  for (const e of sorted) {
    const w = e.kind === "swap" && e.side === "buy" ? e.trader : e.kind === "transfer" && e.delta > 0n && !e.payout ? e.owner : null;
    if (w) {
      const s = inflows.get(e.signature) ?? new Set<string>();
      s.add(w);
      inflows.set(e.signature, s);
    }
    if (e.kind === "parse_issue") parseIssueTxs.add(e.signature);
  }

  const wallets = new Map<string, Wallet>();
  const wallet = (w: string): Wallet => {
    let x = wallets.get(w);
    if (!x) {
      x = { hold: newHold(), balance: 0n, tickets: [], nextSeq: 0n };
      wallets.set(w, x);
    }
    return x;
  };
  const tickets = new Map<string, EngineTicket>();
  const pools = new Map<string, bigint>(); // pool → last post-swap spot (Q64)
  pools.set(coin.dbcPool, spotFromSqrtQ64(coin.startSqrtPrice) ?? 0n);
  let dammPool = coin.dammPool ?? null;
  let reference: ReferencePrice = newReference(pools.get(coin.dbcPool)!, BigInt(coin.launchBlockTime));

  const sells: SellDecision[] = [];
  const rebuys: RebuyDebit[] = [];
  const issues: EngineIssue[] = [];
  const missing = new Set<number>();
  let inconsistent = false;
  let lastKey: OrderKey | null = null;

  const issue = (e: EngineEvent, kind: EngineIssue["kind"], detail: string) => issues.push({ signature: e.signature, slot: e.key.slot, kind, detail });

  const rebuy = (w: string, x: Wallet, amount: bigint, e: EngineEvent, kind: RebuyDebit["kind"], ixKey: number) => {
    const live = x.tickets.filter((t) => t.active);
    if (!live.length || amount === 0n) return;
    const now = BigInt(e.blockTime);
    const debits = planRebuy(
      live.map((t) => ({ sellTs: t.sellTs, seq: t.seq, tokens: t.tokens, active: t.active })),
      amount,
      now,
      params.rebuyWindowSecs,
    );
    live.forEach((t, i) => {
      const d = debits[i];
      if (d === 0n) return;
      t.tokens -= d;
      const voided = t.tokens === 0n || claimAmount(t.tokens, params.claimBps) === 0n;
      if (voided) {
        t.active = false;
        x.hold.openCount -= 1;
      }
      rebuys.push({ signature: e.signature, ixKey, kind, slot: e.key.slot, blockTime: e.blockTime, wallet: w, ticket: t.ref, debit: d, remaining: t.tokens, voided });
    });
  };

  for (const e of sorted) {
    if (lastKey && compareKeys(lastKey, e.key) > 0) issue(e, "out_of_order", "events not in total order");
    lastKey = e.key;
    const now = BigInt(e.blockTime);
    switch (e.kind) {
      case "parse_issue": {
        inconsistent = true;
        issue(e, "parse_issue", `${e.code}: ${e.message}`);
        break;
      }
      case "pool_init": {
        if (dammPool && dammPool !== e.pool) {
          inconsistent = true;
          issue(e, "parse_issue", `second DAMM v2 pool ${e.pool} (known ${dammPool})`);
          break;
        }
        dammPool = e.pool;
        pools.set(e.pool, spotFromSqrtQ64(e.sqrtPrice) ?? 0n);
        break;
      }
      case "ticket_status": {
        const t = tickets.get(refKey(e.ticket));
        if (!t) {
          issue(e, "unknown_ticket_status", `${e.status} for unknown ticket ${refKey(e.ticket)}`);
          break;
        }
        if (t.active) {
          t.active = false;
          wallet(t.owner).hold.openCount -= 1;
        }
        break;
      }
      case "transfer": {
        if (protocol.has(e.owner)) break;
        const x = wallet(e.owner);
        if (e.delta > 0n) {
          if (!e.payout) rebuy(e.owner, x, e.delta, e, "transfer_in", TRANSFER_IX_KEY);
          observeBuy(x.hold, holdParams, e.delta, x.balance, now);
          x.balance += e.delta;
        } else {
          x.balance += e.delta;
          if (x.balance < 0n) {
            inconsistent = true;
            issue(e, "negative_balance", `${e.owner} balance ${x.balance}`);
            x.balance = 0n;
          }
          settle(x.hold, now, params.minHoldSecs);
          capTracked(x.hold, x.balance);
          x.hold.lastBalance = x.balance;
        }
        break;
      }
      case "swap": {
        if (e.pool !== coin.dbcPool && e.pool !== dammPool) break; // third-party pools: balances come via transfers
        const pre = pools.get(e.pool) ?? 0n;
        const post = spotFromSqrtQ64(e.nextSqrtPrice) ?? 0n;
        reference = touch(reference, now, pre, post, "curve");
        pools.set(e.pool, post);
        const w = e.trader;
        const counts = w !== null && !protocol.has(w);
        if (e.side === "buy") {
          if (!counts) break;
          const x = wallet(w);
          rebuy(w, x, e.baseAmount, e, "buy", e.key.ixKey);
          observeBuy(x.hold, holdParams, e.baseAmount, x.balance, now);
          x.balance += e.baseAmount;
          break;
        }
        // sell
        const d: SellDecision = {
          signature: e.signature,
          ixKey: e.key.ixKey,
          slot: e.key.slot,
          txIndex: e.key.txIndex,
          blockTime: e.blockTime,
          venue: e.venue,
          pool: e.pool,
          trader: w,
          baseAmount: e.baseAmount,
          quoteGross: e.quoteGross,
          ticket: null,
          reason: null,
        };
        sells.push(d);
        if (!counts) {
          d.reason = "trader_unverified";
          break;
        }
        const x = wallet(w);
        const balanceBefore = x.balance;
        x.balance -= e.baseAmount;
        if (x.balance < 0n) {
          inconsistent = true;
          issue(e, "negative_balance", `${w} sells ${e.baseAmount} holding ${balanceBefore}`);
          x.balance = 0n;
        }
        const plan = planSell(x.hold, holdParams, w === coin.creator, e.baseAmount, balanceBefore, now);
        const reason = decideSell(e, plan, { inconsistent, parseIssue: parseIssueTxs.has(e.signature), sameTxInflow: inflows.get(e.signature)?.has(w) ?? false });
        if (reason) {
          d.reason = reason;
          break;
        }
        const tokens = (plan as { tokens: bigint }).tokens;
        const executionQ64 = priceQ64(e.quoteGross, e.baseAmount);
        if (executionQ64 === null || executionQ64 === 0n) {
          d.reason = "zero_price";
          break;
        }
        const ticketPrice = ticketPriceQ64(executionQ64, reference.avgQ64, pre);
        const u = pyth(e.blockTime);
        if (u === undefined) {
          missing.add(e.blockTime);
          d.reason = "oracle_unavailable";
          d.oracleIssue = "not_fetched";
          break;
        }
        const v = validateAt(u, e.blockTime, params.maxPythDeltaSecs);
        if (!v.ok) {
          d.reason = "oracle_unavailable";
          d.oracleIssue = v.issue;
          break;
        }
        const ticketLamports = (e.quoteGross * tokens) / e.baseAmount;
        const cents = ticketLamports > (1n << 64n) - 1n ? null : lamportsToUsdCents(ticketLamports, v.usd);
        if (cents === null) {
          d.reason = "oracle_unavailable";
          d.oracleIssue = "overflow";
          break;
        }
        if (cents < params.minSellUsdCents) {
          d.reason = "below_minimum_usd";
          break;
        }
        d.ticket = {
          ticketTokens: tokens,
          ticketPriceQ64: ticketPrice,
          usdCents: cents,
          pythPublishTime: u!.publishTime,
          executionQ64,
          referenceQ64: reference.avgQ64,
          preSpotQ64: pre,
        };
        const t: EngineTicket = { ref: { signature: e.signature, ixKey: e.key.ixKey }, owner: w, seq: x.nextSeq, sellTs: now, tokens, active: true };
        x.nextSeq += 1n;
        x.tickets.push(t);
        x.hold.openCount += 1;
        tickets.set(refKey(t.ref), t);
        break;
      }
    }
  }

  if (missing.size) return { done: false, missingPrices: [...missing].sort((a, b) => a - b) };
  return { done: true, output: { mint: coin.mint, sells, rebuys, issues, reference: { ...reference }, lastKey } };
}

/**
 * Reasons that don't need the oracle, in precedence order. plan_sell's own refusals (creator,
 * not_matured, too_many_open_tickets) follow the engine-level ones; the position was debited either way.
 */
function decideSell(
  e: SwapEvent,
  plan: ReturnType<typeof planSell>,
  ctx: { inconsistent: boolean; parseIssue: boolean; sameTxInflow: boolean },
): NoTicketReason | null {
  if (ctx.inconsistent) return "history_inconsistent";
  if (ctx.parseIssue) return "parse_issue_in_tx";
  if (!STRONG_TRADER_SOURCES.has(e.traderSource)) return "trader_unverified";
  if (ctx.sameTxInflow) return "same_tx_inflow";
  if (e.quoteMint !== WSOL_MINT) return "quote_not_wsol";
  if (!plan.ok) return plan.reason;
  return null;
}

/** Drive `runEngine` with an async price source until every needed price is known. */
export async function runEngineWithPrices(
  coin: CoinFacts,
  events: readonly EngineEvent[],
  params: EngineParams,
  fetchPrice: (blockTime: number) => Promise<import("./rules/usd.js").PythPrice | null>,
  opts: EngineOptions & { cache?: Map<number, import("./rules/usd.js").PythPrice | null>; maxPasses?: number } = {},
): Promise<EngineOutput> {
  const cache = opts.cache ?? new Map();
  for (let pass = 0; pass < (opts.maxPasses ?? 50); pass++) {
    const r = runEngine(coin, events, params, (t) => cache.get(t), opts);
    if (r.done) return r.output;
    for (const t of r.missingPrices) cache.set(t, await fetchPrice(t));
  }
  throw new Error("engine: price fetching did not converge");
}
