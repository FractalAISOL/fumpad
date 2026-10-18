/**
 * APP-1 / M-4: the wallet bridge's own allow-list gate. The Privy bridge (`components/wallet/PrivyIsland.tsx`) hands
 * every `signTransaction` to `bridgeSignTransaction`, which decides — on the exact bytes Privy will sign — whether the
 * embedded wallet may sign without showing its window:
 *
 *   - not silent                       → Privy shows its approval window (nothing to check here).
 *   - silent, no policy                → downgraded: Privy shows its approval window (the user-visible confirm).
 *   - silent, a FUMPAD action policy   → `vetFumpadTx` on the bytes; refused → nothing is signed (throws).
 *   - silent, the confirmed withdrawal → `vetWithdrawTx` on the bytes (one plain transfer of exactly that amount to
 *                                        exactly that address); refused → nothing is signed.
 *
 * The transaction is serialized once, the check runs on a copy deserialized from those bytes, and those same bytes go
 * to Privy, so a caller can't hand the check one transaction and Privy another (a mutable object, a getter). The
 * signed result must carry the same message bytes, or it is thrown away.
 *
 * What this does not stop (see app/LAUNCH.md, "CSP assumption that remains"): a script running in our origin can
 * still call the bridge with a policy of its own making — the allow-list then bounds it to our FUMPAD transactions
 * for the user's own wallet and coins (or a withdrawal it names). Keeping such scripts out is the CSP's job.
 *
 * No React, no `@/` imports: unit-tested by `silentGuard.test.ts` with `npm test`.
 */
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { type SilentPolicy, SilentSignRefused, vetFumpadTx, vetWithdrawTx } from "./allowlist";

/** What a caller asks the bridge to sign silently. */
export type SignPolicy =
  /** A FUMPAD action, under the allow-list policy the app built it with. */
  | { kind: "fumpad"; policy: SilentPolicy }
  /** The withdrawal the user confirmed on screen: exactly `lamports` to `destination`. */
  | { kind: "withdraw"; destination: string; lamports: bigint };

export interface BridgeSignRequest {
  /** The account that signs (base58). */
  address: string;
  tx: VersionedTransaction;
  silent: boolean;
  policy?: SignPolicy;
}

/** Throws `SilentSignRefused` unless `tx` is exactly what `policy` allows `address` to sign without a window. */
export function vetSilent(tx: VersionedTransaction, address: string, policy: SignPolicy): void {
  let wallet: PublicKey;
  try {
    wallet = new PublicKey(address);
  } catch {
    throw new SilentSignRefused("unknown wallet");
  }
  if (policy.kind === "fumpad") {
    vetFumpadTx(tx, wallet, policy.policy);
    return;
  }
  if (policy.kind === "withdraw") {
    let destination: PublicKey;
    try {
      destination = new PublicKey(policy.destination);
    } catch {
      throw new SilentSignRefused("unknown destination");
    }
    if (typeof policy.lamports !== "bigint" || policy.lamports <= BigInt(0)) throw new SilentSignRefused("a withdrawal needs its amount");
    vetWithdrawTx(tx, wallet, destination, policy.lamports);
    return;
  }
  throw new SilentSignRefused("unknown signing policy");
}

/** How the bridge signs: the exact bytes to hand Privy, and whether Privy shows its approval window. */
export function planBridgeSign(req: BridgeSignRequest): { bytes: Uint8Array; showWalletUIs: boolean } {
  const bytes = Uint8Array.from(req.tx.serialize());
  if (!req.silent) return { bytes, showWalletUIs: true };
  // Not allow-listed (no policy): the user sees and approves it in the wallet's own window.
  if (!req.policy) return { bytes, showWalletUIs: true };
  vetSilent(VersionedTransaction.deserialize(bytes), req.address, req.policy);
  return { bytes, showWalletUIs: false };
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Plan, sign with `sign` (Privy's `signTransaction`, given the exact bytes and the window choice), and check the signed
 * transaction is the same message. `sign` is never called when the policy refuses.
 */
export async function bridgeSignTransaction(
  req: BridgeSignRequest,
  sign: (bytes: Uint8Array, showWalletUIs: boolean) => Promise<Uint8Array>,
): Promise<VersionedTransaction> {
  const { bytes, showWalletUIs } = planBridgeSign(req);
  const signed = VersionedTransaction.deserialize(await sign(bytes, showWalletUIs));
  if (!sameBytes(signed.message.serialize(), VersionedTransaction.deserialize(bytes).message.serialize()))
    throw new Error("The wallet changed the transaction, so it wasn't sent.");
  return signed;
}
