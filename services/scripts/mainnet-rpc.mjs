// Read-only mainnet JSON-RPC from the command line (dev helper). URL never printed.
//   node scripts/mainnet-rpc.mjs <method> '<json params>'
// URL: MAINNET_RPC_URL, or FUMPAD_RPC_ENV_FILE (default ~/fumpad-keys/devnet/rpc.env, host devnet→mainnet).
import { homedir } from "node:os";
import { join } from "node:path";
import { mainnetRpcUrl, rpcCall } from "../meteora/scripts/rpc-url.mjs";

const READ_ONLY = /^(get|simulate)/;
const [method, ...rest] = process.argv.slice(2);
if (!method || !READ_ONLY.test(method) || /^send/.test(method)) {
  console.error("usage: mainnet-rpc.mjs <getX method> '<json params>' (read-only methods only)");
  process.exit(2);
}
const env = { ...process.env };
if (!env.MAINNET_RPC_URL && !env.FUMPAD_RPC_ENV_FILE) env.FUMPAD_RPC_ENV_FILE = join(homedir(), "fumpad-keys/devnet/rpc.env");
const url = mainnetRpcUrl(env);
const r = await rpcCall(url, method, JSON.parse(rest.join(" ") || "[]"));
console.log(JSON.stringify(r));
