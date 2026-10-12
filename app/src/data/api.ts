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
  Ticket,
  TradeQuote,
  SystemStatus,
  TradeRow,
  WalletPosition,
} from "./types";
import { isMintAddress, mergeCoins, normalizeSymbol } from "../components/coin/ident";

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | undefined>;

/** One URL path segment (L-2): ids from links and the API are encoded, never spliced raw. */
const seg = (v: string) => encodeURIComponent(String(v));

export class ApiFumpadData implements FumpadData {
  private readonly base: string;
  private readonly wsUrl: string;
  /** Extra request headers (server side only: the SSR secret, see `./ssr.ts`). */
  private readonly headers: Record<string, string>;
  /** server clock − local clock, from the `x-server-time` header of every response. */
  private skew = 0;

  constructor(baseUrl: string, opts: { wsUrl?: string; headers?: Record<string, string> } = {}) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.wsUrl = opts.wsUrl ?? this.base.replace(/^http/, "ws") + "/v1/ws";
    this.headers = opts.headers ?? {};
  }

  now(): number {
    return Date.now() + this.skew;
  }

  private async get<T>(path: string, query: Query = {}): Promise<T> {
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    const res = await fetch(`${this.base}${path}${qs ? `?${qs}` : ""}`, { headers: { ...this.headers, accept: "application/json" } });
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

  /**
   * GET that maps 404 (and 400, a malformed id from a hand-edited link) to null, and 300 (a
   * legacy per-coin route asked with a symbol several coins share) too: never a silent pick.
   */
  private async maybe<T>(path: string, query: Query = {}): Promise<T | null> {
    try {
      return await this.get<T>(path, query);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 400 || e.status === 300)) return null;
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
  /**
   * Every coin answering to `symbol`, newest first (H-3): `/v1/coins/by-symbol/:symbol`, which
   * never picks one. `mergeCoins` re-checks the match and the order client-side. The legacy
   * `/v1/coins/:symbol` isn't used: it answers 300 for a shared symbol.
   */
  async findCoinsBySymbol(symbol: string): Promise<CoinSummary[]> {
    const sym = normalizeSymbol(symbol);
    if (!sym) return [];
    const list = await this.maybe<CoinSummary[]>(`/v1/coins/by-symbol/${seg(sym)}`, { limit: 50 });
    return mergeCoins(sym, list ?? []);
  }
  /**
   * A coin by mint (`/v1/coins/by-mint/:mint`). A symbol resolves only when exactly one coin
   * has it; a shared symbol is null (callers route bare symbols to the chooser instead).
   */
  async getCoin(symbolOrMint: string): Promise<CoinDetail | null> {
    if (isMintAddress(symbolOrMint)) return this.maybe<CoinDetail>(`/v1/coins/by-mint/${seg(symbolOrMint)}`);
    const list = await this.findCoinsBySymbol(symbolOrMint);
    return list.length === 1 ? this.maybe<CoinDetail>(`/v1/coins/by-mint/${seg(list[0].mint)}`) : null;
  }
  getPriceSeries(mint: Address, range: ChartRange): Promise<PricePoint[]> {
    return this.get(`/v1/coins/${seg(mint)}/prices`, { range });
  }
  getHolders(mint: Address, viewer?: Address): Promise<{ total: number; top: Holder[] }> {
    return this.get(`/v1/coins/${seg(mint)}/holders`, { viewer });
  }
  getRecentFumbles(mint: Address, viewer?: Address): Promise<FumbleRow[]> {
    return this.get(`/v1/coins/${seg(mint)}/fumbles`, { viewer });
  }
  getClaimQueue(mint: Address, viewer?: Address): Promise<{ pool: number; owed: number; entries: QueueEntry[] }> {
    return this.get(`/v1/coins/${seg(mint)}/queue`, { viewer });
  }
  getFeed(opts: { kind?: FeedKind | "all"; before?: number; limit?: number } = {}): Promise<FeedEvent[]> {
    return this.get("/v1/feed", { kind: opts.kind, before: opts.before === Infinity ? undefined : opts.before, limit: opts.limit });
  }

  getRecentTrades(mint: Address, limit?: number): Promise<TradeRow[]> {
    return this.get(`/v1/coins/${seg(mint)}/trades`, { limit });
  }
  getParams(): Promise<ProtocolParams> {
    return this.get("/v1/params");
  }

  /* ── Live: one socket for the whole tab, shared by every subscriber ─────── */

  private listeners = new Set<(m: LiveMessage) => void>();
  private ws: WebSocket | null = null;
  private wsAttempt = 0;
  private wsTimer: ReturnType<typeof setTimeout> | undefined;
  private wsIdle: ReturnType<typeof setTimeout> | undefined;
  private wsEverOpened = false;

  private dispatch(m: LiveMessage) {
    for (const l of [...this.listeners]) {
      try {
        l(m);
      } catch (e) {
        console.warn("[fumpad] live listener failed:", e);
      }
    }
  }

  private connect() {
    if (this.ws || !this.listeners.size) return;
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.wsAttempt = 0;
      // After a drop, views refetch what they missed while the socket was down.
      if (this.wsEverOpened) this.dispatch({ type: "resync" });
      this.wsEverOpened = true;
    };
    ws.onmessage = (m) => {
      let msg: LiveMessage | { type: "hello"; serverTime?: number };
      try {
        msg = JSON.parse(String(m.data));
      } catch {
        return; // ignore malformed
      }
      if (msg.type === "hello") {
        if (msg.serverTime) this.skew = msg.serverTime - Date.now();
        return;
      }
      this.dispatch(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.listeners.size) return;
      const delay = Math.min(30_000, 500 * 2 ** this.wsAttempt++);
      this.wsTimer = setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  /** Browser only (no-op on the server). Reconnects with backoff; closes 5 s after the last subscriber leaves. */
  subscribeLive(cb: (m: LiveMessage) => void): Unsubscribe {
    if (typeof WebSocket === "undefined") return () => {};
    this.listeners.add(cb);
    if (this.wsIdle) clearTimeout(this.wsIdle);
    this.wsIdle = undefined;
    this.connect();
    return () => {
      this.listeners.delete(cb);
      if (this.listeners.size) return;
      // Navigation unmounts one view and mounts the next: keep the socket across that gap.
      this.wsIdle = setTimeout(() => {
        if (this.listeners.size) return;
        if (this.wsTimer) clearTimeout(this.wsTimer);
        const ws = this.ws;
        this.ws = null;
        ws?.close();
      }, 5_000);
    };
  }

  subscribeFeed(cb: (e: FeedEvent) => void): Unsubscribe {
    return this.subscribeLive((m) => {
      if (m.type === "feed") cb(m.event);
    });
  }

  getClosestTo10x(limit?: number, viewer?: Address): Promise<CloseCall[]> {
    return this.get("/v1/closest", { limit, viewer });
  }
  getTickets(owner: Address): Promise<Ticket[]> {
    return this.get(`/v1/wallets/${seg(owner)}/tickets`);
  }
  getTicket(id: Address): Promise<Ticket | null> {
    return this.maybe(`/v1/tickets/${seg(id)}`);
  }
  getLeaderboard(board: Board, viewer?: Address): Promise<LeaderRow[]> {
    return this.get(`/v1/leaderboards/${seg(board)}`, { viewer });
  }
  getProfile(addressOrName: string): Promise<Profile | null> {
    return this.maybe(`/v1/profiles/${seg(addressOrName)}`);
  }
  getPositions(wallet: Address): Promise<WalletPosition[]> {
    return this.get(`/v1/wallets/${seg(wallet)}/positions`);
  }
  getClosedPositions(wallet: Address): Promise<ClosedPosition[]> {
    return this.get(`/v1/wallets/${seg(wallet)}/closed`);
  }
  getCreatedCoins(wallet: Address): Promise<CreatedCoin[]> {
    return this.get(`/v1/wallets/${seg(wallet)}/created`);
  }
  quoteTrade(args: { mint: Address; side: Side; amount: number; wallet?: Address }): Promise<TradeQuote> {
    return this.get("/v1/quote", { mint: args.mint, side: args.side, amount: args.amount, wallet: args.wallet });
  }
  getBalances(wallet: Address, mint: Address): Promise<{ sol: number; tokens: number; maturedTokens: number }> {
    return this.get(`/v1/wallets/${seg(wallet)}/balances/${seg(mint)}`);
  }
  getStatus(): Promise<SystemStatus> {
    return this.get("/v1/status");
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
