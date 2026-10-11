import { PublicKey } from "@solana/web3.js";

// ── Programs ────────────────────────────────────────────────────────────────
export const FUMPAD_PROGRAM_ID = new PublicKey("ASVE6Nk8T1c2Uv81vjPeNDnX54nHGWg98G1afYt2j8Cv");
export const LP_LOCKER_PROGRAM_ID = new PublicKey("8TkV5aWsBJ9bHr96HV5iQXrCJ51XvHTTtxnufMQmEaY9");
export const PUMPSWAP_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
export const PUMP_FEES_PROGRAM_ID = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
export const PYTH_RECEIVER_PROGRAM_ID = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");
export const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey("ComputeBudget111111111111111111111111111111");
export const INSTRUCTIONS_SYSVAR_ID = new PublicKey("Sysvar1nstructions1111111111111111111111111");
export const BPF_LOADER_UPGRADEABLE_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

// ── PumpSwap fixed accounts ─────────────────────────────────────────────────
export const PUMPSWAP_GLOBAL_CONFIG = new PublicKey("ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw");
/** Pump Fees `fee_config` PDA for the AMM: ["fee_config", pump_amm_program_id] under the fees program. */
export const PUMPSWAP_FEE_CONFIG = new PublicKey("5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx");
/** PumpSwap pool index used for every FUMPAD pool (`graduate.rs::POOL_INDEX`). */
export const FUMPAD_POOL_INDEX = 0;

/** Default Pyth SOL/USD PriceUpdateV2 account (mainnet sponsored feed, shard 0). */
export const PYTH_SOL_USD_ACCOUNT = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
export const PYTH_SOL_USD_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

// ── Seeds (constants.rs) ────────────────────────────────────────────────────
const enc = (s: string) => new TextEncoder().encode(s);
export const SEEDS = {
  global: enc("global"),
  coin: enc("coin"),
  mintAuthority: enc("mint_authority"),
  rewardVault: enc("reward_vault"),
  curveVault: enc("curve_vault"),
  position: enc("position"),
  ticket: enc("ticket"),
  observations: enc("observations"),
  claimQueue: enc("claim_queue"),
  poolAuthority: enc("pool_authority"),
  eventAuthority: enc("__event_authority"),
  // locker
  lock: enc("lock"),
  lockerAuthority: enc("authority"),
  // pumpswap
  pool: enc("pool"),
  poolLpMint: enc("pool_lp_mint"),
  userVolumeAccumulator: enc("user_volume_accumulator"),
} as const;

// ── Units & fixed point ─────────────────────────────────────────────────────
export const TOKEN_DECIMALS = 6;
export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const BASE_PER_TOKEN = 1_000_000n;
export const Q64 = 1n << 64n;
export const BPS_DENOM = 10_000n;
export const U64_MAX = (1n << 64n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;

// ── Program constants that are NOT params ───────────────────────────────────
export const MAX_OPEN_TICKETS = 5;
export const MAX_KEEPERS = 3;
export const OBSERVATION_CAPACITY = 256;
export const CLAIM_QUEUE_CAPACITY = 256;
export const MAX_SAMPLE_COINS = 10;
/** Coins per legacy `record_samples` tx (5 accounts each); more needs v0 + ALT. */
export const MAX_SAMPLE_COINS_LEGACY = 5;
export const MAX_SELF_IMPACT_DISCOUNT_BPS = 1_000n;
export const LP_FEE_PLATFORM_SHARE_BPS = 6_000n;
export const REFERENCE_WINDOW_SECS = 600n;
export const REFERENCE_MAX_UNCONFIRMED_SECS = 150n;
export const BUYBACK_VENUE_FEE_ALLOWANCE_BPS = 100n;
/** Pyth: reject confidence wider than 2% of price. */
export const PYTH_MAX_CONF_BPS = 200n;
/** Locker dust threshold (0.001 LP). */
export const LOCKER_MIN_SKIM_LP = 1_000_000n;
/** Lamports the graduate caller lends for PumpSwap account rent (unused part returned). */
export const GRADUATION_RENT_BUDGET = 50_000_000n;

/** Anchor `emit_cpi!` instruction tag (EVENT_IX_TAG_LE). */
export const EVENT_IX_TAG = Uint8Array.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

// ── PumpSwap discriminators (external-idl/pump_amm.json) ────────────────────
export const PUMPSWAP_IX = {
  buyExactQuoteInV2: Uint8Array.from([194, 171, 28, 70, 104, 77, 91, 47]),
  sellV2: Uint8Array.from([93, 246, 130, 60, 231, 233, 64, 178]),
  initUserVolumeAccumulator: Uint8Array.from([94, 6, 202, 115, 255, 96, 232, 183]),
  withdraw: Uint8Array.from([183, 18, 70, 156, 148, 109, 161, 34]),
} as const;
export const PUMPSWAP_POOL_DISCRIMINATOR = Uint8Array.from([241, 154, 109, 4, 17, 177, 109, 188]);
/**
 * Fallback PumpSwap fee for non-pump pools. Live value: Pump Fees `FeeConfig.flat_fees`
 * (devnet dump: 0.25% LP + 0.05% protocol = 30 bps; SPEC §1 quotes 0.20 + 0.05).
 */
export const PUMPSWAP_DEFAULT_FEE_BPS = 30n;

/**
 * Compute-unit limits. Measured on solana-test-validator against the real PumpSwap
 * program (see services/README.md "Compute budgets"), with ~30–50% headroom. A
 * transaction pays for the limit it requests only via priority fee (price × limit), so
 * tight-but-safe limits matter when priority fees are high.
 */
export const CU = {
  createCoin: 200_000,
  buy: 200_000,
  sell: 200_000,
  createCoinAndBuy: 350_000,
  graduate: 400_000,
  swapBuy: 250_000,
  swapSell: 250_000,
  executeBuyback: 250_000,
  recordSamplesPerCoin: 30_000,
  recordSamplesBase: 20_000,
  claim: 200_000,
  processQueue: 600_000,
  skimSettle: 200_000,
  initClaimQueue: 100_000,
  initObservations: 60_000,
  default: 200_000,
} as const;
