/**
 * Audit 2026-10-17, off-chain parts:
 *  S-3        buybacks: private submission (send RPC / Jito bundleOnly + own preflight), random slice sizes.
 *  ONC-4/L-9  record_samples: jittered schedule (never later than planned); public RPCs refused for sends in prod.
 *  L-10       claim_for creates an owner's ATA at most once per (owner, mint).
 */
import { Keypair, SystemProgram } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadKeeperConfig, publicRpcProblem } from "../src/config.js";
import { randomizedSlice, sampleJitterFactor, shouldCreateOwnerAta } from "../src/keeper.js";
import { JITO_TIP_ACCOUNTS, jitoSendUrl, Sender } from "../src/sender.js";

const key = JSON.stringify(Array.from(Keypair.generate().secretKey));

describe("ONC-4 / L-9: sends never go through a public RPC", () => {
  it("recognizes the public cluster endpoints, not keyed providers or a local validator", () => {
    expect(publicRpcProblem("https://api.mainnet-beta.solana.com")).toMatch(/public/);
    expect(publicRpcProblem("https://api.devnet.solana.com/")).toMatch(/public/);
    expect(publicRpcProblem("https://solana-rpc.publicnode.com")).toMatch(/public/);
    expect(publicRpcProblem("https://mainnet.helius-rpc.com/?api-key=x")).toBeNull();
    expect(publicRpcProblem("http://127.0.0.1:8899")).toBeNull();
  });
  it("production refuses a public send endpoint (RPC_URL or SEND_RPC_URL); mainnet has no override", () => {
    const base = { NODE_ENV: "production", KEEPER_SECRET_KEY: key, DATABASE_URL: "postgres://x" };
    expect(() => loadKeeperConfig({ ...base, RPC_URL: "https://api.mainnet-beta.solana.com" } as NodeJS.ProcessEnv)).toThrow(/private/);
    expect(() => loadKeeperConfig({ ...base, RPC_URL: "https://p.example/k", SEND_RPC_URL: "https://api.mainnet-beta.solana.com" } as NodeJS.ProcessEnv)).toThrow(/SEND_RPC_URL/);
    expect(() => loadKeeperConfig({ ...base, FUMPAD_CLUSTER: "mainnet", ALLOW_PUBLIC_SEND_RPC: "true", RPC_URL: "https://api.mainnet-beta.solana.com" } as NodeJS.ProcessEnv)).toThrow();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadKeeperConfig({ ...base, FUMPAD_CLUSTER: "devnet", ALLOW_PUBLIC_SEND_RPC: "true", RPC_URL: "https://api.devnet.solana.com" } as NodeJS.ProcessEnv).sendRpcUrl).toBe("https://api.devnet.solana.com");
    warn.mockRestore();
    const c = loadKeeperConfig({ ...base, RPC_URL: "https://read.example/k", SEND_RPC_URL: "https://send.example/k", JITO_URL: "https://mainnet.block-engine.jito.wtf/api/v1/transactions", JITO_TIP_LAMPORTS: "5" } as NodeJS.ProcessEnv);
    expect(c.sendRpcUrl).toBe("https://send.example/k");
    expect(c.jito).toEqual({ url: "https://mainnet.block-engine.jito.wtf/api/v1/transactions", tipLamports: 1_000 }); // Jito's minimum
  });
});

describe("ONC-4 / L-9: sample jitter", () => {
  it("U(1 − jitter, 1]: never later than the schedule, capped at 50%", () => {
    expect(sampleJitterFactor(0.3, () => 0)).toBe(1);
    expect(sampleJitterFactor(0.3, () => 0.999)).toBeCloseTo(0.7003, 4);
    expect(sampleJitterFactor(5, () => 1)).toBe(0.5);
    const seen = new Set(Array.from({ length: 50 }, () => sampleJitterFactor(0.3)));
    expect(seen.size).toBeGreaterThan(10);
    for (const f of seen) expect(f > 0.7 && f <= 1).toBe(true);
    // the 480 s heartbeat stays under keeper_stale_secs (600) whatever the draw
    expect(480 * sampleJitterFactor(0.3, () => 0)).toBeLessThan(600);
  });
});

describe("S-3: buyback slice randomization", () => {
  it("U[minFrac, 1] of the program's limit, never above it", () => {
    expect(randomizedSlice(1_000_000n, 0.5, 0n, () => 0)).toBe(500_000n);
    expect(randomizedSlice(1_000_000n, 0.5, 0n, () => 1)).toBe(1_000_000n);
    expect(randomizedSlice(1_000_000n, 0.5, 200_000n, () => 1)).toBe(200_000n);
    expect(randomizedSlice(1n, 0.5, 0n, () => 0)).toBe(1n);
    expect(randomizedSlice(0n, 0.5, 0n)).toBe(0n);
    for (let i = 0; i < 200; i++) {
      const s = randomizedSlice(123_456_789n, 0.3, 0n);
      expect(s >= 37_037_036n && s <= 123_456_789n).toBe(true);
    }
  });
});

describe("L-10: owner ATA rent paid at most once", () => {
  it("existing → none; missing first time → create; missing after we created it → escrow path", () => {
    expect(shouldCreateOwnerAta({ ataExists: true, keeperCreatedBefore: false })).toBe(false);
    expect(shouldCreateOwnerAta({ ataExists: false, keeperCreatedBefore: false })).toBe(true);
    expect(shouldCreateOwnerAta({ ataExists: false, keeperCreatedBefore: true })).toBe(false);
  });
});

describe("S-3: Jito private submission", () => {
  afterEach(() => vi.unstubAllGlobals());
  const log = { info() {}, warn() {}, debug() {}, error() {} };
  const ix = { instructions: [SystemProgram.transfer({ fromPubkey: Keypair.generate().publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })] };

  function conns(simErr: unknown = null) {
    const calls = { read: [] as string[], send: [] as string[] };
    const status = async () => ({ value: [{ err: null, confirmationStatus: "confirmed" }] });
    const read = {
      getRecentPrioritizationFees: async () => [],
      getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 10 }),
      simulateTransaction: async () => (calls.read.push("simulate"), { value: { err: simErr, logs: ["Program log: x"] } }),
      sendRawTransaction: async () => (calls.read.push("sendRaw"), "readsig"),
      getSignatureStatuses: status,
    };
    const send = {
      sendRawTransaction: async () => (calls.send.push("sendRaw"), "sendsig"),
      getSignatureStatuses: async () => (calls.send.push("status"), (await status())),
      getBlockHeight: async () => 1,
    };
    return { calls, read, send };
  }

  it("bundleOnly=true is set on the block-engine URL", () => {
    expect(jitoSendUrl("https://mainnet.block-engine.jito.wtf/api/v1/transactions")).toBe("https://mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true");
  });

  it("non-MEV sends go through the private send connection with preflight on, never the read connection", async () => {
    const { calls, read, send } = conns();
    const s = new Sender(read as never, Keypair.generate(), { dryRun: false, priorityPercentile: 50, priorityMinMicroLamports: 0, priorityMaxMicroLamports: 1, sendConn: send as never }, log as never);
    const r = await s.send("record_samples", ix);
    expect(r).toMatchObject({ ok: true, signature: "sendsig" });
    expect(calls.read).not.toContain("sendRaw");
    expect(calls.send).toContain("sendRaw");
  });

  it("mev sends: simulate first, POST to Jito with a tip, no rebroadcast through an RPC", async () => {
    const { calls, read, send } = conns();
    const posted: { url: string; body: { method: string; params: [string, { encoding: string }] } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      posted.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ result: "jitosig" }) };
    });
    const s = new Sender(read as never, Keypair.generate(), { dryRun: false, priorityPercentile: 50, priorityMinMicroLamports: 0, priorityMaxMicroLamports: 1, sendConn: send as never, jito: { url: "https://be.example/api/v1/transactions", tipLamports: 2_000 } }, log as never);
    const r = await s.send("execute_buyback", ix, { mev: true });
    expect(r).toMatchObject({ ok: true, signature: "jitosig" });
    expect(calls.read).toEqual(["simulate"]);
    expect(calls.send).not.toContain("sendRaw");
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toContain("bundleOnly=true");
    expect(posted[0].body.method).toBe("sendTransaction");
    expect(posted[0].body.params[1]).toEqual({ encoding: "base64" });
    // the tx carries a transfer to one of Jito's tip accounts
    const raw = Buffer.from(posted[0].body.params[0], "base64");
    expect(JITO_TIP_ACCOUNTS.some((k) => raw.includes(k.toBuffer()))).toBe(true);
    expect(s.stats.jito).toBe(1);
  });

  it("mev sends: a failing preflight is never sent", async () => {
    const { read, send } = conns({ InstructionError: [1, { Custom: 6010 }] });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const s = new Sender(read as never, Keypair.generate(), { dryRun: false, priorityPercentile: 50, priorityMinMicroLamports: 0, priorityMaxMicroLamports: 1, sendConn: send as never, jito: { url: "https://be.example/api/v1/transactions", tipLamports: 2_000 } }, log as never);
    const r = await s.send("execute_buyback", ix, { mev: true });
    expect(r).toMatchObject({ ok: false, code: 6010 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
