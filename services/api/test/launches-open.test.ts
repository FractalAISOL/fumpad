/**
 * LAUNCHES_OPEN: the "standard launches closed" switch (launch day). Cluster defaults (open on devnet/testnet/localnet,
 * closed on mainnet), the 403 `launches_closed` on `POST /v1/launch/prepare` for standard launches only (the
 * first-coin path keeps its own LAUNCH_FIRST_COIN switch), and `launchesOpen` on `GET /v1/launch/options`.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { FEE_POLICY, STANDARD_FEE_POLICY } from "@fumpad/sdk";

import { launchesOpenFromEnv, loadApiConfig } from "../src/config.js";
import { assertLaunchAllowed, LAUNCHES_CLOSED_CODE } from "../src/launch/routes.js";
import { buildServer } from "../src/server.js";

const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;

describe("LAUNCHES_OPEN config (cluster defaults, explicit values)", () => {
  it("defaults: open on devnet/testnet/localnet and with FUMPAD_CLUSTER unset (devnet), closed on mainnet", () => {
    expect(launchesOpenFromEnv(env({}))).toBe(true);
    expect(launchesOpenFromEnv(env({ FUMPAD_CLUSTER: "devnet" }))).toBe(true);
    expect(launchesOpenFromEnv(env({ FUMPAD_CLUSTER: "testnet" }))).toBe(true);
    expect(launchesOpenFromEnv(env({ FUMPAD_CLUSTER: "localnet" }))).toBe(true);
    expect(launchesOpenFromEnv(env({ FUMPAD_CLUSTER: "mainnet" }))).toBe(false);
    expect(launchesOpenFromEnv(env({ FUMPAD_CLUSTER: " Mainnet " }))).toBe(false);
    expect(launchesOpenFromEnv(env({ FUMPAD_CLUSTER: "mainnet", LAUNCHES_OPEN: "" }))).toBe(false);
    // fail-safe: an unknown cluster name is not "open by default"
    expect(launchesOpenFromEnv(env({ FUMPAD_CLUSTER: "mainnet-beta" }))).toBe(false);
  });

  it("explicitly settable either way on every cluster", () => {
    for (const c of ["mainnet", "devnet", "localnet", "testnet"]) {
      for (const v of ["true", "TRUE", "1", "yes"]) expect(launchesOpenFromEnv(env({ FUMPAD_CLUSTER: c, LAUNCHES_OPEN: v }))).toBe(true);
      for (const v of ["false", "False", "0", "no"]) expect(launchesOpenFromEnv(env({ FUMPAD_CLUSTER: c, LAUNCHES_OPEN: v }))).toBe(false);
    }
  });

  it("an unrecognised value is a startup error (never a guess)", () => {
    expect(() => launchesOpenFromEnv(env({ LAUNCHES_OPEN: "maybe" }))).toThrow(/LAUNCHES_OPEN/);
    expect(() => loadApiConfig(env({ DATABASE_URL: "postgres://stub/stub", LAUNCHES_OPEN: "ture" }))).toThrow(/LAUNCHES_OPEN/);
  });

  it("loadApiConfig carries it", () => {
    expect(loadApiConfig(env({ DATABASE_URL: "postgres://stub/stub" })).launchesOpen).toBe(true);
    expect(loadApiConfig(env({ DATABASE_URL: "postgres://stub/stub", FUMPAD_CLUSTER: "mainnet" })).launchesOpen).toBe(false);
    expect(loadApiConfig(env({ DATABASE_URL: "postgres://stub/stub", FUMPAD_CLUSTER: "mainnet", LAUNCHES_OPEN: "true" })).launchesOpen).toBe(true);
    expect(loadApiConfig(env({ DATABASE_URL: "postgres://stub/stub", FUMPAD_CLUSTER: "devnet", LAUNCHES_OPEN: "false" })).launchesOpen).toBe(false);
  });

  it("the gate: closed refuses standard only", () => {
    expect(() => assertLaunchAllowed("standard", true)).not.toThrow();
    expect(() => assertLaunchAllowed("first_coin", true)).not.toThrow();
    expect(() => assertLaunchAllowed("first_coin", false)).not.toThrow();
    expect(() => assertLaunchAllowed("standard", false)).toThrow(/Launches open soon/);
  });
});

describe("routes: open/closed × standard/first_coin", () => {
  const std = Keypair.generate().publicKey;
  const first = Keypair.generate().publicKey;
  const feeWallet = Keypair.generate().publicKey;
  const firstPolicy = { kind: FEE_POLICY.walletSplit, buybackShare: 100, walletShare: 140, maxCoins: 1, wallet: feeWallet };
  const global = {
    params: { launchSigner: PublicKey.default },
    configs: [std, first, ...Array(6).fill(PublicKey.default)],
    configPolicies: [STANDARD_FEE_POLICY, firstPolicy, ...Array(6).fill(STANDARD_FEE_POLICY)],
    configCoins: [5, 0, 0, 0, 0, 0, 0, 0],
  };
  const body = (launchConfig?: string) => ({ creator: Keypair.generate().publicKey.toBase58(), name: "Sad Pigeon", symbol: "PIGN", uri: "ipfs://bafy", ...(launchConfig ? { launchConfig } : {}) });
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  /**
   * A server whose launch pipeline stops right after the config choice: the DBC config account lookup returns
   * nothing (503 "the FUMPAD DBC config is missing"), which proves the request got past the LAUNCHES_OPEN gate.
   */
  async function server(e: Record<string, string>) {
    const cfg = loadApiConfig(env({ DATABASE_URL: "postgres://stub/stub", LOG_LEVEL: "silent", LAUNCH_REQUIRE_SIGNATURE: "false", LAUNCH_MIN_BALANCE_LAMPORTS: "0", LAUNCH_SWEEP_SECS: "0", ...e }));
    const built = await buildServer(cfg, {
      db: { query: async () => ({ rows: [], rowCount: 0 }), end: async () => {} } as never,
      conn: { getAccountInfo: async () => null } as never,
      repo: {} as never,
      chain: { solUsd: async () => 150, client: {}, global: async () => global } as never,
      live: { subscribers: 0, stats: {}, subscribe: () => () => {}, stop: async () => {} } as never,
      pool: { cfg: { suffix: "fmbL" } } as never,
    });
    app = built.app;
    return app;
  }
  const prepare = (a: FastifyInstance, launchConfig?: string) => a.inject({ method: "POST", url: "/v1/launch/prepare", payload: body(launchConfig) });
  const passedGate = { statusCode: 503, error: "the FUMPAD DBC config is missing" };

  it("closed (mainnet default): standard → 403 launches_closed, also with launchConfig 'standard'", async () => {
    const a = await server({ FUMPAD_CLUSTER: "mainnet" });
    for (const lc of [undefined, "standard"]) {
      const r = await prepare(a, lc);
      expect(r.statusCode).toBe(403);
      expect(r.json()).toEqual({ error: "Launches open soon", code: LAUNCHES_CLOSED_CODE });
    }
  });

  it("closed: first_coin still works with LAUNCH_FIRST_COIN=true, and is still refused without it (not as launches_closed)", async () => {
    const on = await server({ FUMPAD_CLUSTER: "mainnet", LAUNCH_FIRST_COIN: "true" });
    const r = await prepare(on, "first_coin");
    expect({ statusCode: r.statusCode, error: r.json().error }).toEqual(passedGate);
    await on.close();
    const off = await server({ FUMPAD_CLUSTER: "mainnet" });
    const r2 = await prepare(off, "first_coin");
    expect(r2.statusCode).toBe(403);
    expect(r2.json().code).toBeUndefined();
    expect(r2.json().error).toMatch(/first-coin launch config is not enabled/);
  });

  it("explicit LAUNCHES_OPEN=false closes devnet too", async () => {
    const a = await server({ FUMPAD_CLUSTER: "devnet", LAUNCHES_OPEN: "false" });
    expect((await prepare(a)).json().code).toBe(LAUNCHES_CLOSED_CODE);
  });

  it("open (devnet default, or LAUNCHES_OPEN=true on mainnet): standard passes the gate; first_coin unchanged", async () => {
    for (const e of [{} as Record<string, string>, { FUMPAD_CLUSTER: "devnet" }, { FUMPAD_CLUSTER: "localnet" }, { FUMPAD_CLUSTER: "mainnet", LAUNCHES_OPEN: "true" }]) {
      const a = await server(e);
      const r = await prepare(a);
      expect({ statusCode: r.statusCode, error: r.json().error }).toEqual(passedGate);
      const fc = await prepare(a, "first_coin");
      expect(fc.statusCode).toBe(403);
      expect(fc.json().error).toMatch(/not enabled/);
      await a.close();
    }
    const both = await server({ FUMPAD_CLUSTER: "mainnet", LAUNCHES_OPEN: "true", LAUNCH_FIRST_COIN: "true" });
    const r = await prepare(both, "first_coin");
    expect({ statusCode: r.statusCode, error: r.json().error }).toEqual(passedGate);
  });

  it("closed without a mint pool still answers launches_closed (not 503)", async () => {
    const cfg = loadApiConfig(env({ DATABASE_URL: "postgres://stub/stub", LOG_LEVEL: "silent", FUMPAD_CLUSTER: "mainnet" }));
    const built = await buildServer(cfg, {
      db: { query: async () => ({ rows: [] }), end: async () => {} } as never,
      conn: {} as never,
      repo: {} as never,
      chain: { solUsd: async () => 150, client: {} } as never,
      live: { subscribers: 0, stats: {}, subscribe: () => () => {}, stop: async () => {} } as never,
      pool: null,
    });
    app = built.app;
    const r = await prepare(app);
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe(LAUNCHES_CLOSED_CODE);
  });

  it("GET /v1/launch/options exposes launchesOpen next to firstCoin", async () => {
    const closed = await server({ FUMPAD_CLUSTER: "mainnet" });
    expect((await closed.inject({ method: "GET", url: "/v1/launch/options" })).json()).toEqual({ launchesOpen: false, firstCoin: null });
    await closed.close();
    const closedFirst = await server({ FUMPAD_CLUSTER: "mainnet", LAUNCH_FIRST_COIN: "true" });
    const o = (await closedFirst.inject({ method: "GET", url: "/v1/launch/options" })).json();
    expect(o.launchesOpen).toBe(false);
    expect(o.firstCoin).toMatchObject({ dbcConfig: first.toBase58(), wallet: feeWallet.toBase58(), launchesLeft: 1 });
    await closedFirst.close();
    const open = await server({ FUMPAD_CLUSTER: "devnet" });
    expect((await open.inject({ method: "GET", url: "/v1/launch/options" })).json()).toEqual({ launchesOpen: true, firstCoin: null });
  });
});
