/**
 * One signer interface for every FUMPAD transaction, whatever wallet is behind it: the
 * Privy embedded Trading wallet (can sign without a prompt) or an external Wallet
 * Standard wallet (always prompts). `tx.ts` builds; this module decides how it is signed.
 */
import type { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { type SilentPolicy, vetFumpadTx } from "./allowlist";
import { vetLaunchAuthMessage } from "./launchAuth";

export type SignerKind = "embedded" | "external";

export interface FumpadSigner {
  publicKey: PublicKey;
  kind: SignerKind;
  /** "Trading wallet", "Phantom", … */
  name: string;
  /** `silent` hides the embedded wallet's prompt; external wallets prompt regardless. */
  sign(tx: VersionedTransaction, opts: { silent: boolean }): Promise<VersionedTransaction>;
  /**
   * `signMessage` over raw bytes (ed25519 signature, 64 bytes). `silent` is honoured only for
   * a vetted FUMPAD launch message (`./launchAuth`); the wallet bridge re-checks it.
   */
  signMessage(message: Uint8Array, opts: { silent: boolean }): Promise<Uint8Array>;
}

/** Same message bytes: a wallet that rewrites the message would break co-signatures and our checks. */
export function sameMessage(a: VersionedTransaction, b: VersionedTransaction): boolean {
  const x = a.message.serialize();
  const y = b.message.serialize();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * Vet, sign, verify. Every FUMPAD transaction goes through the allow-list first, whichever
 * wallet signs (it costs nothing and catches a builder or API gone wrong). Only a vetted
 * transaction from the embedded wallet with instant trading on is signed silently.
 */
export async function signFumpadTx(signer: FumpadSigner, tx: VersionedTransaction, policy: SilentPolicy, instant: boolean): Promise<VersionedTransaction> {
  vetFumpadTx(tx, signer.publicKey, policy);
  const signed = await signer.sign(tx, { silent: signer.kind === "embedded" && instant });
  if (!sameMessage(tx, signed)) throw new Error("Your wallet changed the transaction, so it wasn't sent. Try again.");
  return signed;
}

/**
 * M-2: sign the launch proof-of-ownership message. Same rule as transactions: vetted first
 * whichever wallet signs (`vetLaunchAuthMessage`, the message allow-list), and silent only
 * from the embedded wallet with instant trading on. Any other message never gets here.
 */
export async function signLaunchMessage(signer: FumpadSigner, message: Uint8Array, instant: boolean): Promise<Uint8Array> {
  vetLaunchAuthMessage(message, signer.publicKey);
  return signer.signMessage(message, { silent: signer.kind === "embedded" && instant });
}
