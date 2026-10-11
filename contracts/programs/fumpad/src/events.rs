use anchor_lang::prelude::*;

// Every state change emits an event via `emit_cpi!` (instructions using it need
// `#[event_cpi]` on their Accounts struct). The indexer treats these as the source of truth.

#[event]
pub struct CoinCreated {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub ts: i64,
}

#[event]
pub struct Trade {
    pub mint: Pubkey,
    pub user: Pubkey,
    pub is_buy: bool,
    /// false = bonding curve, true = PumpSwap via router.
    pub on_amm: bool,
    pub token_amount: u64,
    /// SOL side before FUMPAD's fee.
    pub sol_amount: u64,
    pub fee_pool: u64,
    pub fee_platform: u64,
    pub fee_creator: u64,
    /// Tokens bought into the reward pool by this trade (curve: inline buyback).
    pub pool_tokens_bought: u64,
    pub price_q64: u128,
    pub virtual_sol_reserves: u64,
    pub virtual_token_reserves: u64,
    pub ts: i64,
}

#[event]
pub struct CurveCompleted {
    pub mint: Pubkey,
    pub ts: i64,
}

#[event]
pub struct Graduated {
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub sol_deposited: u64,
    pub tokens_deposited: u64,
    /// LP tokens moved into the immutable `fumpad_lp_locker` (D11).
    pub lp_locked: u64,
    pub ts: i64,
}

/// D11: skimmed LP-fee SOL unwrapped from ATA(coin, WSOL) and credited to the Coin.
/// (The skim itself — LP withdrawn, base tokens sent to the reward vault — is logged by
/// the locker's own `Skimmed` event.)
#[event]
pub struct LpFeesSettled {
    pub mint: Pubkey,
    pub lamports: u64,
    pub platform: u64,
    pub creator: u64,
    pub ts: i64,
}

#[event]
pub struct TicketCreated {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub ticket: Pubkey,
    pub tokens: u64,
    pub sell_price_q64: u128,
    pub sell_usd_cents: u64,
    pub ts: i64,
}

#[event]
pub struct TicketDebited {
    pub ticket: Pubkey,
    pub debited: u64,
    pub remaining: u64,
    pub voided: bool,
    pub ts: i64,
}

#[event]
pub struct ClaimQueued {
    pub mint: Pubkey,
    pub ticket: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub queue_len: u16,
    pub ts: i64,
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
}

#[event]
pub struct TicketClosed {
    pub ticket: Pubkey,
    pub owner: Pubkey,
    pub final_status: u8,
    pub ts: i64,
}

#[event]
pub struct SampleRecorded {
    pub mint: Pubkey,
    pub price_q64: u128,
    pub fallback: bool,
    pub ts: i64,
}

#[event]
pub struct BuybackExecuted {
    pub mint: Pubkey,
    pub lamports_in: u64,
    pub tokens_out: u64,
    pub ts: i64,
}

#[event]
pub struct FeesWithdrawn {
    pub mint: Pubkey,
    pub recipient: Pubkey,
    pub lamports: u64,
    /// true = creator fees, false = platform fees.
    pub creator: bool,
    pub ts: i64,
}

#[event]
pub struct HoldingsRegistered {
    pub mint: Pubkey,
    pub wallet: Pubkey,
    pub added: u64,
    pub ts: i64,
}

// ── v0.3 ────────────────────────────────────────────────────────────────────

/// D15: a params change was queued; `execute_params` may apply it from `eta`.
#[event]
pub struct ParamsQueued {
    pub params: crate::state::Params,
    pub eta: i64,
    pub ts: i64,
}

#[event]
pub struct ParamsUpdated {
    pub params: crate::state::Params,
    pub ts: i64,
}

#[event]
pub struct ParamsCancelled {
    pub ts: i64,
}

/// D13: a coin stuck in `Complete` for 7 days reopened its curve (escape hatch).
#[event]
pub struct CurveReopened {
    pub mint: Pubkey,
    pub completed_at: i64,
    pub ts: i64,
}

/// D16: a queued payout whose owner's ATA refuses transfers was paid into the ticket's
/// escrow token account (`["escrow", ticket]`); the owner withdraws it with `withdraw_escrow`.
#[event]
pub struct ClaimEscrowed {
    pub mint: Pubkey,
    pub ticket: Pubkey,
    pub owner: Pubkey,
    pub escrow: Pubkey,
    pub amount: u64,
    pub ts: i64,
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
