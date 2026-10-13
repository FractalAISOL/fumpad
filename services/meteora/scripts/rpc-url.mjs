// Mainnet RPC URL for the read-only scripts in this package. Never printed.
//   MAINNET_RPC_URL=...            explicit (preferred)
//   FUMPAD_RPC_ENV_FILE=path       a file with RPC_URL=<helius devnet url>; the host's "devnet" is
//                                  rewritten to "mainnet" (same key works on both clusters)
//   (neither)                      public https://api.mainnet-beta.solana.com (slow, rate-limited)
import { readFileSync } from "node:fs";

export const PUBLIC_MAINNET = "https://api.mainnet-beta.solana.com";

export function mainnetRpcUrl(env = process.env) {
  if (env.MAINNET_RPC_URL) return env.MAINNET_RPC_URL;
  if (env.FUMPAD_RPC_ENV_FILE) {
    const m = /^\s*RPC_URL\s*=\s*["']?([^"'\s]+)/m.exec(readFileSync(env.FUMPAD_RPC_ENV_FILE, "utf8"));
    if (!m) throw new Error("FUMPAD_RPC_ENV_FILE has no RPC_URL");
    const u = new URL(m[1]);
    u.hostname = u.hostname.replace("devnet", "mainnet");
    return u.toString();
  }
  return PUBLIC_MAINNET;
}

/** Log-safe form: origin only (API keys live in the query string). */
export const redact = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return "<invalid url>";
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;

/** JSON-RPC call with a minimum gap between requests and exponential backoff on 429/5xx. */
export async function rpcCall(url, method, params, { minGapMs = 200, attempts = 8 } = {}) {
  let lastErr = "";
  for (let a = 0; a < attempts; a++) {
    const wait = last + minGapMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    let res;
    try {
      res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    } catch (e) {
      lastErr = String(e).replace(url, redact(url));
      await sleep(500 * 2 ** a);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = `HTTP ${res.status}`;
      await sleep(500 * 2 ** a);
      continue;
    }
    const j = await res.json();
    if (j.error) {
      if (j.error.code === 429 || /rate limit/i.test(String(j.error.message))) {
        lastErr = "rate limited";
        await sleep(500 * 2 ** a);
        continue;
      }
      throw new Error(`${method}: ${String(j.error.message).slice(0, 200)}`);
    }
    return j.result;
  }
  throw new Error(`${method}: gave up (${lastErr})`);
}
