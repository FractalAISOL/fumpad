//! SPEC v0.7 §3.1: the router. User-signed DBC `swap2` (curve) or DAMM v2 `swap2` (graduated) with the venue's
//! accounts passed through `remaining_accounts`. Only the trader signs the CPI; fumpad validates what matters
//! (program, pool, mints, the trader's own accounts, no referral) and measures balance deltas.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;

use crate::{
    constants::*,
    error::FumpadError,
    events::{CurveCompleted, RoutedTrade},
    external::meteora::{self, DBC_PROGRAM_ID, DAMM_V2_PROGRAM_ID},
    state::{Coin, CoinStatus, Global, PAUSE_TRADE},
};

use super::common::{token_amount, token_mint_owner};

#[event_cpi]
#[derive(Accounts)]
pub struct Route<'info> {
    pub trader: Signer<'info>,
    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    #[account(mut, seeds = [COIN_SEED, coin.mint.as_ref()], bump = coin.bump)]
    pub coin: Box<Account<'info, Coin>>,
    /// CHECK: DBC (coin `Curve`) or DAMM v2 (coin `Graduated`); checked in the handler.
    pub venue_program: UncheckedAccount<'info>,
}

/// Indices into the pass-through list.
struct Layout {
    pool: usize,
    input: usize,
    output: usize,
    base_mint: usize,
    quote_mint: usize,
    payer: usize,
    referral: usize,
    min_len: usize,
}

const DBC_LAYOUT: Layout =
    Layout { pool: 2, input: 3, output: 4, base_mint: 7, quote_mint: 8, payer: 9, referral: 12, min_len: 15 };
const DAMM_LAYOUT: Layout =
    Layout { pool: 1, input: 2, output: 3, base_mint: 6, quote_mint: 7, payer: 8, referral: 11, min_len: 14 };

pub fn handle_buy<'info>(ctx: Context<'info, Route<'info>>, amount_in: u64, min_out: u64, mode: u8) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(!ctx.accounts.global.is_paused(PAUSE_TRADE, now), FumpadError::Paused);
    require!(
        mode == meteora::SWAP_MODE_EXACT_IN || mode == meteora::SWAP_MODE_PARTIAL_FILL,
        FumpadError::InvalidParams
    );
    route(ctx, true, amount_in, min_out, mode)
}

/// Router sells are never paused (M-3 spirit; users can always sell on Meteora directly anyway).
pub fn handle_sell<'info>(ctx: Context<'info, Route<'info>>, amount_in: u64, min_out: u64) -> Result<()> {
    route(ctx, false, amount_in, min_out, meteora::SWAP_MODE_EXACT_IN)
}

fn route<'info>(ctx: Context<'info, Route<'info>>, is_buy: bool, amount_in: u64, min_out: u64, mode: u8) -> Result<()> {
    require!(amount_in > 0, FumpadError::ZeroAmount);
    let coin = &ctx.accounts.coin;
    let (venue, program_id, pool_key, layout) = match coin.status {
        CoinStatus::Curve => (meteora::VENUE_DBC, DBC_PROGRAM_ID, coin.dbc_pool, &DBC_LAYOUT),
        CoinStatus::Graduated => (meteora::VENUE_DAMM, DAMM_V2_PROGRAM_ID, coin.damm_pool, &DAMM_LAYOUT),
        CoinStatus::Complete => return err!(FumpadError::WrongCoinStatus),
    };
    require_keys_eq!(ctx.accounts.venue_program.key(), program_id, FumpadError::WrongVenue);
    let rem = ctx.remaining_accounts;
    require!(rem.len() >= layout.min_len && rem.len() <= meteora::MAX_ROUTER_ACCOUNTS, FumpadError::WrongVenue);
    let trader = ctx.accounts.trader.key();
    let mint = coin.mint;
    require_keys_eq!(rem[layout.pool].key(), pool_key, FumpadError::WrongVenue);
    require_keys_eq!(rem[layout.base_mint].key(), mint, FumpadError::WrongVenue);
    require_keys_eq!(rem[layout.quote_mint].key(), WSOL_MINT, FumpadError::WrongVenue);
    require_keys_eq!(rem[layout.payer].key(), trader, FumpadError::WrongVenue);
    // Referral = None (the venue's own program id): keeps the fee measurement exact.
    require_keys_eq!(rem[layout.referral].key(), program_id, FumpadError::WrongVenue);

    let (base_acc, quote_acc) = if is_buy {
        (&rem[layout.output], &rem[layout.input])
    } else {
        (&rem[layout.input], &rem[layout.output])
    };
    // Base: the trader's canonical Token-2022 ATA. Quote: an SPL-Token WSOL account the trader owns.
    require_keys_eq!(
        base_acc.key(),
        get_associated_token_address_with_program_id(&trader, &mint, &anchor_spl::token_2022::ID),
        FumpadError::InvalidAccount
    );
    require_keys_eq!(*quote_acc.owner, anchor_spl::token::ID, FumpadError::InvalidAccount);
    let (qmint, qowner) = token_mint_owner(quote_acc)?;
    require!(qmint == WSOL_MINT && qowner == trader, FumpadError::InvalidAccount);

    let pool_info = &rem[layout.pool];
    if venue == meteora::VENUE_DAMM {
        // D38: DAMM v2 operators can disable a pool; say so instead of surfacing Meteora's error.
        require!(
            meteora::read_damm_pool(pool_info)?.pool_status == meteora::DAMM_POOL_STATUS_ENABLED,
            FumpadError::PoolDisabled
        );
    }
    let (pre_sqrt, pre_fee) = pool_state(venue, pool_info)?;
    let (base0, quote0) = (token_amount(base_acc)?, token_amount(quote_acc)?);

    meteora::invoke_passthrough(
        &ctx.accounts.venue_program.to_account_info(),
        rem,
        meteora::swap2_data(amount_in, min_out, mode),
        None,
    )?;

    let (base1, quote1) = (token_amount(base_acc)?, token_amount(quote_acc)?);
    let (post_sqrt, post_fee) = pool_state(venue, pool_info)?;
    let fee = post_fee.saturating_sub(pre_fee) as u64;
    let (base_amount, quote_moved) = if is_buy {
        (base1.checked_sub(base0), quote0.checked_sub(quote1))
    } else {
        (base0.checked_sub(base1), quote1.checked_sub(quote0))
    };
    let base_amount = base_amount.ok_or(FumpadError::MathOverflow)?;
    let quote_moved = quote_moved.ok_or(FumpadError::MathOverflow)?;
    require!(base_amount > 0 && quote_moved > 0, FumpadError::SlippageExceeded);
    // buy: WSOL spent (fee included); sell: WSOL received + fee (the pre-fee value).
    let quote_gross = if is_buy { quote_moved } else { quote_moved.checked_add(fee).ok_or(FumpadError::MathOverflow)? };

    let completed = venue == meteora::VENUE_DBC && is_buy && {
        let p = meteora::read_dbc_pool(pool_info)?;
        p.migration_progress >= 2
    };
    let slot = Clock::get()?.slot;
    let ts = Clock::get()?.unix_timestamp;
    let coin = &mut ctx.accounts.coin;
    coin.router_volume_lamports = coin.router_volume_lamports.saturating_add(quote_gross);
    coin.router_trade_count = coin.router_trade_count.saturating_add(1);
    if completed {
        coin.status = CoinStatus::Complete;
        coin.completed_at = ts;
    }
    emit_event!(ctx, RoutedTrade {
        mint,
        trader,
        venue,
        is_buy,
        base_amount,
        quote_gross,
        fee,
        pre_sqrt_price: pre_sqrt,
        post_sqrt_price: post_sqrt,
        slot,
        ts,
    });
    if completed {
        emit_event!(ctx, CurveCompleted { mint, dbc_pool: pool_key, ts });
    }
    // Last, so no later CPI resets it: base ‖ quote moved (u64 LE each).
    let mut rd = [0u8; 16];
    rd[..8].copy_from_slice(&base_amount.to_le_bytes());
    rd[8..].copy_from_slice(&quote_moved.to_le_bytes());
    set_return_data(&rd);
    Ok(())
}

/// (sqrt_price, cumulative quote fee counter) of the venue pool.
fn pool_state(venue: u8, pool: &AccountInfo) -> Result<(u128, u128)> {
    if venue == meteora::VENUE_DBC {
        let p = meteora::read_dbc_pool(pool)?;
        Ok((p.sqrt_price, p.total_quote_fee as u128))
    } else {
        let p = meteora::read_damm_pool(pool)?;
        Ok((p.sqrt_price, p.total_b_fee))
    }
}
