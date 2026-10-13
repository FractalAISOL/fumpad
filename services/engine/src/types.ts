import type { TraderSource, Venue } from "@fumpad/meteora";

import type { PythPrice } from "./rules/usd.js";

/** Reward terms the engine applies (the coin's snapshotted params; defaults = v0.6 defaults). */
export interface EngineParams {
  minSellUsdCents: bigint;
  minHoldSecs: bigint;
  rebuyWindowSecs: bigint;
  maxOpenTickets: number;
  /** Ticket voids when claim_amount(tokens) rounds to 0 (apply_rebuy). */
  claimBps: bigint;
  /** SPEC §5.4: |block_time − publish_time| ≤ 60 s (Params.max_price_age_secs). */
  maxPythDeltaSecs: number;
  /**
   * Params.max_attest_age_secs. With `trackAttestations`, an engine ticket that has no TicketAttested
   * within this age of its sell stops counting as open (it can never be attested any more).
   */
  maxAttestAgeSecs: number;
  trackAttestations: boolean;
}

export const DEFAULT_ENGINE_PARAMS: EngineParams = {
  minSellUsdCents: 5_000n,
  minHoldSecs: 600n,
  rebuyWindowSecs: 7n * 86_400n,
  maxOpenTickets: 5,
  claimBps: 1_000n,
  maxPythDeltaSecs: 60,
  maxAttestAgeSecs: 86_400,
  trackAttestations: false,
};

/** What the engine needs to know about one registered coin (all from finalized chain data). */
export interface CoinFacts {
  mint: string;
  creator: string;
  dbcPool: string;
  /** DBC config of the pool (must be on the FUMPAD allow-list; checked by the caller). */
  config: string;
  /** DBC config `sqrt_start_price`: the curve's spot before its first swap (reference init). */
  startSqrtPrice: bigint;
  /** Unix seconds of the pool-creation (launch) block. */
  launchBlockTime: number;
  launchSlot: number;
  /** Graduated DAMM v2 pool if already known; otherwise learned from the migration tx in the history. */
  dammPool?: string | null;
}

/** Total order: (slot, tx index in block, phase, ixKey). */
export interface OrderKey {
  slot: number;
  /** Index of the tx in its block (getBlock). -1 = the only relevant tx of its slot (index not needed). */
  txIndex: number;
  /**
   * Within one tx: 0 = transfers in, 2 = pool/swap instructions (by ixKey), 3 = transfers out,
   * 4 = FUMPAD ticket lifecycle. Token transfers can't be placed between instructions from transaction
   * metadata; inflows-first / outflows-last is the only order that never drives a balance negative for
   * a valid tx (a wallet may buy and forward the tokens, or receive and sell them, in one tx). A sell
   * funded by a same-tx inflow gets no ticket (same_tx_inflow), so inflows-first gives no credit.
   */
  phase: 0 | 2 | 3 | 4;
  ixKey: number;
}

export interface SwapEvent {
  kind: "swap";
  key: OrderKey;
  signature: string;
  blockTime: number;
  venue: Venue;
  pool: string;
  side: "buy" | "sell";
  trader: string | null;
  traderSource: TraderSource;
  baseAmount: bigint;
  quoteGross: bigint;
  quoteMint: string;
  nextSqrtPrice: bigint;
  /** The swap was CPI'd directly by the fumpad router (venue byte bit7 of the attestation). */
  routed: boolean;
}

export interface TransferEvent {
  kind: "transfer";
  key: OrderKey;
  signature: string;
  blockTime: number;
  owner: string;
  /** Net change of the owner's balance of the mint not explained by our-pool swaps (≠ 0). */
  delta: bigint;
  /** Paid out by FUMPAD (claim / escrow): an acquisition, never a rebuy. */
  payout: boolean;
}

/** DAMM v2 pool created by migration_damm_v2 from the coin's DBC pool (sqrt price at init). */
export interface PoolInitEvent {
  kind: "pool_init";
  key: OrderKey;
  signature: string;
  blockTime: number;
  pool: string;
  sqrtPrice: bigint;
}

/** On-chain ticket left the Open/Queued set (claimed, escrowed, expired, guardian-voided, closed). */
export interface TicketStatusEvent {
  kind: "ticket_status";
  key: OrderKey;
  signature: string;
  blockTime: number;
  ticket: TicketRef;
  status: "claimed" | "escrowed" | "expired" | "voided" | "closed";
}

/** A tx that touched our pools but whose swaps could not be derived exactly (parser issue). */
export interface ParseIssueEvent {
  kind: "parse_issue";
  key: OrderKey;
  signature: string;
  blockTime: number;
  code: string;
  message: string;
  /** The coin's pool the issue concerns; null = unknown (the tx touches one of the coin's pools). */
  pool?: string | null;
}

/** The sell's ticket was attested on chain (TicketAttested); `ticket` = the ticket PDA. */
export interface TicketAttestedEvent {
  kind: "ticket_attested";
  key: OrderKey;
  signature: string;
  blockTime: number;
  ref: TicketRef;
  ticket: string;
  /** Ticket owner (TicketAttested.owner), for scoping an unmappable attestation to its wallet. */
  owner?: string;
}

export type EngineEvent = SwapEvent | TransferEvent | PoolInitEvent | TicketStatusEvent | TicketAttestedEvent | ParseIssueEvent;

/** A ticket is identified by the sell that created it. */
export interface TicketRef {
  signature: string;
  ixKey: number;
}
export const refKey = (r: TicketRef) => `${r.signature}:${r.ixKey}`;

export type NoTicketReason =
  /** The trader's own history is inconsistent (negative balance / unmappable attestation): V7-H2, per wallet. */
  | "history_inconsistent"
  | "parse_issue_in_tx"
  /** A swap of the coin's pools couldn't be parsed exactly within the D10 window before this sell (V7-H2). */
  | "price_unverified"
  | "trader_unverified"
  | "same_tx_inflow"
  | "quote_not_wsol"
  | "creator"
  | "not_matured"
  | "too_many_open_tickets"
  | "zero_price"
  | "oracle_unavailable"
  | "below_minimum_usd";

export interface TicketPlan {
  ticketTokens: bigint;
  ticketPriceQ64: bigint;
  usdCents: bigint;
  pythPublishTime: number;
  /** Diagnostics (not attested): execution price, reference after the touch, pre-trade spot. */
  executionQ64: bigint;
  referenceQ64: bigint;
  preSpotQ64: bigint;
}

export interface SellDecision {
  signature: string;
  ixKey: number;
  slot: number;
  txIndex: number;
  blockTime: number;
  venue: Venue;
  pool: string;
  routed: boolean;
  trader: string | null;
  baseAmount: bigint;
  quoteGross: bigint;
  ticket: TicketPlan | null;
  reason: NoTicketReason | null;
  /** Oracle detail when reason = oracle_unavailable. */
  oracleIssue?: string;
}

export interface RebuyDebit {
  /** The acquisition that debits (a buy's signature/ixKey, or a transfer's signature with ixKey = TRANSFER_IX_KEY). */
  signature: string;
  ixKey: number;
  kind: "buy" | "transfer_in";
  slot: number;
  blockTime: number;
  wallet: string;
  ticket: TicketRef;
  /** On-chain ticket PDA when its TicketAttested is in the history (else null: attest the sell first). */
  ticketAddress: string | null;
  debit: bigint;
  remaining: bigint;
  voided: boolean;
}

/** ixKey used for transfer-derived events (no single instruction; u32::MAX never collides with a swap key). */
export const TRANSFER_IX_KEY = 0xffff_ffff;

/**
 * What an issue blocks (V7-H2: failures are scoped, an issue never freezes a whole coin):
 *  - "tx": sells in that transaction (parse issues; the D10 price is also unverified for one window);
 *  - "wallet": that wallet's sells until its history is consistent again (negative balance,
 *    unmappable attestation);
 *  - "coin": everything from that slot on — only engine invariant violations (unreachable from chain data).
 */
export type IssueScope = "tx" | "wallet" | "coin";

export interface EngineIssue {
  signature: string;
  slot: number;
  kind: "negative_balance" | "parse_issue" | "unknown_ticket_status" | "out_of_order" | "second_damm_pool";
  scope: IssueScope;
  /** scope "wallet": the wallet. */
  wallet?: string;
  /** parse issues: the pool concerned (null = unknown). */
  pool?: string | null;
  detail: string;
}

export interface EngineOutput {
  mint: string;
  sells: SellDecision[];
  rebuys: RebuyDebit[];
  issues: EngineIssue[];
  /** Final reference (diagnostic). */
  reference: { avgQ64: bigint; lastSpotQ64: bigint; updatedAt: bigint };
  /** Last event key processed. */
  lastKey: OrderKey | null;
}

/** Synchronous price lookup for a trade's block time; `undefined` = not fetched yet (engine asks). */
export type PythLookup = (blockTime: number) => PythPrice | null | undefined;
