// External audit 2026-10-17 — keeper side: S-1 (crawl-budget alert after N ticks, adaptive budget), H-1 (rebuy
// submission budget per ticket / coin, low-balance alert), L-6 (alert identity = mint + issue kind, alerts never
// awaited in the hot loop).
import { Keypair, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import pino from "pino";
import { describe, expect, it } from "vitest";

import { CrawlBudgetExceeded, type EngineIssue, type EngineOutput } from "@fumpad/engine";
import { type CoinAccount, DEFAULT_PARAMS, type GlobalAccount } from "@fumpad/sdk";

import { Alerter } from "../src/alerts.js";
import { Attestor, type ChainView, groupIssues, issueAlertKey } from "../src/attest/attestor.js";
import { MemoryBoard } from "../src/attest/board.js";
import { coinBudget, type Derivation, engineOverridesFromEnv, newCaches } from "../src/attest/derive.js";
import { deriveLimitsFromEnv, minAttestorLamports } from "../src/attest/run.js";
import { Watcher } from "../src/watch/run.js";

const log = pino({ level: "silent" });
const NOW = 1_800_000_000;
const keepers = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
const mint = Keypair.generate().publicKey;
const owner = Keypair.generate().publicKey;
const coin = { mint, attestCursor: 0n, totalSupply: 1_000_000_000_000_000n } as CoinAccount;
const global = { keepers: keepers.map((k) => k.publicKey), keeperAddedAt: [0n, 0n, 0n], paused: 0, pauseExpiresAt: 0n, clusterTag: 2, params: DEFAULT_PARAMS } as unknown as GlobalAccount;
const sigN = (n: number) => bs58.encode(Uint8Array.from({ length: 64 }, (_, i) => (i + n) & 0xff));

class Chain implements ChainView {
  async global() {
    return global;
  }
  async coins() {
    return [coin];
  }
  async accountsExist(keys: PublicKey[]) {
    return keys.map(() => false);
  }
  async position() {
    return null;
  }
  async ticket() {
    return { status: "open" } as never;
  }
}

class Sub {
  calls: TransactionInstruction[][] = [];
  async submit(_l: string, ixs: TransactionInstruction[]) {
    this.calls.push(ixs);
    return { ok: false, error: "simulated failure" }; // never lands: every tick would resend
  }
}

/** n rebuy debits on `tickets` distinct tickets (round robin), all fresh. */
function rebuys(n: number, tickets: string[]): EngineOutput {
  return {
    mint: mint.toBase58(),
    sells: [],
    rebuys: Array.from({ length: n }, (_, i) => ({
      signature: sigN(i),
      ixKey: 0xffff_ffff,
      kind: "transfer_in" as const,
      slot: 100 + i,
      blockTime: NOW - 600 + i,
      wallet: owner.toBase58(),
      ticket: { signature: sigN(1_000), ixKey: 0 },
      ticketAddress: tickets[i % tickets.length],
      debit: 1_000_000n,
      remaining: 9_000_000n,
      voided: false,
    })),
    issues: [],
    reference: { avgQ64: 0n, lastSpotQ64: 0n, updatedAt: 0n },
    lastKey: null,
  };
}
const der = (o: EngineOutput): Derivation => ({ coin: { mint: mint.toBase58() } as never, output: o, maxSlot: 1_000, txCount: 1, history: [] });

/** The real Alerter (dedupe per key + cooldown), recording what it would send. */
function alertsSink() {
  const sent: { key: string; text: string }[] = [];
  const l = { warn: (o: { alert?: string }, text: string) => o.alert && sent.push({ key: o.alert, text }) };
  return { sent, alerts: new Alerter(l as never, { now: () => NOW * 1000 }) };
}

/** A hanging Telegram: alert() never settles (L-6: the loops must not wait for it). */
function hangingSink() {
  const sent: { key: string; text: string }[] = [];
  return { sent, alerts: { alert: (key: string, text: string) => (sent.push({ key, text }), new Promise<void>(() => {})) } };
}

describe("H-1: rebuy submissions are budgeted per ticket and per coin; low balance alerts", () => {
  it("per ticket: at most 6 submissions per hour; the rest are deferred (still signed), alert deduped per coin", async () => {
    const board = new MemoryBoard(() => NOW * 1000);
    const sub = new Sub();
    const ticket = Keypair.generate().publicKey.toBase58();
    const out = rebuys(20, [ticket]);
    const { sent, alerts } = alertsSink();
    const atts = keepers.map((k) => new Attestor({ keeper: k, chain: new Chain(), derive: async () => der(structuredClone(out)), board, submitter: sub, log, now: () => NOW, alerts, fallbackSubmitSecs: 0 }));
    for (const a of atts) await a.tick();
    for (const a of atts) await a.tick();
    const per = atts.map((a) => a.stats.submitted);
    for (const n of per) expect(n).toBeLessThanOrEqual(6);
    expect(atts.reduce((s, a) => s + a.stats.rebuyDeferred, 0)).toBeGreaterThan(0);
    expect(atts.every((a) => a.stats.signed === 20)).toBe(true); // signed and published regardless
    expect(new Set(sent.filter((s) => s.key.startsWith("rebuy-budget:")).map((s) => s.key))).toEqual(new Set([`rebuy-budget:${mint.toBase58()}`]));
  });

  it("per coin: at most N submissions per hour across tickets", async () => {
    const board = new MemoryBoard(() => NOW * 1000);
    const sub = new Sub();
    const tickets = Array.from({ length: 40 }, () => Keypair.generate().publicKey.toBase58());
    const out = rebuys(40, tickets);
    const a = new Attestor({ keeper: keepers[0], chain: new Chain(), derive: async () => der(structuredClone(out)), board, submitter: sub, log, now: () => NOW, fallbackSubmitSecs: 0, rebuyPerCoinPerHour: 10 });
    const b = new Attestor({ keeper: keepers[1], chain: new Chain(), derive: async () => der(structuredClone(out)), board, submitter: new Sub(), log, now: () => NOW, fallbackSubmitSecs: 0, rebuyPerCoinPerHour: 10 });
    await b.tick(); // peer signature on the board
    await a.tick();
    await a.tick();
    expect(a.stats.submitted).toBe(10);
  });

  it("low balance: alerts (once per hour), reports it on /health stats", async () => {
    const { sent, alerts } = alertsSink();
    const a = new Attestor({ keeper: keepers[0], chain: new Chain(), derive: async () => der(rebuys(0, [])), board: new MemoryBoard(), submitter: new Sub(), log, now: () => NOW, alerts, balance: async () => 50_000_000, minLamports: minAttestorLamports({}) });
    await a.tick();
    await a.tick();
    expect(a.stats.balanceLamports).toBe(50_000_000);
    expect(sent.filter((s) => s.key === "balance")).toHaveLength(1);
    expect(minAttestorLamports({ MIN_KEEPER_LAMPORTS: "7" })).toBe(7);
    expect(minAttestorLamports({ MIN_KEEPER_LAMPORTS: "7", MIN_ATTESTOR_LAMPORTS: "9" })).toBe(9);
  });
});

describe("S-1: a coin whose crawl keeps running out of budget alerts after N ticks (deduped); the budget adapts", () => {
  it("attestor: 3 ticks quiet (warn log), alert on the 4th, once; recovery resets the count", async () => {
    const { sent, alerts } = alertsSink();
    let fail = true;
    const a = new Attestor({
      keeper: keepers[0],
      chain: new Chain(),
      derive: async () => {
        if (fail) throw new CrawlBudgetExceeded(mint.toBase58(), 5_000);
        return der(rebuys(0, []));
      },
      board: new MemoryBoard(),
      submitter: new Sub(),
      log,
      now: () => NOW,
      alerts,
    });
    for (let i = 0; i < 3; i++) await a.tick();
    expect(sent.filter((s) => s.key.startsWith("crawl-budget:"))).toHaveLength(0);
    for (let i = 0; i < 5; i++) await a.tick();
    expect(sent.filter((s) => s.key === `crawl-budget:${mint.toBase58()}`)).toHaveLength(1);
    expect(a.stats.crawlBudgetExceeded).toBe(8);
    fail = false;
    await a.tick();
    expect(a.stats.coinsDerived).toBe(1);
  });

  it("watcher: same rule (it used to alert it as a derivation failure)", async () => {
    const { sent, alerts } = alertsSink();
    const w = new Watcher({
      coins: async () => [coin],
      global: async () => ({ ...global, pendingEta: 0n, pendingConfigEta: 0n, pendingAdminEta: 0n }) as never,
      derive: async () => {
        throw new CrawlBudgetExceeded(mint.toBase58(), 5_000);
      },
      alerts,
      now: () => NOW,
    });
    for (let i = 0; i < 6; i++) await w.tick();
    expect(sent.filter((s) => s.key.startsWith("watch:"))).toHaveLength(0);
    expect(sent.filter((s) => s.key === `crawl-budget:${mint.toBase58()}`)).toHaveLength(1);
  });

  it("adaptive budget from env: base, ceiling 4× (ATTEST_COIN_RPC_BUDGET_MAX); unknown coins get the base", () => {
    const l = deriveLimitsFromEnv({ ATTEST_COIN_RPC_BUDGET: "1000" });
    expect([l.maxRpcCalls, l.maxRpcCallsCeiling]).toEqual([1_000, 4_000]);
    expect(deriveLimitsFromEnv({ ATTEST_COIN_RPC_BUDGET: "1000", ATTEST_COIN_RPC_BUDGET_MAX: "1500" }).maxRpcCallsCeiling).toBe(1_500);
    const caches = newCaches();
    expect(coinBudget({ maxRpcCalls: 1_000, caches }, "X")).toBe(1_000);
    caches.budgets!.set("X", 2_000);
    expect(coinBudget({ maxRpcCalls: 1_000, caches }, "X")).toBe(2_000);
  });

  it("consensus engine knobs: parsed strictly from env (bps 0..10000)", () => {
    expect(engineOverridesFromEnv({})).toEqual({});
    expect(engineOverridesFromEnv({ ENGINE_MIN_REBUY_DEBIT_BPS: "50", ENGINE_DUST_TRANSFER_BPS: "0" })).toEqual({ minRebuyDebitBps: 50n, dustTransferBps: 0n });
    expect(() => engineOverridesFromEnv({ ENGINE_MIN_REBUY_DEBIT_BPS: "1.5" })).toThrow();
    expect(() => engineOverridesFromEnv({ ENGINE_DUST_TRANSFER_BPS: "20000" })).toThrow();
  });
});

describe("L-6: alert identity = mint + issue kind", () => {
  const issue = (kind: EngineIssue["kind"], slot: number): EngineIssue => ({ signature: `s${slot}`, slot, kind, scope: "tx", detail: "x" });
  it("a growing list of issues of one kind keeps ONE key; a new kind gets its own", async () => {
    const { sent, alerts } = alertsSink();
    let issues: EngineIssue[] = [];
    const w = new Watcher({
      coins: async () => [coin],
      global: async () => ({ ...global, pendingEta: 0n, pendingConfigEta: 0n, pendingAdminEta: 0n }) as never,
      derive: async () => ({ ...der({ ...rebuys(0, []), issues }) }),
      alerts,
      now: () => NOW,
    });
    for (let i = 1; i <= 5; i++) {
      issues = [...issues, issue("parse_issue", i)];
      await w.tick();
    }
    issues = [...issues, issue("negative_balance", 9)];
    await w.tick();
    const keys = sent.map((s) => s.key);
    expect(keys.filter((k) => k === issueAlertKey(mint.toBase58(), "parse_issue")).length).toBeGreaterThanOrEqual(1);
    expect(new Set(keys)).toEqual(new Set([issueAlertKey(mint.toBase58(), "parse_issue"), issueAlertKey(mint.toBase58(), "negative_balance")]));
    expect([...groupIssues(issues).keys()]).toEqual(["parse_issue", "negative_balance"]);
  });
  it("a hanging Telegram call never blocks a tick (alerts are fire-and-forget)", async () => {
    const { alerts } = hangingSink(); // every alert() promise never settles
    const w = new Watcher({
      coins: async () => [coin],
      global: async () => ({ ...global, pendingEta: 0n, pendingConfigEta: 0n, pendingAdminEta: 0n }) as never,
      derive: async () => der({ ...rebuys(0, []), issues: [issue("parse_issue", 1)] }),
      alerts,
      now: () => NOW,
    });
    await w.tick(); // would hang forever if the alert were awaited
    expect(w.stats.ticks).toBe(1);
  });
});
