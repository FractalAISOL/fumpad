// Dev helper: replay a golden fixture and print a summary (issues, reasons, rebuys).
//   npx tsx engine/scripts/inspect-fixture.ts coin_a [signature-to-dump]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { normalizeTx, ownerDeltas, parseMeteoraTrades } from "@fumpad/meteora";

import { buildEvents, type CoinFacts, DEFAULT_ENGINE_PARAMS, type HistoryTx, runEngine } from "../src/index.js";

const name = process.argv[2];
const f = JSON.parse(gunzipSync(readFileSync(join(dirname(fileURLToPath(import.meta.url)), `../test/fixtures/${name}.history.json.gz`))).toString()) as {
  coin: CoinFacts & { startSqrtPrice: string };
  history: HistoryTx[];
};
const coin: CoinFacts = { ...f.coin, startSqrtPrice: BigInt(f.coin.startSqrtPrice), dammPool: null };
const events = buildEvents(coin, f.history);
const r = runEngine(coin, events, process.env.RELAXED ? { ...DEFAULT_ENGINE_PARAMS, minHoldSecs: 1n, minSellUsdCents: 50n } : DEFAULT_ENGINE_PARAMS, (t) => ({ price: 150_00000000n, conf: 0n, expo: -8, publishTime: t - 1 }));
if (!r.done) throw new Error("prices");
const o = r.output;
const reasons = new Map<string, number>();
for (const s of o.sells) reasons.set(s.reason ?? "TICKET", (reasons.get(s.reason ?? "TICKET") ?? 0) + 1);
console.log({ coin: { ...coin, startSqrtPrice: String(coin.startSqrtPrice) }, events: events.length, sells: o.sells.length, reasons: Object.fromEntries(reasons), rebuys: o.rebuys.length, issues: o.issues });
const dump = process.argv[3];
if (dump) {
  const h = f.history.find((x) => x.tx.transaction.signatures[0] === dump)!;
  const n = normalizeTx(h.tx);
  console.log("deltas", ownerDeltas(n, coin.mint));
  const p = parseMeteoraTrades(h.tx, { baseMints: new Set([coin.mint]) });
  console.log("trades", p.trades.map((t) => ({ pool: t.pool, side: t.side, trader: t.trader, src: t.traderSource, base: t.baseAmount })), "issues", p.issues);
  console.log(events.filter((e) => e.signature === dump));
}
