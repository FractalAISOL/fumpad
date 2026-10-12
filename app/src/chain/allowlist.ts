/**
 * What the Trading wallet (Privy embedded) may sign without showing anything.
 *
 * Silent signing is only safe if the transaction is exactly what our builders make. This
 * module checks the compiled message, not our intentions: an unexpected program, an
 * unexpected signer, a lookup table, a FUMPAD instruction acting for someone else, a buy
 * larger than the amount the user typed or an outsized priority fee all refuse. The
 * patterns mirror `@fumpad/sdk`'s builders (see `./build.ts`):
 *
 *   [ComputeBudget limit/price] [ATA create_idempotent (owner = payer = wallet)] FUMPAD ix
 *
 * The withdraw flow (Trading wallet → an address) is the one System transfer we sign, and it
 * has its own exact pattern (`vetWithdrawTx`), only after the user confirmed it on screen.
 *
 * No React, no `@/` imports: unit-tested by `allowlist.test.ts` with `npm test`.
 */
import { ComputeBudgetProgram, PublicKey, SystemProgram, type VersionedTransaction } from "@solana/web3.js";
import { FUMPAD_PROGRAM_ID } from "./program";

export const ATA_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGqPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/** Total priority fee a silently signed transaction may carry (0.01 SOL). */
export const MAX_PRIORITY_FEE_LAMPORTS = BigInt(10_000_000);
/** Solana's per-transaction compute ceiling. */
const MAX_CU = 1_400_000;
/** Default CU budget per instruction when no limit is set (runtime rule). */
const DEFAULT_CU_PER_IX = 200_000;

/** FUMPAD instructions the app builds for a user, by IDL discriminator. */
export const FUMPAD_USER_IXS = {
  create_coin: [208, 85, 34, 37, 235, 182, 111, 78],
  buy: [102, 6, 61, 18, 1, 218, 235, 234],
  sell: [51, 230, 133, 164, 1, 127, 131, 173],
  swap_buy: [76, 98, 154, 93, 42, 113, 62, 139],
  swap_sell: [176, 40, 55, 165, 110, 62, 84, 97],
  claim: [62, 198, 214, 193, 213, 159, 108, 210],
  set_auto_claim: [135, 111, 55, 239, 20, 249, 33, 144],
  withdraw_creator_fees: [8, 30, 213, 18, 121, 105, 129, 222],
} as const;
export type FumpadIxName = keyof typeof FUMPAD_USER_IXS;

/** What each app action may contain. */
export const ACTION_IXS = {
  buy: ["buy", "swap_buy"],
  sell: ["sell", "swap_sell"],
  claim: ["claim"],
  "auto-claim": ["set_auto_claim"],
  withdraw: ["withdraw_creator_fees"],
  launch: ["create_coin", "buy"],
} as const satisfies Record<string, readonly FumpadIxName[]>;
export type FumpadAction = keyof typeof ACTION_IXS;

export interface SilentPolicy {
  /** The app action; limits which FUMPAD instructions may appear. */
  action: FumpadAction;
  /** Upper bound on SOL spent by buy / swap_buy `sol_in`, summed (lamports). */
  maxSolInLamports?: bigint;
  /** Launch only: the reserved mint, which the API already signed as (D18). */
  coSigner?: string;
}

export class SilentSignRefused extends Error {
  constructor(why: string) {
    super(`Refusing to sign: ${why}.`);
    this.name = "SilentSignRefused";
  }
}

const refuse = (why: string): never => {
  throw new SilentSignRefused(why);
};

const startsWith = (d: Uint8Array, p: readonly number[]) => d.length >= p.length && p.every((b, i) => d[i] === b);
const u32 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(o, true);
const u64 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);

interface Ix {
  program: PublicKey;
  keys: PublicKey[];
  data: Uint8Array;
}

/** Message → plain instructions, after the checks every silent transaction must pass. */
function open(tx: VersionedTransaction, wallet: PublicKey, coSigners: string[]): { ixs: Ix[]; isSigner: (k: PublicKey) => boolean } {
  const m = tx.message;
  const lookups = "addressTableLookups" in m ? m.addressTableLookups : [];
  if (lookups.length) refuse("it uses address lookup tables");
  const keys = m.staticAccountKeys;
  if (!keys.length || !keys[0].equals(wallet)) refuse("your wallet isn't the fee payer");
  const n = m.header.numRequiredSignatures;
  const signers = keys.slice(0, n);
  const others = signers.slice(1).map((k) => k.toBase58());
  if (others.length !== coSigners.length || others.some((k) => !coSigners.includes(k))) refuse("it asks for unexpected signers");
  // Co-signers sign before us; a blank slot means someone wants our signature first.
  for (let i = 1; i < n; i++) if (!tx.signatures[i] || tx.signatures[i].every((b) => b === 0)) refuse("a co-signer hasn't signed");
  const ixs = m.compiledInstructions.map((c) => {
    if (c.programIdIndex >= keys.length || c.accountKeyIndexes.some((i) => i >= keys.length)) refuse("it references accounts it doesn't list");
    return { program: keys[c.programIdIndex], keys: c.accountKeyIndexes.map((i) => keys[i]), data: c.data };
  });
  return { ixs, isSigner: (k) => signers.some((s) => s.equals(k)) };
}

/** ComputeBudget: one limit and one price at most, and a capped total priority fee. */
function vetComputeBudget(ixs: Ix[]): Ix[] {
  let limit: number | null = null;
  let price: bigint | null = null;
  const rest: Ix[] = [];
  for (const ix of ixs) {
    if (!ix.program.equals(ComputeBudgetProgram.programId)) {
      rest.push(ix);
      continue;
    }
    if (ix.keys.length) refuse("unexpected compute budget accounts");
    if (ix.data[0] === 2 && ix.data.length === 5 && limit === null) limit = u32(ix.data, 1);
    else if (ix.data[0] === 3 && ix.data.length === 9 && price === null) price = u64(ix.data, 1);
    else refuse("unexpected compute budget instruction");
  }
  const units = BigInt(Math.min(MAX_CU, limit ?? DEFAULT_CU_PER_IX * rest.length));
  if (limit !== null && limit > MAX_CU) refuse("compute limit too high");
  if (price !== null && (units * price) / BigInt(1_000_000) > MAX_PRIORITY_FEE_LAMPORTS) refuse("priority fee too high");
  return rest;
}

/** ATA create / create_idempotent for the wallet's own account, paid by the wallet. */
function vetAtaCreate(ix: Ix, wallet: PublicKey) {
  if (!(ix.data.length === 0 || (ix.data.length === 1 && (ix.data[0] === 0 || ix.data[0] === 1)))) refuse("unexpected token account instruction");
  if (ix.keys.length !== 6) refuse("unexpected token account layout");
  const [payer, account, owner, mint, system, tokenProgram] = ix.keys;
  if (!payer.equals(wallet) || !owner.equals(wallet)) refuse("token account isn't yours");
  if (!system.equals(SystemProgram.programId)) refuse("unexpected token account layout");
  if (!tokenProgram.equals(TOKEN_PROGRAM_ID) && !tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) refuse("unexpected token program");
  const [expected] = PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM_ID);
  if (!account.equals(expected)) refuse("token account address doesn't match");
}

/**
 * Throws `SilentSignRefused` unless `tx` is one of our builders' FUMPAD transactions for
 * `wallet` and `policy.action`. Returns the SOL the transaction commits to buys (lamports).
 */
export function vetFumpadTx(tx: VersionedTransaction, wallet: PublicKey, policy: SilentPolicy): { solInLamports: bigint } {
  const { ixs, isSigner } = open(tx, wallet, policy.coSigner ? [policy.coSigner] : []);
  const rest = vetComputeBudget(ixs);
  const allow = ACTION_IXS[policy.action] as readonly FumpadIxName[];
  let fumpad = 0;
  let solIn = BigInt(0);
  for (const ix of rest) {
    if (ix.program.equals(ATA_PROGRAM_ID)) {
      vetAtaCreate(ix, wallet);
      continue;
    }
    if (!ix.program.equals(FUMPAD_PROGRAM_ID)) refuse(`it calls a program FUMPAD doesn't use (${ix.program.toBase58().slice(0, 8)}…)`);
    const name = allow.find((n) => startsWith(ix.data, FUMPAD_USER_IXS[n]));
    if (!name) refuse("it contains a FUMPAD instruction this action doesn't use");
    // Every user instruction's first account is the acting wallet, as signer.
    if (!ix.keys[0]?.equals(wallet) || !isSigner(ix.keys[0])) refuse("it acts for another wallet");
    if (name === "buy" || name === "swap_buy") {
      if (ix.data.length < 24) refuse("malformed buy");
      solIn += u64(ix.data, 8);
    }
    fumpad++;
  }
  if (!fumpad) refuse("it isn't a FUMPAD transaction");
  if (policy.action === "launch" && !policy.coSigner) refuse("a launch needs its reserved mint");
  if (policy.maxSolInLamports !== undefined && solIn > policy.maxSolInLamports) refuse("it spends more SOL than you entered");
  return { solInLamports: solIn };
}

/**
 * The withdraw pattern: optional compute budget, then exactly one System transfer of
 * `lamports` from `wallet` to `destination`. Nothing else.
 */
export function vetWithdrawTx(tx: VersionedTransaction, wallet: PublicKey, destination: PublicKey, lamports: bigint): void {
  const { ixs } = open(tx, wallet, []);
  const rest = vetComputeBudget(ixs);
  if (rest.length !== 1) refuse("a withdrawal is a single transfer");
  const [ix] = rest;
  if (!ix.program.equals(SystemProgram.programId)) refuse("a withdrawal is a System transfer");
  if (ix.data.length !== 12 || u32(ix.data, 0) !== 2) refuse("a withdrawal is a plain transfer");
  if (ix.keys.length !== 2 || !ix.keys[0].equals(wallet) || !ix.keys[1].equals(destination)) refuse("the destination doesn't match");
  if (u64(ix.data, 4) !== lamports) refuse("the amount doesn't match");
}
