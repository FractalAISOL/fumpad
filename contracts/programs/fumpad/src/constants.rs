use anchor_lang::prelude::*;

// ── PDA seeds ────────────────────────────────────────────────────────────────
#[constant]
pub const GLOBAL_SEED: &[u8] = b"global";
#[constant]
pub const COIN_SEED: &[u8] = b"coin"; // ["coin", mint]
#[constant]
pub const POSITION_SEED: &[u8] = b"position"; // ["position", mint, wallet]
#[constant]
pub const TICKET_SEED: &[u8] = b"ticket"; // ["ticket", mint, wallet, seq.to_le_bytes()]
#[constant]
pub const CONSUMED_SEED: &[u8] = b"consumed"; // ["consumed", sha256(sig), ix_key LE (, ticket)]
#[constant]
pub const OBSERVATIONS_SEED: &[u8] = b"observations"; // ["observations", mint]
#[constant]
pub const CLAIM_QUEUE_SEED: &[u8] = b"claim_queue"; // ["claim_queue", mint]
#[constant]
pub const ESCROW_SEED: &[u8] = b"escrow"; // ["escrow", ticket]
/// D30/D36: DBC config `fee_claimer` and owner of the DAMM v2 position NFT. System account, no data.
#[constant]
pub const FEE_CLAIMER_SEED: &[u8] = b"fee_claimer";
/// Transient WSOL account (authority `fee_claimer`) created and closed inside one instruction.
#[constant]
pub const FEE_WSOL_SEED: &[u8] = b"fee_wsol";
/// D35: DBC config `leftover_receiver`; authority of every reward vault (its Token-2022 ATA per mint) and escrow.
#[constant]
pub const REWARD_POOL_SEED: &[u8] = b"reward_pool";
/// D30: swap payer for buybacks; owns only ATA(buyback, WSOL).
#[constant]
pub const BUYBACK_SEED: &[u8] = b"buyback";

// ── Fixed-point ──────────────────────────────────────────────────────────────
/// Prices are lamports per base unit of the token, in Q64.64 (u128).
pub const Q64: u128 = 1u128 << 64;
pub const BPS_DENOM: u64 = 10_000;

// ── Token ────────────────────────────────────────────────────────────────────
pub const TOKEN_DECIMALS: u8 = 6;

// ── Defaults (Global.params; admin-tunable behind the 48h timelock) ──────────
/// D32: our 1.00% (of the 1.25% DBC/DAMM fee) split 50 buyback / 30 platform / 20 creator.
pub const DEFAULT_FEE_BUYBACK_SHARE_BPS: u16 = 5_000;
pub const DEFAULT_FEE_PLATFORM_SHARE_BPS: u16 = 3_000;
pub const DEFAULT_FEE_CREATOR_SHARE_BPS: u16 = 2_000;

pub const DEFAULT_TRIGGER_MULTIPLE_BPS: u32 = 100_000; // 10x
pub const DEFAULT_CLAIM_BPS: u16 = 1_000; // 10% of tokens sold
pub const DEFAULT_MAX_CLAIM_POOL_BPS: u16 = 1_000; // a claim may take at most 10% of the pool
pub const DEFAULT_MIN_SELL_USD_CENTS: u64 = 5_000; // $50
pub const DEFAULT_MIN_HOLD_SECS: i64 = 600; // 10 min (off-chain engine input, snapshotted per coin)
pub const DEFAULT_REBUY_WINDOW_SECS: i64 = 7 * 86_400;
pub const DEFAULT_CLAIM_WINDOW_SECS: i64 = 90 * 86_400;
pub const MAX_OPEN_TICKETS: usize = 5;
/// D16: a wallet may hold at most this many claim-queue entries per coin.
pub const MAX_QUEUED_PER_WALLET: usize = 2;

pub const DEFAULT_ORACLE_WINDOW_SECS: i64 = 1_800; // 30 min
pub const DEFAULT_ORACLE_MIN_SPACING_SECS: i64 = 10;
pub const DEFAULT_ORACLE_MIN_SAMPLES: u16 = 84; // 70% of 120 expected @15s
pub const DEFAULT_KEEPER_STALE_SECS: i64 = 600;
pub const DEFAULT_BUYBACK_MAX_DEVIATION_BPS: u16 = 300; // spot within ±3% of the guard price
pub const DEFAULT_BUYBACK_MAX_POOL_BPS: u16 = 50; // slice ≤ 0.5% of quote depth

/// v0.7: the engine's max |block_time − Pyth publish_time| (SPEC v0.7 §5.4: 60 s). Bounded 30–300 s.
pub const DEFAULT_MAX_PRICE_AGE_SECS: u64 = 60;
/// D31: attestations older than this (now − block_time) are rejected.
pub const DEFAULT_MAX_ATTEST_AGE_SECS: i64 = 86_400;
/// D31: ticket tokens per coin becoming effective per hour ≤ this share of supply (20%); excess is deferred (M-1).
pub const DEFAULT_MAX_ATTEST_TOKENS_PER_HOUR_BPS: u16 = 2_000;
/// D31: a ticket is claimable only after `attested_at + ticket_challenge_secs` (6 h).
pub const DEFAULT_TICKET_CHALLENGE_SECS: i64 = 6 * 3_600;
/// D31: 2-of-3 keeper signatures (fixed in v1).
pub const ATTEST_THRESHOLD: u8 = 2;

/// D15: delay between `queue_params` and the earliest `execute_params`.
pub const PARAMS_TIMELOCK_SECS: i64 = 48 * 3_600;
/// M-2: delay between `propose_admin` and the earliest `accept_admin`.
pub const ADMIN_TIMELOCK_SECS: i64 = 48 * 3_600;
/// SPEC v0.7 §7: config allow-list changes are timelocked 48 h.
pub const CONFIG_TIMELOCK_SECS: i64 = 48 * 3_600;
/// M-3: a `set_pause` lapses after this long unless renewed.
pub const MAX_PAUSE_SECS: i64 = 7 * 86_400;
/// SPEC v0.7 §7: a keeper newly added by `set_keepers` can't count toward an attestation for 6 h.
pub const KEEPER_ATTEST_FREEZE_SECS: i64 = 6 * 3_600;
/// SPEC v0.7 §3.4: the pre-graduation buyback guard needs a keeper sample at most this old.
pub const PREGRAD_SAMPLE_MAX_AGE_SECS: i64 = 60;
/// Clock skew tolerated between an attested `block_time` and the validator clock / the coin's registration.
pub const ATTEST_CLOCK_SKEW_SECS: i64 = 60;
/// Allowance for the venue's own fee (1.25% on DBC/DAMM, D32) when checking a buyback's output.
pub const BUYBACK_VENUE_FEE_ALLOWANCE_BPS: u64 = 200;
/// Rate-cap window: `max_attest_tokens_per_hour_bps` of supply per this many seconds (leaky bucket, M-1).
pub const ATTEST_CAP_WINDOW_SECS: i64 = 3_600;

// ── `Params::is_valid` bounds (inclusive) ────────────────────────────────────
pub const MIN_TRIGGER_MULTIPLE_BPS: u32 = 50_000;
pub const MAX_TRIGGER_MULTIPLE_BPS: u32 = 500_000;
pub const MIN_CLAIM_BPS: u16 = 100;
pub const MAX_CLAIM_BPS: u16 = 2_500;
pub const MIN_MAX_CLAIM_POOL_BPS: u16 = 100;
pub const MAX_MAX_CLAIM_POOL_BPS: u16 = 2_500;
pub const MIN_MIN_SELL_USD_CENTS: u64 = 500;
pub const MAX_MIN_SELL_USD_CENTS: u64 = 100_000;
pub const MIN_MIN_HOLD_SECS: i64 = 60;
pub const MAX_MIN_HOLD_SECS: i64 = 86_400;
pub const MIN_REBUY_WINDOW_SECS: i64 = 86_400;
pub const MAX_REBUY_WINDOW_SECS: i64 = 30 * 86_400;
pub const MIN_CLAIM_WINDOW_SECS: i64 = 7 * 86_400;
pub const MAX_CLAIM_WINDOW_SECS: i64 = 365 * 86_400;
pub const MIN_ORACLE_WINDOW_SECS: i64 = 600;
pub const MAX_ORACLE_WINDOW_SECS: i64 = 7_200;
pub const MIN_ORACLE_MIN_SPACING_SECS: i64 = 5;
pub const MAX_ORACLE_MIN_SPACING_SECS: i64 = 60;
pub const ORACLE_MIN_SAMPLE_EVERY_SECS: i64 = 60;
pub const MIN_KEEPER_STALE_SECS: i64 = 60;
pub const MAX_KEEPER_STALE_SECS: i64 = 3_600;
pub const MIN_BUYBACK_MAX_DEVIATION_BPS: u16 = 10;
pub const MAX_BUYBACK_MAX_DEVIATION_BPS: u16 = 1_000;
pub const MIN_BUYBACK_MAX_POOL_BPS: u16 = 1;
pub const MAX_BUYBACK_MAX_POOL_BPS: u16 = 200;
pub const MIN_MAX_PRICE_AGE_SECS: u64 = 30;
pub const MAX_MAX_PRICE_AGE_SECS: u64 = 300;
pub const MIN_MAX_ATTEST_AGE_SECS: i64 = 3_600;
pub const MAX_MAX_ATTEST_AGE_SECS: i64 = 7 * 86_400;
pub const MIN_ATTEST_TOKENS_PER_HOUR_BPS: u16 = 1;
pub const MAX_ATTEST_TOKENS_PER_HOUR_BPS: u16 = 10_000;
pub const MIN_TICKET_CHALLENGE_SECS: i64 = 3_600;
pub const MAX_TICKET_CHALLENGE_SECS: i64 = 48 * 3_600;

pub const MAX_KEEPERS: usize = 3;
/// Config allow-list slots (`Global.configs`).
pub const MAX_CONFIGS: usize = 8;

pub const OBSERVATION_CAPACITY: usize = 256;
/// D17: 1024 entries; the queue PDA is 8 + 48 + 80 × 1024 = 81,976 bytes (9 `init_claim_queue` calls).
pub const CLAIM_QUEUE_CAPACITY: usize = 1024;

// ── External programs / accounts ─────────────────────────────────────────────
pub const PYTH_SOL_USD_FEED_ID: [u8; 32] = [
    0xef, 0x0d, 0x8b, 0x6f, 0xda, 0x2c, 0xeb, 0xa4, 0x1d, 0xa1, 0x5d, 0x40, 0x95, 0xd1, 0xda, 0x39,
    0x2a, 0x0d, 0x2f, 0x8e, 0xd0, 0xc6, 0xc7, 0xbc, 0x0f, 0x4c, 0xfa, 0xc8, 0xc2, 0x80, 0xb5, 0x6d,
];
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
pub const COMPUTE_BUDGET_PROGRAM_ID: Pubkey = pubkey!("ComputeBudget111111111111111111111111111111");
pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");
