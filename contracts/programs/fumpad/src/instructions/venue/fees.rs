//! SPEC v0.7 §3.2/§3.3: claim our partner fees (DBC) and locked-position LP fees (DAMM v2) with the
//! `fee_claimer` PDA, unwrap them into the Coin and split them (D32 50/30/20; D33 launch window → 100% buyback).
//!
//! Fee policies (2026-10-14, INTERFACE §5.9): a coin registered under a wallet-split policy (`Coin.fee_policy_kind
//! == FEE_POLICY_WALLET_SPLIT`, snapshot in its Coin account's tail) splits each claim `buyback_share :
//! wallet_share` between its buyback balance and the policy wallet (no platform / creator), and its first
//! (launch-window) claim goes 100% to the wallet. The wallet's part is paid straight from `fee_claimer` to the
//! wallet in the same instruction; it never enters the Coin, so the Coin lamport invariant is unchanged.

use anchor_lang::prelude::*;
use anchor_spl::{associated_token::get_associated_token_address_with_program_id, token::Token, token_2022::Token2022};

use crate::{
    constants::*,
    error::FumpadError,
    events::FeesClaimed,
    external::meteora::{self, DAMM_V2_PROGRAM_ID, DBC_PROGRAM_ID},
    math::{launch_window_split, split_fee, wallet_launch_window_split, wallet_split, FeeSplit},
    state::{read_policy_tail, write_policy_tail, Coin, CoinStatus, FeePolicy, Global},
};

use super::common::{close_fee_wsol, open_fee_wsol, signed_system_transfer};

#[event_cpi]
#[derive(Accounts)]
pub struct ClaimFees<'info> {
    /// Pays the transient `fee_wsol` rent (refunded in the same instruction).
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
    /// CHECK: the coin's DBC pool (has_one); its vaults are checked against its data.
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
    /// CHECK: ATA(reward_pool, mint, Token-2022): base-side destination (quote fee mode → receives nothing).
    #[account(
        mut,
        address = get_associated_token_address_with_program_id(&reward_pool_key(), &mint.key(), &anchor_spl::token_2022::ID)
            @ FumpadError::InvalidAccount,
    )]
    pub reward_vault: UncheckedAccount<'info>,
    /// CHECK: WSOL mint.
    #[account(address = WSOL_MINT @ FumpadError::InvalidAccount)]
    pub wsol_mint: UncheckedAccount<'info>,
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
    /// CHECK: the policy wallet of the coin's snapshot (checked) — required iff `coin.fee_policy_kind != 0`,
    /// otherwise pass the fumpad program id (= None).
    #[account(mut)]
    pub fee_wallet: Option<UncheckedAccount<'info>>,
}

pub fn reward_pool_key() -> Pubkey {
    Pubkey::find_program_address(&[REWARD_POOL_SEED], &crate::ID).0
}

pub fn handle_claim_fees(ctx: Context<ClaimFees>) -> Result<()> {
    let a = &ctx.accounts;
    let slot = Clock::get()?.slot;
    let coin = &a.coin;
    // D33: the first claim must wait for the end of the anti-snipe window.
    let launch_window = !coin.launch_fees_settled;
    if launch_window {
        require!(
            slot >= coin.launch_slot.saturating_add(coin.launch_window_slots),
            FumpadError::LaunchWindowActive
        );
    }
    let pool = meteora::read_dbc_pool(&a.dbc_pool)?;
    require_keys_eq!(pool.base_vault, a.dbc_base_vault.key(), FumpadError::WrongVenue);
    require_keys_eq!(pool.quote_vault, a.dbc_quote_vault.key(), FumpadError::WrongVenue);

    let (caller, fee_claimer, fee_wsol) =
        (a.caller.to_account_info(), a.fee_claimer.to_account_info(), a.fee_wsol.to_account_info());
    let (system, token_program) = (a.system_program.to_account_info(), a.token_program.to_account_info());
    open_fee_wsol(&caller, &fee_wsol, ctx.bumps.fee_wsol, &fee_claimer, &a.wsol_mint.to_account_info(), &system, &token_program)?;

    // DBC claim_trading_fee(u64::MAX, u64::MAX), exact pinned list, signed by fee_claimer.
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

    let wallet = policy_wallet(&a.coin, &a.fee_wallet)?;
    let (claimed, rent) = close_fee_wsol(&fee_wsol, &fee_claimer, ctx.bumps.fee_claimer, &token_program)?;
    let split = apply_split(&mut ctx.accounts.coin, claimed, launch_window, wallet.as_ref().map(|w| w.1))?;
    let a = &ctx.accounts;
    let fee_wallet = pay_out(
        &a.coin.to_account_info(),
        &caller,
        &fee_claimer,
        ctx.bumps.fee_claimer,
        &system,
        &split,
        rent,
        wallet.as_ref().map(|w| &w.0),
    )?;
    record_wallet_paid(&ctx.accounts.coin, split.wallet)?;
    let ts = Clock::get()?.unix_timestamp;
    let mint = ctx.accounts.coin.mint;
    emit_event!(ctx, FeesClaimed {
        mint,
        venue: meteora::VENUE_DBC,
        claimed,
        to_buyback: split.buyback,
        to_platform: split.platform,
        to_creator: split.creator,
        launch_window,
        ts,
        to_wallet: split.wallet,
        fee_wallet
    });
    Ok(())
}

/// The policy wallet of a wallet-split coin (account + its snapshotted policy, from the Coin account's tail), or None
/// for a standard coin (which ignores whatever is passed there). A wallet-split coin must pass the snapshot's wallet
/// (`FeeWalletRequired` / `InvalidAccount`).
fn policy_wallet<'info>(coin: &Account<'info, Coin>, fee_wallet: &Option<UncheckedAccount<'info>>) -> Result<Option<(AccountInfo<'info>, FeePolicy)>> {
    if coin.fee_policy_kind == FEE_POLICY_STANDARD {
        return Ok(None);
    }
    let tail = read_policy_tail(&coin.to_account_info())?;
    require!(tail.policy.kind == coin.fee_policy_kind, FumpadError::InvalidAccount);
    let w = fee_wallet.as_ref().ok_or(FumpadError::FeeWalletRequired)?;
    require_keys_eq!(w.key(), tail.policy.wallet, FumpadError::InvalidAccount);
    Ok(Some((w.to_account_info(), tail.policy)))
}

/// Stats: add what this claim paid the policy wallet to the coin's tail (raw write; Anchor only rewrites the prefix).
fn record_wallet_paid(coin: &Account<Coin>, paid: u64) -> Result<()> {
    if coin.fee_policy_kind == FEE_POLICY_STANDARD || paid == 0 {
        return Ok(());
    }
    let info = coin.to_account_info();
    let mut tail = read_policy_tail(&info)?;
    tail.wallet_paid_lamports = tail.wallet_paid_lamports.saturating_add(paid);
    write_policy_tail(&info, &tail)
}

/// Pay a settled claim out of `fee_claimer` (where `close_fee_wsol` left it): the Coin's share (buyback +
/// platform + creator, already credited to its counters) to the Coin, the wallet share to the policy wallet, the
/// transient account rent back to the caller. Returns the wallet paid (default when none).
#[allow(clippy::too_many_arguments)]
fn pay_out<'info>(
    coin: &AccountInfo<'info>,
    caller: &AccountInfo<'info>,
    fee_claimer: &AccountInfo<'info>,
    fee_claimer_bump: u8,
    system: &AccountInfo<'info>,
    split: &FeeSplit,
    rent: u64,
    wallet: Option<&AccountInfo<'info>>,
) -> Result<Pubkey> {
    let seeds: &[&[u8]] = &[FEE_CLAIMER_SEED, &[fee_claimer_bump]];
    let to_coin = split.total.checked_sub(split.wallet).ok_or(FumpadError::MathOverflow)?;
    signed_system_transfer(fee_claimer, coin, system, seeds, to_coin)?;
    let mut paid_to = Pubkey::default();
    if let Some(w) = wallet {
        if split.wallet > 0 {
            // A transfer that leaves a non-empty account below rent exemption fails at the runtime level anyway;
            // fail with a clear error instead (fund the wallet, then claim again — nothing is lost meanwhile).
            let after = w.lamports().checked_add(split.wallet).ok_or(FumpadError::MathOverflow)?;
            require!(after >= Rent::get()?.minimum_balance(w.data_len()), FumpadError::FeeWalletNotRentExempt);
            signed_system_transfer(fee_claimer, w, system, seeds, split.wallet)?;
        }
        paid_to = w.key();
    }
    signed_system_transfer(fee_claimer, caller, system, seeds, rent)?;
    Ok(paid_to)
}

/// Credit a claim to the Coin's ledgers (the lamports arrive in `pay_out`). D33: the first claim after the launch
/// window (`launch_window`) goes 100% to the buyback balance — 100% to the wallet under a wallet-split policy
/// (`policy`) — and settles the flag even when nothing was claimed.
fn apply_split(
    coin: &mut Coin,
    claimed: u64,
    launch_window: bool,
    policy: Option<FeePolicy>,
) -> Result<FeeSplit> {
    if launch_window {
        coin.launch_fees_settled = true;
    } else {
        require!(claimed > 0, FumpadError::NothingToClaim);
    }
    let split = match (policy, launch_window) {
        (None, true) => launch_window_split(claimed),
        (None, false) => split_fee(claimed, &coin.fee_split),
        (Some(_), true) => wallet_launch_window_split(claimed),
        (Some(p), false) => wallet_split(claimed, p.buyback_share, p.wallet_share),
    };
    coin.buyback_lamports = coin.buyback_lamports.checked_add(split.buyback).ok_or(FumpadError::MathOverflow)?;
    coin.platform_fees_unclaimed =
        coin.platform_fees_unclaimed.checked_add(split.platform).ok_or(FumpadError::MathOverflow)?;
    coin.creator_fees_unclaimed =
        coin.creator_fees_unclaimed.checked_add(split.creator).ok_or(FumpadError::MathOverflow)?;
    coin.fees_claimed_lamports = coin.fees_claimed_lamports.saturating_add(claimed);
    Ok(split)
}

#[event_cpi]
#[derive(Accounts)]
pub struct ClaimLpFees<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    #[account(mut, seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump, has_one = mint, has_one = damm_pool)]
    pub coin: Box<Account<'info, Coin>>,
    /// CHECK: the coin's mint (has_one).
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the coin's DAMM v2 pool (has_one); vaults checked against its data.
    pub damm_pool: UncheckedAccount<'info>,
    /// CHECK: any DAMM v2 position of the coin's pool whose NFT the `fee_claimer` PDA holds (usually
    /// `coin.damm_position`; REVIEW-v0.7 H-1: a third-party position handed to `fee_claimer` and recorded by an early
    /// `graduate` must not strand the fees of ours). DAMM checks the NFT owner signs (`fee_claimer`).
    #[account(mut)]
    pub damm_position: UncheckedAccount<'info>,
    /// CHECK: PDA ["position_nft_account", position.nft_mint] (checked).
    pub position_nft_account: UncheckedAccount<'info>,
    /// CHECK: = pool.token_a_vault (checked).
    #[account(mut)]
    pub damm_token_a_vault: UncheckedAccount<'info>,
    /// CHECK: = pool.token_b_vault (checked).
    #[account(mut)]
    pub damm_token_b_vault: UncheckedAccount<'info>,
    /// CHECK: PDA ["fee_claimer"].
    #[account(mut, seeds = [FEE_CLAIMER_SEED], bump)]
    pub fee_claimer: UncheckedAccount<'info>,
    /// CHECK: PDA ["fee_wsol"], created and closed here.
    #[account(mut, seeds = [FEE_WSOL_SEED], bump)]
    pub fee_wsol: UncheckedAccount<'info>,
    /// CHECK: ATA(reward_pool, mint, Token-2022): token-a destination (OnlyB → receives nothing).
    #[account(
        mut,
        address = get_associated_token_address_with_program_id(&reward_pool_key(), &mint.key(), &anchor_spl::token_2022::ID)
            @ FumpadError::InvalidAccount,
    )]
    pub reward_vault: UncheckedAccount<'info>,
    /// CHECK: WSOL mint.
    #[account(address = WSOL_MINT @ FumpadError::InvalidAccount)]
    pub wsol_mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    /// CHECK: DAMM pool authority.
    #[account(address = meteora::DAMM_POOL_AUTHORITY @ FumpadError::WrongVenue)]
    pub damm_pool_authority: UncheckedAccount<'info>,
    /// CHECK: DAMM event authority.
    #[account(address = meteora::DAMM_EVENT_AUTHORITY @ FumpadError::WrongVenue)]
    pub damm_event_authority: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 program.
    #[account(address = DAMM_V2_PROGRAM_ID @ FumpadError::WrongVenue)]
    pub damm_program: UncheckedAccount<'info>,
    /// CHECK: as in `claim_fees`: the snapshot's policy wallet, required iff `coin.fee_policy_kind != 0`, else the
    /// fumpad program id (= None).
    #[account(mut)]
    pub fee_wallet: Option<UncheckedAccount<'info>>,
}

pub fn handle_claim_lp_fees(ctx: Context<ClaimLpFees>) -> Result<()> {
    let a = &ctx.accounts;
    require!(a.coin.status == CoinStatus::Graduated, FumpadError::WrongCoinStatus);
    require!(a.coin.launch_fees_settled, FumpadError::LaunchFeesUnsettled);
    let pool = meteora::read_damm_pool(&a.damm_pool)?;
    require_keys_eq!(pool.token_a_vault, a.damm_token_a_vault.key(), FumpadError::WrongVenue);
    require_keys_eq!(pool.token_b_vault, a.damm_token_b_vault.key(), FumpadError::WrongVenue);
    let position = meteora::read_damm_position(&a.damm_position)?;
    require_keys_eq!(position.pool, a.damm_pool.key(), FumpadError::WrongVenue);
    require_keys_eq!(
        a.position_nft_account.key(),
        meteora::damm_position_nft_account(&position.nft_mint),
        FumpadError::WrongVenue
    );

    let (caller, fee_claimer, fee_wsol) =
        (a.caller.to_account_info(), a.fee_claimer.to_account_info(), a.fee_wsol.to_account_info());
    let (system, token_program) = (a.system_program.to_account_info(), a.token_program.to_account_info());
    open_fee_wsol(&caller, &fee_wsol, ctx.bumps.fee_wsol, &fee_claimer, &a.wsol_mint.to_account_info(), &system, &token_program)?;

    let accounts = [
        a.damm_pool_authority.to_account_info(),
        a.damm_pool.to_account_info(),
        a.damm_position.to_account_info(),
        a.reward_vault.to_account_info(),
        fee_wsol.clone(),
        a.damm_token_a_vault.to_account_info(),
        a.damm_token_b_vault.to_account_info(),
        a.mint.to_account_info(),
        a.wsol_mint.to_account_info(),
        a.position_nft_account.to_account_info(),
        fee_claimer.clone(),
        a.token_2022_program.to_account_info(),
        token_program.clone(),
        a.damm_event_authority.to_account_info(),
        a.damm_program.to_account_info(),
    ];
    let seeds: &[&[u8]] = &[FEE_CLAIMER_SEED, &[ctx.bumps.fee_claimer]];
    meteora::invoke_passthrough(
        &a.damm_program.to_account_info(),
        &accounts,
        meteora::IX_DAMM_CLAIM_POSITION_FEE.to_vec(),
        Some((&fee_claimer.key(), seeds)),
    )?;

    let wallet = policy_wallet(&a.coin, &a.fee_wallet)?;
    let (claimed, rent) = close_fee_wsol(&fee_wsol, &fee_claimer, ctx.bumps.fee_claimer, &token_program)?;
    let split = apply_split(&mut ctx.accounts.coin, claimed, false, wallet.as_ref().map(|w| w.1))?;
    let a = &ctx.accounts;
    let fee_wallet = pay_out(
        &a.coin.to_account_info(),
        &caller,
        &fee_claimer,
        ctx.bumps.fee_claimer,
        &system,
        &split,
        rent,
        wallet.as_ref().map(|w| &w.0),
    )?;
    record_wallet_paid(&ctx.accounts.coin, split.wallet)?;
    let ts = Clock::get()?.unix_timestamp;
    let mint = ctx.accounts.coin.mint;
    emit_event!(ctx, FeesClaimed {
        mint,
        venue: meteora::VENUE_DAMM,
        claimed,
        to_buyback: split.buyback,
        to_platform: split.platform,
        to_creator: split.creator,
        launch_window: false,
        ts,
        to_wallet: split.wallet,
        fee_wallet
    });
    Ok(())
}
