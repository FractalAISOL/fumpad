//! Value that would otherwise be stranded with no claim path (audit THREAT-MODEL G4). Both instructions are
//! permissionless, never paused, forward exact pinned account lists to Meteora, and pay only fixed destinations.
//!
//! * `claim_unregistered_fees`: DBC partner trading fees of a pool on a FUMPAD-shaped config (fee claimer = our PDA)
//!   whose mint never called `register_coin` (no `Coin`) → `Global.platform_treasury`. There is no coin to account
//!   for, so nothing is split.
//! * `claim_position_rewards`: DAMM v2 farming rewards (`claim_reward`) of a `fee_claimer`-held position of a
//!   graduated coin's pool → the coin's reward vault when the reward is paid in the coin's own mint, else the
//!   platform treasury's canonical ATA for the reward mint (must exist).

use anchor_lang::prelude::*;
use anchor_spl::{associated_token::get_associated_token_address_with_program_id, token::Token, token_2022::Token2022};

use crate::{
    constants::*,
    error::FumpadError,
    events::{PositionRewardClaimed, UnregisteredFeesClaimed},
    external::meteora::{self, DAMM_V2_PROGRAM_ID, DBC_PROGRAM_ID},
    state::{Coin, CoinStatus, Global},
};

use super::common::{close_fee_wsol, open_fee_wsol, signed_system_transfer, token_amount};
use super::fees::reward_pool_key;

#[event_cpi]
#[derive(Accounts)]
pub struct ClaimUnregisteredFees<'info> {
    /// Pays the transient `fee_wsol` rent (refunded in the same instruction).
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    /// CHECK: = the pool's base mint (checked against the pool).
    pub mint: UncheckedAccount<'info>,
    /// CHECK: PDA ["coin", mint]; must NOT exist (registered coins use `claim_fees`).
    #[account(seeds = [COIN_SEED, mint.key().as_ref()], bump)]
    pub coin: UncheckedAccount<'info>,
    /// CHECK: the pool's DBC config; must pass the FUMPAD structural checks (fee claimer = our PDA, quote-only fees).
    pub dbc_config: UncheckedAccount<'info>,
    /// CHECK: DBC virtual pool (owner + discriminator checked by the reader); config / mint / vaults checked.
    #[account(mut)]
    pub dbc_pool: UncheckedAccount<'info>,
    /// CHECK: = pool.base_vault (checked).
    #[account(mut)]
    pub dbc_base_vault: UncheckedAccount<'info>,
    /// CHECK: = pool.quote_vault (checked).
    #[account(mut)]
    pub dbc_quote_vault: UncheckedAccount<'info>,
    /// CHECK: PDA ["fee_claimer"] (system account).
    #[account(mut, seeds = [FEE_CLAIMER_SEED], bump)]
    pub fee_claimer: UncheckedAccount<'info>,
    /// CHECK: PDA ["fee_wsol"], created and closed here.
    #[account(mut, seeds = [FEE_WSOL_SEED], bump)]
    pub fee_wsol: UncheckedAccount<'info>,
    /// CHECK: ATA(reward_pool, mint, Token-2022): DBC's base-side fee destination (quote fee mode → receives
    /// nothing). Must exist (create it idempotently in the same transaction).
    #[account(
        mut,
        address = get_associated_token_address_with_program_id(&reward_pool_key(), &mint.key(), &anchor_spl::token_2022::ID)
            @ FumpadError::InvalidAccount,
    )]
    pub reward_vault: UncheckedAccount<'info>,
    /// CHECK: WSOL mint.
    #[account(address = WSOL_MINT @ FumpadError::InvalidAccount)]
    pub wsol_mint: UncheckedAccount<'info>,
    /// CHECK: `Global.platform_treasury` (receives the claimed lamports).
    #[account(mut, address = global.platform_treasury @ FumpadError::InvalidAccount)]
    pub platform_treasury: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    /// CHECK: DBC pool authority.
    #[account(address = meteora::DBC_POOL_AUTHORITY @ FumpadError::WrongVenue)]
    pub dbc_pool_authority: UncheckedAccount<'info>,
    /// CHECK: DBC event authority.
    #[account(address = meteora::DBC_EVENT_AUTHORITY @ FumpadError::WrongVenue)]
    pub dbc_event_authority: UncheckedAccount<'info>,
    /// CHECK: DBC program.
    #[account(address = DBC_PROGRAM_ID @ FumpadError::WrongVenue)]
    pub dbc_program: UncheckedAccount<'info>,
}

pub fn handle_claim_unregistered_fees(ctx: Context<ClaimUnregisteredFees>) -> Result<()> {
    let a = &ctx.accounts;
    // Only pools without a Coin: a registered coin's fees belong to its own accounting (`claim_fees`).
    let coin_info = a.coin.to_account_info();
    require!(
        *coin_info.owner == anchor_lang::system_program::ID && coin_info.data_is_empty(),
        FumpadError::PoolIsRegistered
    );
    // FUMPAD-shaped config: fee claimer = our PDA, quote-only fees (so nothing lands on the base side).
    meteora::read_fumpad_config(&a.dbc_config, &a.fee_claimer.key(), &reward_pool_key())?;
    let pool = meteora::read_dbc_pool(&a.dbc_pool)?;
    require_keys_eq!(pool.config, a.dbc_config.key(), FumpadError::WrongVenue);
    require_keys_eq!(pool.base_mint, a.mint.key(), FumpadError::WrongVenue);
    require_keys_eq!(pool.base_vault, a.dbc_base_vault.key(), FumpadError::WrongVenue);
    require_keys_eq!(pool.quote_vault, a.dbc_quote_vault.key(), FumpadError::WrongVenue);

    let (caller, fee_claimer, fee_wsol) =
        (a.caller.to_account_info(), a.fee_claimer.to_account_info(), a.fee_wsol.to_account_info());
    let (system, token_program) = (a.system_program.to_account_info(), a.token_program.to_account_info());
    open_fee_wsol(&caller, &fee_wsol, ctx.bumps.fee_wsol, &fee_claimer, &a.wsol_mint.to_account_info(), &system, &token_program)?;

    // DBC claim_trading_fee(u64::MAX, u64::MAX): the same exact pinned 14-account list as `claim_fees`.
    let accounts = [
        a.dbc_pool_authority.to_account_info(),
        a.dbc_config.to_account_info(),
        a.dbc_pool.to_account_info(),
        a.reward_vault.to_account_info(),
        fee_wsol.clone(),
        a.dbc_base_vault.to_account_info(),
        a.dbc_quote_vault.to_account_info(),
        a.mint.to_account_info(),
        a.wsol_mint.to_account_info(),
        fee_claimer.clone(),
        a.token_2022_program.to_account_info(),
        token_program.clone(),
        a.dbc_event_authority.to_account_info(),
        a.dbc_program.to_account_info(),
    ];
    let mut data = meteora::IX_DBC_CLAIM_TRADING_FEE.to_vec();
    data.extend_from_slice(&u64::MAX.to_le_bytes());
    data.extend_from_slice(&u64::MAX.to_le_bytes());
    let seeds: &[&[u8]] = &[FEE_CLAIMER_SEED, &[ctx.bumps.fee_claimer]];
    meteora::invoke_passthrough(&a.dbc_program.to_account_info(), &accounts, data, Some((&fee_claimer.key(), seeds)))?;

    // Unwrap: claimed WSOL → platform treasury, the account rent back to the caller; fee_claimer keeps nothing.
    let (claimed, rent) = close_fee_wsol(&fee_wsol, &fee_claimer, ctx.bumps.fee_claimer, &token_program)?;
    require!(claimed > 0, FumpadError::NothingToClaim);
    let treasury = a.platform_treasury.to_account_info();
    signed_system_transfer(&fee_claimer, &treasury, &system, seeds, claimed)?;
    signed_system_transfer(&fee_claimer, &caller, &system, seeds, rent)?;

    let ts = Clock::get()?.unix_timestamp;
    let ev = UnregisteredFeesClaimed {
        mint: a.mint.key(),
        dbc_pool: a.dbc_pool.key(),
        dbc_config: a.dbc_config.key(),
        claimed,
        platform_treasury: treasury.key(),
        ts,
    };
    emit_event!(ctx, ev);
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct ClaimPositionRewards<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    #[account(seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump, has_one = mint, has_one = damm_pool)]
    pub coin: Box<Account<'info, Coin>>,
    /// CHECK: the coin's mint (has_one).
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the coin's DAMM v2 pool (has_one); reward slot read from its data.
    #[account(mut)]
    pub damm_pool: UncheckedAccount<'info>,
    /// CHECK: any DAMM v2 position of the coin's pool whose NFT the `fee_claimer` PDA holds (like `claim_lp_fees`);
    /// DAMM checks the NFT holder (`fee_claimer`) signs.
    #[account(mut)]
    pub damm_position: UncheckedAccount<'info>,
    /// CHECK: PDA ["position_nft_account", position.nft_mint] (checked).
    pub position_nft_account: UncheckedAccount<'info>,
    /// CHECK: = pool.reward_infos[reward_index].vault (checked).
    #[account(mut)]
    pub damm_reward_vault: UncheckedAccount<'info>,
    /// CHECK: = pool.reward_infos[reward_index].mint (checked).
    pub reward_mint: UncheckedAccount<'info>,
    /// CHECK: the coin's reward vault `ATA(reward_pool, mint, Token-2022)` when `reward_mint == mint`, else
    /// `ATA(Global.platform_treasury, reward_mint, reward_token_program)` (must exist). Checked in the handler.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    /// CHECK: PDA ["fee_claimer"]: the position NFT holder, signs `claim_reward`.
    #[account(seeds = [FEE_CLAIMER_SEED], bump)]
    pub fee_claimer: UncheckedAccount<'info>,
    /// CHECK: SPL Token (reward_token_flag 0) or Token-2022 (1), checked against the reward slot.
    pub reward_token_program: UncheckedAccount<'info>,
    /// CHECK: DAMM pool authority.
    #[account(address = meteora::DAMM_POOL_AUTHORITY @ FumpadError::WrongVenue)]
    pub damm_pool_authority: UncheckedAccount<'info>,
    /// CHECK: DAMM event authority.
    #[account(address = meteora::DAMM_EVENT_AUTHORITY @ FumpadError::WrongVenue)]
    pub damm_event_authority: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 program.
    #[account(address = DAMM_V2_PROGRAM_ID @ FumpadError::WrongVenue)]
    pub damm_program: UncheckedAccount<'info>,
}

pub fn handle_claim_position_rewards(ctx: Context<ClaimPositionRewards>, reward_index: u8) -> Result<()> {
    let a = &ctx.accounts;
    require!(a.coin.status == CoinStatus::Graduated, FumpadError::WrongCoinStatus);
    let reward = meteora::read_damm_reward_info(&a.damm_pool, reward_index as usize)?;
    require!(reward.initialized, FumpadError::WrongVenue);
    require_keys_eq!(reward.mint, a.reward_mint.key(), FumpadError::WrongVenue);
    require_keys_eq!(reward.vault, a.damm_reward_vault.key(), FumpadError::WrongVenue);
    let token_program = match reward.token_flag {
        0 => anchor_spl::token::ID,
        1 => anchor_spl::token_2022::ID,
        _ => return err!(FumpadError::WrongVenue),
    };
    require_keys_eq!(a.reward_token_program.key(), token_program, FumpadError::WrongVenue);
    let position = meteora::read_damm_position(&a.damm_position)?;
    require_keys_eq!(position.pool, a.damm_pool.key(), FumpadError::WrongVenue);
    require_keys_eq!(
        a.position_nft_account.key(),
        meteora::damm_position_nft_account(&position.nft_mint),
        FumpadError::WrongVenue
    );

    // Fixed destination: the coin's own reward pool for coin-mint rewards, the platform treasury otherwise.
    let mint = a.mint.key();
    let to_reward_pool = reward.mint == mint;
    let expected = if to_reward_pool {
        get_associated_token_address_with_program_id(&reward_pool_key(), &mint, &anchor_spl::token_2022::ID)
    } else {
        get_associated_token_address_with_program_id(&a.global.platform_treasury, &reward.mint, &token_program)
    };
    require_keys_eq!(a.destination.key(), expected, FumpadError::InvalidAccount);

    let dest = a.destination.to_account_info();
    let before = token_amount(&dest)?;
    let fee_claimer = a.fee_claimer.to_account_info();
    let accounts = [
        a.damm_pool_authority.to_account_info(),
        a.damm_pool.to_account_info(),
        a.damm_position.to_account_info(),
        a.damm_reward_vault.to_account_info(),
        a.reward_mint.to_account_info(),
        dest.clone(),
        a.position_nft_account.to_account_info(),
        fee_claimer.clone(),
        a.reward_token_program.to_account_info(),
        a.damm_event_authority.to_account_info(),
        a.damm_program.to_account_info(),
    ];
    let mut data = meteora::IX_DAMM_CLAIM_REWARD.to_vec();
    data.push(reward_index);
    data.push(0); // skip_reward = false
    let seeds: &[&[u8]] = &[FEE_CLAIMER_SEED, &[ctx.bumps.fee_claimer]];
    meteora::invoke_passthrough(&a.damm_program.to_account_info(), &accounts, data, Some((&fee_claimer.key(), seeds)))?;
    let amount = token_amount(&dest)?.checked_sub(before).ok_or(FumpadError::MathOverflow)?;
    require!(amount > 0, FumpadError::NothingToClaim);

    let ts = Clock::get()?.unix_timestamp;
    let ev = PositionRewardClaimed {
        mint,
        damm_pool: a.damm_pool.key(),
        damm_position: a.damm_position.key(),
        reward_index,
        reward_mint: reward.mint,
        destination: dest.key(),
        amount,
        to_reward_pool,
        ts,
    };
    emit_event!(ctx, ev);
    Ok(())
}
