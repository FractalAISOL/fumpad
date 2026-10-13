/**
 * L8: an RPC provider with incomplete history (pruned ledger, partial archive) derives a different coin
 * history forever. Checked at startup and periodically: the provider's first available block must not be
 * after a coin's launch slot; such coins are refused (derivation error + alert) instead of derived from a
 * partial history. Per coin, derive.ts additionally requires the pool-creation tx in the crawled history.
 */
import type { MeteoraRpc } from "@fumpad/meteora";
import type { CoinAccount, GlobalAccount } from "@fumpad/sdk";

import type { Derivation } from "./derive.js";

export async function firstAvailableSlot(rpc: Pick<MeteoraRpc, "call">): Promise<number> {
  return Number(await rpc.call<number>("getFirstAvailableBlock", []));
}

export class RpcHistoryIncomplete extends Error {}

/** Wrap a derive function so coins launched before the RPC's first available block are refused. */
export function guardHistory(
  rpc: Pick<MeteoraRpc, "call">,
  derive: (coin: CoinAccount, g: GlobalAccount) => Promise<Derivation>,
  opts: { refreshSecs?: number; now?: () => number; onFloor?: (slot: number) => void } = {},
): (coin: CoinAccount, g: GlobalAccount) => Promise<Derivation> {
  let floor: number | null = null;
  let at = 0;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  return async (coin, g) => {
    if (floor === null || now() - at > (opts.refreshSecs ?? 3_600)) {
      floor = await firstAvailableSlot(rpc);
      at = now();
      opts.onFloor?.(floor);
    }
    if (BigInt(floor) > coin.launchSlot) {
      throw new RpcHistoryIncomplete(`RPC history starts at slot ${floor}, after the launch of ${coin.mint.toBase58()} (slot ${coin.launchSlot}): use an archive RPC`);
    }
    return derive(coin, g);
  };
}
