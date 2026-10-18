/**
 * Launch-day gate for the launch page. The API decides (`LAUNCHES_OPEN`, services/api config): while standard
 * launches are closed, `POST /v1/launch/prepare` refuses them with 403 `{code: "launches_closed"}` (every launch
 * needs the API's co-signature, so this holds on chain too) and `GET /v1/launch/options` says
 * `{launchesOpen: false}`. The page then shows "Launches open soon." instead of the form; the one-off first-coin
 * launch (`/launch?config=first-coin`) keeps its form while the API offers it. The API offers the first-coin config
 * only to its allow-listed creator wallet (FIRST_COIN_CREATOR, external audit 2026-10-17 S-2), so the page asks with
 * the connected wallet (`?creator=`).
 *
 * No React, no `@/` imports: unit-tested by `launchGate.test.ts` with `npm test`.
 */

/** The 403 code `POST /v1/launch/prepare` answers with while standard launches are closed. */
export const LAUNCHES_CLOSED_CODE = "launches_closed";

/** `GET /v1/launch/options`. */
export interface LaunchOptions {
  /** False while standard launches are closed (before the public opening). */
  launchesOpen: boolean;
  /** The one-off first-coin config, when this API offers it right now. */
  firstCoin: { dbcConfig: string; wallet: string; buybackShareBps: number; walletShareBps: number; launchesLeft: number | null } | null;
}

/**
 * Parses `GET /v1/launch/options`. An API from before the switch has no `launchesOpen`: treated as open (it never
 * refused standard launches). Anything that isn't an object is null (unknown).
 */
export function parseLaunchOptions(json: unknown): LaunchOptions | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  const fc = o.firstCoin;
  return {
    launchesOpen: o.launchesOpen !== false,
    firstCoin: fc && typeof fc === "object" ? (fc as LaunchOptions["firstCoin"]) : null,
  };
}

/**
 * Fetches the launch options; null when the API can't be reached or answers badly (the API still enforces the gate).
 * `creator`: the connected wallet, so the API can show it the first-coin option (it does for FIRST_COIN_CREATOR only).
 */
export async function fetchLaunchOptions(api: string, fetchFn: typeof fetch = fetch, creator?: string): Promise<LaunchOptions | null> {
  try {
    const q = creator ? `?creator=${encodeURIComponent(creator)}` : "";
    const res = await fetchFn(`${api}/v1/launch/options${q}`, { headers: { accept: "application/json" }, cache: "no-store" });
    if (!res.ok) return null;
    return parseLaunchOptions(await res.json());
  } catch {
    return null;
  }
}

export type LaunchPageState = "loading" | "form" | "closed";

/**
 * What the launch page shows.
 * - `options`: undefined while loading; null when unknown (no API configured, or it couldn't be read): the form,
 *   since the API refuses a closed launch anyway and the page then switches to "closed" (`closedByApi`).
 * - `wantFirstCoin`: the page was opened as `/launch?config=first-coin`.
 * - `closedByApi`: a prepare call came back 403 `launches_closed`.
 */
export function launchPageState(options: LaunchOptions | null | undefined, wantFirstCoin: boolean, closedByApi = false): LaunchPageState {
  const firstCoinOffered = wantFirstCoin && !!options?.firstCoin;
  if (closedByApi && !firstCoinOffered) return "closed";
  if (options === undefined) return "loading";
  if (options === null || options.launchesOpen) return "form";
  return firstCoinOffered ? "form" : "closed";
}
