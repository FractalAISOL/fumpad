/**
 * The single-wallet admin signing page, end to end, on a local validator (the real FUMPAD program, a Global seeded
 * with a pending propose_admin whose eta has passed) and headless Chromium with MOCK injected wallets (no real
 * wallet, nothing on mainnet):
 *  - admin-sign-core builds + simulates the proposals against the chain and refuses the wrong signer;
 *  - accept_admin through the page with a mock `window.phantom.solana` provider: connect → (no auto-sign) → click →
 *    fresh blockhash → simulate → mock signTransaction → sent through the 127.0.0.1 proxy → confirmed; Global.admin moves;
 *  - set_pause(launch) by the new admin + guardian through a mock Wallet Standard wallet → confirmed; Global.paused = 1;
 *  - a wallet connected with another address is refused (nothing signed); no CSP violations.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Run against whatever id contracts/target/deploy/fumpad.so declares (the default devnet id, or one of
// contracts/program-ids/*.txt when the last build was build-program.ts for that id): set before the SDK loads.
vi.hoisted(async () => {
  const { existsSync, readdirSync, readFileSync } = await import("node:fs");
  const { join, resolve } = await import("node:path");
  const { PublicKey: Pk } = await import("@solana/web3.js");
  const contracts = resolve(import.meta.dirname, "../../../contracts");
  const so = join(contracts, "target/deploy/fumpad.so");
  if (process.env.FUMPAD_PROGRAM_ID || !existsSync(so)) return;
  const bytes = readFileSync(so);
  const ids = ["5YMFbHZsEaebs1Ac9P8bPe3nfh1oxbemVRcLBAcxS9Fb", ...readdirSync(join(contracts, "program-ids")).map((f) => readFileSync(join(contracts, "program-ids", f), "utf8").split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() ?? "")];
  for (const id of ids) {
    try {
      if (bytes.indexOf(Buffer.from(new Pk(id).toBytes())) >= 0) {
        process.env.FUMPAD_PROGRAM_ID = id;
        return;
      }
    } catch {
      /* UNSET placeholder */
    }
  }
});

import { decodeGlobal, DEFAULT_PARAMS, FUMPAD_PROGRAM_ID, globalPda } from "@fumpad/sdk";

import { CONTRACTS, SERVICES, startValidator, type Validator } from "../../scripts/local/harness.js";
import { buildProposal, connectionChain } from "../../scripts/mainnet/admin-sign-core.js";
import { type AdminSignServer, bundlePage, startAdminSignServer } from "../../scripts/mainnet/admin-sign-server.js";
import { b64, type Proposal, proposalProblems } from "../../scripts/mainnet/admin-sign-tx.js";

type Browser = import("playwright-core").Browser;
type Page = import("playwright-core").Page;

const RPC_PORT = 18_899;
const solanaBin = join(process.env.HOME ?? "", ".local/share/solana/install/active_release/bin/solana-test-validator");
const ready = existsSync(join(CONTRACTS, "target/deploy/fumpad.so")) && existsSync(solanaBin);

const oldAdmin = Keypair.generate();
const wallet = Keypair.generate(); // the single admin + guardian wallet (held by the MOCK provider)
const treasury = Keypair.generate().publicKey;
let v: Validator;
let conn: Connection;
let browser: Browser;
let bundle: string;
const servers: AdminSignServer[] = [];

const globalNow = async () => decodeGlobal(new Uint8Array((await conn.getAccountInfo(globalPda(), "confirmed"))!.data));

/** Mock wallet providers, injected before the page loads. Signing happens in Node (exposed function) with `wallet`. */
function mockWalletScript(kind: "phantom" | "standard", address: string) {
  return `(() => {
    window.__signCalls = 0;
    const addr = ${JSON.stringify(address)};
    const b64e = (u8) => btoa(Array.from(u8, (c) => String.fromCharCode(c)).join(""));
    const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    if (${JSON.stringify(kind)} === "phantom") {
      window.phantom = { solana: { isPhantom: true, publicKey: null,
        async connect() { this.publicKey = { toBase58: () => addr }; return { publicKey: this.publicKey }; },
        async signTransaction(tx) {
          window.__signCalls++;
          const signed = await window.__mockSign(b64e(tx.serialize({ requireAllSignatures: false, verifySignatures: false })));
          return { serialize: () => b64d(signed) };
        } } };
    } else {
      const acct = { address: addr, publicKey: new Uint8Array(32), chains: ["solana:localnet"], features: ["solana:signTransaction"] };
      const wallet = { version: "1.0.0", name: "MockStandard", icon: "data:,", chains: ["solana:localnet"], accounts: [], features: {
        "standard:connect": { version: "1.0.0", connect: async () => { wallet.accounts = [acct]; return { accounts: [acct] }; } },
        "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy"], signTransaction: async (...inputs) => {
          window.__signCalls++;
          const out = [];
          for (const i of inputs) {
            if (i.chain !== "solana:localnet") throw new Error("wrong chain " + i.chain);
            out.push({ signedTransaction: b64d(await window.__mockSign(b64e(i.transaction))) });
          }
          return out;
        } } } };
      window.addEventListener("wallet-standard:app-ready", (e) => e.detail.register(wallet));
      window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: (api) => api.register(wallet) }));
    }
  })();`;
}

async function openPage(p: Proposal, kind: "phantom" | "standard", address = wallet.publicKey.toBase58()): Promise<{ page: Page; srv: AdminSignServer; cspErrors: string[] }> {
  const srv = await startAdminSignServer({ proposal: p, rpcUrl: v.rpcUrl, bundle, log: () => {} });
  servers.push(srv);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cspErrors: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) cspErrors.push(m.text());
  });
  page.on("pageerror", (e) => cspErrors.push(`pageerror: ${e.message}`));
  await page.exposeFunction("__mockSign", (wire: string) => {
    const tx = Transaction.from(b64.decode(wire));
    tx.partialSign(wallet);
    return b64.encode(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
  });
  await page.addInitScript(mockWalletScript(kind, address));
  await page.goto(srv.url);
  await page.waitForSelector("body[data-state=ready]", { timeout: 15_000 });
  return { page, srv, cspErrors };
}

const state = (page: Page) => page.evaluate(() => document.body.dataset.state);
const signCalls = (page: Page) => page.evaluate(() => (window as unknown as { __signCalls: number }).__signCalls);
async function waitLanded(page: Page) {
  await page.waitForFunction(() => ["confirmed", "finalized", "failed", "error", "error-after-send"].includes(document.body.dataset.state ?? ""), undefined, { timeout: 90_000 });
  const s = await state(page);
  if (s !== "confirmed" && s !== "finalized") throw new Error(`page ended in ${s}: ${await page.textContent("#log")}`);
}

describe.skipIf(!ready)("admin signing page (local validator + headless Chromium + mock wallet)", () => {
  beforeAll(async () => {
    const { chromium } = await import("playwright-core");
    // own gossip / dynamic ports: runs next to another local validator (8899 / 8000) without colliding
    process.env.FUMPAD_GOSSIP_PORT ??= "18000";
    v = await startValidator({
      rpcPort: RPC_PORT,
      upgradeAuthority: oldAdmin,
      global: {
        admin: oldAdmin.publicKey,
        platformTreasury: Keypair.generate().publicKey,
        keepers: [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey],
        operators: [Keypair.generate().publicKey],
        params: DEFAULT_PARAMS,
        configs: [],
        pendingAdmin: { admin: wallet.publicKey, guardian: wallet.publicKey, treasury, eta: 1n },
      },
    });
    conn = new Connection(v.rpcUrl, "confirmed");
    const sig = await conn.requestAirdrop(wallet.publicKey, LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
    bundle = await bundlePage();
    browser = await chromium.launch({ headless: true });
  }, 180_000);
  afterAll(async () => {
    for (const s of servers) await s.close();
    await browser?.close();
    await v?.stop();
  });

  it("refuses proposals the chain would reject (wrong signer: not the pending admin / not yet the guardian)", async () => {
    const chain = connectionChain(conn);
    await expect(buildProposal({ action: "accept-admin", cluster: "local", signer: Keypair.generate().publicKey }, chain)).rejects.toThrow(/wrong signer: the pending admin is/);
    await expect(buildProposal({ action: "accept-admin", cluster: "local", signer: oldAdmin.publicKey }, chain)).rejects.toThrow(/already the admin/);
    await expect(buildProposal({ action: "set-pause", cluster: "local", signer: wallet.publicKey, pauseBits: 1 }, chain)).rejects.toThrow(/wrong signer/);
  });

  it("accept_admin: build + simulate (CLI core), then sign with a mock Phantom on the page → confirmed, Global.admin = the wallet", async () => {
    const p = await buildProposal({ action: "accept-admin", cluster: "local", signer: wallet.publicKey }, connectionChain(conn));
    expect(p.simulation.unitsConsumed).toBeGreaterThan(0);
    const { page, srv, cspErrors } = await openPage(p, "phantom");
    expect(await page.textContent("#title")).toBe("Accept the FUMPAD admin role");
    expect(await page.textContent("#signer")).toBe(wallet.publicKey.toBase58());
    expect(await page.isDisabled("#sign")).toBe(true);
    await page.click('button[data-wallet="Phantom"]');
    await page.waitForSelector("body[data-state=connected]");
    expect(await page.isEnabled("#sign")).toBe(true);
    expect(await signCalls(page)).toBe(0); // never signs before the click
    await page.click("#sign");
    await waitLanded(page);
    expect(await signCalls(page)).toBe(1);
    const sig = (await page.textContent("#result"))!.replace("Signature: ", "").trim();
    expect(sig.length).toBeGreaterThan(80);
    expect(srv.sent()).not.toBeNull();
    const g = await globalNow();
    expect(g.admin.equals(wallet.publicKey)).toBe(true);
    expect(g.guardian.equals(wallet.publicKey)).toBe(true);
    expect(g.platformTreasury.equals(treasury)).toBe(true);
    expect(g.pendingAdminEta).toBe(0n);
    // one action per page load: the button stays off
    expect(await page.isDisabled("#sign")).toBe(true);
    expect(cspErrors).toEqual([]);
  }, 180_000);

  it("set_pause(launch) by the single admin + guardian through a mock Wallet Standard wallet → confirmed, Global.paused = 1", async () => {
    const p = await buildProposal({ action: "set-pause", cluster: "local", signer: wallet.publicKey, pauseBits: 1 }, connectionChain(conn));
    expect(p.signerRole).toBe("admin + guardian");
    const { page, cspErrors } = await openPage(p, "standard");
    await page.click('button[data-wallet="MockStandard"]');
    await page.waitForSelector("body[data-state=connected]");
    await page.click("#sign");
    await waitLanded(page);
    expect(await signCalls(page)).toBe(1);
    expect((await globalNow()).paused).toBe(1);
    expect(cspErrors).toEqual([]);
  }, 180_000);

  it("refuses a wallet connected with another address (nothing signed)", async () => {
    const p = await buildProposal({ action: "set-pause", cluster: "local", signer: wallet.publicKey, pauseBits: 0 }, connectionChain(conn));
    const other = Keypair.generate().publicKey.toBase58();
    const { page } = await openPage(p, "phantom", other);
    await page.click('button[data-wallet="Phantom"]');
    await page.waitForSelector("body[data-state=wrong-wallet]");
    expect(await page.textContent("#wallet-status")).toContain("REFUSED");
    expect(await page.isDisabled("#sign")).toBe(true);
    expect(await signCalls(page)).toBe(0);
    expect((await globalNow()).paused).toBe(1); // unchanged
    expect(new PublicKey(p.signer).equals(wallet.publicKey)).toBe(true);
  }, 60_000);

  it("the CLIs: admin-sign.ts writes a proposal (or refuses with the reason, no file); admin-sign-server.ts serves it on 127.0.0.1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fumpad-admin-sign-"));
    writeFileSync(join(dir, "rpc.env"), `RPC_URL=${v.rpcUrl}\n`);
    const env = { ...process.env, FUMPAD_PROGRAM_ID: FUMPAD_PROGRAM_ID.toBase58() };
    const cli = (args: string[]) => spawnSync("npx", ["tsx", "scripts/mainnet/admin-sign.ts", "--cluster", "local", "--rpc-env", join(dir, "rpc.env"), "--program-id", FUMPAD_PROGRAM_ID.toBase58(), "--signer", wallet.publicKey.toBase58(), ...args], { cwd: SERVICES, env, encoding: "utf8" });
    const bad = cli(["--action", "accept-admin", "--out", join(dir, "bad.json")]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/already the admin/);
    expect(existsSync(join(dir, "bad.json"))).toBe(false);
    const ok = cli(["--action", "set-pause", "--bits", "none", "--out", join(dir, "unpause.json")]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain("UNPAUSE FUMPAD");
    const p = JSON.parse(readFileSync(join(dir, "unpause.json"), "utf8")) as Proposal;
    expect(proposalProblems(p)).toEqual([]);
    // the server CLI: prints the URL, serves only to Host 127.0.0.1:<port>
    const srv = spawn("npx", ["tsx", "scripts/mainnet/admin-sign-server.ts", "--proposal", join(dir, "unpause.json"), "--rpc-env", join(dir, "rpc.env")], { cwd: SERVICES, env, stdio: ["ignore", "pipe", "pipe"] });
    try {
      let out = "";
      srv.stdout.on("data", (d) => (out += d));
      for (let i = 0; i < 120 && !/open → (http:\/\/127\.0\.0\.1:\d+\/)/.test(out); i++) await new Promise((r) => setTimeout(r, 250));
      const url = /open → (http:\/\/127\.0\.0\.1:\d+\/)/.exec(out)?.[1];
      expect(url).toBeTruthy();
      expect(out).not.toContain(v.rpcUrl);
      const page = await fetch(url!);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(JSON.parse(await (await fetch(`${url}proposal.json`)).text()).title).toBe("UNPAUSE FUMPAD");
    } finally {
      srv.kill("SIGINT");
    }
  }, 120_000);
});
