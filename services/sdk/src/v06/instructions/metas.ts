import type { Idl } from "@anchor-lang/core";
import { type AccountMeta, PublicKey, TransactionInstruction } from "@solana/web3.js";

import { idlInstruction } from "../coder.js";
import { FUMPAD_PROGRAM_ID } from "../constants.js";
import { eventAuthorityPda } from "../pda.js";

/** Accounts keyed by IDL name (snake_case or camelCase). `null` = absent optional account. */
export type AccountsInput = Record<string, PublicKey | null | undefined>;

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/**
 * Build the account metas for `ixName` in IDL order, with IDL writable/signer flags.
 *
 * Driving the order from the IDL (not hand-written lists) means a contract change that
 * reorders or renames accounts breaks loudly here (missing account) instead of producing
 * a silently wrong transaction. Fixed addresses from the IDL (`address`) and the
 * `#[event_cpi]` pair (event_authority, program) are filled automatically.
 */
export function idlMetas(idl: Idl, programId: PublicKey, ixName: string, accounts: AccountsInput): AccountMeta[] {
  const ix = idlInstruction(idl, ixName);
  const used = new Set<string>();
  const metas = ix.accounts.map((a) => {
    const c = camel(a.name);
    let key: PublicKey | null | undefined = accounts[c] !== undefined ? accounts[c] : accounts[a.name];
    if (accounts[c] !== undefined) used.add(c);
    if (accounts[a.name] !== undefined) used.add(a.name);
    if (key === undefined) {
      if (a.address) key = new PublicKey(a.address);
      else if (a.name === "event_authority" && programId.equals(FUMPAD_PROGRAM_ID)) key = eventAuthorityPda();
      else if (a.name === "program") key = programId;
    }
    if (key === undefined) throw new Error(`${ixName}: missing account \`${c}\``);
    if (key === null) {
      if (!a.optional) throw new Error(`${ixName}: account \`${c}\` is not optional`);
      // Anchor encodes a None optional account as the program id (read-only).
      return { pubkey: programId, isSigner: false, isWritable: false };
    }
    return { pubkey: key, isSigner: !!a.signer, isWritable: !!a.writable };
  });
  for (const k of Object.keys(accounts)) {
    if (!used.has(k)) throw new Error(`${ixName}: unknown account \`${k}\` (IDL changed?)`);
  }
  return metas;
}

export function makeIx(programId: PublicKey, keys: AccountMeta[], data: Uint8Array | Buffer): TransactionInstruction {
  return new TransactionInstruction({ programId, keys, data: Buffer.from(data) });
}

export const w = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
export const r = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
export const ws = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: true, isWritable: true });
