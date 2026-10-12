/**
 * The little on-chain knowledge the app needs without the SDK: the FUMPAD program id,
 * D18 vanity-mint helpers (mirror of services/sdk/src/vanity.ts), a check of the API's
 * prepared launch transaction before the wallet signs it, and the D17 `set_auto_claim`
 * instruction (two accounts + a bool).
 */
import { ComputeBudgetProgram, PublicKey, TransactionInstruction, type VersionedTransaction } from "@solana/web3.js";

export const FUMPAD_PROGRAM_ID = new PublicKey("ASVE6Nk8T1c2Uv81vjPeNDnX54nHGWg98G1afYt2j8Cv");

/** D18: FUMPAD-launched mints end in `fmbL` (case-sensitive base58; `fmbl` can't exist). */
export const VANITY_SUFFIX = "fmbL";
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

export function isFumpadVanityMint(address: string, suffix = VANITY_SUFFIX): boolean {
  return BASE58.test(suffix) && BASE58.test(address) && address.length > suffix.length && address.endsWith(suffix);
}

/** Split an address for display: `{ head, tail }` where `tail` is the vanity suffix (or ""). */
export function splitVanity(address: string, suffix = VANITY_SUFFIX): { head: string; tail: string } {
  return isFumpadVanityMint(address, suffix) ? { head: address.slice(0, -suffix.length), tail: suffix } : { head: address, tail: "" };
}

/** create_coin discriminator (IDL) — the prepared tx's first FUMPAD instruction. */
const CREATE_COIN = [208, 85, 34, 37, 235, 182, 111, 78];
const BUY = [102, 6, 61, 18, 1, 218, 235, 234];
const startsWith = (d: Uint8Array, p: number[]) => p.every((b, i) => d[i] === b);

/**
 * Refuse to sign anything but `[compute budget…] create_coin [buy]` from FUMPAD, paid by
 * this wallet, for the advertised `…fmbL` mint. The API signs only as the mint, so this is
 * what stands between a compromised API and the user's wallet.
 */
export function checkPreparedLaunch(tx: VersionedTransaction, wallet: PublicKey, mint: string, suffix = VANITY_SUFFIX): void {
  const m = tx.message;
  const keys = m.staticAccountKeys;
  const fail = (why: string) => {
    throw new Error(`Refusing to sign: ${why}.`);
  };
  if (m.addressTableLookups.length) fail("unexpected lookup tables");
  if (!keys[0].equals(wallet)) fail("your wallet isn't the fee payer");
  if (!isFumpadVanityMint(mint, suffix)) fail("the mint address isn't a FUMPAD address");
  const signers = keys.slice(0, m.header.numRequiredSignatures).map((k) => k.toBase58());
  if (signers.length !== 2 || !signers.includes(mint)) fail("unexpected signers");
  const ixs = m.compiledInstructions;
  let i = 0;
  while (i < ixs.length && keys[ixs[i].programIdIndex].equals(ComputeBudgetProgram.programId)) i++;
  const rest = ixs.slice(i);
  if (i > 2 || rest.length < 1 || rest.length > 2 || rest.some((x) => !keys[x.programIdIndex].equals(FUMPAD_PROGRAM_ID))) fail("it isn't a FUMPAD launch");
  const create = rest[0];
  if (!startsWith(create.data, CREATE_COIN)) fail("first instruction isn't create_coin");
  if (!keys[create.accountKeyIndexes[0]].equals(wallet) || keys[create.accountKeyIndexes[2]].toBase58() !== mint) fail("wrong creator or mint");
  if (rest[1] && !startsWith(rest[1].data, BUY)) fail("second instruction isn't your first buy");
}

const enc = (s: string) => new TextEncoder().encode(s);
const SET_AUTO_CLAIM = [135, 111, 55, 239, 20, 249, 33, 144];

/** D17 `set_auto_claim(enabled)`: the wallet's Position on `mint` must exist (it does once they traded). */
export function setAutoClaimIx(wallet: PublicKey, mint: PublicKey, enabled: boolean): TransactionInstruction {
  const [position] = PublicKey.findProgramAddressSync([enc("position"), mint.toBytes(), wallet.toBytes()], FUMPAD_PROGRAM_ID);
  const [eventAuthority] = PublicKey.findProgramAddressSync([enc("__event_authority")], FUMPAD_PROGRAM_ID);
  return new TransactionInstruction({
    programId: FUMPAD_PROGRAM_ID,
    keys: [
      { pubkey: wallet, isSigner: true, isWritable: false },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: FUMPAD_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Uint8Array.from([...SET_AUTO_CLAIM, enabled ? 1 : 0]) as Buffer,
  });
}
