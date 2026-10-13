/**
 * ADAPTER (until @fumpad/sdk v0.7): instruction encoders for what a user wallet signs in v0.7,
 * account lists exactly as `contracts/INTERFACE-v0.7.md` §3 and the Meteora IDLs give them.
 * The allow-list (`../allowlist.ts`) and its tests use these same encoders.
 *
 * No React, no `@/` imports.
 */
import { type AccountMeta, ComputeBudgetProgram, type PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  ATA_PROGRAM_ID,
  coinAta,
  coinPda,
  claimQueuePda,
  DAMM_V2_EVENT_AUTHORITY,
  DAMM_V2_POOL_AUTHORITY,
  DAMM_V2_PROGRAM_ID,
  dammVault,
  DBC_EVENT_AUTHORITY,
  DBC_IX,
  DBC_POOL_AUTHORITY,
  DBC_PROGRAM_ID,
  dbcPoolPda,
  dbcVault,
  escrowPda,
  FUMPAD_IX,
  FUMPAD_PROGRAM_ID,
  fumpadEventAuthority,
  globalPda,
  observationsPda,
  positionPda,
  rewardPoolPda,
  rewardVault,
  SWAP_MODE,
  SYSVAR_INSTRUCTIONS_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
  wsolAta,
} from "./ids";

const r = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
const w = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
const sr = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: true, isWritable: false });
const sw = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: true, isWritable: true });
const ev = (): AccountMeta[] => [r(fumpadEventAuthority()), r(FUMPAD_PROGRAM_ID)];

function data(disc: readonly number[], ...parts: Uint8Array[]): Buffer {
  return Buffer.concat([Buffer.from(disc), ...parts.map((p) => Buffer.from(p))]);
}
const u64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};
const u8 = (v: number) => Buffer.from([v]);
const str = (v: string) => {
  const bytes = Buffer.from(v, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length);
  return Buffer.concat([len, bytes]);
};

export type Venue = "dbc" | "damm";
export type TradeSide = "buy" | "sell";

/* ── Compute budget, ATAs, WSOL ─────────────────────────────────────────────── */

export function computeBudgetIxs(units: number, microLamports?: number): TransactionInstruction[] {
  const out = [ComputeBudgetProgram.setComputeUnitLimit({ units })];
  if (microLamports) out.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
  return out;
}

/** ATA `create_idempotent` (payer = owner = the wallet). */
export function createAtaIdempotentIx(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
  account: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA_PROGRAM_ID,
    keys: [sw(payer), w(account), r(owner), r(mint), r(SystemProgram.programId), r(tokenProgram)],
    data: Buffer.from([1]),
  });
}

/** Fund the wallet's WSOL account with `lamports` (create it if needed, transfer, sync). */
export function wrapSolIxs(wallet: PublicKey, lamports: bigint): TransactionInstruction[] {
  const acct = wsolAta(wallet);
  return [
    createAtaIdempotentIx(wallet, wallet, WSOL_MINT, TOKEN_PROGRAM_ID, acct),
    SystemProgram.transfer({ fromPubkey: wallet, toPubkey: acct, lamports }),
    new TransactionInstruction({ programId: TOKEN_PROGRAM_ID, keys: [w(acct)], data: Buffer.from([17]) }), // SyncNative
  ];
}

/** Close the wallet's WSOL account back into SOL (whatever is left after the trade). */
export function unwrapSolIx(wallet: PublicKey): TransactionInstruction {
  return new TransactionInstruction({ programId: TOKEN_PROGRAM_ID, keys: [w(wsolAta(wallet)), w(wallet), sr(wallet)], data: Buffer.from([9]) }); // CloseAccount
}

/* ── Meteora swap2 account lists (the router's remaining accounts) ─────────── */

/** DBC `swap2` accounts for a trader's own canonical accounts (15). */
export function dbcSwapAccounts(a: { trader: PublicKey; mint: PublicKey; config: PublicKey; side: TradeSide }): AccountMeta[] {
  const pool = dbcPoolPda(a.config, a.mint);
  const base = coinAta(a.trader, a.mint);
  const quote = wsolAta(a.trader);
  const [input, output] = a.side === "buy" ? [quote, base] : [base, quote];
  return [
    r(DBC_POOL_AUTHORITY),
    r(a.config),
    w(pool),
    w(input),
    w(output),
    w(dbcVault(pool, a.mint)),
    w(dbcVault(pool, WSOL_MINT)),
    r(a.mint),
    r(WSOL_MINT),
    sr(a.trader),
    r(TOKEN_2022_PROGRAM_ID),
    r(TOKEN_PROGRAM_ID),
    r(DBC_PROGRAM_ID), // referral: None
    r(DBC_EVENT_AUTHORITY),
    r(DBC_PROGRAM_ID),
  ];
}

/** DAMM v2 `swap2` accounts (14); token A = the coin, token B = WSOL. */
export function dammSwapAccounts(a: { trader: PublicKey; mint: PublicKey; pool: PublicKey; side: TradeSide }): AccountMeta[] {
  const base = coinAta(a.trader, a.mint);
  const quote = wsolAta(a.trader);
  const [input, output] = a.side === "buy" ? [quote, base] : [base, quote];
  return [
    r(DAMM_V2_POOL_AUTHORITY),
    w(a.pool),
    w(input),
    w(output),
    w(dammVault(a.pool, a.mint)),
    w(dammVault(a.pool, WSOL_MINT)),
    r(a.mint),
    r(WSOL_MINT),
    sr(a.trader),
    r(TOKEN_2022_PROGRAM_ID),
    r(TOKEN_PROGRAM_ID),
    r(DAMM_V2_PROGRAM_ID), // referral: None
    r(DAMM_V2_EVENT_AUTHORITY),
    r(DAMM_V2_PROGRAM_ID),
  ];
}

/* ── FUMPAD router ───────────────────────────────────────────────────────── */

export interface RouterTrade {
  trader: PublicKey;
  mint: PublicKey;
  venue: Venue;
  /** The venue's swap2 accounts (`dbcSwapAccounts` / `dammSwapAccounts`). */
  swapAccounts: AccountMeta[];
  /** Buy: lamports of WSOL in (fee included). Sell: base units in. */
  amountIn: bigint;
  /** Buy: minimum base units out. Sell: minimum lamports out. From the shown quote (M-9). */
  minOut: bigint;
}

function routerKeys(t: RouterTrade): AccountMeta[] {
  return [sr(t.trader), r(globalPda()), w(coinPda(t.mint)), r(t.venue === "dbc" ? DBC_PROGRAM_ID : DAMM_V2_PROGRAM_ID), ...ev(), ...t.swapAccounts];
}

/** `buy(amount_in, min_out, mode)`. PartialFill on the curve (a buy that completes it would revert as ExactIn). */
export function routerBuyIx(t: RouterTrade & { mode?: number }): TransactionInstruction {
  const mode = t.mode ?? (t.venue === "dbc" ? SWAP_MODE.partialFill : SWAP_MODE.exactIn);
  return new TransactionInstruction({ programId: FUMPAD_PROGRAM_ID, keys: routerKeys(t), data: data(FUMPAD_IX.buy, u64(t.amountIn), u64(t.minOut), u8(mode)) });
}

/** `sell(amount_in, min_out)` (always ExactIn). */
export function routerSellIx(t: RouterTrade): TransactionInstruction {
  return new TransactionInstruction({ programId: FUMPAD_PROGRAM_ID, keys: routerKeys(t), data: data(FUMPAD_IX.sell, u64(t.amountIn), u64(t.minOut)) });
}

/* ── Claims, auto-claim, creator fees, escrow ───────────────────────────────── */

export function claimIx(a: { owner: PublicKey; mint: PublicKey; ticket: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: FUMPAD_PROGRAM_ID,
    keys: [
      sr(a.owner),
      r(globalPda()),
      w(coinPda(a.mint)),
      r(a.mint),
      w(a.ticket),
      w(positionPda(a.mint, a.owner)),
      w(claimQueuePda(a.mint)),
      r(observationsPda(a.mint)),
      r(rewardPoolPda()),
      w(rewardVault(a.mint)),
      w(coinAta(a.owner, a.mint)),
      r(TOKEN_2022_PROGRAM_ID),
      ...ev(),
    ],
    data: data(FUMPAD_IX.claim),
  });
}

export function setAutoClaimIx(a: { wallet: PublicKey; mint: PublicKey; enabled: boolean }): TransactionInstruction {
  return new TransactionInstruction({
    programId: FUMPAD_PROGRAM_ID,
    keys: [sr(a.wallet), w(positionPda(a.mint, a.wallet)), ...ev()],
    data: data(FUMPAD_IX.set_auto_claim, u8(a.enabled ? 1 : 0)),
  });
}

export function withdrawCreatorFeesIx(a: { creator: PublicKey; mint: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: FUMPAD_PROGRAM_ID,
    keys: [sw(a.creator), w(coinPda(a.mint)), ...ev()],
    data: data(FUMPAD_IX.withdraw_creator_fees),
  });
}

/** D16: move an escrowed payout to the owner's own token account. `escrowPayer` = `Ticket.escrow_payer` (gets the escrow rent back). */
export function withdrawEscrowIx(a: {
  owner: PublicKey;
  mint: PublicKey;
  ticket: PublicKey;
  escrowPayer: PublicKey;
  destination?: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: FUMPAD_PROGRAM_ID,
    keys: [
      sr(a.owner),
      r(globalPda()),
      r(a.mint),
      w(a.ticket),
      w(escrowPda(a.ticket)),
      r(rewardPoolPda()),
      w(a.destination ?? coinAta(a.owner, a.mint)),
      w(a.escrowPayer),
      r(TOKEN_2022_PROGRAM_ID),
      ...ev(),
    ],
    data: data(FUMPAD_IX.withdraw_escrow),
  });
}

/* ── Launch (built by the API; encoders for tests and inspection) ─────────── */

/** DBC `initialize_virtual_pool_with_token2022` (14 accounts): the creator pays, the vanity mint signs. */
export function dbcInitPoolIx(a: {
  config: PublicKey;
  creator: PublicKey;
  mint: PublicKey;
  name: string;
  symbol: string;
  uri: string;
}): TransactionInstruction {
  const pool = dbcPoolPda(a.config, a.mint);
  return new TransactionInstruction({
    programId: DBC_PROGRAM_ID,
    keys: [
      r(a.config),
      r(DBC_POOL_AUTHORITY),
      sr(a.creator),
      sw(a.mint),
      r(WSOL_MINT),
      w(pool),
      w(dbcVault(pool, a.mint)),
      w(dbcVault(pool, WSOL_MINT)),
      sw(a.creator),
      r(TOKEN_PROGRAM_ID),
      r(TOKEN_2022_PROGRAM_ID),
      r(SystemProgram.programId),
      r(DBC_EVENT_AUTHORITY),
      r(DBC_PROGRAM_ID),
    ],
    data: data(DBC_IX.initialize_virtual_pool_with_token2022, str(a.name), str(a.symbol), str(a.uri)),
  });
}

/**
 * The creator's first buy: a top-level DBC `swap2` (the min-fee exemption needs it top level and
 * finds the init instruction through the instructions sysvar, passed as a remaining account).
 */
export function dbcFirstBuyIx(a: {
  creator: PublicKey;
  mint: PublicKey;
  config: PublicKey;
  amountIn: bigint;
  minOut: bigint;
  mode?: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: DBC_PROGRAM_ID,
    keys: [...dbcSwapAccounts({ trader: a.creator, mint: a.mint, config: a.config, side: "buy" }), r(SYSVAR_INSTRUCTIONS_ID)],
    data: data(DBC_IX.swap2, u64(a.amountIn), u64(a.minOut), u8(a.mode ?? SWAP_MODE.exactIn)),
  });
}

/** `register_coin()` (13 accounts), the launch transaction's last FUMPAD step. */
export function registerCoinIx(a: { creator: PublicKey; mint: PublicKey; config: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: FUMPAD_PROGRAM_ID,
    keys: [
      sw(a.creator),
      r(globalPda()),
      r(a.mint),
      r(a.config),
      r(dbcPoolPda(a.config, a.mint)),
      w(coinPda(a.mint)),
      r(rewardPoolPda()),
      w(rewardVault(a.mint)),
      r(TOKEN_2022_PROGRAM_ID),
      r(ATA_PROGRAM_ID),
      r(SystemProgram.programId),
      ...ev(),
    ],
    data: data(FUMPAD_IX.register_coin),
  });
}
