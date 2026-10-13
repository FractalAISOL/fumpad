/**
 * Re-fetch the mainnet fixtures in test/fixtures (read-only `getTransaction` calls, finalized).
 *
 *   MAINNET_RPC_URL=... npm run fixtures -w @fumpad/meteora
 *   FUMPAD_RPC_ENV_FILE=~/fumpad-keys/devnet/rpc.env npm run fixtures -w @fumpad/meteora
 *   (neither → public api.mainnet-beta.solana.com)
 *
 * Trimmed: `meta.logMessages` and `meta.rewards` are dropped (the parser never reads logs; events come
 * from inner instructions). Everything else is stored exactly as the RPC returned it.
 * The URL is never printed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MeteoraRpc } from "../src/rpc.js";
import { FIXTURES } from "../test/fixtures/index.js";

function mainnetUrl(): string {
  if (process.env.MAINNET_RPC_URL) return process.env.MAINNET_RPC_URL;
  if (process.env.FUMPAD_RPC_ENV_FILE) {
    const m = /^\s*RPC_URL\s*=\s*["']?([^"'\s]+)/m.exec(readFileSync(process.env.FUMPAD_RPC_ENV_FILE, "utf8"));
    if (!m) throw new Error("FUMPAD_RPC_ENV_FILE has no RPC_URL");
    const u = new URL(m[1]);
    u.hostname = u.hostname.replace("devnet", "mainnet");
    return u.toString();
  }
  return "https://api.mainnet-beta.solana.com";
}

const dir = join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures");
const rpc = new MeteoraRpc(mainnetUrl(), { minGapMs: 250 });
const only = new Set(process.argv.slice(2));

for (const f of FIXTURES) {
  if (only.size && !only.has(f.name)) continue;
  const tx = (await rpc.getTransaction(f.signature, "finalized", f.encoding ?? "json")) as Record<string, unknown> | null;
  if (!tx) throw new Error(`${f.name}: ${f.signature} not found`);
  const meta = tx.meta as Record<string, unknown>;
  delete meta.logMessages;
  delete meta.rewards;
  writeFileSync(join(dir, `${f.name}.json`), JSON.stringify(tx) + "\n");
  console.log(`${f.name}: ${f.signature.slice(0, 16)}… slot ${tx.slot as number} v${String(tx.version)}`);
}
