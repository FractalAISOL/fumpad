/**
 * PumpSwap pass-through account assembly (mirrors contracts/tests/src/flow.rs).
 *
 * The FUMPAD router validates only the leading 9 venue accounts (pool, user, global
 * config, mints, user token accounts, pool vaults) and passes the rest through, so a
 * PumpSwap account-list upgrade is fixed HERE, not in the program (SPEC §5.2).
 */
import { type AccountMeta, PublicKey, type TransactionInstruction } from "@solana/web3.js";

import {
  PUMPSWAP_FEE_CONFIG,
  PUMPSWAP_GLOBAL_CONFIG,
  PUMPSWAP_IX,
  PUMPSWAP_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from "../constants.js";
import { u64Le } from "../pda.js";
import {
  ata,
  coinAta,
  lpMintPda,
  pumpEventAuthorityPda,
  userVolumeAccumulatorPda,
  wsolAta,
} from "../pda.js";
import { makeIx, r, w } from "./metas.js";

export interface VenuePool {
  pool: PublicKey;
  mint: PublicKey;
  poolBase: PublicKey;
  poolQuote: PublicKey;
}

/**
 * GlobalConfig offset of `buyback_fee_recipients[8]` (see pump_amm.json GlobalConfig):
 * 8 disc + 32 admin + 8 + 8 + 1 + 8×32 + 8 + 32 + 32 + 32 + 1 + 7×32 + 1 = 643.
 */
export const GLOBAL_CONFIG_BUYBACK_RECIPIENTS_OFFSET = 643;
export const GLOBAL_CONFIG_LP_FEE_OFFSET = 40;
export const GLOBAL_CONFIG_PROTOCOL_FEE_OFFSET = 48;

/** The 8 buyback fee recipient wallets from GlobalConfig data (non-default only). */
export function parseBuybackFeeRecipients(globalConfigData: Uint8Array): PublicKey[] {
  const out: PublicKey[] = [];
  for (let i = 0; i < 8; i++) {
    const off = GLOBAL_CONFIG_BUYBACK_RECIPIENTS_OFFSET + i * 32;
    if (globalConfigData.length < off + 32) break;
    const pk = new PublicKey(globalConfigData.subarray(off, off + 32));
    if (!pk.equals(PublicKey.default)) out.push(pk);
  }
  return out;
}

/** LP + protocol fee bps from GlobalConfig (non-canonical pools pay exactly these). */
export function parseGlobalConfigFees(globalConfigData: Uint8Array): { lpFeeBps: bigint; protocolFeeBps: bigint } {
  const dv = new DataView(globalConfigData.buffer, globalConfigData.byteOffset, globalConfigData.byteLength);
  return {
    lpFeeBps: dv.getBigUint64(GLOBAL_CONFIG_LP_FEE_OFFSET, true),
    protocolFeeBps: dv.getBigUint64(GLOBAL_CONFIG_PROTOCOL_FEE_OFFSET, true),
  };
}

/**
 * Pump Fees `FeeConfig.flat_fees` (non-pump pools — every FUMPAD pool): 8 disc | bump |
 * admin | flat_fees {lp, protocol, creator: u64}. The AMM reads the fee schedule from
 * here (v2 trades), not from GlobalConfig.
 */
export function parseFeeConfigFlatFees(feeConfigData: Uint8Array): { lpFeeBps: bigint; protocolFeeBps: bigint; creatorFeeBps: bigint } {
  const dv = new DataView(feeConfigData.buffer, feeConfigData.byteOffset, feeConfigData.byteLength);
  return { lpFeeBps: dv.getBigUint64(41, true), protocolFeeBps: dv.getBigUint64(49, true), creatorFeeBps: dv.getBigUint64(57, true) };
}

/** `buyback_fee_recipient` account = WSOL ATA of one of the buyback recipient wallets (must exist). */
export function buybackFeeRecipientAta(recipientWallet: PublicKey): PublicKey {
  return ata(recipientWallet, WSOL_MINT, TOKEN_PROGRAM_ID);
}

/**
 * PumpSwap `buy_exact_quote_in_v2` / `sell_v2` account list (17), in PumpSwap order.
 * `user` is flagged writable but NOT signer here: the FUMPAD router signs for the user at
 * the outer level (and execute_buyback signs for the pool authority via seeds).
 */
export function venueAccounts(
  p: VenuePool,
  user: PublicKey,
  userBase: PublicKey,
  userQuote: PublicKey,
  buybackFeeRecipient: PublicKey,
): AccountMeta[] {
  return [
    w(p.pool),
    w(user),
    r(PUMPSWAP_GLOBAL_CONFIG),
    r(p.mint),
    r(WSOL_MINT),
    w(userBase),
    w(userQuote),
    w(p.poolBase),
    w(p.poolQuote),
    r(TOKEN_2022_PROGRAM_ID),
    r(TOKEN_PROGRAM_ID),
    r(SYSTEM_PROGRAM_ID),
    w(userVolumeAccumulatorPda(user)),
    r(PUMPSWAP_FEE_CONFIG),
    w(buybackFeeRecipient),
    r(pumpEventAuthorityPda()),
    r(PUMPSWAP_PROGRAM_ID),
  ];
}

/** Venue slice for a wallet trading through the router (user's Token-2022 ATA + WSOL ATA). */
export function userVenueAccounts(p: VenuePool, user: PublicKey, buybackFeeRecipient: PublicKey): AccountMeta[] {
  return venueAccounts(p, user, coinAta(user, p.mint), wsolAta(user), buybackFeeRecipient);
}

/** PumpSwap deposit/withdraw account list (15), used by the locker's `skim`. */
export function liquidityAccounts(
  p: VenuePool,
  user: PublicKey,
  userBase: PublicKey,
  userQuote: PublicKey,
  userLp: PublicKey,
): AccountMeta[] {
  return [
    w(p.pool),
    r(PUMPSWAP_GLOBAL_CONFIG),
    r(user),
    r(p.mint),
    r(WSOL_MINT),
    w(lpMintPda(p.pool)),
    w(userBase),
    w(userQuote),
    w(userLp),
    w(p.poolBase),
    w(p.poolQuote),
    r(TOKEN_PROGRAM_ID),
    r(TOKEN_2022_PROGRAM_ID),
    r(pumpEventAuthorityPda()),
    r(PUMPSWAP_PROGRAM_ID),
  ];
}

/** PumpSwap `init_user_volume_accumulator(payer, user)` — one-time, needed for the pool authority (buybacks). */
export function initUserVolumeAccumulatorIx(payer: PublicKey, user: PublicKey): TransactionInstruction {
  return makeIx(
    PUMPSWAP_PROGRAM_ID,
    [
      { pubkey: payer, isSigner: true, isWritable: true },
      r(user),
      w(userVolumeAccumulatorPda(user)),
      r(SYSTEM_PROGRAM_ID),
      r(pumpEventAuthorityPda()),
      r(PUMPSWAP_PROGRAM_ID),
    ],
    PUMPSWAP_IX.initUserVolumeAccumulator,
  );
}

function withSigner(metas: AccountMeta[], user: PublicKey): AccountMeta[] {
  return metas.map((m, i) => (i === 1 ? { pubkey: user, isSigner: true, isWritable: true } : m));
}

/**
 * Direct PumpSwap buy (outside FUMPAD): spends `quoteIn` lamports of WSOL from the
 * trader's WSOL ATA (wrap first with `wrapSolIxs`). Used for tests and the
 * outside-volume scenario; FUMPAD users trade through `swapBuyIx`.
 */
export function directBuyIx(
  p: VenuePool,
  trader: PublicKey,
  quoteIn: bigint,
  minBaseOut: bigint,
  buybackFeeRecipient: PublicKey,
): TransactionInstruction {
  const data = new Uint8Array(24);
  data.set(PUMPSWAP_IX.buyExactQuoteInV2, 0);
  data.set(u64Le(quoteIn), 8);
  data.set(u64Le(minBaseOut), 16);
  return makeIx(PUMPSWAP_PROGRAM_ID, withSigner(userVenueAccounts(p, trader, buybackFeeRecipient), trader), data);
}

/** Direct PumpSwap sell (outside FUMPAD); proceeds land in the trader's WSOL ATA (must exist). */
export function directSellIx(
  p: VenuePool,
  trader: PublicKey,
  baseIn: bigint,
  minQuoteOut: bigint,
  buybackFeeRecipient: PublicKey,
): TransactionInstruction {
  const data = new Uint8Array(24);
  data.set(PUMPSWAP_IX.sellV2, 0);
  data.set(u64Le(baseIn), 8);
  data.set(u64Le(minQuoteOut), 16);
  return makeIx(PUMPSWAP_PROGRAM_ID, withSigner(userVenueAccounts(p, trader, buybackFeeRecipient), trader), data);
}
