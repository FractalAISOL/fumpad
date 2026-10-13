/**
 * Meteora DBC 0.2.1 / DAMM v2 0.2.4 instructions FUMPAD builds directly (raw bytes; account orders as in
 * contracts/tests/src/meteora.rs, which runs them against the mainnet binaries):
 * pool creation (launch), top-level swap2 (creator first buy, third-party trades, tests), migration,
 * withdraw_leftover, and the swap2 account lists the fumpad router / buyback pass through.
 */
import { type AccountMeta, PublicKey, TransactionInstruction } from "@solana/web3.js";

import {
  DAMM_V2_EVENT_AUTHORITY,
  DAMM_V2_MIGRATION_CONFIG,
  DAMM_V2_POOL_AUTHORITY,
  DAMM_V2_PROGRAM_ID,
  DBC_EVENT_AUTHORITY,
  DBC_POOL_AUTHORITY,
  DBC_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  SYSVAR_INSTRUCTIONS_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from "../constants.js";
import { coinAta, dammPoolPda, dammPositionNftAccountPda, dammPositionPda, dammVaultPda, dbcPoolPda, dbcVaultPda, wsolAta } from "../pda.js";

const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
const rw = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
const sg = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: true, isWritable: false });
const sgw = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: true, isWritable: true });

export const DBC_IX = {
  createConfig: [201, 207, 243, 114, 75, 111, 47, 189],
  initializeVirtualPoolWithToken2022: [169, 118, 51, 78, 145, 110, 220, 155],
  swap2: [65, 75, 63, 76, 235, 91, 91, 136],
  migrationDammV2: [156, 169, 230, 103, 53, 228, 80, 64],
  withdrawLeftover: [20, 198, 202, 237, 235, 243, 183, 66],
  claimTradingFee: [8, 236, 89, 49, 152, 125, 177, 81],
} as const;
/** DAMM v2 swap2 shares the discriminator of DBC swap2 (both Anchor `swap2`). */
export const DAMM_IX = { swap2: [65, 75, 63, 76, 235, 91, 91, 136] } as const;

/** swap2 data: discriminator ‖ amount_0 u64 ‖ amount_1 u64 ‖ swap_mode u8 (0 ExactIn, 1 PartialFill, 2 ExactOut). */
export function swap2Data(amount0: bigint, amount1: bigint, mode: number): Uint8Array {
  const out = new Uint8Array(8 + 8 + 8 + 1);
  out.set(DBC_IX.swap2, 0);
  const v = new DataView(out.buffer);
  v.setBigUint64(8, amount0, true);
  v.setBigUint64(16, amount1, true);
  out[24] = mode;
  return out;
}

function borshString(s: string): Uint8Array {
  const b = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + b.length);
  new DataView(out.buffer).setUint32(0, b.length, true);
  out.set(b, 4);
  return out;
}

/**
 * DBC `initialize_virtual_pool_with_token2022(name, symbol, uri)`: the base mint (vanity keypair) and the
 * creator sign; `payer` pays the pool/vault/mint rent.
 */
export function dbcInitializePoolToken2022Ix(a: { config: PublicKey; creator: PublicKey; mint: PublicKey; payer: PublicKey; name: string; symbol: string; uri: string }): TransactionInstruction {
  const pool = dbcPoolPda(a.config, a.mint);
  const parts = [Uint8Array.from(DBC_IX.initializeVirtualPoolWithToken2022), borshString(a.name), borshString(a.symbol), borshString(a.uri)];
  const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    data.set(p, o);
    o += p.length;
  }
  return new TransactionInstruction({
    programId: DBC_PROGRAM_ID,
    keys: [
      ro(a.config),
      ro(DBC_POOL_AUTHORITY),
      sg(a.creator),
      sgw(a.mint),
      ro(WSOL_MINT),
      rw(pool),
      rw(dbcVaultPda(a.mint, pool)),
      rw(dbcVaultPda(WSOL_MINT, pool)),
      sgw(a.payer),
      ro(TOKEN_PROGRAM_ID),
      ro(TOKEN_2022_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
      ro(DBC_EVENT_AUTHORITY),
      ro(DBC_PROGRAM_ID),
    ],
    data: Buffer.from(data),
  });
}

/**
 * DBC `swap2` accounts (15; referral = None). `ixSysvar` appends the instructions sysvar (required for the
 * launch tx's first swap to get `enable_first_swap_with_min_fee`).
 */
export function dbcSwapAccounts(a: { config: PublicKey; mint: PublicKey; payer: PublicKey; input: PublicKey; output: PublicKey; ixSysvar?: boolean }): AccountMeta[] {
  const pool = dbcPoolPda(a.config, a.mint);
  const v = [
    ro(DBC_POOL_AUTHORITY),
    ro(a.config),
    rw(pool),
    rw(a.input),
    rw(a.output),
    rw(dbcVaultPda(a.mint, pool)),
    rw(dbcVaultPda(WSOL_MINT, pool)),
    ro(a.mint),
    ro(WSOL_MINT),
    sg(a.payer),
    ro(TOKEN_2022_PROGRAM_ID),
    ro(TOKEN_PROGRAM_ID),
    ro(DBC_PROGRAM_ID),
    ro(DBC_EVENT_AUTHORITY),
    ro(DBC_PROGRAM_ID),
  ];
  if (a.ixSysvar) v.push(ro(SYSVAR_INSTRUCTIONS_ID));
  return v;
}

/** DAMM v2 `swap2` accounts (14; token A = the coin (Token-2022), B = WSOL; referral = None). */
export function dammSwapAccounts(a: { pool: PublicKey; mint: PublicKey; payer: PublicKey; input: PublicKey; output: PublicKey }): AccountMeta[] {
  return [
    ro(DAMM_V2_POOL_AUTHORITY),
    rw(a.pool),
    rw(a.input),
    rw(a.output),
    rw(dammVaultPda(a.mint, a.pool)),
    rw(dammVaultPda(WSOL_MINT, a.pool)),
    ro(a.mint),
    ro(WSOL_MINT),
    sg(a.payer),
    ro(TOKEN_2022_PROGRAM_ID),
    ro(TOKEN_PROGRAM_ID),
    ro(DAMM_V2_PROGRAM_ID),
    ro(DAMM_V2_EVENT_AUTHORITY),
    ro(DAMM_V2_PROGRAM_ID),
  ];
}

/** Top-level DBC buy by `owner` (WSOL ATA → coin ATA). */
export function dbcBuyIx(a: { config: PublicKey; mint: PublicKey; owner: PublicKey; lamportsIn: bigint; minOut: bigint; mode?: number; ixSysvar?: boolean }): TransactionInstruction {
  const keys = dbcSwapAccounts({ config: a.config, mint: a.mint, payer: a.owner, input: wsolAta(a.owner), output: coinAta(a.owner, a.mint), ixSysvar: a.ixSysvar });
  return new TransactionInstruction({ programId: DBC_PROGRAM_ID, keys, data: Buffer.from(swap2Data(a.lamportsIn, a.minOut, a.mode ?? 0)) });
}
export function dbcSellIx(a: { config: PublicKey; mint: PublicKey; owner: PublicKey; tokensIn: bigint; minOut: bigint }): TransactionInstruction {
  const keys = dbcSwapAccounts({ config: a.config, mint: a.mint, payer: a.owner, input: coinAta(a.owner, a.mint), output: wsolAta(a.owner) });
  return new TransactionInstruction({ programId: DBC_PROGRAM_ID, keys, data: Buffer.from(swap2Data(a.tokensIn, a.minOut, 0)) });
}
export function dammBuyIx(a: { pool: PublicKey; mint: PublicKey; owner: PublicKey; lamportsIn: bigint; minOut: bigint }): TransactionInstruction {
  const keys = dammSwapAccounts({ pool: a.pool, mint: a.mint, payer: a.owner, input: wsolAta(a.owner), output: coinAta(a.owner, a.mint) });
  return new TransactionInstruction({ programId: DAMM_V2_PROGRAM_ID, keys, data: Buffer.from(swap2Data(a.lamportsIn, a.minOut, 0)) });
}
export function dammSellIx(a: { pool: PublicKey; mint: PublicKey; owner: PublicKey; tokensIn: bigint; minOut: bigint }): TransactionInstruction {
  const keys = dammSwapAccounts({ pool: a.pool, mint: a.mint, payer: a.owner, input: coinAta(a.owner, a.mint), output: wsolAta(a.owner) });
  return new TransactionInstruction({ programId: DAMM_V2_PROGRAM_ID, keys, data: Buffer.from(swap2Data(a.tokensIn, a.minOut, 0)) });
}

/** DBC `migration_damm_v2` accounts (26, DBC order, DAMM v2 Customizable config last). `nftMint` = fresh keypair (signs). */
export function dbcMigrationAccounts(a: { config: PublicKey; mint: PublicKey; nftMint: PublicKey; payer: PublicKey; dammConfig?: PublicKey }): AccountMeta[] {
  const pool = dbcPoolPda(a.config, a.mint);
  const dammConfig = a.dammConfig ?? DAMM_V2_MIGRATION_CONFIG;
  const dammPool = dammPoolPda(a.mint, dammConfig);
  return [
    rw(pool),
    ro(DBC_PROGRAM_ID), // migration_metadata (deprecated; any account)
    ro(a.config),
    rw(DBC_POOL_AUTHORITY),
    rw(dammPool),
    sgw(a.nftMint),
    rw(dammPositionNftAccountPda(a.nftMint)),
    rw(dammPositionPda(a.nftMint)),
    ro(DBC_PROGRAM_ID), // second position = None
    ro(DBC_PROGRAM_ID),
    ro(DBC_PROGRAM_ID),
    ro(DAMM_V2_POOL_AUTHORITY),
    ro(DAMM_V2_PROGRAM_ID),
    rw(a.mint),
    rw(WSOL_MINT),
    rw(dammVaultPda(a.mint, dammPool)),
    rw(dammVaultPda(WSOL_MINT, dammPool)),
    rw(dbcVaultPda(a.mint, pool)),
    rw(dbcVaultPda(WSOL_MINT, pool)),
    sgw(a.payer),
    ro(TOKEN_2022_PROGRAM_ID),
    ro(TOKEN_PROGRAM_ID),
    ro(TOKEN_2022_PROGRAM_ID),
    ro(DAMM_V2_EVENT_AUTHORITY),
    ro(SYSTEM_PROGRAM_ID),
    ro(dammConfig),
  ];
}

/** Direct DBC `migration_damm_v2` (permissionless; the payer fronts ~0.0165 SOL of flash rent). */
export function dbcMigrationIx(a: Parameters<typeof dbcMigrationAccounts>[0]): TransactionInstruction {
  return new TransactionInstruction({ programId: DBC_PROGRAM_ID, keys: dbcMigrationAccounts(a), data: Buffer.from(DBC_IX.migrationDammV2) });
}

/** Direct DBC `withdraw_leftover` (permissionless) into ATA(leftover_receiver = reward_pool, mint). */
export function dbcWithdrawLeftoverIx(a: { config: PublicKey; mint: PublicKey; rewardPool: PublicKey }): TransactionInstruction {
  const pool = dbcPoolPda(a.config, a.mint);
  return new TransactionInstruction({
    programId: DBC_PROGRAM_ID,
    keys: [
      ro(DBC_POOL_AUTHORITY),
      ro(a.config),
      rw(pool),
      rw(coinAta(a.rewardPool, a.mint)),
      rw(dbcVaultPda(a.mint, pool)),
      ro(a.mint),
      ro(a.rewardPool),
      ro(TOKEN_2022_PROGRAM_ID),
      ro(DBC_EVENT_AUTHORITY),
      ro(DBC_PROGRAM_ID),
    ],
    data: Buffer.from(DBC_IX.withdrawLeftover),
  });
}
