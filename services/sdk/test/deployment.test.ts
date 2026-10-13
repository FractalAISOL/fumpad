// Deployment config (FUMPAD_PROGRAM_ID + FUMPAD_CLUSTER) and the services' startup check against the chain.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  accountDiscriminator,
  bn,
  BPF_LOADER_UPGRADEABLE_ID,
  CLUSTER_TAG,
  DEFAULT_FUMPAD_PROGRAM_ID,
  DEFAULT_PARAMS,
  type DeploymentReader,
  FUMPAD_CONFIG,
  FUMPAD_PROGRAM_ID,
  FumpadDeploymentError,
  fumpadCoder,
  paramsToIdl,
  resolveFumpadConfig,
  SEEDS,
  verifyFumpadDeployment,
} from "../src/index.js";

const k = () => Keypair.generate().publicKey;
const MAINNET_ID = k().toBase58();

function globalData(clusterTag: number): Buffer {
  const layout = (fumpadCoder().types as unknown as { typeLayouts: Map<string, { encode(v: unknown, b: Buffer): number }> }).typeLayouts.get("Global")!;
  const buf = Buffer.alloc(4096);
  const len = layout.encode(
    {
      bump: 1, admin: k(), platform_treasury: k(), guardian: k(), keepers: [k(), k(), k()], keeper_added_at: [bn(0n), bn(0n), bn(0n)], cluster_tag: clusterTag, paused: 0,
      pause_expires_at: bn(0n), params: paramsToIdl(DEFAULT_PARAMS), pending_params: paramsToIdl(DEFAULT_PARAMS), pending_eta: bn(0n), pending_admin: PublicKey.default,
      pending_treasury: PublicKey.default, pending_guardian: PublicKey.default, pending_admin_eta: bn(0n), configs: Array(8).fill(PublicKey.default),
      pending_config: PublicKey.default, pending_config_add: 0, pending_config_eta: bn(0n), reserved: Array(64).fill(0),
    },
    buf,
  );
  return Buffer.concat([Buffer.from(accountDiscriminator("Global")), buf.subarray(0, len)]);
}

/** A fake chain: the program account and its Global (or not). */
function chain(o: { programId: PublicKey; clusterTag?: number; program?: "missing" | "data"; global?: "missing" | "foreign" | "garbage"; rpcFailures?: number }): DeploymentReader {
  const global = PublicKey.findProgramAddressSync([SEEDS.global], o.programId)[0];
  let failures = o.rpcFailures ?? 0;
  return {
    async getAccountInfo(a: PublicKey) {
      if (failures > 0) {
        failures--;
        throw new Error("fetch failed");
      }
      if (a.equals(o.programId)) return o.program === "missing" ? null : { data: new Uint8Array(36), owner: BPF_LOADER_UPGRADEABLE_ID, executable: o.program !== "data" };
      if (a.equals(global)) {
        if (o.global === "missing") return null;
        if (o.global === "garbage") return { data: new Uint8Array(1044), owner: o.programId, executable: false };
        return { data: globalData(o.clusterTag ?? 1), owner: o.global === "foreign" ? k() : o.programId, executable: false };
      }
      return null;
    },
  };
}

describe("resolveFumpadConfig", () => {
  it("no env = the devnet deployment (backward compatible)", () => {
    const c = resolveFumpadConfig({});
    expect(c.programId.toBase58()).toBe(DEFAULT_FUMPAD_PROGRAM_ID);
    expect(c).toMatchObject({ cluster: "devnet", clusterTag: 1, programIdSource: "default", clusterSource: "default" });
  });
  it("env overrides both; cluster names are case-insensitive and trimmed", () => {
    const c = resolveFumpadConfig({ FUMPAD_PROGRAM_ID: ` ${MAINNET_ID} `, FUMPAD_CLUSTER: " Mainnet " });
    expect(c.programId.toBase58()).toBe(MAINNET_ID);
    expect(c).toMatchObject({ cluster: "mainnet", clusterTag: CLUSTER_TAG.mainnet, programIdSource: "env", clusterSource: "env" });
    expect(resolveFumpadConfig({ FUMPAD_CLUSTER: "localnet" }).clusterTag).toBe(2);
    expect(resolveFumpadConfig({ FUMPAD_PROGRAM_ID: "", FUMPAD_CLUSTER: "" }).programIdSource).toBe("default");
  });
  it("rejects a bad id or cluster", () => {
    expect(() => resolveFumpadConfig({ FUMPAD_PROGRAM_ID: "not-a-key" })).toThrow(/FUMPAD_PROGRAM_ID/);
    expect(() => resolveFumpadConfig({ FUMPAD_CLUSTER: "mainnet-beta" })).toThrow(/FUMPAD_CLUSTER/);
    expect(() => resolveFumpadConfig({ FUMPAD_CLUSTER: "testnet" })).toThrow(/FUMPAD_CLUSTER/);
  });
  it("the module config follows the process env at import (test run: unset → default)", () => {
    expect(FUMPAD_PROGRAM_ID.equals(FUMPAD_CONFIG.programId)).toBe(true);
    if (!process.env.FUMPAD_PROGRAM_ID) expect(FUMPAD_PROGRAM_ID.toBase58()).toBe(DEFAULT_FUMPAD_PROGRAM_ID);
  });
  it("a process with FUMPAD_PROGRAM_ID/FUMPAD_CLUSTER gets them in every PDA and instruction", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const script = `import { FUMPAD_CONFIG, globalPda, setPauseIx } from "./sdk/src/index.ts";
      const ix = setPauseIx({ guardian: globalPda(), bits: 0 });
      console.log(JSON.stringify({ id: FUMPAD_CONFIG.programId.toBase58(), cluster: FUMPAD_CONFIG.cluster, ixProgram: ix.programId.toBase58(), global: globalPda().toBase58() }));`;
    const out = execFileSync(join(here, "../../node_modules/.bin/tsx"), ["--eval", script], { cwd: join(here, "../.."), env: { ...process.env, FUMPAD_PROGRAM_ID: MAINNET_ID, FUMPAD_CLUSTER: "mainnet" }, encoding: "utf8" });
    const r = JSON.parse(out.trim().split("\n").pop()!) as { id: string; cluster: string; ixProgram: string; global: string };
    expect(r).toEqual({ id: MAINNET_ID, cluster: "mainnet", ixProgram: MAINNET_ID, global: PublicKey.findProgramAddressSync([SEEDS.global], new PublicKey(MAINNET_ID))[0].toBase58() });
  });
});

describe("verifyFumpadDeployment (service startup check)", () => {
  const devnet = resolveFumpadConfig({});
  const mainnet = resolveFumpadConfig({ FUMPAD_PROGRAM_ID: MAINNET_ID, FUMPAD_CLUSTER: "mainnet" });
  const fast = { retryMs: 1 };

  it("accepts the matching program + Global.cluster_tag", async () => {
    const d = await verifyFumpadDeployment(chain({ programId: devnet.programId, clusterTag: 1 }), devnet, fast);
    expect(d.globalAccount.clusterTag).toBe(1);
    const m = await verifyFumpadDeployment(chain({ programId: mainnet.programId, clusterTag: 0 }), mainnet, fast);
    expect(m.global.equals(PublicKey.findProgramAddressSync([SEEDS.global], mainnet.programId)[0])).toBe(true);
  });
  it("refuses a cluster_tag mismatch (e.g. a mainnet config against devnet's / a localnet Global)", async () => {
    await expect(verifyFumpadDeployment(chain({ programId: mainnet.programId, clusterTag: 1 }), mainnet, fast)).rejects.toThrow(/cluster_tag is 1 \(devnet\) but FUMPAD_CLUSTER is mainnet/);
    await expect(verifyFumpadDeployment(chain({ programId: devnet.programId, clusterTag: 2 }), devnet, fast)).rejects.toThrow(FumpadDeploymentError);
    const local = resolveFumpadConfig({ FUMPAD_CLUSTER: "localnet" });
    await expect(verifyFumpadDeployment(chain({ programId: local.programId, clusterTag: 2 }), local, fast)).resolves.toBeDefined();
  });
  it("refuses a non-default id without an explicit FUMPAD_CLUSTER", async () => {
    const implicit = resolveFumpadConfig({ FUMPAD_PROGRAM_ID: MAINNET_ID });
    await expect(verifyFumpadDeployment(chain({ programId: implicit.programId, clusterTag: 1 }), implicit, fast)).rejects.toThrow(/FUMPAD_CLUSTER must be set/);
  });
  it("refuses a missing / non-executable program, a missing / foreign / garbage Global", async () => {
    await expect(verifyFumpadDeployment(chain({ programId: mainnet.programId, clusterTag: 0, program: "missing" }), mainnet, fast)).rejects.toThrow(/no account at the program id/);
    await expect(verifyFumpadDeployment(chain({ programId: mainnet.programId, clusterTag: 0, program: "data" }), mainnet, fast)).rejects.toThrow(/not an executable/);
    await expect(verifyFumpadDeployment(chain({ programId: mainnet.programId, global: "missing" }), mainnet, fast)).rejects.toThrow(/no Global/);
    await expect(verifyFumpadDeployment(chain({ programId: mainnet.programId, clusterTag: 0, global: "foreign" }), mainnet, fast)).rejects.toThrow(/owned by/);
    await expect(verifyFumpadDeployment(chain({ programId: mainnet.programId, global: "garbage" }), mainnet, fast)).rejects.toThrow(/discriminator/);
  });
  it("a config for one id never accepts another id's deployment", async () => {
    // the chain has the devnet deployment; the config names another program: nothing at that id
    const other = resolveFumpadConfig({ FUMPAD_PROGRAM_ID: MAINNET_ID, FUMPAD_CLUSTER: "devnet" });
    await expect(verifyFumpadDeployment(chain({ programId: devnet.programId, clusterTag: 1 }), other, fast)).rejects.toThrow(/no account at the program id/);
  });
  it("retries RPC errors, then refuses", async () => {
    await expect(verifyFumpadDeployment(chain({ programId: devnet.programId, clusterTag: 1, rpcFailures: 2 }), devnet, fast)).resolves.toBeDefined();
    await expect(verifyFumpadDeployment(chain({ programId: devnet.programId, clusterTag: 1, rpcFailures: 99 }), devnet, { ...fast, attempts: 3 })).rejects.toThrow(/can't read/);
  });
});
