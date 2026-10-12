use anchor_lang::{prelude::*, system_program};
use anchor_spl::{
    associated_token::{get_associated_token_address_with_program_id, AssociatedToken},
    token::Token,
    token_2022::{
        spl_token_2022::{extension::StateWithExtensions, state::Account as SplTokenAccount},
        Token2022,
    },
    token_interface::{self, CloseAccount, Mint, SyncNative, TokenAccount},
};

use crate::{
    constants::*,
    error::FumpadError,
    events::Graduated,
    instructions::{rewards::init_claim_queue::CLAIM_QUEUE_SPACE, venue::init_observations::OBSERVATIONS_SPACE},
    external::pumpswap::{self, lp_mint_pda, pool_pda, token_amount, CreatePoolAccounts, CreatePoolArgs, WSOL_MINT},
    state::{Coin, CoinStatus, Global, PAUSE_GRADUATE},
};

/// PumpSwap pool index used for every FUMPAD pool.
pub const POOL_INDEX: u16 = 0;
/// Lamports the caller lends the pool authority PDA to pay the rent of the accounts
/// PumpSwap creates (pool, LP mint, pool vaults, LP token account). The unused part is
/// returned in the same instruction; the caller ends up paying only the actual rent.
pub const GRADUATION_RENT_BUDGET: u64 = 50_000_000;

/// Permissionless: move a completed curve's liquidity into a new PumpSwap pool
/// (index 0, creator = pool authority PDA, quote = WSOL, no coin creator) and lock every
/// LP token received in the immutable `fumpad_lp_locker` (D11: principal locked forever,
/// only fee growth can be skimmed — see that program's docs).
///
/// Liquidity: base = the curve vault's whole balance (= lp_supply minted at launch,
/// since the curve is empty), quote = real_sol_reserves − graduation_fee_lamports.
/// The caller (`payer`) advances PumpSwap's account rent (see `GRADUATION_RENT_BUDGET`).
///
/// D20 — the coin's snapshotted graduation fee pays the setup, in this order:
///   1. the caller's net rent for this instruction, reimbursed (≤ `GRADUATION_RENT_BUDGET`);
///   2. the observations ring's rent, pre-funded into its PDA (`init_observations` then
///      costs nothing);
///   3. the claim queue's full-size rent, pre-funded into its PDA (likewise for the 9
///      `init_claim_queue` calls);
///   4. the rest → `platform_fees_unclaimed`.
/// A fee too small for all of it leaves the shortfall to whoever runs the init calls
/// (the keeper), exactly as before D20.
///
/// L-1 (v0.6): no remaining accounts; every account of the PumpSwap `create_pool` CPI (which
/// `pool_authority` signs) is pinned here — pool, LP mint, the pool authority's LP ATA, the
/// pool vaults (ATAs of the pool) and PumpSwap's event authority — so no other account ever
/// rides along under that signature. The creator stays `pool_authority`: every existing
/// pool's address is derived from it, and the immutable locker requires it as `lock` signer.
#[event_cpi]
#[derive(Accounts)]
pub struct Graduate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,

    #[account(mut, seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump, has_one = mint)]
    pub coin: Box<Account<'info, Coin>>,

    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: PDA; PumpSwap pool creator (signer + rent payer), vault authority.
    #[account(mut, seeds = [POOL_AUTHORITY_SEED], bump)]
    pub pool_authority: UncheckedAccount<'info>,

    #[account(mut, seeds = [CURVE_VAULT_SEED, mint.key().as_ref()], bump)]
    pub curve_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = WSOL_MINT, mint::token_program = quote_token_program)]
    pub wsol_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Graduation's own WSOL account (C-L1: NOT the pool authority's ATA, which is
    /// `execute_buyback`'s persistent `buyback_wsol`): PDA ["graduation_wsol", mint],
    /// created here, the raised SOL wrapped into it and deposited, then closed again in this
    /// instruction (rent back to `payer`).
    #[account(
        init,
        payer = payer,
        seeds = [GRADUATION_WSOL_SEED, mint.key().as_ref()],
        bump,
        token::mint = wsol_mint,
        token::authority = pool_authority,
        token::token_program = quote_token_program,
    )]
    pub graduation_wsol: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: PumpSwap pool PDA, verified in the handler; created by PumpSwap.
    #[account(mut)]
    pub amm_pool: UncheckedAccount<'info>,

    /// CHECK: PumpSwap GlobalConfig.
    #[account(address = PUMPSWAP_GLOBAL_CONFIG)]
    pub amm_global_config: UncheckedAccount<'info>,

    /// CHECK: PumpSwap LP mint PDA of `amm_pool`, verified in the handler.
    #[account(mut)]
    pub lp_mint: UncheckedAccount<'info>,

    /// CHECK: pool authority's Token-2022 ATA for `lp_mint`, verified in the handler;
    /// created by PumpSwap, emptied into the locker and closed here.
    #[account(mut)]
    pub pool_authority_lp: UncheckedAccount<'info>,

    /// CHECK: pool's base vault = ATA(pool, mint, Token-2022); checked in the handler (L-1).
    #[account(mut)]
    pub pool_base_vault: UncheckedAccount<'info>,

    /// CHECK: pool's quote vault = ATA(pool, WSOL, SPL Token); checked in the handler (L-1).
    #[account(mut)]
    pub pool_quote_vault: UncheckedAccount<'info>,

    /// CHECK: PumpSwap event authority PDA; checked in the handler (L-1).
    pub amm_event_authority: UncheckedAccount<'info>,

    /// CHECK: the PumpSwap program.
    #[account(address = PUMPSWAP_PROGRAM_ID @ FumpadError::WrongVenue)]
    pub amm_program: UncheckedAccount<'info>,

    /// CHECK: locker Lock PDA ["lock", amm_pool]; created (init) and checked by the locker.
    #[account(mut)]
    pub lp_lock: UncheckedAccount<'info>,
    /// CHECK: locker authority PDA ["authority"]; checked by the locker.
    pub lp_locker_authority: UncheckedAccount<'info>,
    /// CHECK: locker LP vault = ATA(lp_locker_authority, lp_mint); created by the locker,
    /// balance verified here.
    #[account(mut)]
    pub lp_vault: UncheckedAccount<'info>,
    pub lp_locker_program: Program<'info, fumpad_lp_locker::program::FumpadLpLocker>,

    pub token_program: Program<'info, Token2022>,
    pub quote_token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,

    /// CHECK: D20 — the coin's future observations PDA ["observations", mint] (not created
    /// yet: `init_observations` requires `Graduated`); receives its rent from the
    /// graduation fee so `init_observations` costs its payer nothing.
    #[account(mut, seeds = [OBSERVATIONS_SEED, mint.key().as_ref()], bump)]
    pub observations: UncheckedAccount<'info>,
    /// CHECK: D20 — the coin's future ClaimQueue PDA ["claim_queue", mint]; pre-funded
    /// likewise for `init_claim_queue`.
    #[account(mut, seeds = [CLAIM_QUEUE_SEED, mint.key().as_ref()], bump)]
    pub claim_queue: UncheckedAccount<'info>,
}

pub fn handle_graduate<'info>(ctx: Context<'info, Graduate<'info>>) -> Result<()> {
    let a = &mut *ctx.accounts;
    require!(a.coin.status == CoinStatus::Complete, FumpadError::WrongCoinStatus);
    let now = Clock::get()?.unix_timestamp;
    // L-5 (v0.6): graduation has its own pause (e.g. a PumpSwap incident); D13 still reopens
    // the curve for sells after 7 days in `Complete`.
    require!(!a.global.is_paused(PAUSE_GRADUATE, now), FumpadError::Paused);

    // D14: the fee snapshotted at create_coin, never the current global value.
    let grad_fee = a.coin.fees.graduation_fee_lamports;
    let quote_amount = a.coin.real_sol_reserves.checked_sub(grad_fee).ok_or(FumpadError::InsufficientReserves)?;
    require!(quote_amount > 0, FumpadError::InsufficientReserves);
    let base_amount = a.curve_vault.amount;
    require!(base_amount > 0, FumpadError::InsufficientReserves);
    // D20: the caller's lamports before this instruction = now + the graduation WSOL
    // account's rent (paid by Anchor's `init` before the handler; refunded at its close).
    let payer_start = a.payer.lamports().checked_add(a.graduation_wsol.to_account_info().lamports());

    // ── Account checks for everything we store, burn from or close ──
    let pa_key = a.pool_authority.key();
    let mint_key = a.mint.key();
    let pool = pool_pda(POOL_INDEX, &pa_key, &mint_key, &WSOL_MINT);
    require_keys_eq!(a.amm_pool.key(), pool, FumpadError::WrongVenue);
    let lp_mint = lp_mint_pda(&pool);
    require_keys_eq!(a.lp_mint.key(), lp_mint, FumpadError::WrongVenue);
    let lp_ata = get_associated_token_address_with_program_id(&pa_key, &lp_mint, &a.token_program.key());
    require_keys_eq!(a.pool_authority_lp.key(), lp_ata, FumpadError::InvalidAccount);
    // L-1: pin the rest of the create_pool account list (no foreign account under our signature).
    require!(ctx.remaining_accounts.is_empty(), FumpadError::InvalidAccount);
    let base_vault = get_associated_token_address_with_program_id(&pool, &mint_key, &a.token_program.key());
    require_keys_eq!(a.pool_base_vault.key(), base_vault, FumpadError::WrongVenue);
    let quote_vault = get_associated_token_address_with_program_id(&pool, &WSOL_MINT, &a.quote_token_program.key());
    require_keys_eq!(a.pool_quote_vault.key(), quote_vault, FumpadError::WrongVenue);
    require_keys_eq!(a.amm_event_authority.key(), pumpswap::event_authority_pda(), FumpadError::WrongVenue);

    let pa_bump = [ctx.bumps.pool_authority];
    let pa_seeds: &[&[u8]] = &[POOL_AUTHORITY_SEED, &pa_bump];
    let signer: &[&[&[u8]]] = &[pa_seeds];

    let sys = a.system_program.key();
    let transfer = |from: AccountInfo<'info>, to: AccountInfo<'info>, lamports: u64, signed: bool| -> Result<()> {
        let accounts = system_program::Transfer { from, to };
        let cpi = if signed { CpiContext::new_with_signer(sys, accounts, signer) } else { CpiContext::new(sys, accounts) };
        system_program::transfer(cpi, lamports)
    };

    // ── 1. Raised SOL: coin → pool authority (direct; the coin is program-owned) ──
    // The runtime reconciles a direct lamport move only at the next CPI that includes
    // the account (or at instruction end). The 0-lamport transfer below is that CPI:
    // it includes BOTH sides, so every later CPI sees a balanced instruction.
    a.coin.sub_lamports(quote_amount)?;
    a.pool_authority.add_lamports(quote_amount)?;
    transfer(a.pool_authority.to_account_info(), a.coin.to_account_info(), 0, true)?;

    // ── 2. Lend the pool authority rent for PumpSwap's accounts ──
    transfer(a.payer.to_account_info(), a.pool_authority.to_account_info(), GRADUATION_RENT_BUDGET, false)?;

    // ── 3. Wrap the raised SOL in graduation's own WSOL account ──
    transfer(a.pool_authority.to_account_info(), a.graduation_wsol.to_account_info(), quote_amount, true)?;
    token_interface::sync_native(CpiContext::new(
        a.quote_token_program.key(),
        SyncNative { account: a.graduation_wsol.to_account_info() },
    ))?;
    a.graduation_wsol.reload()?;
    let wsol_before = a.graduation_wsol.amount;
    require!(wsol_before >= quote_amount, FumpadError::GraduationMismatch);

    // ── 4. Create the pool ──
    let system_info = a.system_program.to_account_info();
    let token_2022_info = a.token_program.to_account_info();
    let quote_program_info = a.quote_token_program.to_account_info();
    let ata_program_info = a.associated_token_program.to_account_info();
    pumpswap::create_pool(
        &CreatePoolAccounts {
            pool: &a.amm_pool.to_account_info(),
            global_config: &a.amm_global_config.to_account_info(),
            creator: &a.pool_authority.to_account_info(),
            base_mint: &a.mint.to_account_info(),
            quote_mint: &a.wsol_mint.to_account_info(),
            lp_mint: &a.lp_mint.to_account_info(),
            user_base_token_account: &a.curve_vault.to_account_info(),
            user_quote_token_account: &a.graduation_wsol.to_account_info(),
            user_pool_token_account: &a.pool_authority_lp.to_account_info(),
            pool_base_token_account: &a.pool_base_vault.to_account_info(),
            pool_quote_token_account: &a.pool_quote_vault.to_account_info(),
            system_program: &system_info,
            token_2022_program: &token_2022_info,
            base_token_program: &token_2022_info,
            quote_token_program: &quote_program_info,
            associated_token_program: &ata_program_info,
            event_authority: &a.amm_event_authority.to_account_info(),
            program: &a.amm_program.to_account_info(),
        },
        &CreatePoolArgs {
            index: POOL_INDEX,
            base_amount_in: base_amount,
            quote_amount_in: quote_amount,
            coin_creator: Pubkey::default(),
            is_mayhem_mode: false,
            is_cashback_coin: false,
            creator_fee_bps: 0,
            can_edit_creator_fee: false,
            is_holder_reward: false,
        },
        signer,
    )?;

    // ── 5. Verify by balance deltas ──
    a.curve_vault.reload()?;
    a.graduation_wsol.reload()?;
    require!(a.curve_vault.amount == 0, FumpadError::GraduationMismatch);
    require!(
        wsol_before.checked_sub(a.graduation_wsol.amount) == Some(quote_amount),
        FumpadError::GraduationMismatch
    );
    require_keys_eq!(*a.amm_pool.owner, PUMPSWAP_PROGRAM_ID, FumpadError::WrongVenue);

    // ── 6. Lock every LP token in the immutable locker, close the LP account ──
    let lp_amount = {
        let info = a.pool_authority_lp.to_account_info();
        require_keys_eq!(*info.owner, a.token_program.key(), FumpadError::InvalidAccount);
        let data = info.try_borrow_data()?;
        let acct = StateWithExtensions::<SplTokenAccount>::unpack(&data)?;
        require_keys_eq!(acct.base.mint, lp_mint, FumpadError::InvalidAccount);
        require_keys_eq!(acct.base.owner, pa_key, FumpadError::InvalidAccount);
        acct.base.amount
    };
    require!(lp_amount > 0, FumpadError::GraduationMismatch);
    fumpad_lp_locker::cpi::lock(CpiContext::new_with_signer(
        a.lp_locker_program.key(),
        fumpad_lp_locker::cpi::accounts::LockLp {
            payer: a.payer.to_account_info(),
            fumpad_authority: a.pool_authority.to_account_info(),
            pool: a.amm_pool.to_account_info(),
            lp_mint: a.lp_mint.to_account_info(),
            source_lp: a.pool_authority_lp.to_account_info(),
            lock: a.lp_lock.to_account_info(),
            authority: a.lp_locker_authority.to_account_info(),
            lp_vault: a.lp_vault.to_account_info(),
            pool_base_vault: a.pool_base_vault.to_account_info(),
            pool_quote_vault: a.pool_quote_vault.to_account_info(),
            token_program: a.token_program.to_account_info(),
            associated_token_program: a.associated_token_program.to_account_info(),
            system_program: a.system_program.to_account_info(),
        },
        signer,
    ))?;
    require_keys_eq!(*a.lp_vault.owner, a.token_program.key(), FumpadError::GraduationMismatch);
    require!(token_amount(&a.lp_vault.to_account_info())? == lp_amount, FumpadError::GraduationMismatch);
    token_interface::close_account(CpiContext::new_with_signer(
        a.token_program.key(),
        CloseAccount {
            account: a.pool_authority_lp.to_account_info(),
            destination: a.payer.to_account_info(),
            authority: a.pool_authority.to_account_info(),
        },
        signer,
    ))?;

    // ── 7. Close the (now empty) WSOL account and return the unused rent budget ──
    token_interface::close_account(CpiContext::new_with_signer(
        a.quote_token_program.key(),
        CloseAccount {
            account: a.graduation_wsol.to_account_info(),
            destination: a.payer.to_account_info(),
            authority: a.pool_authority.to_account_info(),
        },
        signer,
    ))?;
    let leftover = a.pool_authority.lamports();
    if leftover > 0 {
        transfer(a.pool_authority.to_account_info(), a.payer.to_account_info(), leftover, true)?;
    }

    // ── 8. D20: spend the graduation fee on the setup rent; the rest → platform fees ──
    // Every CPI is done, so these direct lamport moves need no reconciling CPI (emit_event
    // below touches none of these accounts). Nothing here can exceed `grad_fee`, and every
    // lamport goes either to accounts only FUMPAD can ever spend (the two PDAs, which only
    // `init_observations` / `init_claim_queue` can turn into this coin's ring and queue) or
    // back to the caller for exactly the rent it paid — calling `graduate` can't profit.
    let rent = Rent::get()?;
    let mut left = grad_fee;
    // a) The caller's net rent (PumpSwap pool, LP mint, pool vaults, Lock, LP vault),
    //    measured as its lamport delta over this instruction; capped by the rent budget.
    let payer_cost = payer_start
        .ok_or(FumpadError::MathOverflow)?
        .saturating_sub(a.payer.lamports())
        .min(GRADUATION_RENT_BUDGET);
    let caller_refund = payer_cost.min(left);
    left -= caller_refund;
    // b) Rent of the observations ring and the claim queue, pre-funded into their PDAs.
    let obs_info = a.observations.to_account_info();
    let queue_info = a.claim_queue.to_account_info();
    let obs_fund = prefund_amount(&rent, &obs_info, OBSERVATIONS_SPACE, left);
    left -= obs_fund;
    let queue_fund = prefund_amount(&rent, &queue_info, CLAIM_QUEUE_SPACE, left);
    left -= queue_fund;
    let setup_prefunded = obs_fund + queue_fund;
    let out = caller_refund + setup_prefunded;
    if out > 0 {
        a.coin.sub_lamports(out)?;
        if caller_refund > 0 {
            a.payer.add_lamports(caller_refund)?;
        }
        if obs_fund > 0 {
            obs_info.add_lamports(obs_fund)?;
        }
        if queue_fund > 0 {
            queue_info.add_lamports(queue_fund)?;
        }
    }

    // ── 9. State ──
    let coin = &mut a.coin;
    // Remainder of the fee (still in the coin account) → platform fees.
    coin.platform_fees_unclaimed = coin.platform_fees_unclaimed.checked_add(left).ok_or(FumpadError::MathOverflow)?;
    coin.real_sol_reserves = 0;
    coin.amm_pool = pool;
    coin.status = CoinStatus::Graduated;
    coin.graduated_at = now;

    emit_event!(ctx, Graduated {
        mint: mint_key,
        pool,
        sol_deposited: quote_amount,
        tokens_deposited: base_amount,
        lp_locked: lp_amount,
        ts: now,
        caller_refund,
        setup_prefunded,
        platform_fee: left,
    });
    Ok(())
}

/// D20: lamports to pre-fund into a not-yet-created PDA so that it holds the rent of
/// `space` bytes — at most `budget`. 0 if the account already exists (not system-owned or
/// has data; impossible before graduation) or if the amount would leave a fresh account
/// below the rent-exempt minimum (the transfer would fail).
fn prefund_amount(rent: &Rent, acct: &AccountInfo, space: usize, budget: u64) -> u64 {
    if acct.owner != &system_program::ID || !acct.data_is_empty() {
        return 0;
    }
    let have = acct.lamports();
    let x = rent.minimum_balance(space).saturating_sub(have).min(budget);
    if x == 0 || have.saturating_add(x) < rent.minimum_balance(0) {
        return 0;
    }
    x
}
