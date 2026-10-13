//! SPEC v0.7 §4: graduation. `migrate_pool` wraps DBC's permissionless `migration_damm_v2` (and records the
//! caller's flash-rent cost for a refund); `graduate` verifies + records the DAMM v2 pool and our locked position,
//! pulls the 8% leftover into the reward vault, claims the partner migration fee + surplus and spends them on the
//! post-graduation setup (D34, D20-style).

use anchor_lang::prelude::*;
use anchor_spl::{associated_token::get_associated_token_address_with_program_id, token::Token, token_2022::Token2022};

use crate::{
    constants::*,
    error::FumpadError,
    events::{Graduated, PoolMigrated},
    external::meteora::{self, DAMM_V2_PROGRAM_ID, DBC_PROGRAM_ID},
    instructions::{
        rewards::init_claim_queue::CLAIM_QUEUE_SPACE, venue::init_observations::OBSERVATIONS_SPACE,
    },
    state::{Coin, CoinStatus, Global, PAUSE_GRADUATE},
};

use super::common::{close_fee_wsol, open_fee_wsol, signed_system_transfer, token_amount, token_mint_owner};

// ── migrate_pool ─────────────────────────────────────────────────────────────

#[event_cpi]
#[derive(Accounts)]
pub struct MigratePool<'info> {
    /// DBC `payer` of the migration (fronts the flash rent); refunded by `graduate` from the migration fee.
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    #[account(mut, seeds = [COIN_SEED, coin.mint.as_ref()], bump = coin.bump)]
    pub coin: Box<Account<'info, Coin>>,
    /// CHECK: DBC program.
    #[account(address = DBC_PROGRAM_ID @ FumpadError::WrongVenue)]
    pub dbc_program: UncheckedAccount<'info>,
}

pub fn handle_migrate_pool<'info>(ctx: Context<'info, MigratePool<'info>>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(!ctx.accounts.global.is_paused(PAUSE_GRADUATE, now), FumpadError::Paused);
    require!(ctx.accounts.coin.status != CoinStatus::Graduated, FumpadError::WrongCoinStatus);
    let rem = ctx.remaining_accounts;
    require!(rem.len() == meteora::DBC_MIGRATION_ACCOUNTS, FumpadError::WrongVenue);
    let caller = ctx.accounts.caller.key();
    require_keys_eq!(rem[0].key(), ctx.accounts.coin.dbc_pool, FumpadError::WrongVenue);
    require_keys_eq!(rem[2].key(), ctx.accounts.coin.dbc_config, FumpadError::WrongVenue);
    require_keys_eq!(rem[13].key(), ctx.accounts.coin.mint, FumpadError::WrongVenue);
    require_keys_eq!(rem[19].key(), caller, FumpadError::WrongVenue);
    let damm_pool = rem[4].key();

    let caller_info = ctx.accounts.caller.to_account_info();
    let before = caller_info.lamports();
    meteora::invoke_passthrough(
        &ctx.accounts.dbc_program.to_account_info(),
        rem,
        meteora::IX_DBC_MIGRATION_DAMM_V2.to_vec(),
        None,
    )?;
    let cost = before.saturating_sub(caller_info.lamports());
    let coin = &mut ctx.accounts.coin;
    coin.migrator = caller;
    coin.migrator_cost = cost;
    let mint = coin.mint;
    emit_event!(ctx, PoolMigrated { mint, damm_pool, migrator: caller, cost, ts: now });
    Ok(())
}

// ── graduate ─────────────────────────────────────────────────────────────────

#[event_cpi]
#[derive(Accounts)]
pub struct Graduate<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    #[account(mut, seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump, has_one = mint, has_one = dbc_pool, has_one = dbc_config)]
    pub coin: Box<Account<'info, Coin>>,
    /// CHECK: the coin's mint (has_one).
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the coin's DBC config (has_one).
    pub dbc_config: UncheckedAccount<'info>,
    /// CHECK: the coin's DBC pool (has_one).
    #[account(mut)]
    pub dbc_pool: UncheckedAccount<'info>,
    /// CHECK: = pool.quote_vault (checked).
    #[account(mut)]
    pub dbc_quote_vault: UncheckedAccount<'info>,
    /// CHECK: = pool.base_vault (checked).
    #[account(mut)]
    pub dbc_base_vault: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 config the pool was created with (owner + pool-creator authority checked).
    pub damm_config: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 pool (verified in the handler).
    pub damm_pool: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 position (verified in the handler).
    pub damm_position: UncheckedAccount<'info>,
    /// CHECK: PDA ["position_nft_account", nft_mint] of DAMM v2 (verified).
    pub position_nft_account: UncheckedAccount<'info>,
    /// CHECK: PDA ["fee_claimer"].
    #[account(mut, seeds = [FEE_CLAIMER_SEED], bump)]
    pub fee_claimer: UncheckedAccount<'info>,
    /// CHECK: PDA ["fee_wsol"], created and closed here.
    #[account(mut, seeds = [FEE_WSOL_SEED], bump)]
    pub fee_wsol: UncheckedAccount<'info>,
    /// CHECK: PDA ["reward_pool"] (the config's leftover receiver).
    #[account(seeds = [REWARD_POOL_SEED], bump)]
    pub reward_pool: UncheckedAccount<'info>,
    /// CHECK: ATA(reward_pool, mint, Token-2022).
    #[account(
        mut,
        address = get_associated_token_address_with_program_id(&reward_pool.key(), &mint.key(), &anchor_spl::token_2022::ID)
            @ FumpadError::InvalidAccount,
    )]
    pub reward_vault: UncheckedAccount<'info>,
    /// CHECK: WSOL mint.
    #[account(address = WSOL_MINT @ FumpadError::InvalidAccount)]
    pub wsol_mint: UncheckedAccount<'info>,
    /// CHECK: refund recipient of the migration flash rent: `coin.migrator`, or the caller when none.
    #[account(mut, dup)]
    pub migrator: UncheckedAccount<'info>,
    /// CHECK: PDA ["observations", mint]; pre-funded with its rent (not created).
    #[account(mut, seeds = [OBSERVATIONS_SEED, mint.key().as_ref()], bump)]
    pub observations: UncheckedAccount<'info>,
    /// CHECK: PDA ["claim_queue", mint]; pre-funded with its rent (not created).
    #[account(mut, seeds = [CLAIM_QUEUE_SEED, mint.key().as_ref()], bump)]
    pub claim_queue: UncheckedAccount<'info>,
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

pub fn handle_graduate(ctx: Context<Graduate>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &ctx.accounts;
    require!(!a.global.is_paused(PAUSE_GRADUATE, now), FumpadError::Paused);
    require!(a.coin.status != CoinStatus::Graduated, FumpadError::WrongCoinStatus);
    let caller_start = a.caller.lamports();
    let mint = a.mint.key();

    // 1. DBC pool migrated (by anyone).
    let pool = meteora::read_dbc_pool(&a.dbc_pool)?;
    require!(
        pool.migration_progress == meteora::DBC_PROGRESS_CREATED_POOL && pool.is_migrated == 1,
        FumpadError::NotMigrated
    );
    require_keys_eq!(pool.base_vault, a.dbc_base_vault.key(), FumpadError::WrongVenue);
    require_keys_eq!(pool.quote_vault, a.dbc_quote_vault.key(), FumpadError::WrongVenue);

    // 2. The DAMM v2 pool created by that migration, and our 100%-locked position.
    {
        let cfg = meteora::checked_data(&a.damm_config, &DAMM_V2_PROGRAM_ID, &meteora::ACC_DAMM_CONFIG, 8 + 320)?;
        require_keys_eq!(
            meteora::rd_pubkey(&cfg, meteora::DAMM_CONFIG_POOL_CREATOR_AUTHORITY),
            meteora::DBC_POOL_AUTHORITY,
            FumpadError::InvalidMigratedPool
        );
    }
    require_keys_eq!(
        a.damm_pool.key(),
        meteora::damm_pool_address(&a.damm_config.key(), &mint, &WSOL_MINT),
        FumpadError::InvalidMigratedPool
    );
    let damm = meteora::read_damm_pool(&a.damm_pool)?;
    require!(
        damm.token_a_mint == mint && damm.token_b_mint == WSOL_MINT && damm.creator == meteora::DBC_POOL_AUTHORITY,
        FumpadError::InvalidMigratedPool
    );
    let position = meteora::read_damm_position(&a.damm_position)?;
    require_keys_eq!(position.pool, a.damm_pool.key(), FumpadError::InvalidMigratedPool);
    require!(
        position.unlocked_liquidity == 0
            && position.vested_liquidity == 0
            && position.permanent_locked_liquidity > 0
            && position.permanent_locked_liquidity.checked_mul(BPS_DENOM as u128).is_some_and(|x| {
                damm.liquidity.checked_mul(MIN_LOCKED_LIQUIDITY_BPS as u128).is_some_and(|y| x >= y)
            }),
        FumpadError::InvalidMigratedPool
    );
    require_keys_eq!(
        a.position_nft_account.key(),
        meteora::damm_position_nft_account(&position.nft_mint),
        FumpadError::InvalidMigratedPool
    );
    {
        let nft = &a.position_nft_account;
        require_keys_eq!(*nft.owner, anchor_spl::token_2022::ID, FumpadError::InvalidMigratedPool);
        let (nft_mint, nft_owner) = token_mint_owner(nft)?;
        require!(
            nft_mint == position.nft_mint && nft_owner == a.fee_claimer.key() && token_amount(nft)? == 1,
            FumpadError::InvalidMigratedPool
        );
    }

    // 3a. withdraw_leftover (permissionless at DBC; skip when already done by anyone).
    let vault_before = token_amount(&a.reward_vault)?;
    if pool.is_withdraw_leftover == 0 {
        let accounts = [
            a.dbc_pool_authority.to_account_info(),
            a.dbc_config.to_account_info(),
            a.dbc_pool.to_account_info(),
            a.reward_vault.to_account_info(),
            a.dbc_base_vault.to_account_info(),
            a.mint.to_account_info(),
            a.reward_pool.to_account_info(),
            a.token_2022_program.to_account_info(),
            a.dbc_event_authority.to_account_info(),
            a.dbc_program.to_account_info(),
        ];
        meteora::invoke_passthrough(&a.dbc_program.to_account_info(), &accounts, meteora::IX_DBC_WITHDRAW_LEFTOVER.to_vec(), None)?;
    }
    let leftover_tokens = token_amount(&a.reward_vault)?.saturating_sub(vault_before);

    // 3b. Partner migration fee + partner surplus into the transient WSOL account (fee_claimer signs).
    let (caller, fee_claimer, fee_wsol) =
        (a.caller.to_account_info(), a.fee_claimer.to_account_info(), a.fee_wsol.to_account_info());
    let (system, token_program) = (a.system_program.to_account_info(), a.token_program.to_account_info());
    open_fee_wsol(&caller, &fee_wsol, ctx.bumps.fee_wsol, &fee_claimer, &a.wsol_mint.to_account_info(), &system, &token_program)?;
    let seeds: &[&[u8]] = &[FEE_CLAIMER_SEED, &[ctx.bumps.fee_claimer]];
    let fee_claimer_key = fee_claimer.key();
    let signer: Option<(&Pubkey, &[&[u8]])> = Some((&fee_claimer_key, seeds));
    let quote_accounts = [
        a.dbc_pool_authority.to_account_info(),
        a.dbc_config.to_account_info(),
        a.dbc_pool.to_account_info(),
        fee_wsol.clone(),
        a.dbc_quote_vault.to_account_info(),
        a.wsol_mint.to_account_info(),
        fee_claimer.clone(),
        token_program.clone(),
        a.dbc_event_authority.to_account_info(),
        a.dbc_program.to_account_info(),
    ];
    let migration_fee_before = token_amount(&fee_wsol)?;
    if pool.migration_fee_withdraw_status & meteora::DBC_PARTNER_MIGRATION_FEE_MASK == 0 {
        let mut data = meteora::IX_DBC_WITHDRAW_MIGRATION_FEE.to_vec();
        data.push(0); // SenderFlag::Partner
        meteora::invoke_passthrough(&a.dbc_program.to_account_info(), &quote_accounts, data, signer)?;
    }
    let migration_fee = token_amount(&fee_wsol)?.saturating_sub(migration_fee_before);
    if pool.is_partner_withdraw_surplus == 0 {
        meteora::invoke_passthrough(
            &a.dbc_program.to_account_info(),
            &quote_accounts,
            meteora::IX_DBC_PARTNER_WITHDRAW_SURPLUS.to_vec(),
            signer,
        )?;
    }
    let surplus = token_amount(&fee_wsol)?.saturating_sub(migration_fee);
    let (budget, wsol_rent) = close_fee_wsol(&fee_wsol, &fee_claimer, ctx.bumps.fee_claimer, &token_program)?;

    // 4. Spend the budget (migration fee + surplus), in order: migrator refund → caller's net rent → observations
    //    rent → claim-queue rent → remainder platform. Lamports sit in `fee_claimer`; it pays each out.
    let rent = Rent::get()?;
    let mut left = budget;
    let migrator_refund = {
        let want = if a.coin.migrator != Pubkey::default() { a.coin.migrator_cost } else { 0 };
        if want > 0 {
            require_keys_eq!(a.migrator.key(), a.coin.migrator, FumpadError::InvalidAccount);
        }
        want.min(left)
    };
    left -= migrator_refund;
    // The caller's own net outflow in this instruction so far is the transient account's rent, returned below.
    let caller_net = caller_start.saturating_sub(caller.lamports());
    let caller_refund = caller_net.saturating_sub(wsol_rent).min(left);
    left -= caller_refund;
    let mut setup_prefunded = 0u64;
    for (pda, space) in [(&a.observations, OBSERVATIONS_SPACE), (&a.claim_queue, CLAIM_QUEUE_SPACE)] {
        let need = rent.minimum_balance(space).saturating_sub(pda.lamports());
        // A partial pre-fund that would leave a fresh system account below its own rent minimum isn't sent.
        let send = need.min(left);
        let after = pda.lamports().saturating_add(send);
        if send == 0 || (after < rent.minimum_balance(0) && send < need) {
            continue;
        }
        signed_system_transfer(&fee_claimer, &pda.to_account_info(), &system, seeds, send)?;
        left -= send;
        setup_prefunded = setup_prefunded.saturating_add(send);
    }
    let platform_fee = left;
    signed_system_transfer(&fee_claimer, &a.migrator.to_account_info(), &system, seeds, migrator_refund)?;
    signed_system_transfer(&fee_claimer, &caller, &system, seeds, caller_refund.saturating_add(wsol_rent))?;
    signed_system_transfer(&fee_claimer, &a.coin.to_account_info(), &system, seeds, platform_fee)?;

    let damm_pool = a.damm_pool.key();
    let damm_position = a.damm_position.key();
    let coin = &mut ctx.accounts.coin;
    coin.damm_pool = damm_pool;
    coin.damm_position = damm_position;
    coin.status = CoinStatus::Graduated;
    coin.graduated_at = now;
    if coin.completed_at == 0 {
        coin.completed_at = now;
    }
    coin.platform_fees_unclaimed = coin.platform_fees_unclaimed.checked_add(platform_fee).ok_or(FumpadError::MathOverflow)?;
    coin.migration_fee_lamports = budget;
    coin.leftover_tokens = leftover_tokens;
    coin.migrator_cost = 0;
    emit_event!(ctx, Graduated {
        mint,
        damm_pool,
        damm_position,
        leftover_tokens,
        migration_fee,
        surplus,
        migrator_refund,
        caller_refund,
        setup_prefunded,
        platform_fee,
        ts: now,
    });
    Ok(())
}
