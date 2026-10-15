/**
 * Fumble Checker (`GET /v1/wallets/:wallet/fumbles`): the per-sell assessment (`fumbles.ts`, pure) and the route
 * (validation, rate limit, read-only).
 */
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { loadApiConfig } from "../src/config.js";
import { assessSells, claimTarget, usdRateFrom, type AssessInput, type WalletEvent } from "../src/fumbles.js";
import type { Ticket } from "../src/generated/app-types.js";
import { buildServer } from "../src/server.js";

const T0 = 1_800_000_000;
const NOW = T0 + 3_600;
const params: AssessInput["params"] = {
  minSellUsd: 50,
  minHoldSecs: 600n,
  maxOpenTickets: 5,
  triggerMultiple: 10,
  claimBps: 1_000,
  totalSupply: 1_000_000_000,
  maxAttestAgeSecs: 86_400,
};
const TOK = 1_000_000n; // 1 token in base units
let n = 0;
const ev = (kind: WalletEvent["kind"], ts: number, tokens: number, sol: number, extra: Partial<WalletEvent> = {}): WalletEvent => ({
  kind,
  signature: extra.signature ?? `sig${++n}`,
  ixKey: extra.ixKey ?? 0,
  slot: extra.slot ?? ts,
  ts,
  base: BigInt(tokens) * TOK,
  lamports: BigInt(Math.round(sol * 1e9)),
  venue: "dbc",
  app: "axiom",
  ...extra,
});
const at150 = () => ({ rate: 150, basis: "current" as const });
const run = (events: WalletEvent[], extra: Partial<AssessInput> = {}) =>
  assessSells({ isCreator: false, events, tickets: [], params, usdPerSol: at150, now: NOW, ...extra });

function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: Keypair.generate().publicKey.toBase58(),
    seq: 0,
    owner: "w",
    mint: "m",
    symbol: "FIRST",
    coinName: "First",
    tile: 0,
    coinStatus: "curve",
    tokens: 1_000_000,
    originalTokens: 1_000_000,
    sellPrice: 0.000001,
    source: "outside",
    execPrice: 0.000001,
    sellUsd: 150,
    sellSol: 1,
    sellTs: (T0 + 1_000) * 1000,
    chainStatus: "open",
    state: "challenge",
    multiple: 1,
    peakMultiple: 1,
    claimAmount: 100_000,
    claimValueSol: 0.1,
    rebuyDebited: 0,
    autoClaim: true,
    ...over,
  } as Ticket;
}

describe("assessSells", () => {
  it("a held sell over the minimum with no ticket yet is verifying, with an estimated claim target", () => {
    const [s] = run([ev("buy", T0, 1_000_000, 1), ev("sell", T0 + 900, 1_000_000, 2)]);
    expect(s.outcome).toBe("verifying");
    expect(s.checks).toEqual({ usd: "ok", hold: "ok", creator: "ok" });
    expect(s.usd).toBeCloseTo(300);
    expect(s.usdBasis).toBe("current");
    expect(s.countedTokens).toBe(1_000_000);
    // fill price 2 SOL / 1M tokens = 2e-6; target 10× → 2e-5 × 1B supply = 20,000 SOL
    expect(s.target).toMatchObject({ estimated: true, claimTokens: 100_000 });
    expect(s.target!.sellPrice).toBeCloseTo(2e-6);
    expect(s.target!.targetMarketCapSol).toBeCloseTo(20_000);
    expect(s.target!.claimValueSolAtTarget).toBeCloseTo(2);
  });

  it("tokens held under the hold time don't count", () => {
    const [s] = run([ev("buy", T0, 1_000, 1), ev("sell", T0 + 300, 1_000, 2)]);
    expect(s).toMatchObject({ outcome: "no-ticket", reason: "not_matured", checks: { hold: "fail", usd: "ok", creator: "ok" }, countedTokens: 0 });
  });

  it("only the matured part counts toward the USD minimum", () => {
    // 1,000 matured + 1,000 fresh, sell all 2,000 for 0.4 SOL ($60 in total).
    // V7-M4: the sell draws the 1,000 pending first, then 1,000 matured → 1,000 count → $30 < $50.
    const [s] = run([ev("buy", T0, 1_000, 1), ev("buy", T0 + 1_000, 1_000, 1), ev("sell", T0 + 1_100, 2_000, 0)], {});
    expect(s.countedTokens).toBe(1_000);
    const [t] = run([ev("buy", T0, 1_000, 1), ev("buy", T0 + 1_000, 1_000, 1), { ...ev("sell", T0 + 1_100, 2_000, 0), lamports: 400_000_000n }]);
    expect(t.usd).toBeCloseTo(30);
    expect(t).toMatchObject({ outcome: "no-ticket", reason: "below_minimum_usd", checks: { usd: "fail", hold: "ok" } });
  });

  it("the creator never files tickets", () => {
    const [s] = run([ev("buy", T0, 1_000, 1), ev("sell", T0 + 900, 1_000, 2)], { isCreator: true });
    expect(s).toMatchObject({ outcome: "no-ticket", reason: "creator", checks: { creator: "fail" } });
  });

  it("a buy and a sell in one transaction file no ticket", () => {
    const [s] = run([ev("buy", T0, 1_000, 1), ev("buy", T0 + 900, 5, 1, { signature: "same" }), ev("sell", T0 + 900, 1_000, 2, { signature: "same", ixKey: 1 })]);
    expect(s.reason).toBe("same_tx_buy");
  });

  it("tokens that arrived by transfer: the hold is unknown here, the keepers decide", () => {
    const [s] = run([ev("sell", T0 + 900, 1_000, 2)]);
    expect(s).toMatchObject({ outcome: "verifying", checks: { hold: "unknown", usd: "ok" } });
  });

  it("an eligible-looking sell past the attestation window without a ticket is not attested", () => {
    const [s] = run([ev("buy", T0, 1_000, 1), ev("sell", T0 + 900, 1_000, 2)], { now: T0 + 900 + 86_401 });
    expect(s).toMatchObject({ outcome: "no-ticket", reason: "not_attested" });
  });

  it("an attested sell reports its ticket, the attested USD value and the ticket's claim target", () => {
    const sell = ev("sell", T0 + 1_000, 1_000_000, 2, { signature: "S", ixKey: 3 });
    const tk = ticket({ sellPrice: 3e-6, claimAmount: 90_000, originalTokens: 900_000, sellUsd: 270 });
    const [s] = run([ev("buy", T0, 1_000_000, 1), sell], { tickets: [{ ticket: tk, sellSignature: "S", sellIxKey: 3 }] });
    expect(s).toMatchObject({ outcome: "ticket", usd: 270, usdBasis: "attested", countedTokens: 900_000, checks: { usd: "ok", hold: "ok", creator: "ok" } });
    expect(s.ticket?.id).toBe(tk.id);
    expect(s.target).toEqual(claimTarget(3e-6, 90_000, false, params));
    expect(s.target!.targetMarketCapSol).toBeCloseTo(30_000);
  });

  it("the open-ticket cap", () => {
    const evs: WalletEvent[] = [ev("buy", T0, 10_000, 10)];
    const tickets = [];
    for (let i = 0; i < 6; i++) {
      const e = ev("sell", T0 + 900 + i, 1_000, 2, { signature: `s${i}` });
      evs.push(e);
      if (i < 5) tickets.push({ ticket: ticket(), sellSignature: `s${i}`, sellIxKey: 0 });
    }
    const out = run(evs, { tickets });
    expect(out[0]).toMatchObject({ outcome: "no-ticket", reason: "too_many_open_tickets" });
    expect(out.slice(1).every((s) => s.outcome === "ticket")).toBe(true);
  });

  it("a ticket whose sell trade isn't indexed is still listed, newest first", () => {
    const tk = ticket({ sellTs: (T0 + 2_000) * 1000, sellSignature: "X" });
    const out = run([ev("buy", T0, 1_000, 1), ev("sell", T0 + 900, 1_000, 2)], { tickets: [{ ticket: tk, sellSignature: "X", sellIxKey: 0 }] });
    expect(out.map((s) => s.outcome)).toEqual(["ticket", "verifying"]);
    expect(out[0]).toMatchObject({ signature: "X", ts: (T0 + 2_000) * 1000 });
  });

  it("no sells → nothing", () => {
    expect(run([ev("buy", T0, 1_000, 1)])).toEqual([]);
  });
});

describe("usdRateFrom", () => {
  it("uses the nearest attested sell within the hour, else the current price", () => {
    const f = usdRateFrom([{ ts: 1_000, rate: 140 }, { ts: 3_000, rate: 160 }], 150);
    expect(f(1_200)).toEqual({ rate: 140, basis: "nearby" });
    expect(f(2_900)).toEqual({ rate: 160, basis: "nearby" });
    expect(f(10_000)).toEqual({ rate: 150, basis: "current" });
  });
});

describe("GET /v1/wallets/:wallet/fumbles", () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  const calls: unknown[][] = [];
  const repo = {
    walletFumbles: async (...a: unknown[]) => {
      calls.push(a);
      return { wallet: a[0], found: false, coins: [], asOf: 1 };
    },
  };
  const server = async (env: Record<string, string> = {}) => {
    const cfg = loadApiConfig({ DATABASE_URL: "postgres://stub/stub", LOG_LEVEL: "silent", ...env } as NodeJS.ProcessEnv);
    const { app } = await buildServer(cfg, {
      db: { query: async () => ({ rows: [] }), end: async () => {} } as never,
      conn: {} as never,
      repo: repo as never,
      chain: { solUsd: async () => 150 } as never,
      live: { subscribers: 0, stats: {}, subscribe: () => () => {}, stop: async () => {} } as never,
      pool: null,
    });
    return app;
  };

  it("validates the wallet and the mint, passes today's SOL price", async () => {
    const app = await server();
    expect((await app.inject(`/v1/wallets/${wallet}/fumbles?mint=${mint}`)).json()).toEqual({ wallet, found: false, coins: [], asOf: 1 });
    expect(calls.at(-1)).toEqual([wallet, mint, 150]);
    expect((await app.inject(`/v1/wallets/${wallet}/fumbles`)).statusCode).toBe(200);
    expect(calls.at(-1)).toEqual([wallet, undefined, 150]);
    for (const bad of [`/v1/wallets/0OIl${wallet.slice(4)}/fumbles`, `/v1/wallets/abc/fumbles`, `/v1/wallets/${wallet}/fumbles?mint=nope`, `/v1/wallets/${wallet}'--/fumbles`]) {
      expect((await app.inject(bad)).statusCode, bad).toBe(400);
    }
    expect((await app.inject({ method: "POST", url: `/v1/wallets/${wallet}/fumbles` })).statusCode).toBe(404);
    await app.close();
  });

  it("has its own per-IP rate limit", async () => {
    const app = await server({ FUMBLES_RATE_LIMIT_PER_MIN: "2" });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await app.inject({ url: `/v1/wallets/${wallet}/fumbles?mint=${mint}`, remoteAddress: "198.51.100.9" })).statusCode);
    expect(codes).toEqual([200, 200, 429, 429]);
    await app.close();
  });
});
