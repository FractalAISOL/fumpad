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

    pub fn update_params(ctx: Context<AdminOnly>, params: Params) -> Result<()> {
        instructions::handle_update_params(ctx, params)
    }

    pub fn set_pause(ctx: Context<AdminOnly>, paused: u8) -> Result<()> {
        instructions::handle_set_pause(ctx, paused)
    }

    pub fn set_keepers(ctx: Context<AdminOnly>, keepers: [Pubkey; MAX_KEEPERS]) -> Result<()> {
        instructions::handle_set_keepers(ctx, keepers)
    }

    pub fn set_admin(ctx: Context<AdminOnly>, new_admin: Pubkey, platform_treasury: Pubkey) -> Result<()> {
        instructions::handle_set_admin(ctx, new_admin, platform_treasury)
    }

    // ── curve / launch / graduation ─────────────────────────────────────────
    pub fn create_coin(ctx: Context<CreateCoin>, name: String, symbol: String, uri: String) -> Result<()> {
        instructions::handle_create_coin(ctx, name, symbol, uri)
    }

    pub fn buy(ctx: Context<Buy>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
        instructions::handle_buy(ctx, sol_in, min_tokens_out)
    }

    pub fn sell(ctx: Context<Sell>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
        instructions::handle_sell(ctx, tokens_in, min_sol_out)
    }

    pub fn graduate(ctx: Context<Graduate>) -> Result<()> {
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

    // ── venue: router, oracle, buyback ──────────────────────────────────────
    pub fn swap_buy(ctx: Context<SwapBuy>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
        instructions::handle_swap_buy(ctx, sol_in, min_tokens_out)
    }

    pub fn swap_sell(ctx: Context<SwapSell>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
        instructions::handle_swap_sell(ctx, tokens_in, min_sol_out)
    }

    pub fn execute_buyback(ctx: Context<ExecuteBuyback>, max_lamports: u64) -> Result<()> {
        instructions::handle_execute_buyback(ctx, max_lamports)
    }

    pub fn init_observations(ctx: Context<InitObservations>) -> Result<()> {
        instructions::handle_init_observations(ctx)
    }

    pub fn record_samples(ctx: Context<RecordSamples>) -> Result<()> {
        instructions::handle_record_samples(ctx)
    }
}
