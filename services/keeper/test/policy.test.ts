import { Keypair, PublicKey } from "@solana/web3.js";
import { pino } from "pino";
import { describe, expect, it } from "vitest";

import { recordSamplesIx } from "@fumpad/sdk";

import { Alerter } from "../src/alerts.js";
import { loadKeeperConfig } from "../src/config.js";
import { Keeper, planAutoClaims, pregradBuybackSlice, withinBand } from "../src/keeper.js";

const kp = Keypair.generate();
const cfg = loadKeeperConfig({ KEEPER_SECRET_KEY: JSON.stringify(Array.from(kp.secretKey)), RPC_URL: "http://127.0.0.1:1" } as NodeJS.ProcessEnv);
const keeper = new Keeper(cfg, pino({ level: "silent" }));
const Q = 1n << 64n;
/** sqrt price (Q64) of a Q64 price */
const sqrtOf = (p: bigint) => {
  let x = 1n << 64n;
  const n = p << 64n;
  for (let i = 0; i < 200; i++) x = (x + n / x) >> 1n;
  return x;
};

const state = (o: { spot: bigint; minTrigger?: bigint; buyback?: bigint }) =>
  ({
    coin: { status: "graduated", buybackLamports: o.buyback ?? 0n },
    damm: { sqrtPrice: sqrtOf(o.spot) },
    minTriggerQ64: o.minTrigger,
    openTickets: o.minTrigger ? 1 : 0,
  }) as unknown as Parameters<Keeper["sampleInterval"]>[0];

describe("keeper sampling policy (SPEC §5.4 / v0.7 §6)", () => {
  it("defaults: 15 s full rate, 8 min heartbeat (< 10 min fallback), keypair from env, v0.7 jobs on", () => {
    expect(cfg.fullRateSecs).toBe(15);
    expect(cfg.heartbeatSecs).toBeLessThan(600);
    expect(cfg.keeper.publicKey.equals(kp.publicKey)).toBe(true);
    expect(cfg.dryRun).toBe(false);
    expect(Object.keys(cfg.jobs).sort()).toEqual(["autoclaim", "buyback", "close", "fees", "graduate", "params", "platform", "queue", "sample"]);
  });
  it("heartbeat for a quiet graduated coin with no open tickets", () => {
    expect(keeper.sampleInterval(state({ spot: Q }))).toBe(cfg.heartbeatSecs);
  });
  it("full rate once spot ≥ 50% of the lowest open trigger", () => {
    expect(keeper.sampleInterval(state({ spot: 49n * Q, minTrigger: 100n * Q }))).toBe(cfg.heartbeatSecs);
    expect(keeper.sampleInterval(state({ spot: 51n * Q, minTrigger: 100n * Q }))).toBe(cfg.fullRateSecs);
  });
  it("full rate while buyback lamports ≥ threshold", () => {
    expect(keeper.sampleInterval(state({ spot: Q, buyback: cfg.buybackMinLamports }))).toBe(cfg.fullRateSecs);
    expect(keeper.sampleInterval(state({ spot: Q, buyback: cfg.buybackMinLamports - 1n }))).toBe(cfg.heartbeatSecs);
  });
  it("record_samples takes 1–10 groups of [coin, pool, observations]", () => {
    expect(recordSamplesIx(kp.publicKey, [{ mint: Keypair.generate().publicKey, pool: Keypair.generate().publicKey }]).keys.length).toBe(5 + 3);
    expect(() => recordSamplesIx(kp.publicKey, Array.from({ length: 11 }, () => ({ mint: Keypair.generate().publicKey, pool: PublicKey.default })))).toThrow();
  });
});

describe("buyback guards (INTERFACE §3)", () => {
  it("pre-grad slice: ≤ 0.5% of the quote reserve and never completes the curve", () => {
    expect(pregradBuybackSlice({ buybackLamports: 10n ** 9n, quoteReserve: 10n ** 10n, threshold: 85n * 10n ** 9n, maxPoolBps: 50 })).toBe(50_000_000n);
    expect(pregradBuybackSlice({ buybackLamports: 10n ** 6n, quoteReserve: 10n ** 10n, threshold: 85n * 10n ** 9n, maxPoolBps: 50 })).toBe(10n ** 6n);
    expect(pregradBuybackSlice({ buybackLamports: 10n ** 9n, quoteReserve: 85n * 10n ** 9n - 100n, threshold: 85n * 10n ** 9n, maxPoolBps: 50 })).toBe(99n);
    expect(pregradBuybackSlice({ buybackLamports: 10n ** 9n, quoteReserve: 85n * 10n ** 9n, threshold: 85n * 10n ** 9n, maxPoolBps: 50 })).toBe(0n);
  });
  it("±band check", () => {
    expect(withinBand(103n, 100n, 300)).toBe(true);
    expect(withinBand(104n, 100n, 300)).toBe(false);
    expect(withinBand(97n, 100n, 300)).toBe(true);
  });
});

describe("auto-claim policy (D17 + v0.7 challenge window)", () => {
  const R = { claimWindowSecs: 1_000n, triggerMultipleBps: 100_000, claimBps: 1_000, maxClaimPoolBps: 1_000 };
  const owner = (n: number) => new PublicKey(Uint8Array.from({ length: 32 }, () => n));
  const t = (o: PublicKey, sellTs: bigint, tokens = 1_000n, price = Q, attestedAt = 0n) => ({
    key: Keypair.generate().publicKey,
    ticket: { owner: o, tokens, sellPriceQ64: price, sellTs, status: "open" as const, attestedAt },
  });
  const base = { optedOut: new Set<string>(), queuedPerOwner: new Map<string, number>(), medianQ64: 10n * Q, now: 500n, rewards: R, challengeSecs: 100n, poolTokens: 10_000n };

  it("claims triggered tickets oldest first; skips below-trigger, expired, zero-amount, in-challenge", () => {
    const a = t(owner(1), 300n);
    const b = t(owner(2), 100n);
    const low = t(owner(3), 50n, 1_000n, 2n * Q);
    const old = t(owner(4), -600n);
    const dust = t(owner(5), 60n, 9n);
    const fresh = t(owner(6), 400n, 1_000n, Q, 450n); // attested at 450, challenge until 550
    const picks = planAutoClaims({ ...base, tickets: [a, b, low, old, dust, fresh] });
    expect(picks.map((x) => x.key)).toEqual([b.key, a.key]);
  });
  it("respects opt-out and the D16 limit (unless the claim pays now)", () => {
    const o = owner(7);
    const small = t(o, 1n, 1_000n);
    const big = t(o, 2n, 20_000n);
    const full = new Map([[o.toBase58(), 2]]);
    expect(planAutoClaims({ ...base, tickets: [small, big], queuedPerOwner: full }).map((x) => x.key)).toEqual([small.key]);
    expect(planAutoClaims({ ...base, tickets: [small, big] })).toHaveLength(2);
    expect(planAutoClaims({ ...base, tickets: [small, big], optedOut: new Set([o.toBase58()]) })).toHaveLength(0);
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
