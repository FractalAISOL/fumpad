use anchor_lang::prelude::*;

// ── PDA seeds ────────────────────────────────────────────────────────────────
#[constant]
pub const GLOBAL_SEED: &[u8] = b"global";
#[constant]
pub const COIN_SEED: &[u8] = b"coin"; // ["coin", mint]
#[constant]
pub const MINT_AUTHORITY_SEED: &[u8] = b"mint_authority"; // ["mint_authority"]
#[constant]
pub const REWARD_VAULT_SEED: &[u8] = b"reward_vault"; // ["reward_vault", mint] — token account holding the coin's reward pool
#[constant]
pub const CURVE_VAULT_SEED: &[u8] = b"curve_vault"; // ["curve_vault", mint] — token account holding curve + LP-reserved tokens
#[constant]
pub const POSITION_SEED: &[u8] = b"position"; // ["position", mint, wallet]
#[constant]
pub const TICKET_SEED: &[u8] = b"ticket"; // ["ticket", mint, wallet, seq.to_le_bytes()]
#[constant]
pub const OBSERVATIONS_SEED: &[u8] = b"observations"; // ["observations", mint]
#[constant]
pub const CLAIM_QUEUE_SEED: &[u8] = b"claim_queue"; // ["claim_queue", mint]
#[constant]
pub const POOL_AUTHORITY_SEED: &[u8] = b"pool_authority"; // ["pool_authority"] — creator of PumpSwap pools + signer for program-owned token moves

// ── Fixed-point ──────────────────────────────────────────────────────────────
/// Prices are lamports per base unit of the token, in Q64.64 (u128).
pub const Q64: u128 = 1u128 << 64;
pub const BPS_DENOM: u64 = 10_000;

// ── Token ────────────────────────────────────────────────────────────────────
pub const TOKEN_DECIMALS: u8 = 6;

// ── Defaults (all live in Global and are admin-tunable) ──────────────────────
// Curve re-derived from pump.fun's so that, with 5% of supply set aside for the
// reward pool, the curve's final price equals the PumpSwap LP opening price.
// See docs/SPEC.md §3.
pub const DEFAULT_TOTAL_SUPPLY: u64 = 1_000_000_000_000_000; // 1B * 10^6
pub const DEFAULT_REWARD_POOL_SUPPLY: u64 = 50_000_000_000_000; // 5%
pub const DEFAULT_CURVE_SUPPLY: u64 = 753_448_275_862_069; // real tokens sold on the curve
pub const DEFAULT_LP_SUPPLY: u64 = 196_551_724_137_931; // tokens deposited into PumpSwap at graduation
pub const DEFAULT_INITIAL_VIRTUAL_SOL: u64 = 30_000_000_000; // 30 SOL
pub const DEFAULT_INITIAL_VIRTUAL_TOKEN: u64 = 1_019_371_196_754_564;
pub const DEFAULT_GRADUATION_LAMPORTS: u64 = 85_000_000_000; // 85 SOL real

pub const DEFAULT_FEE_BPS: u16 = 100; // 1% of the SOL side
pub const DEFAULT_FEE_POOL_SHARE_BPS: u16 = 5_000;
pub const DEFAULT_FEE_PLATFORM_SHARE_BPS: u16 = 3_000;
pub const DEFAULT_FEE_CREATOR_SHARE_BPS: u16 = 2_000;

pub const DEFAULT_TRIGGER_MULTIPLE_BPS: u32 = 100_000; // 10x
pub const DEFAULT_CLAIM_BPS: u16 = 1_000; // 10% of tokens sold
pub const DEFAULT_MAX_CLAIM_POOL_BPS: u16 = 1_000; // a claim may take at most 10% of the pool
pub const DEFAULT_MIN_SELL_USD_CENTS: u64 = 5_000; // $50
pub const DEFAULT_MIN_HOLD_SECS: i64 = 600; // 10 min
pub const DEFAULT_REBUY_WINDOW_SECS: i64 = 7 * 86_400;
pub const DEFAULT_CLAIM_WINDOW_SECS: i64 = 90 * 86_400;
pub const MAX_OPEN_TICKETS: usize = 5;

pub const DEFAULT_ORACLE_WINDOW_SECS: i64 = 1_800; // 30 min
pub const DEFAULT_ORACLE_MIN_SPACING_SECS: i64 = 10;
pub const DEFAULT_ORACLE_MIN_SAMPLES: u16 = 84; // 70% of 120 expected @15s
pub const DEFAULT_KEEPER_STALE_SECS: i64 = 600; // permissionless fallback after 10 min w/o keeper sample
pub const DEFAULT_BUYBACK_MAX_DEVIATION_BPS: u16 = 300; // spot within ±3% of median
pub const DEFAULT_BUYBACK_MAX_POOL_BPS: u16 = 50; // slice ≤ 0.5% of pool quote depth

pub const DEFAULT_MAX_PRICE_AGE_SECS: u64 = 60;
pub const MAX_KEEPERS: usize = 3;

pub const OBSERVATION_CAPACITY: usize = 256;
pub const CLAIM_QUEUE_CAPACITY: usize = 256;

// ── External programs ────────────────────────────────────────────────────────
pub const PUMPSWAP_PROGRAM_ID: Pubkey = pubkey!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
pub const PUMPSWAP_GLOBAL_CONFIG: Pubkey = pubkey!("ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw");
pub const PUMP_FEES_PROGRAM_ID: Pubkey = pubkey!("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
pub const PYTH_RECEIVER_PROGRAM_ID: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
/// Pyth SOL/USD feed id.
pub const PYTH_SOL_USD_FEED_ID: [u8; 32] = [
    0xef, 0x0d, 0x8b, 0x6f, 0xda, 0x2c, 0xeb, 0xa4, 0x1d, 0xa1, 0x5d, 0x40, 0x95, 0xd1, 0xda, 0x39,
    0x2a, 0x0d, 0x2f, 0x8e, 0xd0, 0xc6, 0xc7, 0xbc, 0x0f, 0x4c, 0xfa, 0xc8, 0xc2, 0x80, 0xb5, 0x6d,
];

// PumpSwap instruction discriminators (from idl/pump_amm.json).
pub const PUMPSWAP_IX_CREATE_POOL: [u8; 8] = [233, 146, 209, 142, 207, 104, 64, 188];
