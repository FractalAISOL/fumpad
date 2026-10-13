//! Meteora DBC 0.2.1 / DAMM v2 0.2.4 instruction builders for the tests (raw bytes, like the program), the FUMPAD
//! DBC `ConfigParameters` (borsh, same field order as DBC's `process_create_config.rs`) and account readers.

use anchor_lang::prelude::{AccountMeta, Pubkey};
use anchor_lang::AnchorSerialize;
use fumpad::external::meteora as m;
use solana_instruction::Instruction;

use crate::{base_ata, raw_ix, ro, rw, sg, sgw, wsol_ata, ATA_PROGRAM, IX_SYSVAR, SPL_TOKEN, SYSTEM, TOKEN_2022};

pub const DBC: Pubkey = m::DBC_PROGRAM_ID;
pub const DAMM: Pubkey = m::DAMM_V2_PROGRAM_ID;
pub const WSOL: Pubkey = fumpad::WSOL_MINT;
/// Mainnet DAMM v2 config DBC uses for `MigrationFeeOption::Customizable` (`fixtures/damm_v2_migration_config_mainnet.json`).
pub const DAMM_MIGRATION_CONFIG: Pubkey = anchor_lang::pubkey!("A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck");

pub const IX_CREATE_CONFIG: [u8; 8] = [201, 207, 243, 114, 75, 111, 47, 189];
pub const IX_INIT_POOL_T22: [u8; 8] = [169, 118, 51, 78, 145, 110, 220, 155];

// ── ConfigParameters ────────────────────────────────────────────────────────
#[derive(AnchorSerialize, Clone, Copy, Debug, Default)]
pub struct BaseFeeParameters {
    pub cliff_fee_numerator: u64,
    pub first_factor: u16,
    pub second_factor: u64,
    pub third_factor: u64,
    pub base_fee_mode: u8,
}

#[derive(AnchorSerialize, Clone, Copy, Debug, Default)]
pub struct LockedVestingParams {
    pub amount_per_period: u64,
    pub cliff_duration_from_migration_time: u64,
    pub frequency: u64,
    pub number_of_period: u64,
    pub cliff_unlock_amount: u64,
}

#[derive(AnchorSerialize, Clone, Copy, Debug, Default)]
pub struct TokenSupplyParams {
    pub pre_migration_token_supply: u64,
    pub post_migration_token_supply: u64,
}

#[derive(AnchorSerialize, Clone, Copy, Debug, Default)]
pub struct LiquidityVestingInfoParams {
    pub vesting_percentage: u8,
    pub bps_per_period: u16,
    pub number_of_periods: u16,
    pub cliff_duration_from_migration_time: u32,
    pub frequency: u32,
}

#[derive(AnchorSerialize, Clone, Copy, Debug, Default)]
pub struct MarketCapFeeSchedulerParams {
    pub number_of_period: u16,
    pub sqrt_price_step_bps: u16,
    pub scheduler_expiration_duration: u32,
    pub reduction_factor: u64,
}

#[derive(AnchorSerialize, Clone, Copy, Debug, Default)]
pub struct CurvePoint {
    pub sqrt_price: u128,
    pub liquidity: u128,
}

#[derive(AnchorSerialize, Clone, Debug, Default)]
pub struct ConfigParameters {
    pub base_fee: BaseFeeParameters,
    /// Option<DynamicFeeParameters> — always None for FUMPAD.
    pub dynamic_fee_none: u8,
    pub collect_fee_mode: u8,
    pub migration_option: u8,
    pub activation_type: u8,
    pub token_type: u8,
    pub token_decimal: u8,
    pub partner_liquidity_percentage: u8,
    pub partner_permanent_locked_liquidity_percentage: u8,
    pub creator_liquidity_percentage: u8,
    pub creator_permanent_locked_liquidity_percentage: u8,
    pub migration_quote_threshold: u64,
    pub sqrt_start_price: u128,
    pub locked_vesting: LockedVestingParams,
    pub migration_fee_option: u8,
    pub token_supply: Option<TokenSupplyParams>,
    pub creator_trading_fee_percentage: u8,
    pub token_update_authority: u8,
    pub migration_fee_percentage: u8,
    pub creator_migration_fee_percentage: u8,
    pub migrated_collect_fee_mode: u8,
    pub migrated_dynamic_fee: u8,
    pub migrated_pool_fee_bps: u16,
    pub pool_creation_fee: u64,
    pub partner_liquidity_vesting_info: LiquidityVestingInfoParams,
    pub creator_liquidity_vesting_info: LiquidityVestingInfoParams,
    pub migrated_pool_base_fee_mode: u8,
    pub migrated_pool_market_cap_fee_scheduler_params: MarketCapFeeSchedulerParams,
    pub enable_first_swap_with_min_fee: bool,
    pub compounding_fee_bps: u16,
    pub padding: [u8; 2],
    pub curve: Vec<CurvePoint>,
}

/// D33 fee scheduler: 99% → 1.25% linear over 8 periods of 1 slot (SDK: cliff 990,000,000, reduction 122,187,500).
pub const SNIPE_CLIFF_FEE_NUMERATOR: u64 = 990_000_000;
pub const SNIPE_REDUCTION: u64 = 122_187_500;
pub const SNIPE_PERIODS: u16 = 8;
/// D34: DBC's migration fee is an integer percentage → 1% of the raise to the partner (0.85 SOL at 85 SOL).
pub const MIGRATION_FEE_PERCENTAGE: u8 = 1;
pub const TOTAL_SUPPLY: u64 = 1_000_000_000_000_000;
/// D35: exactly 8% of supply to the reward pool.
pub const REWARD_POOL_TOKENS: u64 = 80_000_000_000_000;


/// FUMPAD-shaped config params (D30–D36) for a single constant-liquidity segment `[sqrt_start, sqrt_end]` with
/// liquidity `liquidity`, plus the buffer segment up to MAX_SQRT_PRICE DBC's fixed-supply check needs.
pub fn fumpad_config_params(
    threshold: u64,
    sqrt_start: u128,
    sqrt_end: u128,
    liquidity: u128,
    buffer_liquidity: u128,
) -> ConfigParameters {
    ConfigParameters {
        base_fee: BaseFeeParameters {
            cliff_fee_numerator: SNIPE_CLIFF_FEE_NUMERATOR,
            first_factor: SNIPE_PERIODS,
            second_factor: 1,
            third_factor: SNIPE_REDUCTION,
            base_fee_mode: 0,
        },
        dynamic_fee_none: 0,
        collect_fee_mode: 0,
        migration_option: 1,
        activation_type: 0,
        token_type: 1,
        token_decimal: 6,
        partner_liquidity_percentage: 0,
        partner_permanent_locked_liquidity_percentage: 100,
        creator_liquidity_percentage: 0,
        creator_permanent_locked_liquidity_percentage: 0,
        migration_quote_threshold: threshold,
        sqrt_start_price: sqrt_start,
        locked_vesting: LockedVestingParams::default(),
        migration_fee_option: 6,
        token_supply: Some(TokenSupplyParams { pre_migration_token_supply: TOTAL_SUPPLY, post_migration_token_supply: TOTAL_SUPPLY }),
        creator_trading_fee_percentage: 0,
        token_update_authority: 1,
        migration_fee_percentage: MIGRATION_FEE_PERCENTAGE,
        creator_migration_fee_percentage: 0,
        migrated_collect_fee_mode: 0,
        migrated_dynamic_fee: 0,
        migrated_pool_fee_bps: 125,
        pool_creation_fee: 0,
        partner_liquidity_vesting_info: LiquidityVestingInfoParams::default(),
        creator_liquidity_vesting_info: LiquidityVestingInfoParams::default(),
        migrated_pool_base_fee_mode: 0,
        migrated_pool_market_cap_fee_scheduler_params: MarketCapFeeSchedulerParams::default(),
        enable_first_swap_with_min_fee: true,
        compounding_fee_bps: 0,
        padding: [0; 2],
        curve: vec![
            CurvePoint { sqrt_price: sqrt_end, liquidity },
            CurvePoint { sqrt_price: MAX_SQRT_PRICE, liquidity: buffer_liquidity },
        ],
    }
}

pub const MAX_SQRT_PRICE: u128 = 79_226_673_521_066_979_257_578_248_091;

/// Mainnet curve (85 SOL raise, 1% migration fee) — derived by `config_tests::derive_exact_curves` so that the
/// reward pool (DBC leftover after the real DAMM v2 migration, incl. its deposit rounding dust) is exactly 8%.
pub const MAINNET_THRESHOLD: u64 = 85_000_000_000;
pub const MAINNET_SQRT_START: u128 = MAINNET_CURVE.0;
pub const MAINNET_SQRT_END: u128 = MAINNET_CURVE.1;
pub const MAINNET_LIQUIDITY: u128 = MAINNET_CURVE.2;
pub const MAINNET_BUFFER_LIQUIDITY: u128 = MAINNET_CURVE.3;
pub const MAINNET_CURVE: (u128, u128, u128, u128) =
    (101585640748934272, 389412012282537600, 100491279145714397187999104294912, 11682360368476127917215055872000);

/// Devnet curve (0.85 SOL raise), same shape.
pub const DEVNET_THRESHOLD: u64 = 850_000_000;
pub const DEVNET_CURVE: (u128, u128, u128, u128) =
    (10158564074893426, 38941201228253744, 10049127684724736583391138941440, 1168236036847612369509040521216);

pub fn mainnet_config_params() -> ConfigParameters {
    let (s0, s1, l, lb) = MAINNET_CURVE;
    fumpad_config_params(MAINNET_THRESHOLD, s0, s1, l, lb)
}

pub fn devnet_config_params() -> ConfigParameters {
    let (s0, s1, l, lb) = DEVNET_CURVE;
    fumpad_config_params(DEVNET_THRESHOLD, s0, s1, l, lb)
}

// ── DBC instructions ────────────────────────────────────────────────────────
pub fn dbc_event_authority() -> Pubkey {
    m::DBC_EVENT_AUTHORITY
}

pub fn dbc_pool_pda(config: &Pubkey, mint: &Pubkey) -> Pubkey {
    let (hi, lo) = if mint.to_bytes() > WSOL.to_bytes() { (mint, &WSOL) } else { (&WSOL, mint) };
    Pubkey::find_program_address(&[b"pool", config.as_ref(), hi.as_ref(), lo.as_ref()], &DBC).0
}

pub fn dbc_vault(mint: &Pubkey, pool: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"token_vault", mint.as_ref(), pool.as_ref()], &DBC).0
}

pub fn create_config_ix(
    config: &Pubkey,
    fee_claimer: &Pubkey,
    leftover_receiver: &Pubkey,
    payer: &Pubkey,
    params: &ConfigParameters,
) -> Instruction {
    let mut data = IX_CREATE_CONFIG.to_vec();
    params.serialize(&mut data).unwrap();
    raw_ix(
        &DBC,
        &[
            sgw(*config),
            ro(*fee_claimer),
            ro(*leftover_receiver),
            ro(WSOL),
            sgw(*payer),
            ro(SYSTEM),
            ro(dbc_event_authority()),
            ro(DBC),
        ],
        data,
    )
}

pub fn init_pool_ix(config: &Pubkey, creator: &Pubkey, mint: &Pubkey, payer: &Pubkey, name: &str, symbol: &str, uri: &str) -> Instruction {
    let pool = dbc_pool_pda(config, mint);
    let mut data = IX_INIT_POOL_T22.to_vec();
    (name.to_string(), symbol.to_string(), uri.to_string()).serialize(&mut data).unwrap();
    raw_ix(
        &DBC,
        &[
            ro(*config),
            ro(m::DBC_POOL_AUTHORITY),
            sg(*creator),
            sgw(*mint),
            ro(WSOL),
            rw(pool),
            rw(dbc_vault(mint, &pool)),
            rw(dbc_vault(&WSOL, &pool)),
            sgw(*payer),
            ro(SPL_TOKEN),
            ro(TOKEN_2022),
            ro(SYSTEM),
            ro(dbc_event_authority()),
            ro(DBC),
        ],
        data,
    )
}

/// DBC `swap2` accounts (15, + the instructions sysvar when `ix_sysvar`).
pub fn dbc_swap_accounts(config: &Pubkey, mint: &Pubkey, payer: &Pubkey, input: &Pubkey, output: &Pubkey, ix_sysvar: bool) -> Vec<AccountMeta> {
    let pool = dbc_pool_pda(config, mint);
    let mut v = vec![
        ro(m::DBC_POOL_AUTHORITY),
        ro(*config),
        rw(pool),
        rw(*input),
        rw(*output),
        rw(dbc_vault(mint, &pool)),
        rw(dbc_vault(&WSOL, &pool)),
        ro(*mint),
        ro(WSOL),
        sg(*payer),
        ro(TOKEN_2022),
        ro(SPL_TOKEN),
        ro(DBC),
        ro(dbc_event_authority()),
        ro(DBC),
    ];
    if ix_sysvar {
        v.push(ro(IX_SYSVAR));
    }
    v
}

pub fn swap2_data(amount_0: u64, amount_1: u64, mode: u8) -> Vec<u8> {
    m::swap2_data(amount_0, amount_1, mode)
}

/// Direct (top-level) DBC buy by `owner` (WSOL ATA → base ATA).
pub fn dbc_buy_ix(config: &Pubkey, mint: &Pubkey, owner: &Pubkey, lamports: u64, min_out: u64, mode: u8, ix_sysvar: bool) -> Instruction {
    let accs = dbc_swap_accounts(config, mint, owner, &wsol_ata(owner), &base_ata(owner, mint), ix_sysvar);
    raw_ix(&DBC, &accs, swap2_data(lamports, min_out, mode))
}

pub fn dbc_sell_ix(config: &Pubkey, mint: &Pubkey, owner: &Pubkey, tokens: u64, min_out: u64) -> Instruction {
    let accs = dbc_swap_accounts(config, mint, owner, &base_ata(owner, mint), &wsol_ata(owner), false);
    raw_ix(&DBC, &accs, swap2_data(tokens, min_out, 0))
}

/// DBC `migration_damm_v2` accounts (26, DBC order, DAMM v2 config last).
pub fn migration_accounts(config: &Pubkey, mint: &Pubkey, nft_mint: &Pubkey, payer: &Pubkey) -> Vec<AccountMeta> {
    let pool = dbc_pool_pda(config, mint);
    let damm_pool = damm_pool_pda(&DAMM_MIGRATION_CONFIG, mint);
    vec![
        rw(pool),
        ro(DBC), // migration_metadata (deprecated; any account)
        ro(*config),
        rw(m::DBC_POOL_AUTHORITY),
        rw(damm_pool),
        sgw(*nft_mint),
        rw(damm_position_nft_account(nft_mint)),
        rw(damm_position(nft_mint)),
        ro(DBC), // second_position_nft_mint = None
        ro(DBC),
        ro(DBC),
        ro(m::DAMM_POOL_AUTHORITY),
        ro(DAMM),
        rw(*mint),
        rw(WSOL),
        rw(damm_vault(mint, &damm_pool)),
        rw(damm_vault(&WSOL, &damm_pool)),
        rw(dbc_vault(mint, &pool)),
        rw(dbc_vault(&WSOL, &pool)),
        sgw(*payer),
        ro(TOKEN_2022),
        ro(SPL_TOKEN),
        ro(TOKEN_2022),
        ro(m::DAMM_EVENT_AUTHORITY),
        ro(SYSTEM),
        ro(DAMM_MIGRATION_CONFIG),
    ]
}

pub fn dbc_migration_ix(config: &Pubkey, mint: &Pubkey, nft_mint: &Pubkey, payer: &Pubkey) -> Instruction {
    raw_ix(&DBC, &migration_accounts(config, mint, nft_mint, payer), m::IX_DBC_MIGRATION_DAMM_V2.to_vec())
}

/// Direct DBC `withdraw_leftover` (permissionless).
pub fn dbc_withdraw_leftover_ix(config: &Pubkey, mint: &Pubkey, reward_pool: &Pubkey) -> Instruction {
    let pool = dbc_pool_pda(config, mint);
    raw_ix(
        &DBC,
        &[
            ro(m::DBC_POOL_AUTHORITY),
            ro(*config),
            rw(pool),
            rw(base_ata(reward_pool, mint)),
            rw(dbc_vault(mint, &pool)),
            ro(*mint),
            ro(*reward_pool),
            ro(TOKEN_2022),
            ro(dbc_event_authority()),
            ro(DBC),
        ],
        m::IX_DBC_WITHDRAW_LEFTOVER.to_vec(),
    )
}

// ── DAMM v2 ─────────────────────────────────────────────────────────────────
pub fn damm_pool_pda(config: &Pubkey, mint: &Pubkey) -> Pubkey {
    m::damm_pool_address(config, mint, &WSOL)
}
pub fn damm_vault(mint: &Pubkey, pool: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"token_vault", mint.as_ref(), pool.as_ref()], &DAMM).0
}
pub fn damm_position(nft_mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"position", nft_mint.as_ref()], &DAMM).0
}
pub fn damm_position_nft_account(nft_mint: &Pubkey) -> Pubkey {
    m::damm_position_nft_account(nft_mint)
}

/// DAMM v2 `swap2` accounts (14).
pub fn damm_swap_accounts(pool: &Pubkey, mint: &Pubkey, payer: &Pubkey, input: &Pubkey, output: &Pubkey) -> Vec<AccountMeta> {
    vec![
        ro(m::DAMM_POOL_AUTHORITY),
        rw(*pool),
        rw(*input),
        rw(*output),
        rw(damm_vault(mint, pool)),
        rw(damm_vault(&WSOL, pool)),
        ro(*mint),
        ro(WSOL),
        sg(*payer),
        ro(TOKEN_2022),
        ro(SPL_TOKEN),
        ro(DAMM),
        ro(m::DAMM_EVENT_AUTHORITY),
        ro(DAMM),
    ]
}

pub fn damm_buy_ix(pool: &Pubkey, mint: &Pubkey, owner: &Pubkey, lamports: u64, min_out: u64) -> Instruction {
    raw_ix(&DAMM, &damm_swap_accounts(pool, mint, owner, &wsol_ata(owner), &base_ata(owner, mint)), swap2_data(lamports, min_out, 0))
}

pub fn damm_sell_ix(pool: &Pubkey, mint: &Pubkey, owner: &Pubkey, tokens: u64, min_out: u64) -> Instruction {
    raw_ix(&DAMM, &damm_swap_accounts(pool, mint, owner, &base_ata(owner, mint), &wsol_ata(owner)), swap2_data(tokens, min_out, 0))
}

// ── SPL helpers ─────────────────────────────────────────────────────────────
pub fn create_ata_idempotent_ix(payer: &Pubkey, owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Instruction {
    raw_ix(
        &ATA_PROGRAM,
        &[sgw(*payer), rw(crate::ata(owner, mint, token_program)), ro(*owner), ro(*mint), ro(SYSTEM), ro(*token_program)],
        vec![1],
    )
}

pub fn system_transfer_ix(from: &Pubkey, to: &Pubkey, lamports: u64) -> Instruction {
    let mut data = vec![2, 0, 0, 0];
    data.extend_from_slice(&lamports.to_le_bytes());
    raw_ix(&SYSTEM, &[sgw(*from), rw(*to)], data)
}

pub fn sync_native_ix(account: &Pubkey) -> Instruction {
    raw_ix(&SPL_TOKEN, &[rw(*account)], vec![17])
}

/// Create (idempotent) + fund the owner's WSOL ATA with `lamports`.
pub fn wrap_sol_ixs(owner: &Pubkey, lamports: u64) -> Vec<Instruction> {
    let w = wsol_ata(owner);
    vec![create_ata_idempotent_ix(owner, owner, &WSOL, &SPL_TOKEN), system_transfer_ix(owner, &w, lamports), sync_native_ix(&w)]
}

// ── readers ─────────────────────────────────────────────────────────────────
pub fn rd_u64(d: &[u8], off: usize) -> u64 {
    m::rd_u64(d, off)
}
pub fn rd_u128(d: &[u8], off: usize) -> u128 {
    m::rd_u128(d, off)
}
pub fn rd_pk(d: &[u8], off: usize) -> Pubkey {
    m::rd_pubkey(d, off)
}
