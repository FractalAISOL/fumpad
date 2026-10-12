import type { FumpadData } from "./interface";
import { apiDataFromEnv } from "./api";
import { mockData } from "./mock";

export type * from "./types";
export type { FumpadData, CoinSort, Unsubscribe } from "./interface";
export { DEMO_WALLET, DEMO_NAME } from "./mock";

/**
 * The one place the app chooses a data source. Server and client components both call
 * this. Uses the live API (REST + WebSocket) when `NEXT_PUBLIC_FUMPAD_API` is set,
 * otherwise the deterministic mock.
 */
export function getFumpadData(): FumpadData {
  return apiDataFromEnv() ?? mockData;
}

/**
 * `.catch` for client refreshes on top of server-rendered data: when the API is briefly
 * unreachable (or blocks this origin), keep showing the snapshot instead of throwing an
 * unhandled rejection. Logged so it isn't silent in development.
 */
export function keepSnapshot(err: unknown): void {
  console.warn("[fumpad] refresh failed, keeping the last data:", err instanceof Error ? err.message : err);
}
