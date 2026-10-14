/**
 * Launch transaction (SPEC v0.7 §2, D18): built + mint-co-signed by the API.
 *   [compute budget] [wrap the creator's SOL buy into WSOL]
 *   DBC initialize_virtual_pool_with_token2022 (vanity `…fmbL` mint signs, creator signs + pays)
 *   [create the creator's Token-2022 coin ATA] [creator's top-level DBC swap2 — first swap → min fee]
 *   fumpad register_coin
 *   [close the WSOL ATA]
 * The creator's buy must be top-level DBC (not routed) and the pool's first swap in the creation tx to
 * get `enable_first_swap_with_min_fee` (DBC process_swap.rs validate_contain_initialize_pool_ix_and_no_cpi).
 */
import { ComputeBudgetProgram, PublicKey, type TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

import { fumpadCoder } from "./coder.js";
import { DBC_PROGRAM_ID, FUMPAD_PROGRAM_ID, SWAP_MODE, TOKEN_2022_PROGRAM_ID, WSOL_MINT } from "./constants.js";
import { registerCoinIx } from "./instructions/fumpad.js";
import { closeTokenAccountIx, createAtaIdempotentIx, wrapSolIxs } from "./instructions/spl.js";
import { DBC_IX, dbcBuyIx, dbcInitializePoolToken2022Ix } from "./meteora/instructions.js";
import { wsolAta } from "./pda.js";

export const FUMPAD_VANITY_SUFFIX = "fmbL";
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** True if `pubkey`'s base58 address ends with `suffix` (default `fmbL`, case-sensitive). */
export function isFumpadVanityMint(pubkey: PublicKey | string, suffix: string = FUMPAD_VANITY_SUFFIX): boolean {
  if (!suffix || !BASE58.test(suffix)) return false;
  const s = typeof pubkey === "string" ? pubkey : pubkey.toBase58();
  return s.length > suffix.length && s.endsWith(suffix) && BASE58.test(s);
}

/** DBC Token-2022 metadata limits (UTF-8 bytes; DBC process_initialize_virtual_pool + Token-2022 metadata). UNVERIFIED: DBC's exact name/symbol limits — FUMPAD keeps the v0.6 app limits. */
export const LAUNCH_LIMITS = { nameBytes: 32, symbolBytes: 10, uriBytes: 200 } as const;
export const LAUNCH_URI = /^(https:\/\/|ipfs:\/\/|ar:\/\/)[^\s]+$/;
const bytes = (s: string) => new TextEncoder().encode(s).length;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

/** Validate launch metadata (app hygiene). Returns an error message or null. */
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

export interface LaunchParams {
  creator: PublicKey;
  mint: PublicKey;
  /** FUMPAD DBC config (must be on Global.configs). */
  dbcConfig: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  /** Creator's first buy (lamports, before fees); 0 / undefined = no buy. */
  buyLamports?: bigint;
  /** Min tokens out for the first buy (quote at the config's min fee — 1.25% standard, 3% first-coin — minus slippage). */
  minTokensOut?: bigint;
  computeUnits?: number;
  priorityMicroLamports?: number;
  /** The API's launch key, when `Global.params.launch_signer` is set (it co-signs `register_coin`; off-chain review L1). */
  launchSigner?: PublicKey;
}

/** The launch instructions in order (see module doc). */
export function launchInstructions(p: LaunchParams): TransactionInstruction[] {
  // The launch tx has no lookup table and (with the launch co-signer) little room left under 1,232 bytes: the CU
  // limit is only set when it matters (a priority price, or an explicit limit); the default per-instruction
  // budget covers a launch.
  const ixs: TransactionInstruction[] = [];
  if (p.computeUnits || p.priorityMicroLamports) ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: p.computeUnits ?? 400_000 }));
  if (p.priorityMicroLamports) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: p.priorityMicroLamports }));
  const buy = p.buyLamports ?? 0n;
  if (buy > 0n) ixs.push(...wrapSolIxs(p.creator, buy));
  ixs.push(dbcInitializePoolToken2022Ix({ config: p.dbcConfig, creator: p.creator, mint: p.mint, payer: p.creator, name: p.name, symbol: p.symbol, uri: p.uri }));
  if (buy > 0n) {
    ixs.push(createAtaIdempotentIx(p.creator, p.creator, p.mint, TOKEN_2022_PROGRAM_ID));
    ixs.push(dbcBuyIx({ config: p.dbcConfig, mint: p.mint, owner: p.creator, lamportsIn: buy, minOut: p.minTokensOut ?? 0n, mode: SWAP_MODE.exactIn, ixSysvar: true }));
  }
  ixs.push(registerCoinIx({ creator: p.creator, mint: p.mint, dbcConfig: p.dbcConfig, launchSigner: p.launchSigner }));
  if (buy > 0n) ixs.push(closeTokenAccountIx(wsolAta(p.creator), p.creator, p.creator));
  return ixs;
}

/** v0 launch transaction (creator = fee payer). The caller signs with the mint keypair (+ the launch signer); the creator signs last. */
export function buildLaunchTx(p: LaunchParams, recentBlockhash: string): VersionedTransaction {
  const msg = new TransactionMessage({ payerKey: p.creator, recentBlockhash, instructions: launchInstructions(p) }).compileToV0Message();
  return new VersionedTransaction(msg);
}

export interface LaunchTxInfo {
  feePayer: string;
  creator: string;
  mint: string;
  dbcConfig: string;
  name: string;
  symbol: string;
  uri: string;
  buyLamports?: bigint;
  minTokensOut?: bigint;
  /** Signers whose signature slot is filled. */
  signed: string[];
}

const ALLOWED_SETUP = new Set([
  ComputeBudgetProgram.programId.toBase58(),
  "11111111111111111111111111111111", // system transfer (wrap)
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // sync native / close WSOL
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // ATA create idempotent
]);

/**
 * Decode a launch transaction and check its shape: setup instructions only from compute budget / system /
 * SPL Token / ATA, exactly one DBC init, at most one DBC swap2 by the creator (top-level, after the init),
 * exactly one fumpad register_coin for the same mint + config, creator = fee payer. Throws otherwise.
 */
export function inspectLaunchTx(tx: VersionedTransaction): LaunchTxInfo {
  const msg = tx.message;
  if (msg.addressTableLookups.length) throw new Error("launch tx must not use lookup tables");
  const keys = msg.staticAccountKeys;
  const feePayer = keys[0].toBase58();
  const ixs = msg.compiledInstructions.map((ix) => ({ program: keys[ix.programIdIndex].toBase58(), accounts: ix.accountKeyIndexes.map((i) => keys[i]), data: Uint8Array.from(ix.data) }));
  const disc = (d: Uint8Array, x: readonly number[]) => x.every((b, i) => d[i] === b);
  let init: (typeof ixs)[number] | undefined;
  let swap: (typeof ixs)[number] | undefined;
  let reg: (typeof ixs)[number] | undefined;
  for (const ix of ixs) {
    if (ix.program === DBC_PROGRAM_ID.toBase58()) {
      if (disc(ix.data, DBC_IX.initializeVirtualPoolWithToken2022)) {
        if (init) throw new Error("two pool initializations");
        init = ix;
      } else if (disc(ix.data, DBC_IX.swap2)) {
        if (!init || swap || reg) throw new Error("the creator buy must be the single swap after the pool init");
        swap = ix;
      } else throw new Error("unexpected DBC instruction");
    } else if (ix.program === FUMPAD_PROGRAM_ID.toBase58()) {
      const d = fumpadCoder().instruction.decode(Buffer.from(ix.data));
      if (d?.name !== "register_coin" || reg) throw new Error("unexpected fumpad instruction");
      reg = ix;
    } else if (!ALLOWED_SETUP.has(ix.program)) throw new Error(`unexpected program ${ix.program}`);
  }
  if (!init || !reg) throw new Error("not a FUMPAD launch transaction");
  const dbcConfig = init.accounts[0].toBase58();
  const creator = init.accounts[2].toBase58();
  const mint = init.accounts[3].toBase58();
  if (creator !== feePayer) throw new Error("creator must pay the fees");
  if (init.accounts[8].toBase58() !== creator) throw new Error("creator must pay the pool rent");
  if (reg.accounts[0].toBase58() !== creator || reg.accounts[2].toBase58() !== mint || reg.accounts[3].toBase58() !== dbcConfig) throw new Error("register_coin does not match the pool");
  let buyLamports: bigint | undefined;
  let minTokensOut: bigint | undefined;
  if (swap) {
    if (swap.accounts[9].toBase58() !== creator || swap.accounts[7].toBase58() !== mint || swap.accounts[8].toBase58() !== WSOL_MINT.toBase58()) throw new Error("swap is not the creator's buy of this coin");
    const v = new DataView(swap.data.buffer, swap.data.byteOffset);
    buyLamports = v.getBigUint64(8, true);
    minTokensOut = v.getBigUint64(16, true);
  }
  // name / symbol / uri: borsh strings after the 8-byte discriminator
  const dv = new DataView(init.data.buffer, init.data.byteOffset, init.data.byteLength);
  let o = 8;
  const str = () => {
    const n = dv.getUint32(o, true);
    const s = new TextDecoder().decode(init!.data.subarray(o + 4, o + 4 + n));
    o += 4 + n;
    return s;
  };
  const name = str();
  const symbol = str();
  const uri = str();
  const n = msg.header.numRequiredSignatures;
  const signed = keys.slice(0, n).filter((_, j) => tx.signatures[j]?.some((b) => b !== 0)).map((k) => k.toBase58());
  return { feePayer, creator, mint, dbcConfig, name, symbol, uri, buyLamports, minTokensOut, signed };
}
