use anchor_lang::{
    prelude::*,
    solana_program::{instruction::Instruction, program::invoke_signed},
};

use crate::constants::MAX_KEEPERS;
use crate::state::Params;

// Every state change emits an event via `emit_event!(ctx, Event { .. })` (needs `#[event_cpi]`). The indexer treats
// these as the source of truth. Field lists: INTERFACE-v0.7.md §6.

/// The self-CPI behind `emit_event!`: byte-for-byte what Anchor's `emit_cpi!` sends, one shared copy (size).
#[inline(never)]
pub fn emit_cpi_data(event_authority: &AccountInfo, data: Vec<u8>) -> Result<()> {
    let tag = anchor_lang::event::EVENT_IX_TAG_LE;
    let mut ix_data = Vec::with_capacity(tag.len() + data.len());
    ix_data.extend_from_slice(tag);
    ix_data.extend_from_slice(&data);
    let ix = Instruction::new_with_bytes(crate::ID, &ix_data, vec![AccountMeta::new_readonly(*event_authority.key, true)]);
    invoke_signed(&ix, &[event_authority.clone()], &[&[b"__event_authority", &[crate::EVENT_AUTHORITY_AND_BUMP.1]]])
        .map_err(anchor_lang::error::Error::from)
}

// ── governance ──────────────────────────────────────────────────────────────
#[event]
pub struct GlobalInitialized {
    pub admin: Pubkey,
    pub platform_treasury: Pubkey,
    pub guardian: Pubkey,
    pub cluster_tag: u8,
    pub params: Params,
    pub ts: i64,
}

#[event]
pub struct ParamsQueued {
    pub params: Params,
    pub eta: i64,
    pub ts: i64,
}

#[event]
pub struct ParamsUpdated {
    pub params: Params,
    pub ts: i64,
}

#[event]
pub struct ParamsCancelled {
    pub authority: Pubkey,
    pub ts: i64,
}

#[event]
pub struct PauseSet {
    pub paused: u8,
    pub expires_at: i64,
    pub authority: Pubkey,
    pub ts: i64,
}

#[event]
pub struct KeepersSet {
    pub keepers: [Pubkey; MAX_KEEPERS],
    pub added_at: [i64; MAX_KEEPERS],
    pub ts: i64,
}

#[event]
pub struct AdminProposed {
    pub admin: Pubkey,
    pub platform_treasury: Pubkey,
    pub guardian: Pubkey,
    pub eta: i64,
    pub ts: i64,
}

#[event]
pub struct AdminAccepted {
    pub previous_admin: Pubkey,
    pub admin: Pubkey,
    pub platform_treasury: Pubkey,
    pub guardian: Pubkey,
    pub ts: i64,
}

#[event]
pub struct AdminProposalCancelled {
    pub authority: Pubkey,
    pub ts: i64,
}

#[event]
pub struct ConfigQueued {
    pub config: Pubkey,
    pub add: bool,
    pub eta: i64,
    pub ts: i64,
}

#[event]
pub struct ConfigUpdated {
    pub config: Pubkey,
    pub add: bool,
    pub ts: i64,
}

#[event]
pub struct ConfigCancelled {
    pub config: Pubkey,
    pub authority: Pubkey,
    pub ts: i64,
}

#[event]
pub struct GlobalMigrated {
    pub old_len: u32,
    pub new_len: u32,
    pub ts: i64,
}

// ── coins, trading, fees ────────────────────────────────────────────────────
#[event]
pub struct CoinRegistered {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub dbc_pool: Pubkey,
    pub dbc_config: Pubkey,
    pub launch_slot: u64,
    pub launch_window_slots: u64,
    pub ts: i64,
}

/// A router trade. buy: `quote_gross` = WSOL spent (fee included); sell: WSOL received + fee. `fee` = Meteora
/// trading + protocol fee of the swap (pool counters).
#[event]
pub struct RoutedTrade {
    pub mint: Pubkey,
    pub trader: Pubkey,
    pub venue: u8,
    pub is_buy: bool,
    pub base_amount: u64,
    pub quote_gross: u64,
    pub fee: u64,
    pub pre_sqrt_price: u128,
    pub post_sqrt_price: u128,
    pub slot: u64,
    pub ts: i64,
}

#[event]
pub struct CurveCompleted {
    pub mint: Pubkey,
    pub dbc_pool: Pubkey,
    pub ts: i64,
}

#[event]
pub struct FeesClaimed {
    pub mint: Pubkey,
    pub venue: u8,
    pub claimed: u64,
    pub to_buyback: u64,
    pub to_platform: u64,
    pub to_creator: u64,
    pub launch_window: bool,
    pub ts: i64,
}

#[event]
pub struct FeesWithdrawn {
    pub mint: Pubkey,
    pub recipient: Pubkey,
    pub lamports: u64,
    pub creator: bool,
    pub ts: i64,
}

#[event]
pub struct BuybackExecuted {
    pub mint: Pubkey,
    pub venue: u8,
    pub lamports_in: u64,
    pub tokens_out: u64,
    pub guard_price_q64: u128,
    pub spot_price_q64: u128,
    pub ts: i64,
}

#[event]
pub struct PoolMigrated {
    pub mint: Pubkey,
    pub damm_pool: Pubkey,
    pub migrator: Pubkey,
    pub cost: u64,
    pub ts: i64,
}

#[event]
pub struct Graduated {
    pub mint: Pubkey,
    pub damm_pool: Pubkey,
    pub damm_position: Pubkey,
    pub leftover_tokens: u64,
    pub migration_fee: u64,
    pub surplus: u64,
    pub migrator_refund: u64,
    pub caller_refund: u64,
    pub setup_prefunded: u64,
    pub platform_fee: u64,
    pub ts: i64,
}

#[event]
pub struct SampleRecorded {
    pub mint: Pubkey,
    pub venue: u8,
    pub price_q64: u128,
    pub fallback: bool,
    pub ts: i64,
}

// ── tickets ─────────────────────────────────────────────────────────────────
#[event]
pub struct TicketAttested {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub ticket: Pubkey,
    pub seq: u64,
    pub pool: Pubkey,
    pub venue: u8,
    pub source: u8,
    pub signature: [u8; 64],
    pub ix_key: u32,
    pub base_amount: u64,
    pub quote_gross: u64,
    pub tokens: u64,
    pub sell_price_q64: u128,
    pub sell_usd_cents: u64,
    pub pyth_publish_time: i64,
    pub slot: u64,
    pub sell_ts: i64,
    pub keepers: [Pubkey; 2],
    pub submitter: Pubkey,
    pub ts: i64,
}

#[event]
pub struct TicketDebited {
    pub ticket: Pubkey,
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub signature: [u8; 64],
    pub ix_key: u32,
    pub debited: u64,
    pub remaining: u64,
    pub voided: bool,
    pub ts: i64,
}

#[event]
pub struct TicketVoided {
    pub ticket: Pubkey,
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub reason: u8,
    pub authority: Pubkey,
    pub ts: i64,
}

#[event]
pub struct ConsumedClosed {
    pub consumed: Pubkey,
    pub ticket: Pubkey,
    pub rent_payer: Pubkey,
    pub ts: i64,
}

// ── claims ──────────────────────────────────────────────────────────────────
#[event]
pub struct ClaimQueued {
    pub mint: Pubkey,
    pub ticket: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub queue_len: u16,
    pub ts: i64,
    pub triggered_by: Pubkey,
}

#[event]
pub struct ClaimPaid {
    pub mint: Pubkey,
    pub ticket: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub from_queue: bool,
    pub median_price_q64: u128,
    pub ts: i64,
    pub triggered_by: Pubkey,
}

#[event]
pub struct ClaimEscrowed {
    pub mint: Pubkey,
    pub ticket: Pubkey,
    pub owner: Pubkey,
    pub escrow: Pubkey,
    pub amount: u64,
    pub ts: i64,
    pub triggered_by: Pubkey,
}

#[event]
pub struct EscrowWithdrawn {
    pub mint: Pubkey,
    pub ticket: Pubkey,
    pub owner: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
    pub ts: i64,
}

#[event]
pub struct TicketClosed {
    pub ticket: Pubkey,
    pub owner: Pubkey,
    pub final_status: u8,
    pub rent_payer: Pubkey,
    pub ts: i64,
}

#[event]
pub struct PositionClosed {
    pub mint: Pubkey,
    pub wallet: Pubkey,
    pub ts: i64,
}

#[event]
pub struct AutoClaimSet {
    pub mint: Pubkey,
    pub wallet: Pubkey,
    pub enabled: bool,
    pub ts: i64,
}
