/** Local admin signing server (scripts/mainnet/admin-sign-server.ts): Host check, RPC allow-list, send rules, CSP, no RPC URL leaks. */
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setPauseIx } from "@fumpad/sdk";

import { type AdminSignServer, bundlePage, CSP, startAdminSignServer } from "../../scripts/mainnet/admin-sign-server.js";
import { b64, buildProposalTx, ixToJson, maxFeeLamports, type Proposal } from "../../scripts/mainnet/admin-sign-tx.js";

const GENESIS = "LocalGenesis1111111111111111111111111111111";
const wallet = Keypair.generate();

const proposal: Proposal = {
  version: 1,
  action: "set-pause",
  cluster: "local",
  genesisHash: GENESIS,
  programId: setPauseIx(wallet.publicKey, 0).programId.toBase58(),
  signer: wallet.publicKey.toBase58(),
  signerRole: "guardian",
  title: "Guardian drill",
  summary: ["harmless"],
  accounts: [],
  values: [],
  instructions: [ixToJson(setPauseIx(wallet.publicKey, 0))],
  computeUnitLimit: 30_000,
  computeUnitPriceMicroLamports: 1_000,
  maxFeeLamports: maxFeeLamports(30_000, 1_000),
  createdAt: "2026-10-18T00:00:00.000Z",
  simulation: { unitsConsumed: 1, logs: [] },
};

// fake upstream RPC: records methods; its URL carries a "secret" that must never reach the browser
let upstream: Server;
let upstreamUrl = "";
const calls: string[] = [];
let srv: AdminSignServer;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const j = JSON.parse(b) as { id: number; method: string; params: unknown[] };
      calls.push(j.method);
      const reply = (x: object) => res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, ...x }));
      if (j.method === "getGenesisHash") return reply({ result: GENESIS });
      if (j.method === "getBalance") return reply({ result: { context: { slot: 1 }, value: 123 } });
      if (j.method === "getAccountInfo") return reply({ error: { code: -32000, message: `upstream ${upstreamUrl} exploded` } });
      if (j.method === "sendTransaction") {
        const tx = b64.decode((j.params as [string])[0]);
        return reply({ result: bs58.encode(tx.subarray(1, 65)) });
      }
      if (j.method === "getSignatureStatuses") return reply({ result: { context: { slot: 1 }, value: [null] } });
      return reply({ result: null });
    });
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", () => ok()));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/?api-key=SECRETKEY`;
  srv = await startAdminSignServer({ proposal, rpcUrl: upstreamUrl, bundle: "/* test bundle */", log: () => {} });
});
afterAll(async () => {
  await srv?.close();
  upstream?.closeAllConnections();
  await new Promise<void>((ok) => upstream.close(() => ok()));
});

function req(o: { path: string; method?: string; host?: string; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((ok, fail) => {
    const data = o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body);
    const r = request(
      { host: "127.0.0.1", port: srv.port, path: o.path, method: o.method ?? (data ? "POST" : "GET"), headers: { Host: o.host ?? `127.0.0.1:${srv.port}`, ...(data ? { "content-type": "application/json" } : {}), ...o.headers } },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => ok({ status: res.statusCode!, headers: res.headers, body: b }));
      },
    );
    r.on("error", fail);
    if (data) r.write(data);
    r.end();
  });
}
const rpc = (method: string, params: unknown[] = [], extra: Partial<Parameters<typeof req>[0]> = {}) => req({ path: "/rpc", body: { jsonrpc: "2.0", id: 7, method, params }, ...extra });

describe("admin-sign server", () => {
  it("binds 127.0.0.1 on a random port and serves the page with a strict CSP and no RPC URL", async () => {
    expect(srv.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    for (const path of ["/", "/app.js", "/app.css", "/proposal.json"]) {
      const r = await req({ path });
      expect(r.status).toBe(200);
      expect(r.headers["content-security-policy"]).toBe(CSP);
      expect(r.headers["x-frame-options"]).toBe("DENY");
      expect(r.body).not.toContain("SECRETKEY");
      expect(r.body).not.toContain(upstreamUrl.split("/?")[0]);
    }
    expect(CSP).toContain("script-src 'self'");
    expect(CSP).not.toMatch(/unsafe-inline|unsafe-eval|https:/);
    expect(JSON.parse((await req({ path: "/proposal.json" })).body)).toEqual(proposal);
    expect((await req({ path: "/nope" })).status).toBe(404);
    expect((await req({ path: "/", method: "PUT" })).status).toBe(405);
  });
  it("refuses any Host but 127.0.0.1:<port> (DNS rebinding)", async () => {
    for (const host of ["localhost:" + srv.port, "evil.example", `127.0.0.1:${srv.port + 1}`, `evil.example:${srv.port}`]) {
      expect((await req({ path: "/", host })).status).toBe(421);
      expect((await rpc("getBalance", [proposal.signer], { host })).status).toBe(421);
    }
  });
  it("forwards only the allow-listed RPC methods", async () => {
    const before = calls.length;
    for (const m of ["requestAirdrop", "getProgramAccounts", "getGenesisHash", "getTransaction", "sendRawTransaction", "", "__proto__"]) {
      const r = await rpc(m);
      expect(r.status).toBe(403);
      expect(JSON.parse(r.body).error.message).toMatch(/not allowed/);
    }
    expect(calls.length).toBe(before); // nothing reached the upstream
    const ok = await rpc("getBalance", [proposal.signer]);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ jsonrpc: "2.0", id: 7, result: { context: { slot: 1 }, value: 123 } });
    expect(calls.at(-1)).toBe("getBalance");
  });
  it("refuses batches, cross-origin / cross-site posts, non-JSON bodies; redacts upstream errors", async () => {
    expect((await req({ path: "/rpc", body: [{ jsonrpc: "2.0", id: 1, method: "getBalance", params: [] }] })).status).toBe(400);
    expect((await rpc("getBalance", [], { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await rpc("getBalance", [], { headers: { origin: `http://127.0.0.1:${srv.port}`, "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await rpc("getBalance", [], { headers: { origin: `http://127.0.0.1:${srv.port}`, "sec-fetch-site": "same-origin" } })).status).toBe(200);
    expect((await req({ path: "/rpc", body: "method=getBalance", headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(415);
    expect((await req({ path: "/rpc", body: "{nope" })).status).toBe(400);
    expect((await req({ path: "/rpc", body: { jsonrpc: "2.0", id: 1, method: "getBalance", params: "x".repeat(70_000) } })).status).toBe(413);
    const err = await rpc("getAccountInfo", [proposal.signer]);
    expect(err.body).not.toContain("SECRETKEY");
    expect(err.body).not.toContain(upstreamUrl);
  });
  it("sendTransaction: only the proposal's tx signed by the signer, then only that same tx (one action per run)", async () => {
    const bh = () => Keypair.generate().publicKey.toBase58();
    const send = (tx: { serialize(): Uint8Array }) => rpc("sendTransaction", [b64.encode(tx.serialize()), { encoding: "base64" }]);
    // signed by the wrong key / different instruction / unsigned → refused, nothing forwarded
    const before = calls.length;
    const wrong = Keypair.generate();
    const t1 = buildProposalTx({ ...proposal, signer: wrong.publicKey.toBase58(), instructions: [ixToJson(setPauseIx(wrong.publicKey, 0))] }, bh());
    t1.sign(wrong);
    expect((await send(t1)).status).toBe(403);
    const t2 = buildProposalTx({ ...proposal, instructions: [ixToJson(setPauseIx(wallet.publicKey, 31))] }, bh());
    t2.sign(wallet);
    const r2 = await send(t2);
    expect(r2.status).toBe(403);
    expect(JSON.parse(r2.body).error.message).toMatch(/instructions differ/);
    const unsigned = buildProposalTx(proposal, bh());
    expect((await rpc("sendTransaction", [b64.encode(unsigned.serialize({ requireAllSignatures: false })), { encoding: "base64" }])).status).toBe(403);
    expect((await rpc("sendTransaction", ["AAAA", {}])).status).toBe(400);
    expect(calls.length).toBe(before);
    // the right one goes through
    const good = buildProposalTx(proposal, bh());
    good.sign(wallet);
    const r = await send(good);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).result).toBe(bs58.encode(good.signature!));
    expect(srv.sent()).toBe(Buffer.from(good.signature!).toString("hex"));
    // rebroadcast of the same bytes: allowed; a second, different (valid) tx: refused
    expect((await send(good)).status).toBe(200);
    const again = buildProposalTx(proposal, bh());
    again.sign(wallet);
    expect((await send(again)).status).toBe(409);
  });
  it("refuses an RPC serving another chain, and an invalid proposal", async () => {
    await expect(startAdminSignServer({ proposal: { ...proposal, genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" }, rpcUrl: upstreamUrl, bundle: "x", log: () => {} })).rejects.toThrow(/refusing/);
    await expect(startAdminSignServer({ proposal: { ...proposal, action: "drain" as never }, rpcUrl: upstreamUrl, bundle: "x", log: () => {} })).rejects.toThrow(/unsupported action/);
  });
  it("bundles the page locally (web3.js inside, no external script)", async () => {
    const js = await bundlePage();
    expect(js.length).toBeGreaterThan(50_000);
    expect(js).toContain("wallet-standard:app-ready");
    expect(js).not.toMatch(/<script|importScripts\(/);
  }, 60_000);
});
