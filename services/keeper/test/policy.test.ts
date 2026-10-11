import { ComputeBudgetProgram, Keypair, PublicKey } from "@solana/web3.js";
import { pino } from "pino";
import { describe, expect, it } from "vitest";

import { recordSamplesIx } from "@fumpad/sdk";

import { Alerter } from "../src/alerts.js";
import { loadKeeperConfig } from "../src/config.js";
import { Keeper } from "../src/keeper.js";

const kp = Keypair.generate();
const cfg = loadKeeperConfig({ KEEPER_SECRET_KEY: JSON.stringify(Array.from(kp.secretKey)), RPC_URL: "http://127.0.0.1:1" } as NodeJS.ProcessEnv);
const keeper = new Keeper(cfg, pino({ level: "silent" }));
const Q = 1n << 64n;

const state = (o: { spot: bigint; minTrigger?: bigint; buyback?: bigint }) =>
  ({
    mint: PublicKey.default,
    coin: { buybackLamports: o.buyback ?? 0n },
    pool: { base: 1_000_000n, quote: (o.spot * 1_000_000n) / Q },
    minTriggerQ64: o.minTrigger,
    openTickets: o.minTrigger ? 1 : 0,
  }) as unknown as Parameters<Keeper["sampleInterval"]>[0];

describe("keeper sampling policy (SPEC §5.4)", () => {
  it("defaults: 15 s full rate, 8 min heartbeat (< 10 min fallback), keypair from env", () => {
    expect(cfg.fullRateSecs).toBe(15);
    expect(cfg.heartbeatSecs).toBeLessThan(600);
    expect(cfg.keeper.publicKey.equals(kp.publicKey)).toBe(true);
    expect(cfg.dryRun).toBe(false);
  });
  it("heartbeat for a quiet graduated coin with no open tickets", () => {
    expect(keeper.sampleInterval(state({ spot: Q }))).toBe(cfg.heartbeatSecs);
  });
  it("full rate once spot ≥ 50% of the lowest open trigger", () => {
    expect(keeper.sampleInterval(state({ spot: 49n * Q, minTrigger: 100n * Q }))).toBe(cfg.heartbeatSecs);
    expect(keeper.sampleInterval(state({ spot: 50n * Q, minTrigger: 100n * Q }))).toBe(cfg.fullRateSecs);
  });
  it("full rate while buyback lamports ≥ threshold (execute_buyback needs a median)", () => {
    expect(keeper.sampleInterval(state({ spot: Q, buyback: cfg.buybackMinLamports }))).toBe(cfg.fullRateSecs);
    expect(keeper.sampleInterval(state({ spot: Q, buyback: cfg.buybackMinLamports - 1n }))).toBe(cfg.heartbeatSecs);
  });
  it("sampling tx stays isolated: only compute-budget ixs besides record_samples", () => {
    const b = keeper.client.buildRecordSamples({ sampler: kp.publicKey, mints: [Keypair.generate().publicKey] });
    const others = b.instructions.filter((i) => !i.programId.equals(ComputeBudgetProgram.programId));
    expect(others).toHaveLength(1);
    expect(others[0].data.equals(recordSamplesIx({ sampler: kp.publicKey, mints: [PublicKey.default] }).data)).toBe(true);
  });
  it("record_samples rejects > 10 coins", () => {
    expect(() => recordSamplesIx({ sampler: kp.publicKey, mints: Array.from({ length: 11 }, () => Keypair.generate().publicKey) })).toThrow();
  });
});

describe("alerts", () => {
  it("dedupes per key within the cooldown and works without Telegram configured", async () => {
    const a = new Alerter(pino({ level: "silent" }), {});
    expect(a.enabled).toBe(false);
    await a.alert("x", "one");
    await a.alert("x", "two");
    expect(a.sent).toBe(0);
  });
});
