/// `emit_event!(ctx, Event { .. })`: same event self-CPI as Anchor's `emit_cpi!(Event { .. })`
/// (same bytes, accounts and signer), routed through `events::emit_cpi_data` so the CPI code
/// exists once instead of at all ~30 call sites (program size).
macro_rules! emit_event {
    ($ctx:ident, $event:expr) => {
        $crate::events::emit_cpi_data(&$ctx.accounts.event_authority, anchor_lang::Event::data(&$event))?
    };
}

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

declare_id!("ASVE6Nk8T1c2Uv81vjPeNDnX54nHGWg98G1afYt2j8Cv");

#[program]
pub mod fumpad {
    use super::*;

    // ── admin ───────────────────────────────────────────────────────────────
    pub fn initialize_global(
        ctx: Context<InitializeGlobal>,
        admin: Pubkey,
        platform_treasury: Pubkey,
        params: Params,
    ) -> Result<()> {
        instructions::handle_initialize_global(ctx, admin, platform_treasury, params)
    }

    /// D15: queue a params change; `execute_params` applies it after 48h.
    pub fn queue_params(ctx: Context<QueueParams>, params: Params) -> Result<()> {
        instructions::handle_queue_params(ctx, params)
    }

    pub fn execute_params(ctx: Context<ExecuteParams>) -> Result<()> {
        instructions::handle_execute_params(ctx)
    }

    /// M-2: admin or guardian.
    pub fn cancel_params(ctx: Context<GuardianOrAdmin>) -> Result<()> {
        instructions::handle_cancel_params(ctx)
    }

    /// Grow a Global written by an older program version to the current layout (admin; pays
    /// the extra rent). Fills only newly appended params from `args`; no-op when current.
    pub fn migrate_global(ctx: Context<MigrateGlobal>, args: MigrateGlobalArgs) -> Result<()> {
        instructions::handle_migrate_global(ctx, args)
    }

    /// M-2 / M-3: admin or guardian; flags lapse after 7 days unless renewed.
    pub fn set_pause(ctx: Context<GuardianOrAdmin>, paused: u8) -> Result<()> {
        instructions::handle_set_pause(ctx, paused)
    }

    pub fn set_keepers(ctx: Context<AdminOnly>, keepers: [Pubkey; MAX_KEEPERS]) -> Result<()> {
        instructions::handle_set_keepers(ctx, keepers)
    }

    /// M-2 (replaces `set_admin`): propose a new admin / treasury / guardian; the new admin
    /// applies it with `accept_admin` after 48h; the guardian or admin can `cancel_admin`.
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

    // ── curve / launch / graduation ─────────────────────────────────────────
    pub fn create_coin(ctx: Context<CreateCoin>, name: String, symbol: String, uri: String) -> Result<()> {
        instructions::handle_create_coin(ctx, name, symbol, uri)
    }

    pub fn buy<'info>(ctx: Context<'info, Buy<'info>>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
        instructions::handle_buy(ctx, sol_in, min_tokens_out)
    }

    pub fn sell<'info>(ctx: Context<'info, Sell<'info>>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
        instructions::handle_sell(ctx, tokens_in, min_sol_out)
    }

    pub fn graduate<'info>(ctx: Context<'info, Graduate<'info>>) -> Result<()> {
        instructions::handle_graduate(ctx)
    }

    // ── rewards ─────────────────────────────────────────────────────────────
    pub fn register_holdings(ctx: Context<RegisterHoldings>) -> Result<()> {
        instructions::handle_register_holdings(ctx)
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        instructions::handle_claim(ctx)
    }

    pub fn process_queue<'info>(ctx: Context<'info, ProcessQueue<'info>>, max_entries: u8) -> Result<()> {
        instructions::handle_process_queue(ctx, max_entries)
    }

    pub fn close_ticket(ctx: Context<CloseTicket>) -> Result<()> {
        instructions::handle_close_ticket(ctx)
    }

    pub fn withdraw_creator_fees(ctx: Context<WithdrawCreatorFees>) -> Result<()> {
        instructions::handle_withdraw_creator_fees(ctx)
    }

    pub fn withdraw_platform_fees(ctx: Context<WithdrawPlatformFees>) -> Result<()> {
        instructions::handle_withdraw_platform_fees(ctx)
    }

    pub fn init_claim_queue(ctx: Context<InitClaimQueue>) -> Result<()> {
        instructions::handle_init_claim_queue(ctx)
    }

    /// D16: move an escrowed queue payout to the owner's token account of choice.
    pub fn withdraw_escrow(ctx: Context<WithdrawEscrow>) -> Result<()> {
        instructions::handle_withdraw_escrow(ctx)
    }

    /// D17 auto-claim: a keeper claims a ticket for its owner (payout to the owner's
    /// canonical ATA, or its escrow). Same rules as `claim`; owner may opt out.
    pub fn claim_for(ctx: Context<ClaimFor>) -> Result<()> {
        instructions::handle_claim_for(ctx)
    }

    /// D17: the position's wallet opts out of / back into keeper auto-claim for this coin.
    pub fn set_auto_claim(ctx: Context<SetAutoClaim>, enabled: bool) -> Result<()> {
        instructions::handle_set_auto_claim(ctx, enabled)
    }

    // ── venue: router, oracle, buyback ──────────────────────────────────────
    pub fn swap_buy<'info>(ctx: Context<'info, SwapBuy<'info>>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
        instructions::handle_swap_buy(ctx, sol_in, min_tokens_out)
    }

    pub fn swap_sell<'info>(ctx: Context<'info, SwapSell<'info>>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
        instructions::handle_swap_sell(ctx, tokens_in, min_sol_out)
    }

    pub fn execute_buyback<'info>(ctx: Context<'info, ExecuteBuyback<'info>>, max_lamports: u64) -> Result<()> {
        instructions::handle_execute_buyback(ctx, max_lamports)
    }

    pub fn init_observations(ctx: Context<InitObservations>) -> Result<()> {
        instructions::handle_init_observations(ctx)
    }

    pub fn record_samples<'info>(ctx: Context<'info, RecordSamples<'info>>) -> Result<()> {
        instructions::handle_record_samples(ctx)
    }

    /// D11: unwrap LP fees skimmed by `fumpad_lp_locker` into the Coin's fee counters.
    pub fn settle_lp_fees(ctx: Context<SettleLpFees>) -> Result<()> {
        instructions::handle_settle_lp_fees(ctx)
    }
}
