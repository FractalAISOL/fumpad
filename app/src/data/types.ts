/**
 * Domain types for the app. They mirror the on-chain accounts and events in
 * `contracts/programs/fumpad/src/{state,events}.rs`, normalised for display:
 *
 *   chain                         app
 *   ───────────────────────────── ──────────────────────────────────────────
 *   u64 base units (6 decimals)   `number` of whole tokens        (see chain.ts)
 *   u64 lamports                  `number` of SOL
 *   u128 Q64.64 lamports/base     `number` SOL per whole token
 *   i64 unix seconds              `number` unix milliseconds
 *   Pubkey                        base58 `string`
 *
 * Floats are fine for display. Transaction building must go back to raw units via
 * `chain.ts` and never round-trip through these numbers.
 */

export type Address = string;
export type Millis = number;

/* ── Coins ─────────────────────────────────────────────────────────────────── */

/** Mirrors `CoinStatus`. */
export type CoinStatus = "curve" | "complete" | "graduated";

export interface CoinSummary {
  mint: Address;
  symbol: string; // without "$"
  name: string;
  creator: Address;
  /** Monogram style for the generated tile (until real images land). */
  tile: 0 | 1 | 2;
  imageUrl?: string;
  status: CoinStatus;
  createdAt: Millis;
  graduatedAt?: Millis;
  /** Spot, SOL per token. */
  price: number;
  /** 30-minute median of keeper samples, SOL per token. Graduated coins only. */
  median?: number;
  change24h: number; // percent
  volume24hSol: number;
  marketCapSol: number;
  holders: number;
  /** Real SOL raised on the curve (pre-graduation). */
  curveSol: number;
  /** SOL the curve must raise to graduate (Global.params; 85 on mainnet, scaled down on devnet). */
  graduationSol?: number;
  /** Reward pool balance, tokens. */
  poolTokens: number;
  ticketsOpen: number;
  /** Last 24 points of price, oldest first, for sparklines. */
  spark: number[];
  /** FUMPAD trades (curve + router) in the last 24 hours. */
  trades24h: number;
  /** Creator-supplied links from the metadata (http/https only). */
  socials?: CoinSocials;
  /** The open ticket nearest to 10×: the highest multiple still below the trigger. */
  closestMultiple?: number;
  /** The creator's wallet carries an indexer flag (linked wallets, rebuys elsewhere). */
  creatorFlagged: boolean;
  /**
   * D19 snipe protection, early-launch stats: SOL that buys in the first ~2 s paid into the reward
   * pool as snipe tax, and how many buys paid it. Absent when none did.
   */
  snipeTaxSol?: number;
  snipeTaxedBuys?: number;
}

export interface CoinSocials {
  x?: string;
  telegram?: string;
  website?: string;
}

export interface CoinDetail extends CoinSummary {
  description: string;
  links: { label: string; href: string }[];
  /** Tokens seeded to the pool at launch (8% of supply). */
  poolSeeded: number;
  poolBought24h: number;
  poolPaidOut: number;
  /** Tokens owed to the claim queue. */
  queueOwed: number;
  ticketsCreated: number;
  /** Open tickets already at ≥ 10× (pre-graduation: waiting on graduation). */
  ticketsPast10x: number;
  /** D10 reference average (10-min TWAP), SOL per token. Used only as the ticket floor. */
  referencePrice: number;
  /** PumpSwap pool address after graduation. */
  ammPool?: Address;
  /** Virtual reserves, for curve quotes. */
  virtualSol: number;
  virtualTokens: number;
  /** Real tokens left on the curve. */
  curveTokensLeft: number;
  /** Graduated-coin pool reserves (quote side incl. virtual), for quotes. */
  ammSol?: number;
  ammTokens?: number;
  curveSol1h: number;
  /** SOL FUMPAD trades sent to the reward pool: the pool's fee share plus any snipe tax. */
  poolInflowSol?: number;
}

export type ChartRange = "1h" | "1d" | "7d" | "all";
export interface PricePoint {
  t: Millis;
  p: number; // SOL per token
}

export interface Holder {
  address: Address;
  label?: string;
  kind: "pool" | "creator" | "you" | "holder" | "amm";
  share: number; // percent of supply
}

/* ── Tickets ───────────────────────────────────────────────────────────────── */

/** Mirrors `TicketStatus`. */
export type TicketChainStatus = "open" | "queued" | "claimed" | "expired" | "voided";

/**
 * What the UI shows. Derived from chain status + coin status + oracle median:
 *  - claimable:   open, graduated, median ≥ 10× with coverage, inside 90 days
 *  - queued:      waiting in the claim queue (clock stopped, never expires)
 *  - tracking:    open, graduated, below 10×
 *  - awaiting-graduation: open, coin still on the curve (may already be ≥ 10×)
 *  - claimed / expired / voided: closed
 * `rebuyReduced` is orthogonal: tokens < originalTokens after a rebuy inside 7 days.
 */
export type TicketState = "claimable" | "queued" | "tracking" | "awaiting-graduation" | "claimed" | "expired" | "voided";

export interface Ticket {
  id: Address; // ticket PDA
  seq: number;
  owner: Address;
  mint: Address;
  symbol: string;
  coinName: string;
  tile: 0 | 1 | 2;
  coinStatus: CoinStatus;
  /** Tokens credited after rebuy debits. */
  tokens: number;
  originalTokens: number;
  /** Ticket price, SOL per token: max(execution, D12 floor). */
  sellPrice: number;
  /** What the sell actually filled at. Differs from sellPrice when the floor applied. */
  execPrice: number;
  sellUsd: number;
  sellSol: number;
  sellTs: Millis;
  /** sellTs + 90 days, or undefined once queued (clock stopped). */
  expiresAt?: Millis;
  chainStatus: TicketChainStatus;
  state: TicketState;
  /** Current 30-min median ÷ ticket price. */
  multiple: number;
  /** Highest multiple the median has reached. */
  peakMultiple: number;
  /** 10% of tokens, fixed at queue entry or payout. */
  claimAmount: number;
  /** Claim value in SOL at the current median. */
  claimValueSol: number;
  queuedAt?: Millis;
  queuePosition?: number;
  /** Pool balance at which this claim fits (claim ≤ 10% of pool). */
  queueNeedsPool?: number;
  queueEta?: number; // ms
  claimedAt?: Millis;
  claimTx?: string;
  /** When the median first held 10× (crossing detected, or the claim/queue entry that proved it). */
  crossedAt?: Millis;
  /** Multiple at the crossing sample, when the indexer saw it (absent if only the claim proved it). */
  crossedMultiple?: number;
  /** Median ÷ ticket price at payout (claimed tickets). */
  claimMultiple?: number;
  /** D16: the payout went to the ticket's escrow (owner's token account refused it) and waits to be withdrawn. */
  escrowed?: boolean;
  /** Debits applied by rebuys within 7 days. */
  rebuyDebited: number;
  /** D17: the keeper may claim this coin's tickets for the owner (per coin; on unless opted out). */
  autoClaim: boolean;
  /** The keeper claimed (or queued) this ticket on the owner's behalf. */
  autoClaimed?: boolean;
}

/* ── Queue ─────────────────────────────────────────────────────────────────── */

export interface QueueEntry {
  position: number;
  ticket: Address;
  owner: Address;
  ownerName?: string;
  amount: number;
  sellTs: Millis;
  /** True when amount ≤ 10% of the pool right now. */
  fits: boolean;
  needsPool: number;
  eta?: number;
  isYou?: boolean;
}

/* ── Trades & quotes ───────────────────────────────────────────────────────── */

export type Side = "buy" | "sell";

export interface FumbleRow {
  ticket: Address;
  owner: Address;
  ownerName?: string;
  tokens: number;
  sol: number;
  ts: Millis;
  multiple: number;
  isYou?: boolean;
}

export interface TradeQuote {
  side: Side;
  /** Input amount (SOL for buys, tokens for sells). */
  amountIn: number;
  /** Output before slippage (tokens for buys, SOL for sells), after the fee. */
  amountOut: number;
  feeSol: number;
  feePoolSol: number;
  feePlatformSol: number;
  feeCreatorSol: number;
  /** PumpSwap's own 0.25% (0.20% LP + 0.05% protocol) on graduated coins; 0 on the curve. */
  venueFeeSol: number;
  /** Spot before the trade. */
  spotBefore: number;
  /** Average execution price, SOL per token, before the fee. */
  execPrice: number;
  priceImpact: number; // percent
  venue: "curve" | "pumpswap";
  ticket?: TicketPreview;
  rebuyWarning?: RebuyWarning;
  /** Curve buys that would fill the curve are partially filled. */
  partialFill?: boolean;
  /**
   * D19: the buy lands in the coin's launch window, so part of it is snipe tax paid to the reward
   * pool (SOL, included in amountIn) at `snipeTaxBps`. Absent outside the window.
   */
  snipeTaxSol?: number;
  snipeTaxBps?: number;
}

export interface TicketPreview {
  /** Whether this sell files a ticket, and why not when it doesn't. */
  files: boolean;
  reason?: "under-min" | "creator" | "max-open" | "not-matured" | "no-oracle";
  usdValue: number;
  /** Tokens credited (sold, capped by tokens held ≥ 10 min). */
  tokens: number;
  execPrice: number;
  /** D12 floor: reference × exec ÷ spotBefore. */
  floorPrice: number;
  /** max(exec, floor). */
  ticketPrice: number;
  floorApplied: boolean;
  triggerPrice: number;
  claimTokens: number;
  openTickets: number;
  maxOpenTickets: number;
}

export interface RebuyWarning {
  /** Tickets that a buy of this size would debit (newest first). */
  tickets: { id: Address; symbol: string; tokens: number; debit: number; soldAgo: number }[];
  totalDebit: number;
}

/* ── Feed ──────────────────────────────────────────────────────────────────── */

export type FeedKind = "launch" | "fumble" | "cross" | "graduation" | "claim";

interface FeedBase {
  id: string;
  kind: FeedKind;
  ts: Millis;
  actor: Address;
  actorName?: string;
  mint: Address;
  symbol: string;
  coinName: string;
  tile: 0 | 1 | 2;
  /** Social counters, off-chain. */
  replies: number;
  reposts: number;
}
export interface FeedLaunch extends FeedBase {
  kind: "launch";
  poolTokens: number;
  /** D19: snipe tax that launch-window buys have paid into the pool so far (SOL). */
  snipeTaxSol?: number;
}
export interface FeedFumble extends FeedBase {
  kind: "fumble";
  tokens: number;
  sol: number;
  ticketPrice: number;
}
export interface FeedCross extends FeedBase {
  kind: "cross";
  multiple: number;
  claimTokens: number;
  claimSol: number;
}
export interface FeedGraduation extends FeedBase {
  kind: "graduation";
  raisedSol: number;
  ticketsUnlocked: number;
}
export interface FeedClaim extends FeedBase {
  kind: "claim";
  multiple: number;
  tokens: number;
  sol: number;
  fromQueue: boolean;
  skippedAhead: boolean;
  /** D17: paid by the keeper's auto-claim, not a click. */
  auto?: boolean;
}
export type FeedEvent = FeedLaunch | FeedFumble | FeedCross | FeedGraduation | FeedClaim;

export interface PlatformStats {
  paidBack24hSol: number;
  crossings24h: number;
  graduated24h: number;
  openTickets: number;
  solUsd: number;
}

export interface CloseCall {
  ticket: Address;
  symbol: string;
  mint: Address;
  owner: Address;
  ownerName?: string;
  multiple: number;
  isYou?: boolean;
}

/* ── People ────────────────────────────────────────────────────────────────── */

export type Board = "fumbles" | "claimers" | "diamond";

export interface LeaderRow {
  rank: number;
  address: Address;
  name?: string;
  isYou?: boolean;
  symbol?: string;
  /** The coin behind `symbol` (links go by mint; older API builds omit it and link by symbol). */
  mint?: Address;
  /** Board-specific numeric columns. */
  soldForSol?: number;
  worthNowSol?: number;
  multiple?: number;
  claims?: number;
  claimedSol?: number;
  unlockedAt?: number;
  claimedAtMultiple?: number;
  waitedDays?: number;
}

export interface Achievement {
  id: string;
  title: string;
  detail: string;
  earned: boolean;
  glyph: "ring" | "ring-dot" | "bar" | "queue" | "check" | "down";
}

export interface Profile {
  address: Address;
  name?: string;
  level: number;
  levelTitle: string;
  xp: number;
  xpNext: number;
  fumbleRank?: number;
  ticketsFiled: number;
  crossed10x: number;
  claimedSol: number;
  worst?: { symbol: string; multiple: number };
  flagged: boolean;
  achievements: Achievement[];
}

/* ── Portfolio (wallet profile) ────────────────────────────────────────────── */

/**
 * Measured from FUMPAD trades (curve + router) with the average-cost method: a buy adds
 * its tokens and the SOL it cost (fee included); a sell removes tokens at the running
 * average cost and books what it paid out (after the fee) minus that cost as realized
 * P&L. Fumble payouts (claims) arrive at zero cost. Balances come from the chain (the
 * wallet's canonical Token-2022 account). Nothing here is a projection.
 */
export interface PortfolioCoin {
  mint: Address;
  symbol: string;
  name: string;
  tile: 0 | 1 | 2;
  imageUrl?: string;
  status: CoinStatus;
  /** Real SOL raised on the curve (pre-graduation). */
  curveSol: number;
  graduationSol?: number;
}

export interface WalletPosition extends PortfolioCoin {
  /** Tokens in the wallet now (chain). */
  balance: number;
  /** Spot, SOL per token. */
  price: number;
  /** balance × price, SOL. */
  valueSol: number;
  /** Tokens FUMPAD trades and payouts account for: bought + payouts − sold. */
  trackedTokens: number;
  /** Average cost of the tracked tokens, SOL per token (payouts count at zero). */
  avgCost: number;
  /** Tokens the cost basis covers: min(balance, tracked). */
  coveredTokens: number;
  /** What the covered tokens cost, SOL. */
  costSol: number;
  /** covered × price − cost. Undefined when no token is covered. */
  unrealizedSol?: number;
  /** unrealized ÷ cost, percent. Undefined at zero cost (payout-only positions). */
  unrealizedPct?: number;
  /** Realized on sells so far (a position partly sold). */
  realizedSol: number;
  /** The balance holds tokens acquired outside FUMPAD; the cost basis covers FUMPAD trades only. */
  partialBasis: boolean;
  boughtTokens: number;
  /** Tokens received as fumble payouts (zero cost). */
  payoutTokens: number;
  firstTs?: Millis;
  lastTs?: Millis;
  /** Open fumble tickets on this coin (open or queued). */
  openTickets: number;
  /** Highest current multiple among them. */
  bestMultiple?: number;
}

export interface ClosedPosition extends PortfolioCoin {
  boughtTokens: number;
  /** SOL spent on buys, fees included. */
  boughtSol: number;
  soldTokens: number;
  /** SOL received from sells, after fees. */
  soldSol: number;
  payoutTokens: number;
  /** Sale proceeds minus the average cost of the tokens sold. */
  realizedSol: number;
  /** realized ÷ cost of the tokens sold, percent. Undefined at zero cost. */
  realizedPct?: number;
  /** Sells exceeded what FUMPAD trades explain; P&L covers the explained part only. */
  partialBasis: boolean;
  firstTs: Millis;
  lastTs: Millis;
  /** Fumble tickets the wallet filed on this coin. */
  ticketsEarned: number;
}

/** A coin the wallet launched, with its creator fees. */
export interface CreatedCoin extends CoinSummary {
  /** Creator share of trading fees, all time, SOL. */
  feesEarnedSol: number;
  feesWithdrawnSol: number;
  /** Sitting in the coin account, withdrawable by the creator now. */
  feesWithdrawableSol: number;
}

/* ── Launch ────────────────────────────────────────────────────────────────── */

export interface LaunchDraft {
  name: string;
  symbol: string;
  description: string;
  imageFile?: File | null;
  website?: string;
  x?: string;
  telegram?: string;
  /** Optional first buy in SOL, made in the same transaction. */
  initialBuySol: number;
}

/* ── Protocol params ───────────────────────────────────────────────────────── */

/**
 * `Global.params` in display units (SOL, whole tokens, seconds, USD). Mainnet runs the
 * program defaults; devnet runs a scaled-down curve and short windows (e.g. 30 s hold,
 * 0.85 SOL graduation). Copy that quotes a rule reads it from here, never a literal.
 */
export interface ProtocolParams {
  totalSupply: number;
  rewardPoolSupply: number;
  curveSupply: number;
  lpSupply: number;
  initialVirtualSol: number;
  initialVirtualTokens: number;
  graduationSol: number;
  feeBps: number;
  feePoolShareBps: number;
  feePlatformShareBps: number;
  feeCreatorShareBps: number;
  /** 10 = 10×. */
  triggerMultiple: number;
  claimBps: number;
  maxClaimPoolBps: number;
  /** Smallest sell (USD) that files a ticket. */
  minSellUsd: number;
  /** Tokens must sit this long in a wallet before a sell of them counts. */
  minHoldSecs: number;
  rebuyWindowSecs: number;
  claimWindowSecs: number;
  maxOpenTickets: number;
  /** The claim median's window. */
  oracleWindowSecs: number;
  oracleMinSamples: number;
  /** D19: curve buys within this many slots of launch pay the snipe tax (0 = off). */
  snipeWindowSlots: number;
  /** D19: snipe tax at the launch slot, bps (9,900 = 99%), decaying to 0 over the window. */
  snipeStartBps: number;
  /** D20: SOL taken at graduation to pay the pool's setup rent (remainder to FUMPAD). */
  graduationFeeSol: number;
}

/* ── Trades & live updates ─────────────────────────────────────────────────── */

/** One FUMPAD trade on a coin (curve or PumpSwap via the router). */
export interface TradeRow {
  signature: string;
  mint: Address;
  wallet: Address;
  side: Side;
  tokens: number;
  /** SOL in (buys) or out (sells), before the fee. */
  sol: number;
  /** Spot after the trade, SOL per token. */
  price: number;
  ts: Millis;
  /** D19: snipe tax this buy paid to the reward pool (SOL, on top of `sol`) and its rate. Absent when none. */
  snipeTaxSol?: number;
  snipeTaxBps?: number;
}

/**
 * What the WebSocket (`/v1/ws`) pushes. Indexed transactions are coalesced per short window
 * (250 ms): one `coins` message (the mints and wallets they touched) and, per touched coin, one
 * `coin` message with the coin's fresh state, the window's new trades (newest first) and the
 * chart points they add. `resync` is local: the client emits it after a reconnect so views
 * catch up on what they missed.
 */
export type LiveMessage =
  | { type: "feed"; event: FeedEvent }
  | { type: "coins"; mints: Address[]; wallets?: Address[] }
  | { type: "coin"; coin: CoinDetail; trades: TradeRow[]; points: PricePoint[] }
  | { type: "params" }
  | { type: "resync" };

/* ── System status (`/v1/status`, the footer dot and /status) ───────────────── */

/** ok: working; degraded: working but behind or running low; down: not working; unknown: no signal yet. */
export type HealthLevel = "ok" | "degraded" | "down" | "unknown";

/** One deployed service and the build it runs (git sha when the host provides it). */
export interface ServiceVersion {
  name: "api" | "indexer" | "keeper";
  /** Git commit, when the host exposes one (`GIT_SHA` / `RAILWAY_GIT_COMMIT_SHA`). */
  sha: string | null;
  /** Host deployment id (Railway), so two instances can be told apart. */
  deploymentId: string | null;
  startedAt: Millis | null;
  /** Last time the service reported in (the API itself: now). */
  seenAt: Millis | null;
}

export interface SystemStatus {
  /** The worst of the checks below. */
  level: HealthLevel;
  at: Millis;
  indexer: {
    level: HealthLevel;
    /** How far behind the chain the indexed data can be: heartbeat age + time since its last poll. */
    lagSecs: number | null;
    /** Age of the newest indexed transaction (quiet chains make this large; not an error by itself). */
    lastTxAgeSecs: number | null;
    tipSlot: number | null;
  };
  keeper: {
    level: HealthLevel;
    /** Age of the newest keeper price sample (graduated coins are sampled at least every 8 min). */
    lastSampleAgeSecs: number | null;
    graduatedCoins: number;
  };
  /** Pre-ground `…fmbL` launch mints. Null when launches are disabled on this API. */
  vanityPool: { level: HealthLevel; available: number; reserved: number } | null;
  services: ServiceVersion[];
}
