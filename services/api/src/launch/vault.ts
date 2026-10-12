/**
 * Decrypts pooled vanity mint secrets (format: services/grinder/src/crypto.rs) into an
 * opaque signer. The 32-byte seed lives only long enough to build a node `KeyObject`
 * (non-extractable in practice: nothing here exports it), the buffer is zeroed right
 * after, and the signer exposes only `publicKey` + `sign(message)`. Nothing in this
 * module logs, returns or serializes key material.
 */
import { createDecipheriv, createHash, createPrivateKey, createPublicKey, type KeyObject, sign as edSign } from "node:crypto";

import { PublicKey } from "@solana/web3.js";

const AAD_PREFIX = Buffer.from("fumpad-vanity-mint:v1:");
const FP_PREFIX = Buffer.from("fumpad-mint-pool-key-fp:");
/** PKCS#8 DER header for an Ed25519 private key; the 32-byte seed follows. */
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

export const ENC_VERSION = 1;

export interface MintSigner {
  readonly publicKey: PublicKey;
  sign(message: Uint8Array): Uint8Array;
}

export class VaultError extends Error {}

/** Parse MINT_POOL_KEY: 32 bytes as 64 hex chars or standard base64. */
export function parsePoolKey(raw: string): Buffer {
  const s = raw.trim();
  const b = /^[0-9a-fA-F]{64}$/.test(s) ? Buffer.from(s, "hex") : Buffer.from(s, "base64");
  if (b.length !== 32) throw new VaultError("MINT_POOL_KEY must be 32 bytes (64 hex chars or base64)");
  return b;
}

export function keyFingerprint(key: Buffer): string {
  return createHash("sha256").update(FP_PREFIX).update(key).digest().subarray(0, 8).toString("hex");
}

export class MintVault {
  readonly fingerprint: string;
  readonly #key: Buffer;

  constructor(rawKey: string) {
    this.#key = parsePoolKey(rawKey);
    this.fingerprint = keyFingerprint(this.#key);
  }

  /** Decrypt `blob` for `pubkey` and return a signer; throws if it doesn't decrypt to that exact key. */
  signer(pubkey: string, blob: Uint8Array, encVersion = ENC_VERSION): MintSigner {
    if (encVersion !== ENC_VERSION) throw new VaultError(`unsupported enc_version ${encVersion}`);
    const b = Buffer.from(blob);
    if (b.length !== 12 + 32 + 16) throw new VaultError("bad secret length");
    let seed: Buffer | undefined;
    let der: Buffer | undefined;
    try {
      const d = createDecipheriv("aes-256-gcm", this.#key, b.subarray(0, 12));
      d.setAAD(Buffer.concat([AAD_PREFIX, Buffer.from(pubkey)]));
      d.setAuthTag(b.subarray(44));
      seed = Buffer.concat([d.update(b.subarray(12, 44)), d.final()]);
      der = Buffer.concat([PKCS8_ED25519, seed]);
      const key: KeyObject = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
      const x = createPublicKey(key).export({ format: "jwk" }).x;
      const derived = new PublicKey(Buffer.from(x ?? "", "base64url"));
      if (derived.toBase58() !== pubkey) throw new VaultError("secret does not match pubkey");
      return {
        publicKey: derived,
        sign: (message: Uint8Array) => new Uint8Array(edSign(null, message, key)),
      };
    } catch (e) {
      if (e instanceof VaultError) throw e;
      throw new VaultError("could not decrypt mint secret");
    } finally {
      seed?.fill(0);
      der?.fill(0);
    }
  }
}
