/** Instruction builders for the immutable `fumpad_lp_locker` (both instructions). */
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";

import { LP_LOCKER_IDL, lockerCoder } from "../coder.js";
import { LP_LOCKER_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from "../constants.js";
import { ata, coinAddresses, poolAuthorityPda } from "../pda.js";
import { idlMetas, makeIx } from "./metas.js";
import { liquidityAccounts } from "./pumpswap.js";
import { createAtaIdempotentIx } from "./spl.js";

/**
 * `lock` — only callable via CPI from `graduate` (the FUMPAD pool-authority PDA must
 * sign). Provided for completeness / simulation; clients never send it directly.
 */
export function lockIx(a: { payer: PublicKey; mint: PublicKey }): TransactionInstruction {
  const c = coinAddresses(a.mint);
  const pa = poolAuthorityPda();
  const keys = idlMetas(LP_LOCKER_IDL, LP_LOCKER_PROGRAM_ID, "lock", {
    payer: a.payer,
    fumpadAuthority: pa,
    pool: c.pool,
    lpMint: c.lpMint,
    sourceLp: ata(pa, c.lpMint, TOKEN_2022_PROGRAM_ID),
    lock: c.lock,
    authority: c.lockerAuthority,
    lpVault: c.lpVault,
    poolBaseVault: c.poolBase,
    poolQuoteVault: c.poolQuote,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
  });
  return makeIx(LP_LOCKER_PROGRAM_ID, keys, lockerCoder().instruction.encode("lock", {}));
}

/**
 * Locker `skim` (permissionless): withdraws LP fee growth; base → reward vault,
 * WSOL → ATA(coin, WSOL). remaining = PumpSwap withdraw accounts (15).
 */
export function skimIx(a: { mint: PublicKey }): TransactionInstruction {
  const c = coinAddresses(a.mint);
  const keys = idlMetas(LP_LOCKER_IDL, LP_LOCKER_PROGRAM_ID, "skim", {
    lock: c.lock,
    authority: c.lockerAuthority,
  }).concat(
    liquidityAccounts(
      { pool: c.pool, mint: a.mint, poolBase: c.poolBase, poolQuote: c.poolQuote },
      c.lockerAuthority,
      c.rewardVault,
      c.lpFeeWsol,
      c.lpVault,
    ),
  );
  return makeIx(LP_LOCKER_PROGRAM_ID, keys, lockerCoder().instruction.encode("skim", {}));
}

/** [create ATA(coin, WSOL) idempotent (payer), locker `skim`] — SPEC §7 periodic LP crank. */
export function skimIxs(payer: PublicKey, mint: PublicKey): TransactionInstruction[] {
  const c = coinAddresses(mint);
  return [createAtaIdempotentIx(payer, c.coin, WSOL_MINT, TOKEN_PROGRAM_ID), skimIx({ mint })];
}

