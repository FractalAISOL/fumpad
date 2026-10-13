// Instruction builders for DBC + DAMM v2 using the official SDKs' Anchor programs (IDL from SDK 1.5.13 / cp-amm 1.5.1).
import BN from "bn.js";
import { PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction,
} from "@solana/spl-token";
import {
  createDbcProgram, deriveDbcPoolAddress, deriveDbcTokenVaultAddress, deriveDbcPoolAuthority,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { connection } from "./common.js";

export const dbcProgram = createDbcProgram(connection).program as any;
export const DBC_POOL_AUTHORITY = deriveDbcPoolAuthority();

export function poolKeys(config: PublicKey, baseMint: PublicKey) {
  const pool = deriveDbcPoolAddress(NATIVE_MINT, baseMint, config);
  return {
    pool,
    baseVault: deriveDbcTokenVaultAddress(pool, baseMint),
    quoteVault: deriveDbcTokenVaultAddress(pool, NATIVE_MINT),
  };
}

export const ata = (owner: PublicKey, mint: PublicKey, prog = TOKEN_PROGRAM_ID) => getAssociatedTokenAddressSync(mint, owner, true, prog);
export const baseAta = (owner: PublicKey, mint: PublicKey) => ata(owner, mint, TOKEN_2022_PROGRAM_ID);

/** create both ATAs (idempotent) + wrap `lamports` SOL into the owner's WSOL ATA */
export function prepUser(payerPk: PublicKey, owner: PublicKey, baseMint: PublicKey, wrapLamports: bigint): TransactionInstruction[] {
  const wsol = ata(owner, NATIVE_MINT);
  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(payerPk, wsol, owner, NATIVE_MINT, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(payerPk, baseAta(owner, baseMint), owner, baseMint, TOKEN_2022_PROGRAM_ID),
  ];
  if (wrapLamports > 0n) {
    ixs.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: wsol, lamports: wrapLamports }), createSyncNativeInstruction(wsol));
  }
  return ixs;
}

export async function initPoolIx(a: { config: PublicKey; baseMint: PublicKey; creator: PublicKey; payer: PublicKey; name: string; symbol: string; uri: string }) {
  const { pool, baseVault, quoteVault } = poolKeys(a.config, a.baseMint);
  return dbcProgram.methods
    .initializeVirtualPoolWithToken2022({ name: a.name, symbol: a.symbol, uri: a.uri })
    .accountsPartial({
      pool, config: a.config, payer: a.payer, creator: a.creator, baseMint: a.baseMint,
      poolAuthority: DBC_POOL_AUTHORITY, baseVault, quoteVault, quoteMint: NATIVE_MINT,
      tokenQuoteProgram: TOKEN_PROGRAM_ID, tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .instruction() as Promise<TransactionInstruction>;
}

/** DBC swap2. buy = WSOL -> base. mode 0 ExactIn, 1 PartialFill, 2 ExactOut. Account order (index): 0 pool_authority,
 * 1 config, 2 pool, 3 input_token_account, 4 output_token_account, 5 base_vault, 6 quote_vault, 7 base_mint,
 * 8 quote_mint, 9 payer, 10 token_base_program, 11 token_quote_program, 12 referral (program id = None),
 * 13 event_authority, 14 program, [15 instructions sysvar] */
export async function dbcSwapIx(a: {
  config: PublicKey; baseMint: PublicKey; owner: PublicKey; buy: boolean; amount0: BN; amount1: BN; mode?: number;
  withIxSysvar?: boolean; inputAccount?: PublicKey; outputAccount?: PublicKey;
}) {
  const { pool, baseVault, quoteVault } = poolKeys(a.config, a.baseMint);
  const wsol = ata(a.owner, NATIVE_MINT), base = baseAta(a.owner, a.baseMint);
  return dbcProgram.methods
    .swap2({ amount0: a.amount0, amount1: a.amount1, swapMode: a.mode ?? 0 })
    .accountsPartial({
      poolAuthority: DBC_POOL_AUTHORITY, config: a.config, pool,
      inputTokenAccount: a.inputAccount ?? (a.buy ? wsol : base),
      outputTokenAccount: a.outputAccount ?? (a.buy ? base : wsol),
      baseVault, quoteVault, baseMint: a.baseMint, quoteMint: NATIVE_MINT, payer: a.owner,
      tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
    })
    .remainingAccounts(a.withIxSysvar ? [{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }] : [])
    .instruction() as Promise<TransactionInstruction>;
}

export async function dbcClaimTradingFeeIx(a: { config: PublicKey; baseMint: PublicKey; feeClaimer: PublicKey; tokenA: PublicKey; tokenB: PublicKey }) {
  const { pool, baseVault, quoteVault } = poolKeys(a.config, a.baseMint);
  return dbcProgram.methods
    .claimTradingFee(new BN("18446744073709551615"), new BN("18446744073709551615"))
    .accountsPartial({
      poolAuthority: DBC_POOL_AUTHORITY, config: a.config, pool, tokenAAccount: a.tokenA, tokenBAccount: a.tokenB,
      baseVault, quoteVault, baseMint: a.baseMint, quoteMint: NATIVE_MINT, feeClaimer: a.feeClaimer,
      tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID,
    })
    .instruction() as Promise<TransactionInstruction>;
}

export async function fetchPool(pool: PublicKey) {
  return dbcProgram.account.virtualPool.fetch(pool);
}
