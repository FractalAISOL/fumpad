// SOL/USD source wiring: PYTH_SOURCE=onchain is the production default (free, chain-native), hermes stays
// selectable, constant is local-only; a not-yet-final price window is a quiet retry for the watcher.
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { HermesPythSource, OnchainPythSource, PriceNotReady } from "@fumpad/engine";

import { pythSourceFromEnv } from "../src/attest/run.js";
import { Watcher } from "../src/watch/run.js";

const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;

describe("pythSourceFromEnv", () => {
  it("production defaults to onchain (PYTH_RPC_URL, else RPC_URL); hermes and constant stay explicit", () => {
    expect(pythSourceFromEnv(env({ NODE_ENV: "production", RPC_URL: "https://rpc.example" }))).toBeInstanceOf(OnchainPythSource);
    expect(pythSourceFromEnv(env({ NODE_ENV: "production", PYTH_RPC_URL: "https://mainnet.example" }))).toBeInstanceOf(OnchainPythSource);
    expect(() => pythSourceFromEnv(env({ NODE_ENV: "production" }))).toThrow(/PYTH_RPC_URL/);
    expect(pythSourceFromEnv(env({ NODE_ENV: "production", PYTH_SOURCE: "hermes", PYTH_API_KEY: "k" }))).toBeInstanceOf(HermesPythSource);
    expect(() => pythSourceFromEnv(env({ NODE_ENV: "production", PYTH_SOURCE: "constant" }))).toThrow(/local chains only/);
    expect(() => pythSourceFromEnv(env({ PYTH_SOURCE: "nope" }))).toThrow(/unknown PYTH_SOURCE/);
  });

  it("onchain refuses a non-mainnet RPC at startup", async () => {
    const fetchCalls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      fetchCalls.push(JSON.parse(String(init.body)).method);
      return Response.json({ jsonrpc: "2.0", id: 1, result: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" }); // devnet genesis
    }) as typeof fetch;
    try {
      const src = pythSourceFromEnv(env({ NODE_ENV: "production", RPC_URL: "https://devnet.example" })) as OnchainPythSource;
      await expect(src.verifyCluster()).rejects.toThrow(/not Solana mainnet/);
      expect(fetchCalls).toEqual(["getGenesisHash"]);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("watcher + PriceNotReady", () => {
  it("skips the coin quietly (no error, no alert) and keeps its last result", async () => {
    const alerts: string[] = [];
    const mint = Keypair.generate().publicKey;
    const w = new Watcher({
      coins: async () => [{ mint } as never],
      global: async () => ({ params: { ticketChallengeSecs: 21_600n, maxAttestAgeSecs: 86_400n } }) as never,
      derive: async () => {
        throw new PriceNotReady(1_800_000_000, 1_800_000_030, 1_800_000_000);
      },
      alerts: { alert: async (k: string) => void alerts.push(k) },
      now: () => 1_800_000_100,
    });
    await w.tick();
    expect(w.stats.errors).toBe(0);
    expect(alerts).toEqual([]);
    expect(w.results.size).toBe(0);
  });
});
