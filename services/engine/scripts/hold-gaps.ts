// Dev helper: for each sell in a fixture, seconds since the trader's first acquisition.
//   npx tsx engine/scripts/hold-gaps.ts coin_a
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { buildEvents, type CoinFacts, type HistoryTx, sortEvents } from "../src/index.js";

const f = JSON.parse(gunzipSync(readFileSync(`engine/test/fixtures/${process.argv[2]}.history.json.gz`)).toString()) as {
  coin: CoinFacts & { startSqrtPrice: string };
  history: HistoryTx[];
};
const coin = { ...f.coin, startSqrtPrice: BigInt(f.coin.startSqrtPrice), dammPool: null };
const first = new Map<string, number>();
const gaps: number[] = [];
const ts = f.history.map((h) => h.tx.blockTime ?? 0);
for (const e of sortEvents(buildEvents(coin, f.history))) {
  const w = e.kind === "swap" ? e.trader : e.kind === "transfer" ? e.owner : null;
  if (!w) continue;
  const inflow = (e.kind === "swap" && e.side === "buy") || (e.kind === "transfer" && e.delta > 0n);
  if (inflow && !first.has(w)) first.set(w, e.blockTime);
  if (e.kind === "swap" && e.side === "sell") gaps.push(first.has(w) ? e.blockTime - first.get(w)! : -1);
}
console.log("history span (s):", Math.max(...ts) - Math.min(...ts));
console.log(gaps.sort((a, b) => a - b).join(" "));
