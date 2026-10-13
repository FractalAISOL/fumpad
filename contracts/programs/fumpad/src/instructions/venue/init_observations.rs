//! Create a graduated coin's price-observation ring. OWNER: venue/oracle module.
//!
//! Permissionless. `graduate` pre-funds the PDA with its rent (~0.0585 SOL) out of the
//! DBC migration fee (D34), so the payer normally pays nothing (Anchor's `init` only
//! tops up a shortfall). The account is the canonical PDA ["observations", mint] — created here with `init` (8,280 bytes fits the 10 KiB CPI
//! allocation limit) rather than as a client-pre-allocated `#[account(zero)]` keypair
//! account: a keypair account would let anyone create extra rings for the same coin, and
//! every consumer (claim, buyback) would have to be trusted to pick the right one. With
//! the PDA, uniqueness is enforced by the seeds.

use anchor_lang::prelude::*;

use crate::{constants::*, error::FumpadError, state::*};

/// Total account size of the observations PDA (8,280 bytes).
pub const OBSERVATIONS_SPACE: usize = 8 + core::mem::size_of::<Observations>();

#[derive(Accounts)]
pub struct InitObservations<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [COIN_SEED, coin.mint.as_ref()], bump = coin.bump)]
    pub coin: Box<Account<'info, Coin>>,
    #[account(
        init,
        payer = payer,
        space = OBSERVATIONS_SPACE,
        seeds = [OBSERVATIONS_SEED, coin.mint.as_ref()],
        bump,
    )]
    pub observations: AccountLoader<'info, Observations>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_observations(ctx: Context<InitObservations>) -> Result<()> {
    let coin = &ctx.accounts.coin;
    require!(coin.status == CoinStatus::Graduated, FumpadError::WrongCoinStatus);
    require_keys_neq!(coin.damm_pool, Pubkey::default(), FumpadError::WrongCoinStatus);
    let mut obs = ctx.accounts.observations.load_init()?;
    obs.mint = coin.mint;
    obs.pool = coin.damm_pool;
    obs.bump = ctx.bumps.observations;
    // The keeper gets a full `keeper_stale_secs` grace period before sampling for this
    // coin becomes permissionless (otherwise a brand-new ring would start in fallback mode).
    obs.last_keeper_sample_ts = Clock::get()?.unix_timestamp;
    Ok(())
}
