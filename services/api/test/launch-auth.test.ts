/** M-2: the signed launch message (proof of wallet control before a mint is reserved). */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";

import { launchAuthError, launchAuthMessage, signLaunchAuth } from "../src/launch/auth.js";

const kp = Keypair.generate();
const creator = kp.publicKey;
const opts = { maxAgeSecs: 600 };

describe("launch auth", () => {
  it("accepts the creator's signature over the exact message (base58 or base64)", () => {
    const a = signLaunchAuth(kp.secretKey, { creator: creator.toBase58(), symbol: "PIGN" });
    expect(launchAuthError(a, { creator, symbol: "PIGN" }, opts)).toBeNull();
    const b64 = { ...a, signature: Buffer.from(bs58.decode(a.signature)).toString("base64") };
    expect(launchAuthError(b64, { creator, symbol: "PIGN" }, opts)).toBeNull();
  });

  it("rejects: missing, another wallet's key, another wallet/symbol in the text, tampering, expiry, future", () => {
    const other = Keypair.generate();
    expect(launchAuthError(undefined, { creator, symbol: "PIGN" }, opts)).toMatch(/auth required/);
    // Signed by someone else but claiming to be the creator (a drainer without the key).
    const forged = signLaunchAuth(other.secretKey, { creator: creator.toBase58(), symbol: "PIGN" });
    expect(launchAuthError(forged, { creator, symbol: "PIGN" }, opts)).toMatch(/does not match/);
    const theirs = signLaunchAuth(other.secretKey, { creator: other.publicKey.toBase58(), symbol: "PIGN" });
    expect(launchAuthError(theirs, { creator, symbol: "PIGN" }, opts)).toMatch(/another wallet/);
    const a = signLaunchAuth(kp.secretKey, { creator: creator.toBase58(), symbol: "PIGN" });
    expect(launchAuthError(a, { creator, symbol: "OTHER" }, opts)).toMatch(/another symbol/);
    expect(launchAuthError({ ...a, message: a.message.replace("PIGN", "PIGX") }, { creator, symbol: "PIGX" }, opts)).toMatch(/does not match/);
    const old = signLaunchAuth(kp.secretKey, { creator: creator.toBase58(), symbol: "PIGN", issuedAt: Date.now() - 601_000 });
    expect(launchAuthError(old, { creator, symbol: "PIGN" }, opts)).toMatch(/expired/);
    const future = signLaunchAuth(kp.secretKey, { creator: creator.toBase58(), symbol: "PIGN", issuedAt: Date.now() + 120_000 });
    expect(launchAuthError(future, { creator, symbol: "PIGN" }, opts)).toMatch(/expired/);
    const shortNonce = signLaunchAuth(kp.secretKey, { creator: creator.toBase58(), symbol: "PIGN", nonce: "abc" });
    expect(launchAuthError(shortNonce, { creator, symbol: "PIGN" }, opts)).toMatch(/nonce/);
    expect(launchAuthError({ message: a.message, signature: "zz" }, { creator, symbol: "PIGN" }, opts)).toMatch(/signature/);
  });

  it("message format is stable (the app builds the same text)", () => {
    // legacy five lines (apps before L-3; accepted while LAUNCH_AUTH_LEGACY=true)
    expect(launchAuthMessage({ creator: "C", symbol: "S", nonce: "n".repeat(16), issuedAt: 1 })).toBe(`FUMPAD launch\ncreator: C\nsymbol: S\nnonce: ${"n".repeat(16)}\nissuedAt: 1`);
    // L-3: what app/src/chain/launchAuth.ts signs now
    expect(launchAuthMessage({ domain: "fumpad.app", cluster: "mainnet", creator: "C", symbol: "S", nonce: "n".repeat(16), issuedAt: 1 })).toBe(
      `FUMPAD launch\ndomain: fumpad.app\ncluster: mainnet\ncreator: C\nsymbol: S\nnonce: ${"n".repeat(16)}\nissuedAt: 1`,
    );
  });

  it("the app's message builder emits the same seven lines (app/src/chain/launchAuth.ts)", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../app/src/chain/launchAuth.ts"), "utf8");
    expect(src).toContain("[LAUNCH_AUTH_HEADER, `domain: ${a.domain}`, `cluster: ${a.cluster}`, `creator: ${a.creator}`, `symbol: ${a.symbol}`, `nonce: ${a.nonce}`, `issuedAt: ${a.issuedAt}`]");
  });
});
