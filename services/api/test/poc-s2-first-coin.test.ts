/**
 * PoC for audit finding S-2 / H-3 (external audit 2026-10-17), adopted as a regression test and flipped: while
 * LAUNCH_FIRST_COIN=true, an arbitrary wallet asking for `launchConfig: "first_coin"` used to get a transaction on the
 * one-off first-coin config (wallet-split, max_coins=1) co-signed by the API's launch_signer. The attack must now
 * FAIL (403 `first_coin_not_allowed`, nothing reserved or signed), on prepare and on the metadata upload, while the
 * allow-listed FIRST_COIN_CREATOR still gets its co-signed launch. Fully mocked (no RPC, no DB, keys generated in-test).
 */
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { createPublicKey, verify } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { DBC_CONFIG_SIZE, FEE_POLICY, STANDARD_FEE_POLICY } from "@fumpad/sdk";

import { loadApiConfig } from "../src/config.js";
import { pickLaunchConfig } from "../src/launch/routes.js";
import { buildServer } from "../src/server.js";

const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;

describe("PoC S-2: first_coin config is bound to FIRST_COIN_CREATOR (attack now fails)", () => {
  const std = Keypair.generate().publicKey;
  const firstCfg = Keypair.generate().publicKey;
  const teamWallet = Keypair.generate().publicKey;
  const teamCreator = Keypair.generate().publicKey; // stands in for FIRST_COIN_CREATOR (mainnet: EiwHzSkty4…VGc)
  const launchSigner = Keypair.generate(); // test-only key, stands in for LAUNCH_SIGNER_KEY
  const firstPolicy = { kind: FEE_POLICY.walletSplit, buybackShare: 100, walletShare: 140, maxCoins: 1, wallet: teamWallet };
  const global = {
    params: { launchSigner: launchSigner.publicKey },
    configs: [std, firstCfg, ...Array(6).fill(PublicKey.default)],
    configPolicies: [STANDARD_FEE_POLICY, firstPolicy, ...Array(6).fill(STANDARD_FEE_POLICY)],
    configCoins: [5, 0, 0, 0, 0, 0, 0, 0],
  };
  const gate = { allowedCreator: teamCreator.toBase58() };
  let app: Awaited<ReturnType<typeof buildServer>>["app"] | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("pickLaunchConfig binds the slot to the creator: 1,000 random creators are all refused, the team creator gets it", () => {
    for (let i = 0; i < 1_000; i++) {
      expect(() => pickLaunchConfig(global as never, "first_coin", gate, Keypair.generate().publicKey.toBase58())).toThrow(/reserved for the FUMPAD team wallet/);
    }
    expect(pickLaunchConfig(global as never, "first_coin", gate, teamCreator.toBase58()).dbcConfig.equals(firstCfg)).toBe(true);
  });

  it("LAUNCH_FIRST_COIN=true without FIRST_COIN_CREATOR refuses to start", () => {
    expect(() => loadApiConfig(env({ DATABASE_URL: "postgres://stub/stub", LAUNCH_FIRST_COIN: "true" }))).toThrow(/FIRST_COIN_CREATOR/);
    expect(() => loadApiConfig(env({ DATABASE_URL: "postgres://stub/stub", LAUNCH_FIRST_COIN: "true", FIRST_COIN_CREATOR: "not-a-key" }))).toThrow(/FIRST_COIN_CREATOR/);
    expect(loadApiConfig(env({ DATABASE_URL: "postgres://stub/stub", LAUNCH_FIRST_COIN: "true", FIRST_COIN_CREATOR: "EiwHzSkty4mD1463dvbr7o1fHMNaA8xQPgk4PyXpnVGc" })).firstCoinCreator).toBe(
      "EiwHzSkty4mD1463dvbr7o1fHMNaA8xQPgk4PyXpnVGc",
    );
  });

  /** mainnet (LAUNCH_ALT set, as in production) or localnet (inline launch, so the positive control can build the tx). */
  async function server(cluster: "mainnet" | "localnet" = "mainnet") {
    const mintKp = Keypair.generate();
    const suffix = mintKp.publicKey.toBase58().slice(-1); // pool suffix the fake mint satisfies
    const cfg = loadApiConfig(
      env({
        DATABASE_URL: "postgres://stub/stub",
        LOG_LEVEL: "silent",
        FUMPAD_CLUSTER: cluster,
        LAUNCHES_OPEN: "false",
        LAUNCH_FIRST_COIN: "true",
        FIRST_COIN_CREATOR: teamCreator.toBase58(),
        LAUNCH_REQUIRE_SIGNATURE: "false", // signature only proves control of the attacker's OWN wallet; irrelevant here
        LAUNCH_MIN_BALANCE_LAMPORTS: "0",
        LAUNCH_SWEEP_SECS: "0",
        LAUNCH_SIGNER_KEY: JSON.stringify([...launchSigner.secretKey]),
        ...(cluster === "mainnet" ? { LAUNCH_ALT: Keypair.generate().publicKey.toBase58(), PINATA_JWT: "x" } : {}),
      }),
    );
    const calls = { prepared: 0, pinned: 0 };
    const built = await buildServer(cfg, {
      db: { query: async () => ({ rows: [], rowCount: 0 }), end: async () => {} } as never,
      conn: {
        getAccountInfo: async () => ({ data: Buffer.alloc(DBC_CONFIG_SIZE), owner: PublicKey.default, lamports: 1, executable: false }),
        getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
        getBalance: async () => 10e9,
      } as never,
      repo: {} as never,
      chain: { solUsd: async () => 150, client: {}, global: async () => global } as never,
      live: { subscribers: 0, stats: {}, subscribe: () => () => {}, stop: async () => {} } as never,
      pool: {
        cfg: { suffix },
        prepare: async (_creator: string, _ip: string, build: (m: PublicKey) => Promise<{ tx: VersionedTransaction; lastValidBlockHeight: number }>) => {
          calls.prepared++;
          const { tx, lastValidBlockHeight } = await build(mintKp.publicKey);
          tx.sign([mintKp]);
          return { mint: mintKp.publicKey.toBase58(), tx, lastValidBlockHeight, expiresAt: Date.now() + 60_000, reusedReservation: false };
        },
      } as never,
      pinner: {
        pin: async () => {
          calls.pinned++;
          return "Qm" + "Z".repeat(44);
        },
      },
    });
    app = built.app;
    return { app, calls };
  }

  it("POST /v1/launch/prepare (mainnet, LAUNCHES_OPEN=false, LAUNCH_FIRST_COIN=true): an unrelated wallet is refused, nothing reserved or co-signed", async () => {
    const { app, calls } = await server();
    const attacker = Keypair.generate().publicKey;
    const r = await app.inject({ method: "POST", url: "/v1/launch/prepare", payload: { creator: attacker.toBase58(), name: "FUMPAD", symbol: "FMBL", uri: "ipfs://bafyimpostor", launchConfig: "first_coin" } });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: "the first-coin launch config is reserved for the FUMPAD team wallet", code: "first_coin_not_allowed" });
    expect(r.json().transaction).toBeUndefined();
    expect(calls.prepared).toBe(0);
    // ...and /v1/launch/options doesn't advertise it to that wallet (nor to an anonymous caller)
    for (const q of ["", `?creator=${attacker.toBase58()}`]) expect((await app.inject({ method: "GET", url: `/v1/launch/options${q}` })).json().firstCoin).toBeNull();
  });

  it("POST /v1/launch/metadata: same gate, nothing pinned for an unrelated wallet", async () => {
    const { app, calls } = await server();
    const attacker = Keypair.generate().publicKey;
    const r = await app.inject({ method: "POST", url: "/v1/launch/metadata", payload: { creator: attacker.toBase58(), name: "FUMPAD", symbol: "FMBL", launchConfig: "first_coin" } });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe("first_coin_not_allowed");
    expect(calls.pinned).toBe(0);
  });

  it("positive control: FIRST_COIN_CREATOR (launches still closed) gets the co-signed first-coin launch tx and sees the option", async () => {
    const { app, calls } = await server("localnet");
    const opts = (await app.inject({ method: "GET", url: `/v1/launch/options?creator=${teamCreator.toBase58()}` })).json();
    expect(opts.launchesOpen).toBe(false);
    expect(opts.firstCoin).toMatchObject({ dbcConfig: firstCfg.toBase58(), wallet: teamWallet.toBase58(), launchesLeft: 1 });
    const r = await app.inject({ method: "POST", url: "/v1/launch/prepare", payload: { creator: teamCreator.toBase58(), name: "FUMPAD", symbol: "FMBL", uri: "ipfs://bafyreal", launchConfig: "first_coin" } });
    expect(r.statusCode).toBe(200);
    expect(calls.prepared).toBe(1);
    const body = r.json();
    expect(body.config.kind).toBe("first_coin");
    expect(body.config.dbcConfig).toBe(firstCfg.toBase58());
    const tx = VersionedTransaction.deserialize(Buffer.from(body.transaction, "base64"));
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    expect(keys[0]).toBe(teamCreator.toBase58());
    const i = keys.indexOf(launchSigner.publicKey.toBase58());
    expect(i).toBeGreaterThan(0);
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), launchSigner.publicKey.toBuffer()]);
    expect(verify(null, Buffer.from(tx.message.serialize()), createPublicKey({ key: spki, format: "der", type: "spki" }), Buffer.from(tx.signatures[i]))).toBe(true);
  });
});
