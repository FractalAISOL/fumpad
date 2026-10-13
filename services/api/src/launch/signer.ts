/**
 * Launch binding key (off-chain review L1; INTERFACE §8.1). When `Global.params.launch_signer` is set,
 * `register_coin` must be co-signed by that key, so only launch transactions built by this API register a
 * coin. The key is separate from MINT_POOL_KEY (which only decrypts pooled vanity mints).
 *
 * LAUNCH_SIGNER_KEY: the 64-byte secret key as base58, or as a JSON byte array (solana-keygen format).
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import { LaunchError } from "./pool.js";

export function parseLaunchSignerKey(v: string | undefined): Keypair | null {
  if (!v) return null;
  const s = v.trim();
  let bytes: Uint8Array;
  try {
    bytes = s.startsWith("[") ? Uint8Array.from(JSON.parse(s) as number[]) : bs58.decode(s);
  } catch {
    throw new Error("LAUNCH_SIGNER_KEY must be a base58 secret key or a JSON byte array");
  }
  if (bytes.length !== 64) throw new Error("LAUNCH_SIGNER_KEY must be a 64-byte secret key");
  return Keypair.fromSecretKey(bytes);
}

/**
 * Which launch signer the launch tx needs: none while the on-chain param is unset; this API's key when it
 * matches; otherwise launches can't register (503) — never build a tx the program will refuse.
 */
export function launchSignerFor(onChain: PublicKey, key: Keypair | null): Keypair | null {
  if (onChain.equals(PublicKey.default)) return null;
  if (!key) throw new LaunchError(503, "launches need the server's launch key, which isn't configured");
  if (!key.publicKey.equals(onChain)) throw new LaunchError(503, "the server's launch key doesn't match Global.params.launch_signer");
  return key;
}
