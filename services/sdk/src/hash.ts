/** Synchronous hashing / Ed25519 (browser-safe, @noble — already a dependency of @solana/web3.js). */
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 as nobleSha256 } from "@noble/hashes/sha256";

export const sha256 = (data: Uint8Array): Uint8Array => nobleSha256(data);

/** Ed25519 signature check (used by the watcher / verification feed and tests). */
export function ed25519Verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

/** Ed25519 sign with a 32-byte seed or a 64-byte Solana secret key (keepers sign attestations). */
export function ed25519Sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return ed25519.sign(message, secretKey.length === 64 ? secretKey.subarray(0, 32) : secretKey);
}
