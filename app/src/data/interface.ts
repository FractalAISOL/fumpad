import type {
  Address,
  Board,
  ChartRange,
  CloseCall,
  CoinDetail,
  CoinSummary,
  FeedEvent,
  FeedKind,
  FumbleRow,
  Holder,
  LeaderRow,
  PlatformStats,
  PricePoint,
  Profile,
  QueueEntry,
  Side,
  Ticket,
  TradeQuote,
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

  listCoins(opts?: { sort?: CoinSort; status?: "curve" | "graduated" | "all"; limit?: number }): Promise<CoinSummary[]>;
  getCoin(symbolOrMint: string): Promise<CoinDetail | null>;
  getPriceSeries(mint: Address, range: ChartRange): Promise<PricePoint[]>;
  getHolders(mint: Address, viewer?: Address): Promise<{ total: number; top: Holder[] }>;
  getRecentFumbles(mint: Address, viewer?: Address): Promise<FumbleRow[]>;
  getClaimQueue(mint: Address, viewer?: Address): Promise<{ pool: number; owed: number; entries: QueueEntry[] }>;

  getFeed(opts?: { kind?: FeedKind | "all"; before?: number; limit?: number }): Promise<FeedEvent[]>;
  /** Live events (indexer WebSocket). Calls back with each new event. */
  subscribeFeed(cb: (e: FeedEvent) => void): Unsubscribe;
  getClosestTo10x(limit?: number, viewer?: Address): Promise<CloseCall[]>;

  getTickets(owner: Address): Promise<Ticket[]>;
  getTicket(id: Address): Promise<Ticket | null>;

  getLeaderboard(board: Board, viewer?: Address): Promise<LeaderRow[]>;
  getProfile(addressOrName: string): Promise<Profile | null>;

  /** Off-chain quote mirroring the program's math (curve or PumpSwap + fee + ticket rules). */
  quoteTrade(args: { mint: Address; side: Side; amount: number; wallet?: Address }): Promise<TradeQuote>;
  /** Wallet balances for the trade panel. */
  getBalances(wallet: Address, mint: Address): Promise<{ sol: number; tokens: number; maturedTokens: number }>;
}
