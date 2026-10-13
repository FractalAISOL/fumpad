/**
 * Shared helpers for the ops scripts (multisig.ts, rpc-check.ts): env files read without exporting or
 * printing them, RPC URLs shown only as a redacted host, keypair files, cluster detection by genesis hash.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { type Connection, Keypair } from "@solana/web3.js";

export const expandHome = (p: string) => resolve(p.replace(/^~(?=$|\/)/, homedir()));

/** One KEY=value from an env file (`export ` prefix and quotes allowed). Never printed. */
export function readEnvValue(file: string, key: string): string | undefined {
  const path = expandHome(file);
  if (!existsSync(path)) throw new Error(`no such env file: ${path}`);
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*?)\\s*$`).exec(line);
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  return undefined;
}

/**
 * "https://devnet.helius-rpc.com/?api-key=abc" → "devnet.helius-rpc.com"; path segments that look like
 * keys (QuickNode / Alchemy put the key in the path) and every query string are dropped.
 */
export function redactHost(url: string): string {
  try {
    const u = new URL(url);
    const tail = u.pathname.split("/").filter(Boolean).length ? "/…" : "";
    return `${u.hostname}${u.port ? `:${u.port}` : ""}${tail}`;
  } catch {
    return "<unparseable url>";
  }
}

/** Removes a secret URL (and anything URL-shaped) from an error message before it is printed. */
export function redactText(text: string, ...secrets: (string | undefined)[]): string {
  let s = text;
  for (const secret of secrets) if (secret) s = s.split(secret).join("<rpc>");
  return s.replace(/(https?|wss?|postgres(ql)?):\/\/[^\s"']+/g, (m) => `<${redactHost(m)}>`).replace(/api[-_]?key=[^&\s"']+/gi, "api-key=<redacted>");
}

export function readKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(expandHome(path), "utf8")) as number[]));
}

export const GENESIS = {
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
} as const;
export type ClusterName = "mainnet" | "devnet" | "testnet" | "local";

export async function detectCluster(conn: Connection): Promise<ClusterName> {
  const g = await conn.getGenesisHash();
  return (Object.entries(GENESIS).find(([, h]) => h === g)?.[0] as ClusterName | undefined) ?? "local";
}

/** Refuses to run unless `--cluster` names the cluster the RPC actually serves (no accidental mainnet writes). */
export async function assertCluster(conn: Connection, expected: string | undefined): Promise<ClusterName> {
  const actual = await detectCluster(conn);
  if (!expected) throw new Error(`pass --cluster ${actual} (the RPC serves ${actual}); required so a wrong env file can't hit the wrong cluster`);
  if (expected !== actual) throw new Error(`--cluster ${expected} but the RPC serves ${actual}: refusing`);
  return actual;
}

/** Minimal `--flag value` / `--switch` parser. */
export function parseArgs(argv: string[]): { cmd: string | undefined; get(n: string): string | undefined; has(n: string): boolean; need(n: string): string } {
  const [cmd, ...rest] = argv;
  const get = (n: string) => {
    const i = rest.indexOf(`--${n}`);
    return i >= 0 && i + 1 < rest.length && !rest[i + 1].startsWith("--") ? rest[i + 1] : undefined;
  };
  return {
    cmd,
    get,
    has: (n) => rest.includes(`--${n}`),
    need(n) {
      const v = get(n);
      if (v === undefined) throw new Error(`missing --${n}`);
      return v;
    },
  };
}
