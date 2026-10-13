/**
 * Meteora program ids and fixed PDAs (base58 strings; no web3.js dependency so the parser stays tiny
 * and browser-safe). The PDAs are re-derived in test/constants.test.ts.
 */

/** Dynamic Bonding Curve (`declare_id!` in MeteoraAg/dynamic-bonding-curve, on-chain IDL `dynamic_bonding_curve`). */
export const DBC_PROGRAM_ID = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
/** DAMM v2 (`cp_amm`, `declare_id!` in MeteoraAg/damm-v2 programs/cp-amm/src/lib.rs). */
export const DAMM_V2_PROGRAM_ID = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";

/** PDA ["__event_authority"] of each program: the only account that can sign an `emit_cpi!` event. */
export const DBC_EVENT_AUTHORITY = "8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF";
export const DAMM_V2_EVENT_AUTHORITY = "3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet";
/** PDA ["pool_authority"]: owner of every pool vault. */
export const DBC_POOL_AUTHORITY = "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM";
export const DAMM_V2_POOL_AUTHORITY = "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC";

/** Anchor `EVENT_IX_TAG_LE` (sha256("anchor:event")[..8], little-endian u64 0x1d9acb512ea545e4). */
export const EVENT_IX_TAG = Uint8Array.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qiYZhq6tUykyLqVTsH3UAVebPq";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";

/**
 * Account positions inside the swap instructions (identical for `swap` and `swap2`; from the
 * on-chain IDLs, src/idl). Optional `referral_token_account` = the program id when absent.
 */
export const DBC_SWAP_ACCOUNTS = {
  poolAuthority: 0,
  config: 1,
  pool: 2,
  inputTokenAccount: 3,
  outputTokenAccount: 4,
  baseVault: 5,
  quoteVault: 6,
  baseMint: 7,
  quoteMint: 8,
  payer: 9,
  tokenBaseProgram: 10,
  tokenQuoteProgram: 11,
  referralTokenAccount: 12,
  eventAuthority: 13,
  program: 14,
} as const;

export const DAMM_V2_SWAP_ACCOUNTS = {
  poolAuthority: 0,
  pool: 1,
  inputTokenAccount: 2,
  outputTokenAccount: 3,
  tokenAVault: 4,
  tokenBVault: 5,
  tokenAMint: 6,
  tokenBMint: 7,
  payer: 8,
  tokenAProgram: 9,
  tokenBProgram: 10,
  referralTokenAccount: 11,
  eventAuthority: 12,
  program: 13,
} as const;

/** `migration_damm_v2` (DBC) account positions. */
export const DBC_MIGRATION_DAMM_V2_ACCOUNTS = {
  virtualPool: 0,
  migrationMetadata: 1,
  config: 2,
  poolAuthority: 3,
  dammPool: 4,
  baseMint: 13,
  quoteMint: 14,
  dammEventAuthority: 23,
} as const;
