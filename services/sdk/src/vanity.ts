/**
 * D18 vanity mints: every coin launched from the FUMPAD app gets a mint address ending in
 * `fmbL` (case-sensitive base58; lowercase `fmbl` is impossible because base58 has no
 * `l`). App-level only, like pump.fun's `pump` — the program accepts any fresh mint.
 * The keys are pre-ground by services/grinder and co-signed by the API
 * (`POST /v1/launch/prepare`), so mint secrets never reach the browser.
 */
import { ComputeBudgetProgram, PublicKey, VersionedTransaction } from "@solana/web3.js";

import { FUMPAD_PROGRAM_ID } from "./constants.js";
import { fumpadCoder } from "./coder.js";

export const FUMPAD_VANITY_SUFFIX = "fmbL";
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** True if `pubkey`'s base58 address ends with `suffix` (default `fmbL`, case-sensitive). */
export function isFumpadVanityMint(pubkey: PublicKey | string, suffix: string = FUMPAD_VANITY_SUFFIX): boolean {
  if (!suffix || !BASE58.test(suffix)) return false;
  const s = typeof pubkey === "string" ? pubkey : pubkey.toBase58();
  return s.length > suffix.length && s.endsWith(suffix) && BASE58.test(s);
}

/** Program limits for `create_coin` metadata (curve/mod.rs; UTF-8 byte lengths). */
export const LAUNCH_LIMITS = { nameBytes: 32, symbolBytes: 10, uriBytes: 200 } as const;
/** URI schemes the app/API accept for the metadata JSON (the program accepts any string). */
export const LAUNCH_URI = /^(https:\/\/|ipfs:\/\/|ar:\/\/)[^\s]+$/;

const bytes = (s: string) => new TextEncoder().encode(s).length;
// C0/C1 control characters and bidi overrides have no place in a coin name.
const CONTROL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

/** Validate launch metadata like the program does (+ app hygiene). Returns an error message or null. */
export function launchMetadataError(m: { name: unknown; symbol: unknown; uri: unknown }): string | null {
  if (typeof m.name !== "string" || typeof m.symbol !== "string" || typeof m.uri !== "string") return "name, symbol and uri must be strings";
  if (!m.name.trim()) return "name is empty";
  if (!m.symbol.trim()) return "symbol is empty";
  if (bytes(m.name) > LAUNCH_LIMITS.nameBytes) return `name is longer than ${LAUNCH_LIMITS.nameBytes} bytes`;
  if (bytes(m.symbol) > LAUNCH_LIMITS.symbolBytes) return `symbol is longer than ${LAUNCH_LIMITS.symbolBytes} bytes`;
  if (bytes(m.uri) > LAUNCH_LIMITS.uriBytes) return `uri is longer than ${LAUNCH_LIMITS.uriBytes} bytes`;
  if (CONTROL.test(m.name) || CONTROL.test(m.symbol) || CONTROL.test(m.uri)) return "metadata contains control characters";
  if (!LAUNCH_URI.test(m.uri)) return "uri must be https://, ipfs:// or ar://";
  return null;
}

export interface LaunchTxInfo {
  feePayer: string;
  mint: string;
  creator: string;
  name: string;
  symbol: string;
  uri: string;
  /** Lamports of the optional first buy (same tx). */
  buySolIn?: bigint;
  /** Signers whose signature slot is filled. */
  signed: string[];
}

/**
 * Decode a prepared launch transaction and check it is exactly
 * `[compute budget…] create_coin [buy]` from FUMPAD, paid by the creator. Throws otherwise.
 * The app runs this on the API's transaction before asking the wallet to sign.
 */
export function inspectLaunchTx(tx: VersionedTransaction): LaunchTxInfo {
  const msg = tx.message;
  const keys = msg.staticAccountKeys;
  if (msg.addressTableLookups.length) throw new Error("launch tx must not use lookup tables");
  const feePayer = keys[0].toBase58();
  const ixs = msg.compiledInstructions.map((ix) => ({ program: keys[ix.programIdIndex], accounts: ix.accountKeyIndexes.map((i) => keys[i]), data: Buffer.from(ix.data) }));
  let i = 0;
  while (i < ixs.length && ixs[i].program.equals(ComputeBudgetProgram.programId)) i++;
  if (i > 2) throw new Error("too many compute budget instructions");
  const rest = ixs.slice(i);
  if (rest.length < 1 || rest.length > 2 || rest.some((x) => !x.program.equals(FUMPAD_PROGRAM_ID))) throw new Error("not a FUMPAD launch transaction");
  const coder = fumpadCoder();
  const create = coder.instruction.decode(rest[0].data);
  if (create?.name !== "create_coin") throw new Error("first program instruction is not create_coin");
  const a = create.data as { name: string; symbol: string; uri: string };
  const creator = rest[0].accounts[0].toBase58();
  const mint = rest[0].accounts[2].toBase58();
  if (creator !== feePayer) throw new Error("creator must pay the fees");
  let buySolIn: bigint | undefined;
  if (rest[1]) {
    const buy = coder.instruction.decode(rest[1].data);
    if (buy?.name !== "buy") throw new Error("second program instruction is not buy");
    if (rest[1].accounts[0].toBase58() !== creator || rest[1].accounts[3].toBase58() !== mint) throw new Error("buy is not the creator's first buy");
    buySolIn = BigInt((buy.data as { sol_in: { toString(): string } }).sol_in.toString());
  }
  const n = msg.header.numRequiredSignatures;
  const signed = keys.slice(0, n).filter((_, j) => tx.signatures[j]?.some((b) => b !== 0)).map((k) => k.toBase58());
  return { feePayer, mint, creator, name: a.name, symbol: a.symbol, uri: a.uri, buySolIn, signed };
}
