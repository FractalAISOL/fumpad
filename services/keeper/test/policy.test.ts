import { ComputeBudgetProgram, Keypair, PublicKey } from "@solana/web3.js";
import { pino } from "pino";
import { describe, expect, it } from "vitest";

import { recordSamplesIx } from "@fumpad/sdk/v06";

import { Alerter } from "../src/alerts.js";
import { loadKeeperConfig } from "../src/config.js";
import { Keeper, planAutoClaims } from "../src/keeper.js";

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

describe("auto-claim policy (D17)", () => {
  const P = { claimWindowSecs: 1_000n, triggerMultipleBps: 100_000, claimBps: 1_000, maxClaimPoolBps: 1_000 };
  const owner = (n: number) => new PublicKey(Uint8Array.from({ length: 32 }, () => n));
  const t = (o: PublicKey, sellTs: bigint, tokens = 1_000n, price = Q) => ({ key: Keypair.generate().publicKey, ticket: { owner: o, tokens, sellPriceQ64: price, sellTs, status: "open" as const } });
  const base = { optedOut: new Set<string>(), queuedPerOwner: new Map<string, number>(), medianQ64: 10n * Q, now: 500n, params: P, poolTokens: 10_000n };

  it("claims triggered tickets oldest first; skips below-trigger, expired, zero-amount", () => {
    const a = t(owner(1), 300n);
    const b = t(owner(2), 100n);
    const low = t(owner(3), 50n, 1_000n, 2n * Q); // needs 20× Q
    const old = t(owner(4), -600n); // window ended at 400
    const dust = t(owner(5), 60n, 9n); // 10% of 9 = 0
    const picks = planAutoClaims({ ...base, tickets: [a, b, low, old, dust] });
    expect(picks.map((x) => x.key)).toEqual([b.key, a.key]);
  });
  it("respects opt-out and the D16 limit (unless the claim pays now)", () => {
    const o = owner(7);
    const small = t(o, 1n, 1_000n); // 100 ≤ 10% of 10_000 → pays now
    const big = t(o, 2n, 20_000n); // 2_000 > 1_000 cap → would queue
    const full = new Map([[o.toBase58(), 2]]);
    expect(planAutoClaims({ ...base, tickets: [small, big], queuedPerOwner: full }).map((x) => x.key)).toEqual([small.key]);
    expect(planAutoClaims({ ...base, tickets: [small, big] })).toHaveLength(2);
    expect(planAutoClaims({ ...base, tickets: [small, big], optedOut: new Set([o.toBase58()]) })).toHaveLength(0);
  });
  it("claim_for tx: keeper-paid idempotent owner ATA first, then claim_for; job on by default", () => {
    const o = owner(9);
    const b = keeper.client.buildClaimFor({ keeper: kp.publicKey, mint: PublicKey.default, ticket: Keypair.generate().publicKey, owner: o });
    const ixs = b.instructions.filter((i) => !i.programId.equals(ComputeBudgetProgram.programId));
    expect(ixs).toHaveLength(2);
    expect(ixs[0].keys[0].pubkey.equals(kp.publicKey) && ixs[0].keys[2].pubkey.equals(o)).toBe(true);
    expect(cfg.jobs.autoclaim).toBe(true);
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
