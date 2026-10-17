/**
 * `npm run pinata-check -- --env <file>`: does the PINATA_JWT in that env file authenticate against Pinata?
 *
 * Read-only: one `GET https://api.pinata.cloud/data/testAuthentication` with the JWT as Bearer token (nothing is
 * uploaded or pinned). The JWT is read from the file without exporting it and is never printed: the output is
 * PASS / FAIL with the HTTP status, plus whether PINATA_GATEWAY in the same file is well-formed. Exit code 1 on FAIL.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pinataGatewayFromEnv } from "@fumpad/indexer";

import { parseArgs, readEnvValue } from "./common.js";

export const PINATA_AUTH_URL = "https://api.pinata.cloud/data/testAuthentication";

export interface PinataCheck {
  ok: boolean;
  lines: string[];
}

/** The check itself (fetch injectable for tests). The JWT never appears in `lines`. */
export async function checkPinata(jwt: string | undefined, gateway: string | undefined, f: typeof fetch = fetch): Promise<PinataCheck> {
  const lines: string[] = [];
  let ok = true;
  if (!jwt) return { ok: false, lines: ["FAIL  PINATA_JWT is not set in the env file"] };
  if (jwt.split(".").length !== 3) lines.push("WARN  PINATA_JWT doesn't look like a JWT (three dot-separated parts); trying anyway");
  try {
    const res = await f(PINATA_AUTH_URL, { headers: { authorization: `Bearer ${jwt}` }, signal: AbortSignal.timeout(10_000) });
    if (res.ok) lines.push(`PASS  Pinata accepted the JWT (HTTP ${res.status})`);
    else {
      ok = false;
      lines.push(`FAIL  Pinata refused the JWT (HTTP ${res.status}${res.status === 401 || res.status === 403 ? ": wrong, revoked or missing scopes" : ""})`);
    }
  } catch (e) {
    ok = false;
    lines.push(`FAIL  could not reach Pinata (${e instanceof Error ? e.name : "error"})`);
  }
  try {
    const gw = pinataGatewayFromEnv({ PINATA_GATEWAY: gateway } as NodeJS.ProcessEnv);
    lines.push(gw ? `PASS  PINATA_GATEWAY → ${gw}` : "INFO  PINATA_GATEWAY not set (our fetches use the public gateway only)");
  } catch (e) {
    ok = false;
    lines.push(`FAIL  ${e instanceof Error ? e.message : "invalid PINATA_GATEWAY"}`);
  }
  // Belt and braces: never print the secret, whatever an error message carried.
  return { ok, lines: lines.map((l) => l.split(jwt).join("<PINATA_JWT>")) };
}

async function main() {
  const args = parseArgs(["check", ...process.argv.slice(2)]);
  const file = args.get("env");
  if (!file) {
    console.error("usage: npm run pinata-check -- --env <file with PINATA_JWT=…>");
    process.exit(2);
  }
  const r = await checkPinata(readEnvValue(file, "PINATA_JWT")?.trim() || undefined, readEnvValue(file, "PINATA_GATEWAY"));
  for (const l of r.lines) console.log(l);
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`FAIL  ${e instanceof Error ? e.message : "error"}`);
    process.exit(1);
  });
}
