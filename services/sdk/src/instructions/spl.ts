import { ComputeBudgetProgram, PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";

import { ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from "../constants.js";
import { ata } from "../pda.js";
import { makeIx, r, w, ws } from "./metas.js";

/** Associated Token Account `create_idempotent` (no-op if it exists). */
export function createAtaIdempotentIx(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
): TransactionInstruction {
  return makeIx(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    [ws(payer), w(ata(owner, mint, tokenProgram)), r(owner), r(mint), r(SYSTEM_PROGRAM_ID), r(tokenProgram)],
    Uint8Array.from([1]),
  );
}

/** SPL Token `SyncNative` (17) on a WSOL account. */
export function syncNativeIx(account: PublicKey): TransactionInstruction {
  return makeIx(TOKEN_PROGRAM_ID, [w(account)], Uint8Array.from([17]));
}

/** SPL Token `CloseAccount` (9). */
export function closeTokenAccountIx(
  account: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID,
): TransactionInstruction {
  return makeIx(
    tokenProgram,
    [w(account), w(destination), { pubkey: owner, isSigner: true, isWritable: false }],
    Uint8Array.from([9]),
  );
}

/**
 * Wrap `lamports` SOL into the owner's WSOL ATA (create idempotent + transfer + sync).
 * The FUMPAD router wraps/unwraps by itself; this is for direct PumpSwap trades and tests.
 */
export function wrapSolIxs(owner: PublicKey, lamports: bigint): TransactionInstruction[] {
  const dest = ata(owner, WSOL_MINT, TOKEN_PROGRAM_ID);
  return [
    createAtaIdempotentIx(owner, owner, WSOL_MINT, TOKEN_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: dest, lamports }),
    syncNativeIx(dest),
  ];
}
/** Close the owner's WSOL ATA: whole balance + rent back as SOL. */
export function unwrapSolIx(owner: PublicKey): TransactionInstruction {
  return closeTokenAccountIx(ata(owner, WSOL_MINT, TOKEN_PROGRAM_ID), owner, owner);
}

/** Compute-budget prefix: CU limit + optional priority fee (micro-lamports per CU). */
export function computeBudgetIxs(units: number, microLamportsPerCu?: number | bigint): TransactionInstruction[] {
  const out = [ComputeBudgetProgram.setComputeUnitLimit({ units })];
  if (microLamportsPerCu !== undefined && BigInt(microLamportsPerCu) > 0n) {
    out.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BigInt(microLamportsPerCu) }));
  }
  return out;
}
