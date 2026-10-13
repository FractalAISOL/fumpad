/**
 * ADAPTER (until @fumpad/sdk v0.7): program ids, instruction discriminators and PDAs of the v0.7
 * program and the Meteora programs it wraps, from `contracts/INTERFACE-v0.7.md` (contracts branch,
 * commit 40ee37c) and the Meteora IDLs (DBC 0.2.1, DAMM v2 0.2.4/0.2.5). Every Meteora PDA here
 * was checked against the official SDKs (dynamic-bonding-curve-sdk 1.5.13, cp-amm-sdk 1.5.1) on
 * the spike's devnet pool. Swap for the SDK's exports when it ships.
 *
 * No React, no `@/` imports.
 */
import { PublicKey } from "@solana/web3.js";
import { FUMPAD_PROGRAM_ADDRESS } from "../cluster";

export const FUMPAD_PROGRAM_ID = new PublicKey(FUMPAD_PROGRAM_ADDRESS);
export const DBC_PROGRAM_ID = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
export const DAMM_V2_PROGRAM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ATA_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const SYSVAR_INSTRUCTIONS_ID = new PublicKey("Sysvar1nstructions1111111111111111111111111");

/** Meteora fixed PDAs (`["pool_authority"]`, `["__event_authority"]` of each program). */
export const DBC_POOL_AUTHORITY = new PublicKey("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
export const DBC_EVENT_AUTHORITY = new PublicKey("8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF");
export const DAMM_V2_POOL_AUTHORITY = new PublicKey("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
export const DAMM_V2_EVENT_AUTHORITY = new PublicKey("3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet");

/** FUMPAD v0.7 instructions a user wallet signs (Anchor `sha256("global:<name>")[..8]`). */
export const FUMPAD_IX = {
  buy: [102, 6, 61, 18, 1, 218, 235, 234],
  sell: [51, 230, 133, 164, 1, 127, 131, 173],
  register_coin: [79, 37, 188, 46, 209, 104, 90, 10],
  claim: [62, 198, 214, 193, 213, 159, 108, 210],
  set_auto_claim: [135, 111, 55, 239, 20, 249, 33, 144],
  withdraw_creator_fees: [8, 30, 213, 18, 121, 105, 129, 222],
  withdraw_escrow: [81, 84, 226, 128, 245, 47, 96, 104],
} as const;
export type FumpadIxName = keyof typeof FUMPAD_IX;

/** Meteora instructions FUMPAD transactions contain (IDL discriminators). */
export const DBC_IX = {
  initialize_virtual_pool_with_token2022: [169, 118, 51, 78, 145, 110, 220, 155],
  swap2: [65, 75, 63, 76, 235, 91, 91, 136],
} as const;
export const DAMM_V2_IX = {
  swap2: [65, 75, 63, 76, 235, 91, 91, 136],
} as const;

/** Account discriminators (`sha256("account:<Name>")[..8]`). */
export const ACCOUNT_DISC = {
  Coin: [215, 195, 53, 238, 217, 196, 213, 51],
  Ticket: [41, 228, 24, 165, 78, 90, 235, 200],
  PoolConfig: [26, 108, 14, 123, 116, 230, 129, 43],
} as const;

/** DBC / DAMM `swap2` modes. */
export const SWAP_MODE = { exactIn: 0, partialFill: 1 } as const;

const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];
const s = (t: string) => Buffer.from(t);

export const globalPda = () => pda([s("global")], FUMPAD_PROGRAM_ID);
export const coinPda = (mint: PublicKey) => pda([s("coin"), mint.toBuffer()], FUMPAD_PROGRAM_ID);
export const positionPda = (mint: PublicKey, wallet: PublicKey) => pda([s("position"), mint.toBuffer(), wallet.toBuffer()], FUMPAD_PROGRAM_ID);
export const claimQueuePda = (mint: PublicKey) => pda([s("claim_queue"), mint.toBuffer()], FUMPAD_PROGRAM_ID);
export const observationsPda = (mint: PublicKey) => pda([s("observations"), mint.toBuffer()], FUMPAD_PROGRAM_ID);
export const rewardPoolPda = () => pda([s("reward_pool")], FUMPAD_PROGRAM_ID);
export const escrowPda = (ticket: PublicKey) => pda([s("escrow"), ticket.toBuffer()], FUMPAD_PROGRAM_ID);
export const fumpadEventAuthority = () => pda([s("__event_authority")], FUMPAD_PROGRAM_ID);

/** Canonical associated token account. */
export function ata(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return pda([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM_ID);
}
/** The wallet's Token-2022 account for a FUMPAD coin (the router requires this one). */
export const coinAta = (owner: PublicKey, mint: PublicKey) => ata(owner, mint, TOKEN_2022_PROGRAM_ID);
/** The wallet's WSOL account (SPL Token). */
export const wsolAta = (owner: PublicKey) => ata(owner, WSOL_MINT, TOKEN_PROGRAM_ID);
/** The coin's reward pool: `ATA(reward_pool, mint, Token-2022)`. */
export const rewardVault = (mint: PublicKey) => ata(rewardPoolPda(), mint, TOKEN_2022_PROGRAM_ID);

/** Meteora pools order their two mints: `["pool", config, max(a, b), min(a, b)]`. */
function ordered(a: PublicKey, b: PublicKey): [PublicKey, PublicKey] {
  return Buffer.compare(a.toBuffer(), b.toBuffer()) > 0 ? [a, b] : [b, a];
}
export function dbcPoolPda(config: PublicKey, mint: PublicKey): PublicKey {
  const [hi, lo] = ordered(mint, WSOL_MINT);
  return pda([s("pool"), config.toBuffer(), hi.toBuffer(), lo.toBuffer()], DBC_PROGRAM_ID);
}
export const dbcVault = (pool: PublicKey, mint: PublicKey) => pda([s("token_vault"), mint.toBuffer(), pool.toBuffer()], DBC_PROGRAM_ID);
export const dammVault = (pool: PublicKey, mint: PublicKey) => pda([s("token_vault"), mint.toBuffer(), pool.toBuffer()], DAMM_V2_PROGRAM_ID);

export const startsWith = (d: Uint8Array, p: readonly number[]) => d.length >= p.length && p.every((b, i) => d[i] === b);
