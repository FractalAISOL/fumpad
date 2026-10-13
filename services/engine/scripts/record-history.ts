// Record the complete finalized history of a mainnet DBC coin as a golden fixture (read-only).
//   FUMPAD_RPC_ENV_FILE=~/fumpad-keys/devnet/rpc.env npx tsx engine/scripts/record-history.ts <mint> [name]
// Writes engine/test/fixtures/<name>.history.json.gz: { coin, maxSlot, accounts, history: [{txIndex, tx}] }.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { MeteoraRpc } from "@fumpad/meteora";

import { crawlMintHistory, deriveCoinFacts } from "../src/index.js";
// @ts-expect-error untyped .mjs helper
import { mainnetRpcUrl } from "../../meteora/scripts/rpc-url.mjs";

const mint = process.argv[2];
const name = process.argv[3] ?? mint.slice(0, 8);
if (!mint) throw new Error("usage: record-history.ts <mint> [name]");
const rpc = new MeteoraRpc(mainnetRpcUrl() as string, { minGapMs: 100 });
const crawl = await crawlMintHistory(rpc, mint, { onProgress: (m) => process.stderr.write(`\r${m}    `), maxTxs: 5_000 });
const coin = await deriveCoinFacts(rpc, mint, crawl.history);
const out = {
  recordedAt: new Date().toISOString(),
  coin: { ...coin, startSqrtPrice: coin.startSqrtPrice.toString() },
  maxSlot: crawl.maxSlot,
  accounts: crawl.accounts,
  history: crawl.history,
};
const file = join(dirname(fileURLToPath(import.meta.url)), `../test/fixtures/${name}.history.json.gz`);
writeFileSync(file, gzipSync(JSON.stringify(out), { level: 9 }));
console.error(`\n${name}: ${crawl.history.length} txs, ${crawl.accounts.length} token accounts → ${file}`);
