/** D18 vanity launch: request validation, vault format (shared with the Rust grinder), helpers. */
import { createCipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { DEFAULT_FUMPAD_PROGRAM_ID, FEE_POLICY, FUMPAD_IDL, FUMPAD_PROGRAM_ID, FUMPAD_VANITY_SUFFIX, idlInstruction, isFumpadVanityMint, launchMetadataError, STANDARD_FEE_POLICY } from "@fumpad/sdk";

import { parsePrepareBody, pickLaunchConfig, WindowLimiter } from "../src/launch/routes.js";
import { keyFingerprint, MintVault, parsePoolKey } from "../src/launch/vault.js";

const KEY_HEX = "11".repeat(32);

/** Same format as services/grinder/src/crypto.rs (nonce ‖ AES-256-GCM(seed) ‖ tag, AAD binds the pubkey). */
export function encryptSeed(keyHex: string, pubkey: string, seed: Uint8Array): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), nonce);
  c.setAAD(Buffer.concat([Buffer.from("fumpad-vanity-mint:v1:"), Buffer.from(pubkey)]));
  return Buffer.concat([nonce, c.update(seed), c.final(), c.getAuthTag()]);
}

const cfg = { launchMaxInitialBuyLamports: 100_000_000_000n, launchMaxPriorityMicroLamports: 5_000_000 };
const wallet = Keypair.generate().publicKey.toBase58();
const ok = { creator: wallet, name: "Sad Pigeon", symbol: "PIGN", uri: "ipfs://bafy" };

describe("vanity helpers", () => {
  it("isFumpadVanityMint: case-sensitive fmbL suffix", () => {
    expect(FUMPAD_VANITY_SUFFIX).toBe("fmbL");
    expect(isFumpadVanityMint("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosfmbL")).toBe(true);
    expect(isFumpadVanityMint("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosfmbl")).toBe(false);
    expect(isFumpadVanityMint("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosFMBL")).toBe(false);
    expect(isFumpadVanityMint(new PublicKey("So11111111111111111111111111111111111111112"))).toBe(false);
    expect(isFumpadVanityMint("abcz", "z")).toBe(true);
    expect(isFumpadVanityMint("abcl", "l")).toBe(false); // `l` isn't base58
  });
  it("metadata limits match the program (UTF-8 bytes) + hygiene", () => {
    expect(launchMetadataError({ name: "x".repeat(32), symbol: "y".repeat(10), uri: "https://" + "z".repeat(192) })).toBeNull();
    expect(launchMetadataError({ name: "x".repeat(33), symbol: "Y", uri: "https://a" })).toMatch(/name/);
    expect(launchMetadataError({ name: "é".repeat(17), symbol: "Y", uri: "https://a" })).toMatch(/32 bytes/);
    expect(launchMetadataError({ name: "X", symbol: "Y".repeat(11), uri: "https://a" })).toMatch(/symbol/);
    expect(launchMetadataError({ name: "X", symbol: "Y", uri: "https://" + "z".repeat(193) })).toMatch(/uri/);
    expect(launchMetadataError({ name: "  ", symbol: "Y", uri: "https://a" })).toMatch(/empty/);
    expect(launchMetadataError({ name: "X", symbol: "Y", uri: "javascript:alert(1)" })).toMatch(/https/);
    expect(launchMetadataError({ name: "X‮", symbol: "Y", uri: "https://a" })).toMatch(/control/);
    expect(launchMetadataError({ name: 5, symbol: "Y", uri: "https://a" })).toMatch(/strings/);
  });
});

describe("POST /v1/launch/prepare body", () => {
  it("accepts a valid request", () => {
    const p = parsePrepareBody({ ...ok, initialBuyLamports: "500000000", slippageBps: 200, priorityMicroLamports: 1000 }, cfg);
    expect(p.creator.toBase58()).toBe(wallet);
    expect(p.initialBuyLamports).toBe(500_000_000n);
    expect(p.slippageBps).toBe(200);
  });
  it("rejects bad creators (garbage, off-curve PDA) and bad numbers", () => {
    const bad = (b: object) => () => parsePrepareBody(b, cfg);
    expect(bad({ ...ok, creator: "nope" })).toThrow(/creator/);
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("x")], new PublicKey("ASVE6Nk8T1c2Uv81vjPeNDnX54nHGWg98G1afYt2j8Cv"));
    expect(bad({ ...ok, creator: pda.toBase58() })).toThrow(/wallet/);
    expect(bad({ ...ok, initialBuyLamports: "-1" })).toThrow(/initialBuy/);
    expect(bad({ ...ok, initialBuyLamports: 1.5 })).toThrow(/initialBuy/);
    expect(bad({ ...ok, initialBuyLamports: "100000000001" })).toThrow(/too large/);
    expect(bad({ ...ok, slippageBps: 9_000 })).toThrow(/slippage/);
    expect(bad({ ...ok, priorityMicroLamports: 10_000_000 })).toThrow(/priority/);
    expect(bad({ ...ok, name: "" })).toThrow(/name/);
    expect(bad("x" as unknown as object)).toThrow(/JSON/);
  });
  it("launchConfig: standard by default, first_coin on request, anything else refused", () => {
    expect(parsePrepareBody(ok, cfg).launchConfig).toBe("standard");
    expect(parsePrepareBody({ ...ok, launchConfig: "first_coin" }, cfg).launchConfig).toBe("first_coin");
    expect(() => parsePrepareBody({ ...ok, launchConfig: "special" }, cfg)).toThrow(/launchConfig/);
  });
  it("per-wallet window limiter", () => {
    const l = new WindowLimiter(2, 1_000);
    expect([l.take("a", 0), l.take("a", 1), l.take("a", 2), l.take("b", 2), l.take("a", 1_001)]).toEqual([true, true, false, true, true]);
  });
});

describe("app/src/chain stays in sync with the v0.7 program", () => {
  it("program id (cluster.ts; the rest from @fumpad/sdk), vanity suffix, IDL account lists the app relies on", () => {
    const chainDir = join(dirname(fileURLToPath(import.meta.url)), "../../../app/src/chain/");
    // the app's default (NEXT_PUBLIC_FUMPAD_PROGRAM_ID unset) = the SDK's default = the devnet build's declare_id!
    expect(readFileSync(chainDir + "cluster.ts", "utf8")).toContain(`DEVNET_PROGRAM_ADDRESS = "${DEFAULT_FUMPAD_PROGRAM_ID}"`);
    if (!process.env.FUMPAD_PROGRAM_ID) expect(FUMPAD_PROGRAM_ID.toBase58()).toBe(DEFAULT_FUMPAD_PROGRAM_ID);
    // The app's instruction encoders, PDAs and vanity suffix are the SDK's own (no app copies left).
    expect(readFileSync(chainDir + "program.ts", "utf8")).toContain("VANITY_SUFFIX = FUMPAD_VANITY_SUFFIX");
    expect(FUMPAD_VANITY_SUFFIX).toBe("fmbL");
    expect(idlInstruction(FUMPAD_IDL, "set_auto_claim").accounts.map((a) => a.name)).toEqual(["wallet", "position", "event_authority", "program"]);
    // 14 since INTERFACE §8.1 (optional launch_signer); unchanged by the fee policies (the snapshot lives in the Coin
    // account itself): the app's allow-list rebuilds register_coin with the SDK and must follow
    expect(idlInstruction(FUMPAD_IDL, "register_coin").accounts.length).toBe(14);
  });
});

describe("launch config choice (first-coin config, INTERFACE §5.9)", () => {
  const std = Keypair.generate().publicKey;
  const first = Keypair.generate().publicKey;
  const wallet = Keypair.generate().publicKey;
  const firstPolicy = { kind: FEE_POLICY.walletSplit, buybackShare: 100, walletShare: 140, maxCoins: 1, wallet };
  const g = (coins = 0, order: "std-first" | "first-first" = "std-first") => {
    const slots = order === "std-first" ? [[std, STANDARD_FEE_POLICY], [first, firstPolicy]] : [[first, firstPolicy], [std, STANDARD_FEE_POLICY]];
    return {
      configs: [...slots.map((s) => s[0] as PublicKey), ...Array(6).fill(PublicKey.default)],
      configPolicies: [...slots.map((s) => s[1] as typeof firstPolicy), ...Array(6).fill(STANDARD_FEE_POLICY)],
      configCoins: order === "std-first" ? [5, coins, 0, 0, 0, 0, 0, 0] : [coins, 5, 0, 0, 0, 0, 0, 0],
    };
  };
  it("standard never picks the first-coin config, whatever the slot order", () => {
    expect(pickLaunchConfig(g(), "standard", true).dbcConfig.equals(std)).toBe(true);
    expect(pickLaunchConfig(g(0, "first-first"), "standard", true).dbcConfig.equals(std)).toBe(true);
  });
  it("first_coin needs the server flag, an allow-listed wallet-split config and a launch left", () => {
    expect(() => pickLaunchConfig(g(), "first_coin", false)).toThrow(/not enabled/);
    const s = pickLaunchConfig(g(), "first_coin", true);
    expect(s.dbcConfig.equals(first) && s.policy.wallet.equals(wallet)).toBe(true);
    expect(() => pickLaunchConfig(g(1), "first_coin", true)).toThrow(/not available/);
    const none = { configs: [std, ...Array(7).fill(PublicKey.default)], configPolicies: Array(8).fill(STANDARD_FEE_POLICY), configCoins: Array(8).fill(0) };
    expect(() => pickLaunchConfig(none, "first_coin", true)).toThrow(/not available/);
  });
});

describe("mint vault (format shared with the Rust grinder)", () => {
  it("fingerprint matches the grinder's pinned vector; hex and base64 keys agree", () => {
    expect(keyFingerprint(parsePoolKey(KEY_HEX))).toBe("cc290de99b2f1d15"); // grinder crypto.rs fingerprint_vector
    expect(keyFingerprint(parsePoolKey(Buffer.from(KEY_HEX, "hex").toString("base64")))).toBe("cc290de99b2f1d15");
    expect(() => parsePoolKey("abcd")).toThrow();
  });
  it("decrypts to a signer for exactly that pubkey; tampering or another row's ciphertext fails", () => {
    const kp = Keypair.generate();
    const seed = kp.secretKey.slice(0, 32);
    const pk = kp.publicKey.toBase58();
    const blob = encryptSeed(KEY_HEX, pk, seed);
    const v = new MintVault(KEY_HEX);
    const s = v.signer(pk, blob);
    expect(s.publicKey.equals(kp.publicKey)).toBe(true);
    const msg = Buffer.from("hello");
    const nacl = Keypair.fromSeed(seed);
    expect(Buffer.from(s.sign(msg)).length).toBe(64);
    expect(nacl.publicKey.equals(s.publicKey)).toBe(true);
    const other = Keypair.generate().publicKey.toBase58();
    expect(() => v.signer(other, blob)).toThrow(/decrypt/);
    const t = Buffer.from(blob);
    t[20] ^= 1;
    expect(() => v.signer(pk, t)).toThrow(/decrypt/);
    expect(() => new MintVault("22".repeat(32)).signer(pk, blob)).toThrow(/decrypt/);
    // The signer object exposes no key material.
    expect(JSON.stringify(s)).not.toContain(Buffer.from(seed).toString("hex"));
    expect(Object.keys(s).sort()).toEqual(["publicKey", "sign"]);
  });
});
