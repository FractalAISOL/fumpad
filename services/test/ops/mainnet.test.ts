/** Mainnet launch path (scripts/mainnet): CLI safety gates, config bytes, params, manifests, program-id override. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { DEFAULT_FUMPAD_PROGRAM_ID, DEFAULT_PARAMS, FUMPAD_PROGRAM_ID, FUMPAD_PROGRAM_ID_SOURCE, paramsProblems } from "@fumpad/sdk";

import { configBytesProblem, mainnetParams } from "../../scripts/mainnet/bootstrap-core.js";
import { parseCli } from "../../scripts/mainnet/bootstrap-mainnet.js";
import { compareManifests, type Manifest } from "../../scripts/mainnet/fork.js";
import { ensureHotKeys, HOT_KEYS, loadConfig, programIdOf } from "../../scripts/mainnet/keys.js";

const rpcEnv = () => {
  const d = mkdtempSync(join(tmpdir(), "fumpad-mn-"));
  writeFileSync(join(d, "rpc.env"), "RPC_URL=https://example.invalid/?api-key=secret\n");
  return join(d, "rpc.env");
};

describe("mainnet bootstrap CLI safety", () => {
  it("plan is the default; --cluster is required", () => {
    expect(() => parseCli(["--step", "verify"])).toThrow(/--cluster/);
    expect(parseCli(["--cluster", "mainnet", "--rpc-env", rpcEnv()]).mode).toBe("plan");
  });
  it("mainnet --send needs the spend flag, refuses --yes, and needs a TTY", () => {
    const env = rpcEnv();
    expect(() => parseCli(["--cluster", "mainnet", "--send", "--rpc-env", env])).toThrow(/i-understand-this-spends-real-sol/);
    expect(() => parseCli(["--cluster", "mainnet", "--send", "--i-understand-this-spends-real-sol", "--yes", "--rpc-env", env])).toThrow(/--yes/);
    if (!process.stdin.isTTY) expect(() => parseCli(["--cluster", "mainnet", "--send", "--i-understand-this-spends-real-sol", "--rpc-env", env])).toThrow(/interactive terminal/);
  });
  it("rejects unknown flags/steps and --simulate with --send", () => {
    expect(() => parseCli(["--cluster", "local-fork", "--sned"])).toThrow(/unknown flag/);
    expect(() => parseCli(["--cluster", "local-fork", "--step", "deploy"])).toThrow(/unknown step/);
    expect(() => parseCli(["--cluster", "local-fork", "--simulate", "--send"])).toThrow(/exclusive/);
    expect(parseCli(["--cluster", "local-fork", "--step", "handover"]).steps).toEqual(["accept-admin", "upgrade-authority", "verify"]);
  });
});

describe("mainnet values", () => {
  it("create_config bytes = contracts/tests/vectors/dbc_config.json mainnet", () => expect(configBytesProblem()).toBeNull());
  it("mainnet params = every default + launch_signer, valid", () => {
    const ls = Keypair.generate().publicKey;
    const p = mainnetParams(ls);
    expect(paramsProblems(p)).toEqual([]);
    expect(p.minSellUsdCents).toBe(5_000n);
    expect(p.minHoldSecs).toBe(600n);
    expect(p.ticketChallengeSecs).toBe(21_600n);
    expect([p.oracleWindowSecs, p.oracleMinSamples]).toEqual([1_800n, 84]);
    expect(p.claimWindowSecs).toBe(90n * 86_400n);
    expect(p.rebuyWindowSecs).toBe(7n * 86_400n);
    expect({ ...p, launchSigner: DEFAULT_PARAMS.launchSigner }).toEqual(DEFAULT_PARAMS);
  });
  it("without FUMPAD_PROGRAM_ID the SDK uses the compiled-in id", () => {
    expect(FUMPAD_PROGRAM_ID_SOURCE).toBe(process.env.FUMPAD_PROGRAM_ID ? "env" : "default");
    if (!process.env.FUMPAD_PROGRAM_ID) expect(FUMPAD_PROGRAM_ID.equals(new PublicKey(DEFAULT_FUMPAD_PROGRAM_ID))).toBe(true);
  });
});

describe("keys + config", () => {
  it("hot keys are created once (600) and the program id is the program keypair", () => {
    const d = mkdtempSync(join(tmpdir(), "fumpad-keys-"));
    expect(ensureHotKeys(d)).toEqual([...HOT_KEYS]);
    const id = programIdOf(d);
    expect(ensureHotKeys(d)).toEqual([]);
    expect(programIdOf(d)).toBe(id);
  });
  it("config validation", () => {
    const d = mkdtempSync(join(tmpdir(), "fumpad-cfg-"));
    const pk = () => Keypair.generate().publicKey.toBase58();
    const same = pk();
    writeFileSync(join(d, "c.json"), JSON.stringify({ deployerKeypair: "d.json", admin: { kind: "hardware", address: same }, guardian: { kind: "hardware", address: same }, treasury: "nope" }));
    expect(() => loadConfig(join(d, "c.json"))).toThrow(/treasury: not a public key.*admin and guardian must differ/);
  });
});

describe("tested-programs manifest comparison", () => {
  const m = (sha: string, auth: string): Manifest =>
    ({ takenAt: "t", slot: 1, genesis: "g", programs: [{ name: "dbc", id: "x", programData: null, upgradeAuthority: auth, lastDeployedSlot: 1, payloadBytes: 1, sha256: sha, file: "" }], accounts: [{ name: "damm_v2_migration_config", id: "y", owner: "o", lamports: 1, space: 1, sha256: "a", file: "" }], rent: [], rentLinear: { perByteTwoYears: 0, ok: true }, priorityFees: [], pyth: { priceUsd: 0, publishTime: 0, ageSecs: 0 } }) as Manifest;
  it("flags changed program bytes and upgrade authorities", () => {
    expect(compareManifests(m("aa", "A"), m("aa", "A"))).toEqual([]);
    expect(compareManifests(m("aa", "A"), m("bb", "B")).join()).toMatch(/program bytes CHANGED.*upgrade authority changed/);
  });
});
