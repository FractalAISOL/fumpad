/**
 * FUMPAD single-wallet admin: the LOCAL signing page server (runbook: services/LAUNCH-DAY.md "single-wallet admin").
 *
 *   npx tsx scripts/mainnet/admin-sign-server.ts --proposal <file from admin-sign.ts> --rpc-env ~/fumpad-keys/mainnet/rpc.env
 *   → prints http://127.0.0.1:<random port>/ : open it in the browser that has the admin wallet extension.
 *
 * Bound to 127.0.0.1 only; requests whose Host is not exactly 127.0.0.1:<port> are refused (DNS rebinding), POSTs from
 * another origin too. Serves one page (+ its bundled script / style: @solana/web3.js bundled locally with esbuild, no
 * CDN), the proposal, and a JSON-RPC proxy that forwards ONLY getLatestBlockhash, simulateTransaction,
 * sendTransaction, getSignatureStatuses, getAccountInfo, getBalance to the RPC from the env file (the URL never reaches
 * the browser). sendTransaction is forwarded only for a transaction signed by the proposal's signer whose
 * instructions are exactly the proposal's, and after one is accepted only that same transaction (rebroadcasts):
 * one action per server run. No keys here; the wallet signs.
 * Flags: --proposal <file> (required) · --rpc-env <file> (RPC_URL=…; default ~/fumpad-keys/mainnet/rpc.env) · --port <n>
 * (default: a random free port).
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Transaction } from "@solana/web3.js";

import { readEnvValue, redactText } from "../ops/common.js";
import { b64, type Proposal, proposalProblems, RPC_ALLOW, signedTxProblems } from "./admin-sign-tx.js";
import { expandHome } from "./keys.js";

const here = dirname(fileURLToPath(import.meta.url));
const PAGE_DIR = join(here, "admin-sign-page");
const MAX_BODY = 64 * 1024;

export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-store",
};

/** Bundle the page script (web3.js included) for the browser, in memory. */
export async function bundlePage(): Promise<string> {
  const { build } = await import("esbuild");
  const r = await build({
    entryPoints: [join(PAGE_DIR, "page.ts")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
    legalComments: "none",
    define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
    logLevel: "silent",
  });
  return r.outputFiles[0].text;
}

export interface AdminSignServer {
  url: string;
  port: number;
  /** the signature of the transaction sent through the proxy (one per run), once the RPC accepted it */
  sent(): string | null;
  close(): Promise<void>;
}

export interface ServerOpts {
  proposal: Proposal;
  rpcUrl: string;
  port?: number;
  log?: (s: string) => void;
  /** a pre-built page script (tests build it once); default: bundlePage() */
  bundle?: string;
}

/** JSON-RPC call to the upstream RPC (never logs or returns the URL). */
async function upstream(rpcUrl: string, body: unknown): Promise<unknown> {
  const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}

export async function startAdminSignServer(o: ServerOpts): Promise<AdminSignServer> {
  const log = o.log ?? ((s: string) => console.log(s));
  const say = (s: string) => log(redactText(s, o.rpcUrl));
  const problems = proposalProblems(o.proposal);
  if (problems.length) throw new Error(`proposal invalid: ${problems.join("; ")}`);
  const p = o.proposal;
  // the RPC must serve the chain the proposal was built (and simulated) on
  const gen = (await upstream(o.rpcUrl, { jsonrpc: "2.0", id: 1, method: "getGenesisHash" }).catch((e) => ({ error: { message: String(e) } }))) as { result?: string; error?: { message: string } };
  if (!gen.result) throw new Error(redactText(`RPC getGenesisHash failed: ${gen.error?.message ?? "no result"}`, o.rpcUrl));
  if (gen.result !== p.genesisHash) throw new Error(`the RPC serves genesis ${gen.result}, the proposal was built on ${p.genesisHash} (${p.cluster}): refusing`);

  const files: Record<string, { type: string; body: string }> = {
    "/": { type: "text/html; charset=utf-8", body: readFileSync(join(PAGE_DIR, "index.html"), "utf8") },
    "/app.css": { type: "text/css; charset=utf-8", body: readFileSync(join(PAGE_DIR, "style.css"), "utf8") },
    "/app.js": { type: "text/javascript; charset=utf-8", body: o.bundle ?? (await bundlePage()) },
    "/proposal.json": { type: "application/json; charset=utf-8", body: JSON.stringify(p) },
  };
  let port = 0;
  let sentSig: string | null = null;
  let watching = false;
  let closed = false;

  const send = (res: ServerResponse, status: number, type: string, body: string) => {
    res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  };
  const rpcReply = (res: ServerResponse, id: unknown, payload: { result?: unknown; error?: { code: number; message: string } }, status = 200) =>
    send(res, status, "application/json; charset=utf-8", JSON.stringify({ jsonrpc: "2.0", id: id ?? null, ...payload }));

  /** Server-side status print (the page polls too): confirmed → finalized. */
  const watch = async (sig: string) => {
    if (watching) return;
    watching = true;
    let last = "";
    for (let i = 0; i < 180 && !closed; i++) {
      await new Promise((r) => setTimeout(r, 1_000));
      const r = (await upstream(o.rpcUrl, { jsonrpc: "2.0", id: 1, method: "getSignatureStatuses", params: [[sig], { searchTransactionHistory: true }] }).catch(() => null)) as { result?: { value: ({ err: unknown; confirmationStatus?: string } | null)[] } } | null;
      const st = r?.result?.value?.[0];
      if (!st) continue;
      if (st.err) return say(`✗ ${sig} FAILED on chain: ${JSON.stringify(st.err)}`);
      if (st.confirmationStatus && st.confirmationStatus !== last) {
        last = st.confirmationStatus;
        say(`  ${sig}: ${last}`);
        if (last === "finalized") return say("✓ done (one action per run: Ctrl-C to stop the server)");
      }
    }
  };

  const handleRpc = async (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://127.0.0.1:${port}`) return rpcReply(res, null, { error: { code: -32600, message: "cross-origin request refused" } }, 403);
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin") return rpcReply(res, null, { error: { code: -32600, message: "cross-site request refused" } }, 403);
    if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return rpcReply(res, null, { error: { code: -32600, message: "content-type must be application/json" } }, 415);
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size <= MAX_BODY) chunks.push(c as Buffer); // past the cap: drain, then refuse
    }
    if (size > MAX_BODY) return rpcReply(res, null, { error: { code: -32600, message: "request too large" } }, 413);
    let body: { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return rpcReply(res, null, { error: { code: -32700, message: "parse error" } }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return rpcReply(res, null, { error: { code: -32600, message: "single JSON-RPC requests only (no batches)" } }, 400);
    const { id, method, params } = body;
    if (typeof method !== "string" || !(RPC_ALLOW as readonly string[]).includes(method)) {
      say(`  refused RPC method ${JSON.stringify(method).slice(0, 60)}`);
      return rpcReply(res, id, { error: { code: -32601, message: `method not allowed by the local proxy (${RPC_ALLOW.join(", ")})` } }, 403);
    }
    if (params !== undefined && !Array.isArray(params)) return rpcReply(res, id, { error: { code: -32602, message: "params must be an array" } }, 400);
    let sig: string | null = null;
    if (method === "sendTransaction") {
      const [wire, cfg] = (params ?? []) as [unknown, { encoding?: string } | undefined];
      if (typeof wire !== "string" || cfg?.encoding !== "base64") return rpcReply(res, id, { error: { code: -32602, message: "sendTransaction: base64 transaction + {encoding: 'base64'} required" } }, 400);
      let tx: Transaction;
      try {
        tx = Transaction.from(b64.decode(wire));
      } catch (e) {
        return rpcReply(res, id, { error: { code: -32602, message: `not a legacy transaction: ${(e as Error).message}` } }, 400);
      }
      const bad = signedTxProblems(p, tx);
      if (bad.length) {
        say(`  refused sendTransaction: ${bad.join("; ")}`);
        return rpcReply(res, id, { error: { code: -32003, message: `refused by the local proxy: ${bad.join("; ")}` } }, 403);
      }
      sig = Buffer.from(tx.signature!).toString("hex");
      if (sentSig !== null && sentSig !== sig) {
        say("  refused a second, different transaction (one action per run: restart the server with a new proposal)");
        return rpcReply(res, id, { error: { code: -32003, message: "this server already sent its one transaction (rebroadcasts of it only)" } }, 409);
      }
    }
    let out: { result?: unknown; error?: { code: number; message: string } };
    try {
      out = (await upstream(o.rpcUrl, { jsonrpc: "2.0", id: id ?? 1, method, params: params ?? [] })) as typeof out;
    } catch (e) {
      return rpcReply(res, id, { error: { code: -32000, message: redactText(`RPC unreachable: ${(e as Error).message}`, o.rpcUrl) } }, 502);
    }
    if (out.error) out.error.message = redactText(String(out.error.message), o.rpcUrl);
    if (sig && typeof out.result === "string") {
      if (sentSig === null) {
        sentSig = sig;
        say(`→ sent ${out.result} (signed by ${p.signer})`);
        void watch(out.result);
      }
    }
    return rpcReply(res, id, { result: out.result, error: out.error });
  };

  const server: Server = createServer((req, res) => {
    // DNS rebinding: only the literal loopback origin we printed
    if (req.headers.host !== `127.0.0.1:${port}`) return send(res, 421, "text/plain; charset=utf-8", "wrong Host: open the exact URL printed by admin-sign-server\n");
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "POST" && path === "/rpc") {
      handleRpc(req, res).catch((e) => rpcReply(res, null, { error: { code: -32000, message: redactText(String(e), o.rpcUrl) } }, 500));
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "text/plain; charset=utf-8", "method not allowed\n");
    const f = files[path];
    if (!f) return send(res, 404, "text/plain; charset=utf-8", "not found\n");
    return send(res, 200, f.type, f.body);
  });
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(o.port ?? 0, "127.0.0.1", () => ok());
  });
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    sent: () => sentSig,
    close: () => new Promise<void>((ok) => {
      closed = true;
      server.closeAllConnections();
      server.close(() => ok());
    }),
  };
}

export function parseServerCli(argv: string[]): { proposalPath: string; rpcUrl: string; port?: number } {
  const vals: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!["--proposal", "--rpc-env", "--port"].includes(argv[i])) throw new Error(`unknown flag ${argv[i]}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${argv[i]} needs a value`);
    vals[argv[i]] = v;
    i++;
  }
  if (!vals["--proposal"]) throw new Error("--proposal <file from admin-sign.ts> is required");
  const env = expandHome(vals["--rpc-env"] ?? join(homedir(), "fumpad-keys/mainnet/rpc.env"));
  const rpcUrl = readEnvValue(env, "RPC_URL");
  if (!rpcUrl) throw new Error(`no RPC_URL in ${env}`);
  const port = vals["--port"] !== undefined ? Number(vals["--port"]) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535)) throw new Error("--port: 1024 … 65535");
  return { proposalPath: resolve(expandHome(vals["--proposal"])), rpcUrl, port };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let secret = "";
  try {
    const a = parseServerCli(process.argv.slice(2));
    secret = a.rpcUrl;
    const proposal = JSON.parse(readFileSync(a.proposalPath, "utf8")) as Proposal;
    const s = await startAdminSignServer({ proposal, rpcUrl: a.rpcUrl, port: a.port });
    console.log(`\n${proposal.title}  [${proposal.cluster}]  signer ${proposal.signer}`);
    console.log(`\n  open → ${s.url}\n\n  (127.0.0.1 only · one action · Ctrl-C to stop)`);
    process.on("SIGINT", () => void s.close().then(() => process.exit(0)));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`✗ ${secret ? redactText(msg, secret) : msg}`);
    process.exit(1);
  }
}
