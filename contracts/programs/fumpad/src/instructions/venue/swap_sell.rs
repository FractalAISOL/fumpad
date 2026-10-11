//! Router sell on a graduated coin's PumpSwap pool. OWNER: venue/oracle module.
//!
//! Fee convention (same as the curve, pump.fun style): FUMPAD's fee is taken FROM the
//! proceeds. `min_sol_out` bounds the NET SOL the user keeps (gross − fee).
//!
//! WSOL: the user never unwraps. Proceeds land in the user's WSOL ATA (created if
//! needed), which the program closes afterwards, so they arrive as native SOL; the fee is
//! then transferred from the user's SOL into the Coin account. NOTE: closing unwraps the
//! WHOLE ATA (any WSOL already there comes back as SOL too; value-neutral).
//!
//! remaining_accounts = PumpSwap `sell_v2` accounts, in PumpSwap order (no tickets:
//! sells never need open tickets). The venue slice's `user` is this instruction's `user`,
//! `user_base_token_account` is `user_token_account`, `user_quote_token_account` is `user_wsol`.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::Token,
    token_2022::Token2022,
    token_interface::{Mint, TokenAccount},
};

use super::common::*;
use crate::math::reference::Touch;
use crate::{
    constants::*,
    error::FumpadError,
    events::Trade,
    external::pumpswap::{self, token_amount, VenueExpect, WSOL_MINT},
    instructions::rewards::hooks::{self, SellHookAccounts, SellInfo},
    math::{compute_fee, price_q64},
    state::*,
};

#[event_cpi]
#[derive(Accounts)]
pub struct SwapSell<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    #[account(
        mut,
        seeds = [COIN_SEED, mint.key().as_ref()],
        bump = coin.bump,
        has_one = mint @ FumpadError::InvalidAccount,
    )]
    pub coin: Box<Account<'info, Coin>>,
    #[account(mint::token_program = token_2022_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, mint.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub position: Box<Account<'info, Position>>,
    /// CHECK: ticket PDA ["ticket", mint, user, position.next_ticket_seq]; validated and
    /// created (only if the sell qualifies) by `hooks::on_sell`.
    #[account(mut)]
    pub ticket: UncheckedAccount<'info>,
    /// CHECK: Pyth PriceUpdateV2; owner/feed/staleness checked by `hooks::on_sell`.
    pub sol_usd_price: UncheckedAccount<'info>,
    /// R-L3: the user's canonical Token-2022 ATA (as on the curve): eligibility is capped by
    /// the balance FUMPAD observes, so a sell from a secondary account must not stand in for it.
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = wsol_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_wsol: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = WSOL_MINT @ FumpadError::InvalidAccount)]
    pub wsol_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: address-checked; the only program the router CPIs into.
    #[account(address = PUMPSWAP_PROGRAM_ID @ FumpadError::WrongVenue)]
    pub pumpswap_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_swap_sell<'info>(ctx: Context<'info, SwapSell<'info>>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let venue = ctx.remaining_accounts;
    let program_id = ctx.program_id;
    let a = &mut *ctx.accounts;

    require!(tokens_in > 0, FumpadError::ZeroAmount);
    require!(!a.global.is_paused(PAUSE_TRADE), FumpadError::Paused);
    require!(a.coin.status == CoinStatus::Graduated, FumpadError::WrongCoinStatus);

    let user_info = a.user.to_account_info();
    let token_acc_info = a.user_token_account.to_account_info();
    let wsol_info = a.user_wsol.to_account_info();
    let (pool, before) = pumpswap::validate_venue(
        venue,
        &VenueExpect {
            pool: a.coin.amm_pool,
            base_mint: a.mint.key(),
            user: user_info.key(),
            user_base: token_acc_info.key(),
            user_quote: wsol_info.key(),
        },
    )?;

    let balance_before = token_amount(&token_acc_info)?;
    let wsol_before = token_amount(&wsol_info)?;
    // PumpSwap's own floor is on gross; ours (below) is on net, which is stricter.
    pumpswap::cpi_sell(venue, &a.pumpswap_program.to_account_info(), tokens_in, min_sol_out)?;
    let tokens_sold = balance_before.checked_sub(token_amount(&token_acc_info)?).ok_or(FumpadError::MathOverflow)?;
    let gross = token_amount(&wsol_info)?.checked_sub(wsol_before).ok_or(FumpadError::MathOverflow)?;
    require!(tokens_sold > 0 && tokens_sold <= tokens_in, FumpadError::InvalidAccount);

    let fee = compute_fee(gross, &a.coin.fees).ok_or(FumpadError::MathOverflow)?;
    let net = gross.checked_sub(fee.total).ok_or(FumpadError::MathOverflow)?;
    require!(net >= min_sol_out, FumpadError::SlippageExceeded);

    // Proceeds → native SOL, then the fee → Coin account.
    let system_info = a.system_program.to_account_info();
    unwrap_wsol(&a.token_program.to_account_info(), &wsol_info, &user_info, &user_info)?;
    transfer_sol(&system_info, &user_info, &a.coin.to_account_info(), fee.total)?;
    accrue_fee(&mut a.coin, &fee)?;
    record_volume(&mut a.coin, gross);

    // D10: PumpSwap touch point (pre-trade effective spot, post-trade spot); the ticket
    // (if any) is floored at the updated average.
    let after = pumpswap::venue_reserves(venue, &pool)?;
    // A degenerate (empty-sided) pool has no spot: skip the update rather than fail the trade.
    let pre_spot = before.spot_price_q64().ok();
    if let (Some(pre), Ok(post)) = (pre_spot, after.spot_price_q64()) {
        a.coin.touch_reference(now, pre, post, Touch::Venue);
    }
    // D12: effective PumpSwap spot before the sell (0 = unknown → D10 floor).
    let pre_trade_spot_q64 = pre_spot.unwrap_or(0);
    let reference_price_q64 = a.coin.reference.avg_q64;

    let position_bump = ctx.bumps.position;
    a.position.init_if_new(user_info.key(), a.mint.key(), position_bump);
    let ticket_info = a.ticket.to_account_info();
    let price_info = a.sol_usd_price.to_account_info();
    let ticket = hooks::on_sell(
        SellHookAccounts {
            global: &a.global,
            coin: &a.coin,
            position: &mut a.position,
            ticket: &ticket_info,
            sol_usd_price: &price_info,
            seller: &user_info,
            system_program: &system_info,
            program_id,
            event_authority: &a.event_authority,
        },
        SellInfo { tokens_sold, gross_lamports_out: gross, balance_before, reference_price_q64, pre_trade_spot_q64, now },
    )?;
    if ticket.is_some() {
        a.coin.tickets_created = a.coin.tickets_created.saturating_add(1);
    }
    let ev = Trade {
        mint: a.mint.key(),
        user: user_info.key(),
        is_buy: false,
        on_amm: true,
        token_amount: tokens_sold,
        sol_amount: gross,
        fee_pool: fee.pool,
        fee_platform: fee.platform,
        fee_creator: fee.creator,
        pool_tokens_bought: 0,
        price_q64: price_q64(gross, tokens_sold).ok_or(FumpadError::MathOverflow)?,
        virtual_sol_reserves: after.quote,
        virtual_token_reserves: after.base,
        ts: now,
    };
    emit_cpi!(ev);
    Ok(())
}
