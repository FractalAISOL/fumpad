import type { FumpadData } from "./interface";
import { mockData } from "./mock";

export type * from "./types";
export type { FumpadData, CoinSort, Unsubscribe } from "./interface";
export { DEMO_WALLET, DEMO_NAME } from "./mock";

/**
 * The one place the app chooses a data source. Server and client components both call
 * this. When the indexer ships, return an `ApiFumpadData` (REST + WebSocket) here when
 * `NEXT_PUBLIC_FUMPAD_API` is set.
 */
export function getFumpadData(): FumpadData {
  // TODO(indexer): if (process.env.NEXT_PUBLIC_FUMPAD_API) return apiData;
  return mockData;
}
