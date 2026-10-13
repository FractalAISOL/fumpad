/** Ops scripts (scripts/ops): secret hygiene helpers, RPC check internals, multisig config + instruction layouts. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import type { MeteoraRpc, SignatureInfo } from "@fumpad/meteora";
import { BPF_LOADER_UPGRADEABLE_ID, FUMPAD_PROGRAM_ID, programDataPda } from "@fumpad/sdk";

import { readEnvValue, redactHost, redactText } from "../../scripts/ops/common.js";
import { actionIxs, checkMultisigConfig, extendProgramIx, loadMultisigConfig, type MultisigConfig, setUpgradeAuthorityIx, upgradeIx } from "../../scripts/ops/multisig.js";
import { canonical, paginate, providerFromEnvFile } from "../../scripts/ops/rpc-check.js";

const dir = mkdtempSync(join(tmpdir(), "ops-test-"));
const envFile = (name: string, body: string) => {
  const f = join(dir, name);
  writeFileSync(f, body);
  return f;
};

describe("secret hygiene", () => {
  it("shows only a host, never a key in the query or the path", () => {
    expect(redactHost("https://devnet.helius-rpc.com/?api-key=SECRET")).toBe("devnet.helius-rpc.com");
    expect(redactHost("https://x.solana-mainnet.quiknode.pro/SECRETTOKEN/")).toBe("x.solana-mainnet.quiknode.pro/…");
    expect(redactHost("http://127.0.0.1:8899")).toBe("127.0.0.1:8899");
    expect(redactHost("not a url")).toBe("<unparseable url>");
  });
  it("scrubs URLs and keys out of error text", () => {
    const url = "https://mainnet.helius-rpc.com/?api-key=SECRET";
    const out = redactText(`fetch ${url} failed; also https://a.b/c?api_key=K and postgres://u:pw@h/db`, url);
    expect(out).not.toMatch(/SECRET|pw@|=K/);
  });
  it("reads one value from an env file (export, quotes), nothing else", () => {
    const f = envFile("a.env", `# c\nexport RPC_URL="https://h/?api-key=1"\nRPC_MIN_GAP_MS=250\n`);
    expect(readEnvValue(f, "RPC_URL")).toBe("https://h/?api-key=1");
    expect(readEnvValue(f, "RPC_MIN_GAP_MS")).toBe("250");
    expect(readEnvValue(f, "NOPE")).toBeUndefined();
  });
});

describe("rpc-check internals", () => {
  it("swaps devnet → mainnet in the host only and reads RPC_MIN_GAP_MS", () => {
    const f = envFile("h.env", "RPC_URL=https://devnet.helius-rpc.com/?api-key=K\nRPC_MIN_GAP_MS=120\n");
    const p = providerFromEnvFile(f, { swapCluster: "mainnet" });
    expect(p.url).toBe("https://mainnet.helius-rpc.com/?api-key=K");
    expect(p.host).toBe("mainnet.helius-rpc.com");
    expect(p.minGapMs).toBe(120);
    expect(() => providerFromEnvFile(envFile("q.env", "RPC_URL=https://other.example/x\n"), { swapCluster: "mainnet" })).toThrow(/no "devnet"/);
  });
  it("canonical JSON is stable for bigints", () => {
    expect(canonical({ a: 1n, b: [2n] })).toBe('{"a":"1n","b":["2n"]}');
  });
  it("paginates with a cursor and flags duplicates / slot regressions", async () => {
    const all: SignatureInfo[] = Array.from({ length: 2500 }, (_, i) => ({ signature: `s${i}`, slot: 10_000 - i, err: null }));
    const fake = (list: SignatureInfo[]) =>
      ({
        getSignaturesForAddress: async (_a: string, o: { before?: string; limit?: number }) => {
          const start = o.before ? list.findIndex((s) => s.signature === o.before) + 1 : 0;
          return list.slice(start, start + (o.limit ?? 1000));
        },
      }) as unknown as MeteoraRpc;
    const ok = await paginate(fake(all), "x", 10);
    expect([ok.sigs.length, ok.pages, ok.exhausted, ok.problems]).toEqual([2500, 3, true, []]);
    const capped = await paginate(fake(all), "x", 2);
    expect([capped.sigs.length, capped.exhausted]).toEqual([2000, false]);
    const bad = [...all];
    bad[1500] = { ...bad[1500], slot: 99_999 };
    bad[1700] = bad[1600];
    expect((await paginate(fake(bad), "x", 10)).problems.join()).toMatch(/slot went up.*duplicate|duplicate.*slot went up/);
  });
});

const pk = () => Keypair.generate().publicKey.toBase58();
const cfg = (over: Partial<MultisigConfig> = {}): MultisigConfig => ({
  label: "admin",
  threshold: 3,
  timeLockSecs: 172_800,
  members: [1, 2, 3, 4, 5].map(() => ({ pubkey: pk(), permissions: "all" as const })),
  createKeyPath: "admin-create-key.json",
  ...over,
});

describe("multisig config", () => {
  it("accepts the recommended admin 3-of-5 / 48 h and guardian 2-of-3 / 0", () => {
    expect(checkMultisigConfig(cfg())).toEqual({ problems: [], warnings: [] });
    expect(checkMultisigConfig(cfg({ label: "guardian", threshold: 2, timeLockSecs: 0, members: [1, 2, 3].map(() => ({ pubkey: pk(), permissions: "all" as const })) }))).toEqual({ problems: [], warnings: [] });
  });
  it("refuses unusable configs and warns about weak ones", () => {
    const m = cfg().members;
    expect(checkMultisigConfig(cfg({ threshold: 6 })).problems.join()).toMatch(/threshold 6 > 5 voting/);
    expect(checkMultisigConfig(cfg({ members: [m[0], m[0], m[1]] })).problems.join()).toMatch(/duplicate/);
    expect(checkMultisigConfig(cfg({ members: [{ pubkey: "nope", permissions: "all" }] })).problems.join()).toMatch(/not a public key/);
    expect(checkMultisigConfig(cfg({ members: m.map((x) => ({ ...x, permissions: ["vote" as const] })) })).problems.join()).toMatch(/initiate.*execute|no member can initiate/);
    expect(checkMultisigConfig(cfg({ timeLockSecs: 100 * 86_400 })).problems.join()).toMatch(/timeLockSecs/);
    expect(checkMultisigConfig(cfg({ timeLockSecs: 3600 })).warnings.join()).toMatch(/< 48h/);
    expect(checkMultisigConfig(cfg({ threshold: 5 })).warnings.join()).toMatch(/no spare voter/);
    expect(checkMultisigConfig(cfg({ label: "guardian", threshold: 2, timeLockSecs: 60, members: m.slice(0, 3) })).warnings.join()).toMatch(/delays emergency pauses/);
    // an ops key (initiate + execute, no vote) doesn't count toward the threshold
    expect(checkMultisigConfig(cfg({ threshold: 3, members: [...m.slice(0, 2), { pubkey: pk(), permissions: ["initiate", "execute"] }] })).problems.join()).toMatch(/threshold 3 > 2 voting/);
  });
  it("resolves createKeyPath next to the config file", () => {
    const f = envFile("admin.json", JSON.stringify(cfg()));
    expect(loadMultisigConfig(f).createKeyPath).toBe(join(dir, "admin-create-key.json"));
  });
});

describe("loader + governance instructions", () => {
  const vault = Keypair.generate().publicKey;
  it("SetAuthority (unchecked: a vault PDA can't co-sign)", () => {
    const ix = setUpgradeAuthorityIx(new PublicKey(pk()), vault);
    expect(ix.programId.equals(BPF_LOADER_UPGRADEABLE_ID)).toBe(true);
    expect([...ix.data]).toEqual([4, 0, 0, 0]);
    expect(ix.keys[0].pubkey.equals(programDataPda())).toBe(true);
    expect([ix.keys[1].isSigner, ix.keys[2].pubkey.equals(vault), ix.keys[2].isSigner]).toEqual([true, true, false]);
  });
  it("Upgrade: programdata, program, buffer, spill, rent, clock, authority(signer)", () => {
    const buffer = new PublicKey(pk());
    const ix = upgradeIx({ buffer, spill: vault, authority: vault });
    expect([...ix.data]).toEqual([3, 0, 0, 0]);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([programDataPda(), FUMPAD_PROGRAM_ID, buffer, vault, SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY, vault].map((k) => k.toBase58()));
    expect(ix.keys[6].isSigner).toBe(true);
  });
  it("ExtendProgram unchecked (6, no authority) and checked (9, authority signs)", () => {
    const u = extendProgramIx({ bytes: 10_240, payer: vault });
    expect([u.data.readUInt32LE(0), u.data.readUInt32LE(4), u.keys.length]).toEqual([6, 10_240, 4]);
    const c = extendProgramIx({ bytes: 10_240, payer: vault, checkedAuthority: vault });
    expect([c.data.readUInt32LE(0), c.keys.length, c.keys[2].isSigner]).toEqual([9, 5, true]);
  });
  it("vault actions sign as the vault; pause bits are bounded", () => {
    for (const a of [{ kind: "accept-admin" }, { kind: "cancel-admin" }, { kind: "cancel-params" }, { kind: "set-pause", bits: 31 }] as const) {
      const [ix] = actionIxs(a, vault);
      expect(ix.programId.equals(FUMPAD_PROGRAM_ID)).toBe(true);
      expect(ix.keys.find((k) => k.pubkey.equals(vault))?.isSigner).toBe(true);
    }
    expect(() => actionIxs({ kind: "set-pause", bits: 32 }, vault)).toThrow(/pause bits/);
  });
});
