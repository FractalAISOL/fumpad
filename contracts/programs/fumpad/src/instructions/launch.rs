//! `register_coin` — the last instruction of the launch tx (SPEC v0.7 §2): DBC `initialize_virtual_pool_with_token2022`
//! → creator's top-level DBC `swap2` (min fee) → `register_coin`.
//!
//! Launch binding (off-chain review L1): when `Global.params.launch_signer` is set, the API's launch key must
//! co-sign `register_coin` (as it co-signs the vanity mint), so only API-built launch transactions register. DBC
//! 0.2.1 gives its min fee (`enable_first_swap_with_min_fee`) to ONE swap of the pool-creation transaction only —
//! further top-level swaps in the same transaction pay the scheduler's 99% (`launch_tests`), so no
//! instructions-sysvar check is needed here.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::{self, get_associated_token_address_with_program_id, AssociatedToken},
    token_2022::Token2022,
    token_interface::Mint,
};

use crate::{
    constants::*,
    error::FumpadError,
    events::CoinRegistered,
    external::meteora,
    state::{Coin, CoinStatus, Global, PAUSE_LAUNCH},
};

#[event_cpi]
#[derive(Accounts)]
pub struct RegisterCoin<'info> {
    /// The DBC pool's creator; pays the Coin and reward-vault rent.
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    #[account(mint::token_program = token_2022_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: DBC config; allow-listed + FUMPAD shape checked in the handler.
    pub dbc_config: UncheckedAccount<'info>,
    /// CHECK: DBC virtual pool; owner, discriminator and fields checked in the handler.
    pub dbc_pool: UncheckedAccount<'info>,
    #[account(init, payer = creator, space = 8 + Coin::INIT_SPACE, seeds = [COIN_SEED, mint.key().as_ref()], bump)]
    pub coin: Box<Account<'info, Coin>>,
    /// CHECK: PDA ["reward_pool"] (the config's leftover receiver), owner of the reward vault.
    #[account(seeds = [REWARD_POOL_SEED], bump)]
    pub reward_pool: UncheckedAccount<'info>,
    /// CHECK: ATA(reward_pool, mint, Token-2022), created idempotently here.
    #[account(
        mut,
        address = get_associated_token_address_with_program_id(&reward_pool.key(), &mint.key(), &anchor_spl::token_2022::ID)
            @ FumpadError::InvalidAccount,
    )]
    pub reward_vault: UncheckedAccount<'info>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// `Global.params.launch_signer` (required iff that is set; otherwise pass the fumpad program id = None).
    pub launch_signer: Option<Signer<'info>>,
}

pub fn handle_register_coin(ctx: Context<RegisterCoin>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let g = &ctx.accounts.global;
    require!(!g.is_paused(PAUSE_LAUNCH, now), FumpadError::Paused);
    let want = g.params.launch_signer;
    if want != Pubkey::default() {
        let got = ctx.accounts.launch_signer.as_ref().map(|s| s.key());
        require!(got == Some(want), FumpadError::Unauthorized);
    }
    let config_key = ctx.accounts.dbc_config.key();
    require!(g.is_allowed_config(&config_key), FumpadError::ConfigNotAllowed);
    let cfg = super::admin::validate_config(&ctx.accounts.dbc_config)?;

    let pool = meteora::read_dbc_pool(&ctx.accounts.dbc_pool)?;
    let mint = ctx.accounts.mint.key();
    require_keys_eq!(pool.base_mint, mint, FumpadError::PoolNotOfCoin);
    require_keys_eq!(pool.config, config_key, FumpadError::PoolNotOfCoin);
    require_keys_eq!(pool.creator, ctx.accounts.creator.key(), FumpadError::Unauthorized);
    require!(
        pool.migration_progress == meteora::DBC_PROGRESS_PRE_BONDING && pool.is_migrated == 0,
        FumpadError::PoolNotFresh
    );

    // The reward vault: ATA(reward_pool, mint, Token-2022), idempotent (withdraw_leftover and buybacks pay here).
    associated_token::create_idempotent(CpiContext::new(
        ctx.accounts.associated_token_program.key(),
        associated_token::Create {
            payer: ctx.accounts.creator.to_account_info(),
            associated_token: ctx.accounts.reward_vault.to_account_info(),
            authority: ctx.accounts.reward_pool.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            token_program: ctx.accounts.token_2022_program.to_account_info(),
        },
    ))?;

    let params = ctx.accounts.global.params;
    let c = &mut ctx.accounts.coin;
    c.bump = ctx.bumps.coin;
    c.status = CoinStatus::Curve;
    c.launch_fees_settled = false;
    c.mint = mint;
    c.creator = pool.creator;
    c.dbc_pool = ctx.accounts.dbc_pool.key();
    c.dbc_config = config_key;
    c.launch_slot = pool.activation_point;
    c.launch_window_slots = cfg.launch_window_slots;
    c.created_at = now;
    c.total_supply = cfg.pre_migration_token_supply;
    c.rewards = params.reward_terms();
    c.fee_split = params.fee_split();
    let (dbc_pool, launch_slot, launch_window_slots, creator) =
        (c.dbc_pool, c.launch_slot, c.launch_window_slots, c.creator);
    emit_event!(ctx, CoinRegistered {
        mint,
        creator,
        dbc_pool,
        dbc_config: config_key,
        launch_slot,
        launch_window_slots,
        ts: now
    });
    Ok(())
}
