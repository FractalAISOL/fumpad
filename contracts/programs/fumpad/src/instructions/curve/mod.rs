//! OWNER: curve module.
//!
//! Fee convention (curve and, by the same rule, the router): the FUMPAD fee is
//! computed on the GROSS SOL that crosses the curve and is
//!   - buy : charged ON TOP — the user pays `sol_used + fee`; `sol_in` is the SOL
//!           offered to the curve (the last buy may use less; the fee follows `sol_used`);
//!   - sell: DEDUCTED — the user receives `sol_out − fee`.
//! This matches pump.fun and keeps `Trade.sol_amount` / ticket prices "before fee".
//!
//! Fee routing on the curve: platform + creator shares accrue as lamports in the
//! `Coin` account (`*_fees_unclaimed`); the pool share is spent in the same
//! instruction buying tokens from the curve into the reward vault (inline buyback).
//! Lamports the buyback cannot spend (curve just completed, or a dust amount that
//! rounds to 0 tokens) accrue to `buyback_lamports` for the post-graduation crank.

pub mod create_coin;
pub mod buy;
pub mod sell;
pub mod graduate;

pub use create_coin::*;
pub use buy::*;
pub use sell::*;
pub use graduate::*;

use anchor_lang::prelude::*;

use crate::{
    error::FumpadError,
    math::curve::{quote_buy, BuyQuote, CurveReserves},
    state::Coin,
};

pub const MAX_NAME_LEN: usize = 32;
pub const MAX_SYMBOL_LEN: usize = 10;
pub const MAX_URI_LEN: usize = 200;

pub(crate) fn reserves_of(coin: &Coin) -> CurveReserves {
    CurveReserves {
        virtual_sol: coin.virtual_sol_reserves,
        virtual_token: coin.virtual_token_reserves,
        real_sol: coin.real_sol_reserves,
        real_token: coin.real_token_reserves,
    }
}

pub(crate) fn store_reserves(coin: &mut Coin, r: &CurveReserves) {
    coin.virtual_sol_reserves = r.virtual_sol;
    coin.virtual_token_reserves = r.virtual_token;
    coin.real_sol_reserves = r.real_sol;
    coin.real_token_reserves = r.real_token;
}

/// Spend `pool_lamports` (already held by the coin account) on the curve for the
/// reward pool. Updates `r` and `buyback_lamports`; the caller moves `tokens_out`
/// from the curve vault to the reward vault. Never fails for economic reasons.
pub(crate) fn inline_buyback(coin: &mut Coin, r: &mut CurveReserves, pool_lamports: u64) -> Result<BuyQuote> {
    let q = quote_buy(r, pool_lamports).ok_or(FumpadError::MathOverflow)?;
    let q = if q.tokens_out == 0 { BuyQuote::default() } else { q };
    r.apply_buy(&q).ok_or(FumpadError::MathOverflow)?;
    let unspent = pool_lamports.checked_sub(q.sol_used).ok_or(FumpadError::MathOverflow)?;
    coin.buyback_lamports = coin.buyback_lamports.checked_add(unspent).ok_or(FumpadError::MathOverflow)?;
    Ok(q)
}

/// Credit the platform and creator shares to the coin's fee balances.
pub(crate) fn accrue_fees(coin: &mut Coin, platform: u64, creator: u64) -> Result<()> {
    coin.platform_fees_unclaimed =
        coin.platform_fees_unclaimed.checked_add(platform).ok_or(FumpadError::MathOverflow)?;
    coin.creator_fees_unclaimed = coin.creator_fees_unclaimed.checked_add(creator).ok_or(FumpadError::MathOverflow)?;
    Ok(())
}

pub(crate) fn bump_stats(coin: &mut Coin, volume: u64) {
    coin.volume_lamports = coin.volume_lamports.saturating_add(volume);
    coin.trade_count = coin.trade_count.saturating_add(1);
}
