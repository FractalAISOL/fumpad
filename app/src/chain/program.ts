/**
 * The little on-chain knowledge the app needs outside the builders: the FUMPAD program id, D18
 * vanity-mint helpers (the SDK's check plus the display split), and the shape check of the API's
 * prepared launch transaction before the wallet signs it. Instruction encoders are @fumpad/sdk's.
 */
import type { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { FUMPAD_VANITY_SUFFIX, isFumpadVanityMint as sdkIsVanity } from "@fumpad/sdk";
import { type LaunchShape, vetFumpadTx } from "./allowlist";

export { FUMPAD_PROGRAM_ID } from "@fumpad/sdk";

/** D18: FUMPAD-launched mints end in `fmbL` (case-sensitive base58; `fmbl` can't exist). */
export const VANITY_SUFFIX = FUMPAD_VANITY_SUFFIX;

export function isFumpadVanityMint(address: string, suffix = VANITY_SUFFIX): boolean {
  return sdkIsVanity(address, suffix);
}

/** Split an address for display: `{ head, tail }` where `tail` is the vanity suffix (or ""). */
export function splitVanity(address: string, suffix = VANITY_SUFFIX): { head: string; tail: string } {
  return isFumpadVanityMint(address, suffix) ? { head: address.slice(0, -suffix.length), tail: suffix } : { head: address, tail: "" };
}

/**
 * Refuse to sign anything but a v0.7 FUMPAD launch of the advertised `…fmbL` mint, paid by this
 * wallet and co-signed by the mint: [wrap SOL] → DBC pool init → [the creator's first buy] →
 * register_coin (the allow-list's launch pattern, `./allowlist.ts`). The API signs only as the
 * mint, so this is what stands between a compromised API and the user's wallet; `./launch.ts`
 * then binds the details (name, symbol, uri, first-buy amount and minimum) to what the user asked for.
 */
export function checkPreparedLaunch(
  tx: VersionedTransaction,
  wallet: PublicKey,
  mint: string,
  suffix = VANITY_SUFFIX,
  maxSolInLamports = BigInt(0),
): LaunchShape {
  if (!isFumpadVanityMint(mint, suffix)) throw new Error("Refusing to sign: the mint address isn't a FUMPAD address.");
  const { launch } = vetFumpadTx(tx, wallet, { action: "launch", mint, coSigner: mint, maxSolInLamports });
  return launch!;
}
