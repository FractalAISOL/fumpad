/** D18 vanity launch: request validation, vault format (shared with the Rust grinder), helpers. */
import { createCipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { FUMPAD_IDL, FUMPAD_PROGRAM_ID, FUMPAD_VANITY_SUFFIX, idlInstruction, isFumpadVanityMint, launchMetadataError } from "@fumpad/sdk";

import { parsePrepareBody, WindowLimiter } from "../src/launch/routes.js";
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
  it("per-wallet window limiter", () => {
    const l = new WindowLimiter(2, 1_000);
    expect([l.take("a", 0), l.take("a", 1), l.take("a", 2), l.take("b", 2), l.take("a", 1_001)]).toEqual([true, true, false, true, true]);
  });
});

describe("app/src/chain/program.ts stays in sync with the IDL", () => {
  it("program id, discriminators and suffix", () => {
    const chainDir = join(dirname(fileURLToPath(import.meta.url)), "../../../app/src/chain/");
    const src = readFileSync(chainDir + "program.ts", "utf8");
    // The program id lives in cluster.ts (one place per cluster); program.ts wraps it.
    expect(src).toContain("new PublicKey(FUMPAD_PROGRAM_ADDRESS)");
    expect(readFileSync(chainDir + "cluster.ts", "utf8")).toContain(`FUMPAD_PROGRAM_ADDRESS = "${FUMPAD_PROGRAM_ID.toBase58()}"`);
    expect(src).toContain(`VANITY_SUFFIX = "${FUMPAD_VANITY_SUFFIX}"`);
    // Only the launch check's discriminators live in the app; every builder comes from @fumpad/sdk.
    for (const [name, constName] of [["create_coin", "CREATE_COIN"], ["buy", "BUY"]]) {
      expect(src).toContain(`const ${constName} = [${idlInstruction(FUMPAD_IDL, name).discriminator.join(", ")}];`);
    }
    expect(idlInstruction(FUMPAD_IDL, "set_auto_claim").accounts.map((a) => a.name)).toEqual(["wallet", "position", "event_authority", "program"]);
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
