import type {
  Address,
  Board,
  ChartRange,
  CloseCall,
  ClosedPosition,
  CoinDetail,
  CoinSummary,
  CreatedCoin,
  FeedEvent,
  FeedKind,
  FumbleRow,
  Holder,
  LeaderRow,
  LiveMessage,
  PlatformStats,
  PricePoint,
  Profile,
  ProtocolParams,
  QueueEntry,
  Side,
  SystemStatus,
  Ticket,
  TradeQuote,
  TradeRow,
  WalletFumbles,
  WalletPosition,
} from "./types";

export type Unsubscribe = () => void;

export type CoinSort = "trending" | "new" | "mcap" | "closest" | "graduating";

/**
 * Everything the UI reads. The mock in `./mock` implements it today; the indexer/API
 * client (REST + WebSocket, docs/SPEC.md §7) implements the same interface later.
 * Every method is async so the swap is transparent.
 */
export interface FumpadData {
  /** Current time in the data source's clock (mock: a frozen epoch + elapsed). */
  now(): number;

  getStats(): Promise<PlatformStats>;
  getSolUsd(): Promise<number>;
  /** Global.params in display units (the hold time, graduation target, windows quoted in copy). */
  getParams(): Promise<ProtocolParams>;

  listCoins(opts?: { sort?: CoinSort; status?: "curve" | "graduated" | "all"; limit?: number }): Promise<CoinSummary[]>;
  /** One coin by mint (preferred) or by symbol (the API's oldest match: links must use the mint). */
  getCoin(symbolOrMint: string): Promise<CoinDetail | null>;
  /** Every coin whose symbol matches (case-insensitive), newest first. For `/coin/<SYMBOL>` lookups. */
  findCoinsBySymbol(symbol: string): Promise<CoinSummary[]>;
  getPriceSeries(mint: Address, range: ChartRange): Promise<PricePoint[]>;
  getHolders(mint: Address, viewer?: Address): Promise<{ total: number; top: Holder[] }>;
  getRecentFumbles(mint: Address, viewer?: Address): Promise<FumbleRow[]>;
  getClaimQueue(mint: Address, viewer?: Address): Promise<{ pool: number; owed: number; entries: QueueEntry[] }>;
  /** Latest trades on a coin's own pools (DBC + DAMM v2, every app), newest first. */
  getRecentTrades(mint: Address, limit?: number): Promise<TradeRow[]>;

  getFeed(opts?: { kind?: FeedKind | "all"; before?: number; limit?: number }): Promise<FeedEvent[]>;
  /** Live events (indexer WebSocket). Calls back with each new event. */
  subscribeFeed(cb: (e: FeedEvent) => void): Unsubscribe;
  /** Every live message (feed, touched coins/wallets, per-coin state + trades, params). One shared socket. */
  subscribeLive(cb: (m: LiveMessage) => void): Unsubscribe;
  getClosestTo10x(limit?: number, viewer?: Address): Promise<CloseCall[]>;

  getTickets(owner: Address): Promise<Ticket[]>;
  getTicket(id: Address): Promise<Ticket | null>;

  getLeaderboard(board: Board, viewer?: Address): Promise<LeaderRow[]>;
  getProfile(addressOrName: string): Promise<Profile | null>;

  /** Coins the wallet holds now (chain balance > 0), with FUMPAD cost basis. */
  getPositions(wallet: Address): Promise<WalletPosition[]>;
  /** Coins the wallet traded (any app) and fully exited, last trade first. */
  getClosedPositions(wallet: Address): Promise<ClosedPosition[]>;
  /** Coins the wallet launched, newest first, with creator fees. */
  getCreatedCoins(wallet: Address): Promise<CreatedCoin[]>;
  /**
   * Fumble Checker: the wallet's sells (one coin, or every coin it sold), each with its ticket conditions, the
   * ticket when the keepers attested one, and the claim target. Read-only; any address, no login.
   */
  getWalletFumbles(wallet: Address, mint?: Address): Promise<WalletFumbles>;

  /** Off-chain quote mirroring Meteora's math (DBC curve or DAMM v2 + the pool fee + ticket rules). */
  quoteTrade(args: { mint: Address; side: Side; amount: number; wallet?: Address }): Promise<TradeQuote>;
  /** Wallet balances for the trade panel. */
  getBalances(wallet: Address, mint: Address): Promise<{ sol: number; tokens: number; maturedTokens: number }>;

  /** Backend health: indexer lag, keeper sampling, launch mint pool, deployed versions. */
  getStatus(): Promise<SystemStatus>;
}
