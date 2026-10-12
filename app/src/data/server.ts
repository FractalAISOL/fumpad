/**
 * Cached reads for Server Components, `generateMetadata` and `generateStaticParams`.
 *
 * With Cache Components every uncached fetch during prerender must sit under a <Suspense>.
 * Routing server reads through these `"use cache"` functions instead lets the live API's
 * data join the static shell (revalidated in the background, like ISR) while the client
 * keeps it fresh: the feed over the WebSocket, quotes/balances/series on mount.
 *
 * Lifetime: `minutes` (stale 5 m, revalidate 1 m, expire 1 h) throughout. Everything here
 * moves with trading, but `seconds` (expire < 5 m) would drop it out of the prerender and
 * turn every page into skeletons; the client refreshes what has to be live. The mock is
 * pure and deterministic, so caching it changes nothing.
 *
 * Arguments are the cache key; keep them serializable (strings, numbers, plain objects).
 */
import { cacheLife } from "next/cache";
import { getFumpadData } from ".";
import type { CoinSort } from "./interface";
import type { Address, Board, ChartRange, FeedKind, ProtocolParams } from "./types";

/** Floor to the minute: the shell's clock must not churn the cache key or the HTML. */
const minute = (ms: number) => Math.floor(ms / 60_000) * 60_000;

/**
 * SOL/USD, Global.params and the data source's clock at render time, for the root layout. The clock
 * seeds `useNow()` so relative times in the prerendered HTML ("4m") match hydration; the
 * client takes over with its own clock after mount.
 */
export async function shellSnapshot(): Promise<{ solUsd: number; now: number; params: ProtocolParams }> {
  "use cache";
  cacheLife("minutes");
  const data = getFumpadData();
  const [solUsd, params] = await Promise.all([data.getSolUsd(), data.getParams()]);
  return { solUsd, now: minute(data.now()), params };
}

export async function cachedParams() {
  "use cache";
  cacheLife("minutes");
  return getFumpadData().getParams();
}

export async function cachedSolUsd() {
  "use cache";
  cacheLife("minutes");
  return getFumpadData().getSolUsd();
}

export async function cachedStats() {
  "use cache";
  cacheLife("minutes");
  return getFumpadData().getStats();
}

export async function cachedCoins(opts: { sort?: CoinSort; status?: "curve" | "graduated" | "all"; limit?: number } = {}) {
  "use cache";
  cacheLife("minutes");
  return getFumpadData().listCoins(opts);
}

export async function cachedCoin(symbolOrMint: string) {
  "use cache";
  cacheLife("minutes");
  return getFumpadData().getCoin(symbolOrMint);
}

export async function cachedPriceSeries(mint: Address, range: ChartRange) {
  "use cache";
  cacheLife("minutes");
  return getFumpadData().getPriceSeries(mint, range);
}

export async function cachedHolders(mint: Address, viewer?: Address) {
  "use cache";
  cacheLife("minutes");
  return getFumpadData().getHolders(mint, viewer);
}

export async function cachedRecentFumbles(mint: Address, viewer?: Address) {
  "use cache";
  cacheLife("minutes");
  return getFumpadData().getRecentFumbles(mint, viewer);
}

export async function cachedClaimQueue(mint: Address, viewer?: Address) {
  "use cache";
  cacheLife("minutes");
  return getFumpadData().getClaimQueue(mint, viewer);
}

export async function cachedFeed(opts: { kind?: FeedKind | "all"; limit?: number } = {}) {
  "use cache";
  cacheLife("minutes");
  return getFumpadData().getFeed(opts);
}

export async function cachedClosestTo10x(limit?: number, viewer?: Address) {
  "use cache";
  cacheLife("minutes");
  return getFumpadData().getClosestTo10x(limit, viewer);
}

export async function cachedTickets(owner: Address) {
  "use cache";
  cacheLife("minutes");
  return getFumpadData().getTickets(owner);
}

export async function cachedTicket(id: Address) {
  "use cache";
  cacheLife("minutes");
  return getFumpadData().getTicket(id);
}

export async function cachedLeaderboard(board: Board, viewer?: Address) {
  "use cache";
  cacheLife("minutes");
  return getFumpadData().getLeaderboard(board, viewer);
}

export async function cachedProfile(addressOrName: string) {
  "use cache";
  cacheLife("minutes");
  return getFumpadData().getProfile(addressOrName);
}

export async function cachedPositions(wallet: Address) {
  "use cache";
  cacheLife("minutes");
  return getFumpadData().getPositions(wallet);
}

export async function cachedClosedPositions(wallet: Address) {
  "use cache";
  cacheLife("minutes");
  return getFumpadData().getClosedPositions(wallet);
}

export async function cachedCreatedCoins(wallet: Address) {
  "use cache";
  cacheLife("minutes");
  return getFumpadData().getCreatedCoins(wallet);
}
