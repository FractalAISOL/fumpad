/**
 * `npm run local:app` — the whole v0.7 stack (scripts/local/stack.ts) kept running for the app: API on
 * http://127.0.0.1:18080, RPC on http://127.0.0.1:8899, plus funded local test wallets (keypairs in
 * services/.local, never committed). Writes services/.local/app-stack.json for the app's headless driver
 * (app/scripts/local-app-e2e.ts) and prints the app env. Ctrl-C stops everything.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { airdrop } from "./actors.js";
import { keypair, keypairPath, LOCAL } from "./harness.js";
import { startStack } from "./stack.js";

const WALLETS: Record<string, number> = { "app-creator": 20, "app-trader": 20, "app-trader2": 20, "app-whale": 60 };

const port = (v: string | undefined) => (v ? Number(v) : undefined);
const stack = await startStack({ poolTarget: 3, rpcPort: port(process.env.FUMPAD_RPC_PORT), apiPort: port(process.env.FUMPAD_API_PORT) });
const wallets: Record<string, { address: string; keypair: string }> = {};
for (const [name, sol] of Object.entries(WALLETS)) {
  const k = keypair(name);
  await airdrop(stack.conn, k.publicKey, sol);
  wallets[name] = { address: k.publicKey.toBase58(), keypair: keypairPath(name) };
}
const info = { rpcUrl: stack.v.rpcUrl, wsUrl: stack.v.wsUrl, api: stack.api, dbcConfig: stack.config.publicKey.toBase58(), wallets };
writeFileSync(join(LOCAL, "app-stack.json"), JSON.stringify(info, null, 2));
console.log(`
local v0.7 stack ready (${join(LOCAL, "app-stack.json")})
  rpc  ${info.rpcUrl}
  api  ${info.api}
  app  NEXT_PUBLIC_FUMPAD_API=${info.api} NEXT_PUBLIC_SOLANA_RPC=${info.rpcUrl} npm run dev
Ctrl-C to stop.`);

const stop = async () => {
  stack.dumpLogs("app-stack-logs", () => {});
  await stack.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
await new Promise(() => {});
