/**
 * `FumpadData` over the FUMPAD API (services/api): REST for reads, one WebSocket for the
 * live feed. Same types and units as the mock, so screens don't change.
 *
 * Switching: set NEXT_PUBLIC_FUMPAD_API (e.g. https://api.fumpad.fun) and make
 * `getFumpadData()` in ./index.ts return `apiDataFromEnv() ?? mockData` (two lines; left to
 * the app owner — this file is the only app change the backend ships).
 */
import type { CoinSort, FumpadData, Unsubscribe } from "./interface";
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

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | undefined>;

export class ApiFumpadData implements FumpadData {
  private readonly base: string;
  private readonly wsUrl: string;
  /** server clock − local clock, from the `x-server-time` header of every response. */
  private skew = 0;

  constructor(baseUrl: string, opts: { wsUrl?: string } = {}) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.wsUrl = opts.wsUrl ?? this.base.replace(/^http/, "ws") + "/v1/ws";
  }

  now(): number {
    return Date.now() + this.skew;
  }

  private async get<T>(path: string, query: Query = {}): Promise<T> {
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    const res = await fetch(`${this.base}${path}${qs ? `?${qs}` : ""}`, { headers: { accept: "application/json" } });
    const st = Number(res.headers.get("x-server-time"));
    if (st) this.skew = st - Date.now();
    if (!res.ok) {
      let msg = res.statusText;
      try {
        msg = ((await res.json()) as { error?: string }).error ?? msg;
      } catch {
        /* not json */
      }
      throw new ApiError(res.status, msg);
    }
    return (await res.json()) as T;
  }

  /** GET that maps 404 to null. */
  private async maybe<T>(path: string, query: Query = {}): Promise<T | null> {
    try {
      return await this.get<T>(path, query);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }

  getStats(): Promise<PlatformStats> {
    return this.get("/v1/stats");
  }
  async getSolUsd(): Promise<number> {
    return (await this.get<{ solUsd: number }>("/v1/sol-usd")).solUsd;
  }
  listCoins(opts: { sort?: CoinSort; status?: "curve" | "graduated" | "all"; limit?: number } = {}): Promise<CoinSummary[]> {
    return this.get("/v1/coins", { sort: opts.sort, status: opts.status, limit: opts.limit });
  }
  getCoin(symbolOrMint: string): Promise<CoinDetail | null> {
    return this.maybe(`/v1/coins/${encodeURIComponent(symbolOrMint)}`);
  }
  getPriceSeries(mint: Address, range: ChartRange): Promise<PricePoint[]> {
    return this.get(`/v1/coins/${mint}/prices`, { range });
  }
  getHolders(mint: Address, viewer?: Address): Promise<{ total: number; top: Holder[] }> {
    return this.get(`/v1/coins/${mint}/holders`, { viewer });
  }
  getRecentFumbles(mint: Address, viewer?: Address): Promise<FumbleRow[]> {
    return this.get(`/v1/coins/${mint}/fumbles`, { viewer });
  }
  getClaimQueue(mint: Address, viewer?: Address): Promise<{ pool: number; owed: number; entries: QueueEntry[] }> {
    return this.get(`/v1/coins/${mint}/queue`, { viewer });
  }
  getFeed(opts: { kind?: FeedKind | "all"; before?: number; limit?: number } = {}): Promise<FeedEvent[]> {
    return this.get("/v1/feed", { kind: opts.kind, before: opts.before === Infinity ? undefined : opts.before, limit: opts.limit });
  }

  /** One shared socket per subscriber; reconnects with backoff. Browser only (no-op on the server). */
  subscribeFeed(cb: (e: FeedEvent) => void): Unsubscribe {
    if (typeof WebSocket === "undefined") return () => {};
    let ws: WebSocket | null = null;
    let stopped = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (stopped) return;
      ws = new WebSocket(this.wsUrl);
      ws.onopen = () => {
        attempt = 0;
      };
      ws.onmessage = (m) => {
        try {
          const msg = JSON.parse(String(m.data)) as { type: string; event?: FeedEvent; serverTime?: number };
          if (msg.type === "hello" && msg.serverTime) this.skew = msg.serverTime - Date.now();
          if (msg.type === "feed" && msg.event) cb(msg.event);
        } catch {
          /* ignore malformed */
        }
      };
      ws.onclose = () => {
        if (stopped) return;
        const delay = Math.min(30_000, 500 * 2 ** attempt++);
        timer = setTimeout(connect, delay);
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }

  getClosestTo10x(limit?: number, viewer?: Address): Promise<CloseCall[]> {
    return this.get("/v1/closest", { limit, viewer });
  }
  getTickets(owner: Address): Promise<Ticket[]> {
    return this.get(`/v1/wallets/${owner}/tickets`);
  }
  getTicket(id: Address): Promise<Ticket | null> {
    return this.maybe(`/v1/tickets/${id}`);
  }
  getLeaderboard(board: Board, viewer?: Address): Promise<LeaderRow[]> {
    return this.get(`/v1/leaderboards/${board}`, { viewer });
  }
  getProfile(addressOrName: string): Promise<Profile | null> {
    return this.maybe(`/v1/profiles/${encodeURIComponent(addressOrName)}`);
  }
  quoteTrade(args: { mint: Address; side: Side; amount: number; wallet?: Address }): Promise<TradeQuote> {
    return this.get("/v1/quote", { mint: args.mint, side: args.side, amount: args.amount, wallet: args.wallet });
  }
  getBalances(wallet: Address, mint: Address): Promise<{ sol: number; tokens: number; maturedTokens: number }> {
    return this.get(`/v1/wallets/${wallet}/balances/${mint}`);
  }
}

let shared: ApiFumpadData | null = null;

/** The API-backed data source when NEXT_PUBLIC_FUMPAD_API is set, else null (keep the mock). */
export function apiDataFromEnv(): FumpadData | null {
  const base = process.env.NEXT_PUBLIC_FUMPAD_API;
  if (!base) return null;
  if (!shared) shared = new ApiFumpadData(base, { wsUrl: process.env.NEXT_PUBLIC_FUMPAD_WS || undefined });
  return shared;
}
