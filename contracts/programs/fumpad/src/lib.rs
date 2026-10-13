/// `emit_event!(ctx, Event { .. })`: same event self-CPI as Anchor's `emit_cpi!(Event { .. })`, routed through one
/// shared `events::emit_cpi_data` (program size).
macro_rules! emit_event {
    ($ctx:ident, $event:expr) => {
        $crate::events::emit_cpi_data(&$ctx.accounts.event_authority, anchor_lang::Event::data(&$event))?
    };
}

pub mod attestation;
pub mod constants;
pub mod error;
pub mod events;
pub mod external;
pub mod instructions;
pub mod math;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("5YMFbHZsEaebs1Ac9P8bPe3nfh1oxbemVRcLBAcxS9Fb");

/// FUMPAD v0.7 — Meteora DBC (curve) → DAMM v2 (pool); tickets by 2-of-3 keeper attestation. INTERFACE-v0.7.md.
#[program]
pub mod fumpad {
    use super::*;

    // ── admin / governance ──────────────────────────────────────────────────
    pub fn initialize_global(
        ctx: Context<InitializeGlobal>,
        admin: Pubkey,
        platform_treasury: Pubkey,
        cluster_tag: u8,
        params: Params,
    ) -> Result<()> {
        instructions::handle_initialize_global(ctx, admin, platform_treasury, cluster_tag, params)
    }

    pub fn queue_params(ctx: Context<AdminOnly>, params: Params) -> Result<()> {
        instructions::handle_queue_params(ctx, params)
    }

    pub fn execute_params(ctx: Context<PermissionlessGlobal>) -> Result<()> {
        instructions::handle_execute_params(ctx)
    }

    pub fn cancel_params(ctx: Context<GuardianOrAdmin>) -> Result<()> {
        instructions::handle_cancel_params(ctx)
    }

    pub fn set_pause(ctx: Context<GuardianOrAdmin>, paused: u8) -> Result<()> {
        instructions::handle_set_pause(ctx, paused)
    }

    pub fn set_keepers(ctx: Context<AdminOnly>, keepers: [Pubkey; MAX_KEEPERS]) -> Result<()> {
        instructions::handle_set_keepers(ctx, keepers)
    }

    pub fn propose_admin(
        ctx: Context<AdminOnly>,
        new_admin: Pubkey,
        platform_treasury: Pubkey,
        guardian: Pubkey,
    ) -> Result<()> {
        instructions::handle_propose_admin(ctx, new_admin, platform_treasury, guardian)
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::handle_accept_admin(ctx)
    }

    pub fn cancel_admin(ctx: Context<GuardianOrAdmin>) -> Result<()> {
        instructions::handle_cancel_admin(ctx)
    }

    pub fn queue_config(ctx: Context<QueueConfig>, config: Pubkey, add: bool) -> Result<()> {
        instructions::handle_queue_config(ctx, config, add)
    }

    pub fn execute_config(ctx: Context<ExecuteConfig>) -> Result<()> {
        instructions::handle_execute_config(ctx)
    }

    pub fn cancel_config(ctx: Context<GuardianOrAdmin>) -> Result<()> {
        instructions::handle_cancel_config(ctx)
    }

    pub fn migrate_global(ctx: Context<MigrateGlobal>) -> Result<()> {
        instructions::handle_migrate_global(ctx)
    }

    // ── launch ──────────────────────────────────────────────────────────────
    pub fn register_coin(ctx: Context<RegisterCoin>) -> Result<()> {
        instructions::handle_register_coin(ctx)
    }

    // ── router ──────────────────────────────────────────────────────────────
    pub fn buy<'info>(ctx: Context<'info, Route<'info>>, amount_in: u64, min_out: u64, mode: u8) -> Result<()> {
        instructions::handle_buy(ctx, amount_in, min_out, mode)
    }

    pub fn sell<'info>(ctx: Context<'info, Route<'info>>, amount_in: u64, min_out: u64) -> Result<()> {
        instructions::handle_sell(ctx, amount_in, min_out)
    }

    // ── fees / buyback ──────────────────────────────────────────────────────
    pub fn claim_fees(ctx: Context<ClaimFees>) -> Result<()> {
        instructions::handle_claim_fees(ctx)
    }

    pub fn claim_lp_fees(ctx: Context<ClaimLpFees>) -> Result<()> {
        instructions::handle_claim_lp_fees(ctx)
    }

    pub fn withdraw_creator_fees(ctx: Context<WithdrawCreatorFees>) -> Result<()> {
        instructions::handle_withdraw_creator_fees(ctx)
    }

    pub fn withdraw_platform_fees(ctx: Context<WithdrawPlatformFees>) -> Result<()> {
        instructions::handle_withdraw_platform_fees(ctx)
    }

    pub fn execute_buyback<'info>(ctx: Context<'info, ExecuteBuyback<'info>>, max_in: u64) -> Result<()> {
        instructions::handle_execute_buyback(ctx, max_in)
    }

    // ── graduation ──────────────────────────────────────────────────────────
    pub fn migrate_pool<'info>(ctx: Context<'info, MigratePool<'info>>) -> Result<()> {
        instructions::handle_migrate_pool(ctx)
    }

    pub fn graduate(ctx: Context<Graduate>) -> Result<()> {
        instructions::handle_graduate(ctx)
    }

    pub fn init_observations(ctx: Context<InitObservations>) -> Result<()> {
        instructions::handle_init_observations(ctx)
    }

    pub fn init_claim_queue(ctx: Context<InitClaimQueue>) -> Result<()> {
        instructions::handle_init_claim_queue(ctx)
    }

    // ── oracle ──────────────────────────────────────────────────────────────
    pub fn record_samples<'info>(ctx: Context<'info, RecordSamples<'info>>) -> Result<()> {
        instructions::handle_record_samples(ctx)
    }

    // ── tickets (D31) ───────────────────────────────────────────────────────
    pub fn attest_sell(ctx: Context<AttestSell>) -> Result<()> {
        instructions::handle_attest_sell(ctx)
    }

    pub fn attest_rebuy(ctx: Context<AttestRebuy>) -> Result<()> {
        instructions::handle_attest_rebuy(ctx)
    }

    pub fn void_ticket(ctx: Context<VoidTicket>, reason: u8, reopen: bool) -> Result<()> {
        instructions::handle_void_ticket(ctx, reason, reopen)
    }

    pub fn close_consumed(ctx: Context<CloseConsumed>) -> Result<()> {
        instructions::handle_close_consumed(ctx)
    }

    // ── claims ──────────────────────────────────────────────────────────────
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        instructions::handle_claim(ctx)
    }

    pub fn claim_for(ctx: Context<ClaimFor>) -> Result<()> {
        instructions::handle_claim_for(ctx)
    }

    pub fn process_queue<'info>(ctx: Context<'info, ProcessQueue<'info>>, max_entries: u8) -> Result<()> {
        instructions::handle_process_queue(ctx, max_entries)
    }

    pub fn withdraw_escrow(ctx: Context<WithdrawEscrow>) -> Result<()> {
        instructions::handle_withdraw_escrow(ctx)
    }

    pub fn set_auto_claim(ctx: Context<SetAutoClaim>, enabled: bool) -> Result<()> {
        instructions::handle_set_auto_claim(ctx, enabled)
    }

    pub fn close_ticket(ctx: Context<CloseTicket>) -> Result<()> {
        instructions::handle_close_ticket(ctx)
    }

    pub fn close_position(ctx: Context<ClosePosition>) -> Result<()> {
        instructions::handle_close_position(ctx)
    }
}
