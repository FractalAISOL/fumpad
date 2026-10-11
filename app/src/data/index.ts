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
