//! Meteora DBC 0.2.1 / DAMM v2 0.2.4 by raw bytes (no Meteora crates, like the spike). Layouts are the programs'
//! zero-copy structs (`repr(C)`), offsets INCLUDE the 8-byte Anchor discriminator. Verified against the mainnet
//! binaries in `tests/` (LiteSVM). Readers fail closed on a wrong owner, discriminator or a short account.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
};

use crate::error::FumpadError;

pub const DBC_PROGRAM_ID: Pubkey = pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
pub const DAMM_V2_PROGRAM_ID: Pubkey = pubkey!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
/// DBC PDA ["pool_authority"] (owns DBC vaults; pool creator of migrated DAMM v2 pools).
pub const DBC_POOL_AUTHORITY: Pubkey = pubkey!("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
pub const DBC_EVENT_AUTHORITY: Pubkey = pubkey!("8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF");
/// DAMM v2 PDA ["pool_authority"].
pub const DAMM_POOL_AUTHORITY: Pubkey = pubkey!("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
pub const DAMM_EVENT_AUTHORITY: Pubkey = pubkey!("3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet");

// sha256("global:<name>")[..8]
pub const IX_SWAP2: [u8; 8] = [65, 75, 63, 76, 235, 91, 91, 136];
pub const IX_DBC_CLAIM_TRADING_FEE: [u8; 8] = [8, 236, 89, 49, 152, 125, 177, 81];
pub const IX_DBC_WITHDRAW_LEFTOVER: [u8; 8] = [20, 198, 202, 237, 235, 243, 183, 66];
pub const IX_DBC_WITHDRAW_MIGRATION_FEE: [u8; 8] = [237, 142, 45, 23, 129, 6, 222, 162];
pub const IX_DBC_PARTNER_WITHDRAW_SURPLUS: [u8; 8] = [168, 173, 72, 100, 201, 98, 38, 92];
pub const IX_DBC_MIGRATION_DAMM_V2: [u8; 8] = [156, 169, 230, 103, 53, 228, 80, 64];
pub const IX_DAMM_CLAIM_POSITION_FEE: [u8; 8] = [180, 38, 154, 17, 133, 33, 162, 211];

// sha256("account:<Name>")[..8]
pub const ACC_DBC_VIRTUAL_POOL: [u8; 8] = [213, 224, 5, 209, 98, 69, 119, 92];
pub const ACC_DBC_POOL_CONFIG: [u8; 8] = [26, 108, 14, 123, 116, 230, 129, 43];
pub const ACC_DAMM_POOL: [u8; 8] = [241, 154, 109, 4, 17, 177, 109, 188];
pub const ACC_DAMM_POSITION: [u8; 8] = [170, 188, 143, 228, 122, 64, 247, 208];
pub const ACC_DAMM_CONFIG: [u8; 8] = [155, 12, 170, 224, 30, 250, 204, 130];

/// DBC swap2 / DAMM swap2 account counts (named accounts incl. the event-CPI pair).
pub const DBC_SWAP2_ACCOUNTS: usize = 15;
pub const DAMM_SWAP2_ACCOUNTS: usize = 14;
/// Upper bound of the user-signed router pass-through (forward-compatible with appended accounts).
pub const MAX_ROUTER_ACCOUNTS: usize = 24;
/// DBC `migration_damm_v2`: 25 named accounts + the DAMM v2 config (remaining 0).
pub const DBC_MIGRATION_ACCOUNTS: usize = 26;

pub const SWAP_MODE_EXACT_IN: u8 = 0;
pub const SWAP_MODE_PARTIAL_FILL: u8 = 1;

pub const VENUE_DBC: u8 = 0;
pub const VENUE_DAMM: u8 = 1;

// ── DBC VirtualPool (8 + 416 = 424 bytes) ────────────────────────────────────
pub const DBC_POOL_LEN: usize = 424;
pub const DBC_POOL_CONFIG: usize = 72;
pub const DBC_POOL_CREATOR: usize = 104;
pub const DBC_POOL_BASE_MINT: usize = 136;
pub const DBC_POOL_BASE_VAULT: usize = 168;
pub const DBC_POOL_QUOTE_VAULT: usize = 200;
pub const DBC_POOL_BASE_RESERVE: usize = 232;
pub const DBC_POOL_QUOTE_RESERVE: usize = 240;
pub const DBC_POOL_SQRT_PRICE: usize = 280;
pub const DBC_POOL_ACTIVATION_POINT: usize = 296;
pub const DBC_POOL_IS_MIGRATED: usize = 305;
pub const DBC_POOL_IS_PARTNER_WITHDRAW_SURPLUS: usize = 306;
pub const DBC_POOL_MIGRATION_PROGRESS: usize = 308;
pub const DBC_POOL_IS_WITHDRAW_LEFTOVER: usize = 309;
pub const DBC_POOL_MIGRATION_FEE_WITHDRAW_STATUS: usize = 311;
/// `metrics.total_protocol_quote_fee`, `metrics.total_trading_quote_fee` (cumulative; fee measurement).
pub const DBC_POOL_TOTAL_PROTOCOL_QUOTE_FEE: usize = 320;
pub const DBC_POOL_TOTAL_TRADING_QUOTE_FEE: usize = 336;
/// DBC `PARTNER_MIGRATION_FEE_MASK`.
pub const DBC_PARTNER_MIGRATION_FEE_MASK: u8 = 0b100;
/// `MigrationProgress`: 0 PreBondingCurve, 1 PostBondingCurve, 2 LockedVesting, 3 CreatedPool.
pub const DBC_PROGRESS_PRE_BONDING: u8 = 0;
pub const DBC_PROGRESS_CREATED_POOL: u8 = 3;

// ── DBC PoolConfig (8 + 1040 = 1048 bytes) ───────────────────────────────────
pub const DBC_CONFIG_LEN: usize = 1048;
pub const CFG_QUOTE_MINT: usize = 8;
pub const CFG_FEE_CLAIMER: usize = 40;
pub const CFG_LEFTOVER_RECEIVER: usize = 72;
/// `pool_fees.base_fee`: cliff u64 @104, second_factor (period_frequency) u64 @112, third_factor @120,
/// first_factor (number_of_period) u16 @128, base_fee_mode u8 @130.
pub const CFG_BASE_FEE_SECOND_FACTOR: usize = 112;
pub const CFG_BASE_FEE_FIRST_FACTOR: usize = 128;
pub const CFG_BASE_FEE_MODE: usize = 130;
pub const CFG_PARTNER_VESTING_INFO: usize = 184;
pub const CFG_CREATOR_VESTING_INFO: usize = 200;
pub const CFG_COLLECT_FEE_MODE: usize = 232;
pub const CFG_MIGRATION_OPTION: usize = 233;
pub const CFG_ACTIVATION_TYPE: usize = 234;
pub const CFG_TOKEN_DECIMAL: usize = 235;
pub const CFG_TOKEN_TYPE: usize = 237;
pub const CFG_PARTNER_PERMANENT_LOCKED: usize = 239;
pub const CFG_PARTNER_LIQUIDITY: usize = 240;
pub const CFG_CREATOR_PERMANENT_LOCKED: usize = 241;
pub const CFG_CREATOR_LIQUIDITY: usize = 242;
pub const CFG_MIGRATION_FEE_OPTION: usize = 243;
pub const CFG_FIXED_SUPPLY_FLAG: usize = 244;
pub const CFG_CREATOR_TRADING_FEE_PCT: usize = 245;
pub const CFG_TOKEN_UPDATE_AUTHORITY: usize = 246;
pub const CFG_MIGRATION_FEE_PCT: usize = 247;
pub const CFG_CREATOR_MIGRATION_FEE_PCT: usize = 248;
pub const CFG_MIGRATION_QUOTE_THRESHOLD: usize = 264;
pub const CFG_LOCKED_VESTING: usize = 296;
pub const CFG_PRE_MIGRATION_SUPPLY: usize = 344;
pub const CFG_POST_MIGRATION_SUPPLY: usize = 352;
pub const CFG_MIGRATED_COLLECT_FEE_MODE: usize = 360;

// ── DAMM v2 Pool (8 + 1104 = 1112 bytes) ─────────────────────────────────────
pub const DAMM_POOL_LEN: usize = 1112;
pub const DAMM_POOL_TOKEN_A_MINT: usize = 168;
pub const DAMM_POOL_TOKEN_B_MINT: usize = 200;
pub const DAMM_POOL_TOKEN_A_VAULT: usize = 232;
pub const DAMM_POOL_TOKEN_B_VAULT: usize = 264;
pub const DAMM_POOL_LIQUIDITY: usize = 360;
pub const DAMM_POOL_SQRT_PRICE: usize = 456;
pub const DAMM_POOL_STATUS: usize = 481;
/// `metrics.total_lp_b_fee` (u128) @584, `metrics.total_protocol_b_fee` (u64) @608.
pub const DAMM_POOL_TOTAL_LP_B_FEE: usize = 584;
pub const DAMM_POOL_TOTAL_PROTOCOL_B_FEE: usize = 608;
pub const DAMM_POOL_CREATOR: usize = 648;
pub const DAMM_POOL_TOKEN_B_AMOUNT: usize = 688;

// ── DAMM v2 Position (8 + 400 bytes) ─────────────────────────────────────────
pub const DAMM_POSITION_LEN: usize = 408;
pub const DAMM_POSITION_POOL: usize = 8;
pub const DAMM_POSITION_NFT_MINT: usize = 40;
pub const DAMM_POSITION_UNLOCKED: usize = 152;
pub const DAMM_POSITION_VESTED: usize = 168;
pub const DAMM_POSITION_PERMANENT_LOCKED: usize = 184;

// ── DAMM v2 Config (8 + 320 bytes) ───────────────────────────────────────────
pub const DAMM_CONFIG_POOL_CREATOR_AUTHORITY: usize = 40;

pub fn rd_pubkey(d: &[u8], off: usize) -> Pubkey {
    Pubkey::new_from_array(d[off..off + 32].try_into().unwrap())
}
pub fn rd_u64(d: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(d[off..off + 8].try_into().unwrap())
}
pub fn rd_u128(d: &[u8], off: usize) -> u128 {
    u128::from_le_bytes(d[off..off + 16].try_into().unwrap())
}
pub fn rd_u16(d: &[u8], off: usize) -> u16 {
    u16::from_le_bytes(d[off..off + 2].try_into().unwrap())
}

/// Borrow `info`'s data after checking owner, discriminator and minimum length.
pub fn checked_data<'a>(
    info: &'a AccountInfo,
    owner: &Pubkey,
    disc: &[u8; 8],
    min_len: usize,
) -> Result<std::cell::Ref<'a, &'a mut [u8]>> {
    require_keys_eq!(*info.owner, *owner, FumpadError::WrongVenue);
    let d = info.try_borrow_data()?;
    require!(d.len() >= min_len && d[..8] == *disc, FumpadError::WrongVenue);
    Ok(d)
}

/// The fields of a DBC virtual pool FUMPAD reads.
#[derive(Clone, Copy, Debug)]
pub struct DbcPool {
    pub config: Pubkey,
    pub creator: Pubkey,
    pub base_mint: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub quote_reserve: u64,
    pub sqrt_price: u128,
    pub activation_point: u64,
    pub is_migrated: u8,
    pub is_partner_withdraw_surplus: u8,
    pub migration_progress: u8,
    pub is_withdraw_leftover: u8,
    pub migration_fee_withdraw_status: u8,
    pub total_quote_fee: u64,
}

pub fn read_dbc_pool(info: &AccountInfo) -> Result<DbcPool> {
    let d = checked_data(info, &DBC_PROGRAM_ID, &ACC_DBC_VIRTUAL_POOL, DBC_POOL_LEN)?;
    Ok(DbcPool {
        config: rd_pubkey(&d, DBC_POOL_CONFIG),
        creator: rd_pubkey(&d, DBC_POOL_CREATOR),
        base_mint: rd_pubkey(&d, DBC_POOL_BASE_MINT),
        base_vault: rd_pubkey(&d, DBC_POOL_BASE_VAULT),
        quote_vault: rd_pubkey(&d, DBC_POOL_QUOTE_VAULT),
        quote_reserve: rd_u64(&d, DBC_POOL_QUOTE_RESERVE),
        sqrt_price: rd_u128(&d, DBC_POOL_SQRT_PRICE),
        activation_point: rd_u64(&d, DBC_POOL_ACTIVATION_POINT),
        is_migrated: d[DBC_POOL_IS_MIGRATED],
        is_partner_withdraw_surplus: d[DBC_POOL_IS_PARTNER_WITHDRAW_SURPLUS],
        migration_progress: d[DBC_POOL_MIGRATION_PROGRESS],
        is_withdraw_leftover: d[DBC_POOL_IS_WITHDRAW_LEFTOVER],
        migration_fee_withdraw_status: d[DBC_POOL_MIGRATION_FEE_WITHDRAW_STATUS],
        total_quote_fee: rd_u64(&d, DBC_POOL_TOTAL_PROTOCOL_QUOTE_FEE)
            .wrapping_add(rd_u64(&d, DBC_POOL_TOTAL_TRADING_QUOTE_FEE)),
    })
}

/// The fields of a DBC config FUMPAD reads.
#[derive(Clone, Copy, Debug)]
pub struct DbcConfig {
    pub migration_quote_threshold: u64,
    pub pre_migration_token_supply: u64,
    /// Fee-scheduler length in slots (number_of_period × period_frequency), 0 without a scheduler.
    pub launch_window_slots: u64,
}

/// Read a DBC config and check the FUMPAD structural invariants (INTERFACE §5.4).
pub fn read_fumpad_config(info: &AccountInfo, fee_claimer: &Pubkey, reward_pool: &Pubkey) -> Result<DbcConfig> {
    let d = checked_data(info, &DBC_PROGRAM_ID, &ACC_DBC_POOL_CONFIG, DBC_CONFIG_LEN)?;
    let zero = |off: usize, len: usize| d[off..off + len].iter().all(|b| *b == 0);
    let ok = rd_pubkey(&d, CFG_QUOTE_MINT) == crate::constants::WSOL_MINT
        && rd_pubkey(&d, CFG_FEE_CLAIMER) == *fee_claimer
        && rd_pubkey(&d, CFG_LEFTOVER_RECEIVER) == *reward_pool
        && d[CFG_COLLECT_FEE_MODE] == 0
        && d[CFG_MIGRATION_OPTION] == 1
        && d[CFG_ACTIVATION_TYPE] == 0
        && d[CFG_TOKEN_DECIMAL] == crate::constants::TOKEN_DECIMALS
        && d[CFG_TOKEN_TYPE] == 1
        && d[CFG_PARTNER_PERMANENT_LOCKED] == 100
        && d[CFG_PARTNER_LIQUIDITY] == 0
        && d[CFG_CREATOR_PERMANENT_LOCKED] == 0
        && d[CFG_CREATOR_LIQUIDITY] == 0
        && d[CFG_MIGRATION_FEE_OPTION] == 6
        && d[CFG_FIXED_SUPPLY_FLAG] == 1
        && d[CFG_CREATOR_TRADING_FEE_PCT] == 0
        && d[CFG_TOKEN_UPDATE_AUTHORITY] == 1
        && d[CFG_CREATOR_MIGRATION_FEE_PCT] == 0
        && zero(CFG_PARTNER_VESTING_INFO, 16)
        && zero(CFG_CREATOR_VESTING_INFO, 16)
        && zero(CFG_LOCKED_VESTING, 40)
        && d[CFG_MIGRATED_COLLECT_FEE_MODE] == 0
        && rd_u64(&d, CFG_PRE_MIGRATION_SUPPLY) == rd_u64(&d, CFG_POST_MIGRATION_SUPPLY)
        && rd_u64(&d, CFG_PRE_MIGRATION_SUPPLY) > 0;
    require!(ok, FumpadError::InvalidConfig);
    // Base fee modes 0/1 = linear/exponential scheduler: number_of_period × period_frequency slots.
    let launch_window_slots = if d[CFG_BASE_FEE_MODE] <= 1 {
        (rd_u16(&d, CFG_BASE_FEE_FIRST_FACTOR) as u64).saturating_mul(rd_u64(&d, CFG_BASE_FEE_SECOND_FACTOR))
    } else {
        0
    };
    Ok(DbcConfig {
        migration_quote_threshold: rd_u64(&d, CFG_MIGRATION_QUOTE_THRESHOLD),
        pre_migration_token_supply: rd_u64(&d, CFG_PRE_MIGRATION_SUPPLY),
        launch_window_slots,
    })
}

/// The fields of a DAMM v2 pool FUMPAD reads.
#[derive(Clone, Copy, Debug)]
pub struct DammPool {
    pub token_a_mint: Pubkey,
    pub token_b_mint: Pubkey,
    pub token_a_vault: Pubkey,
    pub token_b_vault: Pubkey,
    pub liquidity: u128,
    pub sqrt_price: u128,
    pub creator: Pubkey,
    pub token_b_amount: u64,
    pub total_b_fee: u128,
    /// 0 = enabled, 1 = disabled by the DAMM v2 operator.
    pub pool_status: u8,
}

pub fn read_damm_pool(info: &AccountInfo) -> Result<DammPool> {
    let d = checked_data(info, &DAMM_V2_PROGRAM_ID, &ACC_DAMM_POOL, DAMM_POOL_LEN)?;
    Ok(DammPool {
        token_a_mint: rd_pubkey(&d, DAMM_POOL_TOKEN_A_MINT),
        token_b_mint: rd_pubkey(&d, DAMM_POOL_TOKEN_B_MINT),
        token_a_vault: rd_pubkey(&d, DAMM_POOL_TOKEN_A_VAULT),
        token_b_vault: rd_pubkey(&d, DAMM_POOL_TOKEN_B_VAULT),
        liquidity: rd_u128(&d, DAMM_POOL_LIQUIDITY),
        sqrt_price: rd_u128(&d, DAMM_POOL_SQRT_PRICE),
        creator: rd_pubkey(&d, DAMM_POOL_CREATOR),
        token_b_amount: rd_u64(&d, DAMM_POOL_TOKEN_B_AMOUNT),
        total_b_fee: rd_u128(&d, DAMM_POOL_TOTAL_LP_B_FEE)
            .wrapping_add(rd_u64(&d, DAMM_POOL_TOTAL_PROTOCOL_B_FEE) as u128),
        pool_status: d[DAMM_POOL_STATUS],
    })
}

#[derive(Clone, Copy, Debug)]
pub struct DammPosition {
    pub pool: Pubkey,
    pub nft_mint: Pubkey,
    pub unlocked_liquidity: u128,
    pub vested_liquidity: u128,
    pub permanent_locked_liquidity: u128,
}

pub fn read_damm_position(info: &AccountInfo) -> Result<DammPosition> {
    let d = checked_data(info, &DAMM_V2_PROGRAM_ID, &ACC_DAMM_POSITION, DAMM_POSITION_LEN)?;
    Ok(DammPosition {
        pool: rd_pubkey(&d, DAMM_POSITION_POOL),
        nft_mint: rd_pubkey(&d, DAMM_POSITION_NFT_MINT),
        unlocked_liquidity: rd_u128(&d, DAMM_POSITION_UNLOCKED),
        vested_liquidity: rd_u128(&d, DAMM_POSITION_VESTED),
        permanent_locked_liquidity: rd_u128(&d, DAMM_POSITION_PERMANENT_LOCKED),
    })
}

/// DAMM v2 pool PDA for a (config, mint a, mint b) pair: ["pool", config, max(a, b), min(a, b)].
pub fn damm_pool_address(config: &Pubkey, a: &Pubkey, b: &Pubkey) -> Pubkey {
    let (hi, lo) = if a.to_bytes() > b.to_bytes() { (a, b) } else { (b, a) };
    Pubkey::find_program_address(&[b"pool", config.as_ref(), hi.as_ref(), lo.as_ref()], &DAMM_V2_PROGRAM_ID).0
}

/// DAMM v2 position NFT account PDA ["position_nft_account", nft_mint].
pub fn damm_position_nft_account(nft_mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"position_nft_account", nft_mint.as_ref()], &DAMM_V2_PROGRAM_ID).0
}

/// `swap2` data: disc ‖ amount_0 ‖ amount_1 ‖ swap_mode (same shape on DBC and DAMM v2).
pub fn swap2_data(amount_0: u64, amount_1: u64, mode: u8) -> Vec<u8> {
    let mut d = Vec::with_capacity(25);
    d.extend_from_slice(&IX_SWAP2);
    d.extend_from_slice(&amount_0.to_le_bytes());
    d.extend_from_slice(&amount_1.to_le_bytes());
    d.push(mode);
    d
}

/// Invoke `program` with `accounts` as its exact account list (pass-through). `signer`: a fumpad PDA that signs
/// (its key gets the signer flag). The caller has validated every account a PDA signature could reach.
pub fn invoke_passthrough<'info>(
    program: &AccountInfo<'info>,
    accounts: &[AccountInfo<'info>],
    data: Vec<u8>,
    signer: Option<(&Pubkey, &[&[u8]])>,
) -> Result<()> {
    let metas: Vec<AccountMeta> = accounts
        .iter()
        .map(|a| AccountMeta {
            pubkey: *a.key,
            is_signer: a.is_signer || signer.is_some_and(|(k, _)| k == a.key),
            is_writable: a.is_writable,
        })
        .collect();
    let ix = Instruction { program_id: *program.key, accounts: metas, data };
    let mut infos: Vec<AccountInfo<'info>> = Vec::with_capacity(accounts.len() + 1);
    infos.extend_from_slice(accounts);
    infos.push(program.clone());
    match signer {
        Some((_, seeds)) => invoke_signed(&ix, &infos, &[seeds])?,
        None => invoke(&ix, &infos)?,
    }
    Ok(())
}

/// Require `accounts` to be exactly `expected` (same keys, same order, same length) — PDA-signed CPIs forward
/// only pinned account lists (v0.6 L-1).
pub fn require_exact_accounts(accounts: &[AccountInfo], expected: &[Pubkey]) -> Result<()> {
    require!(accounts.len() == expected.len(), FumpadError::WrongVenue);
    for (a, e) in accounts.iter().zip(expected) {
        require_keys_eq!(*a.key, *e, FumpadError::WrongVenue);
    }
    Ok(())
}
