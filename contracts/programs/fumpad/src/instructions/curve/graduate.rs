use anchor_lang::{prelude::*, system_program};
use anchor_spl::{
    associated_token::{get_associated_token_address_with_program_id, AssociatedToken},
    token::Token,
    token_2022::{
        spl_token_2022::{extension::StateWithExtensions, state::Account as SplTokenAccount},
        Token2022,
    },
    token_interface::{self, Burn, CloseAccount, Mint, SyncNative, TokenAccount},
};

use crate::{
    constants::*,
    error::FumpadError,
    events::Graduated,
    external::pumpswap::{self, lp_mint_pda, pool_pda, CreatePoolAccounts, CreatePoolArgs, WSOL_MINT},
    state::{Coin, CoinStatus, Global},
};

/// PumpSwap pool index used for every FUMPAD pool.
pub const POOL_INDEX: u16 = 0;
/// Lamports the caller lends the pool authority PDA to pay the rent of the accounts
/// PumpSwap creates (pool, LP mint, pool vaults, LP token account). The unused part is
/// returned in the same instruction; the caller ends up paying only the actual rent.
pub const GRADUATION_RENT_BUDGET: u64 = 50_000_000;

/// Permissionless: move a completed curve's liquidity into a new PumpSwap pool
/// (index 0, creator = pool authority PDA, quote = WSOL, no coin creator) and burn
/// every LP token received.
///
/// Liquidity: base = the curve vault's whole balance (= lp_supply minted at launch,
/// since the curve is empty), quote = real_sol_reserves − graduation_fee_lamports.
/// The graduation fee is credited to `platform_fees_unclaimed`. The caller (`payer`)
/// pays PumpSwap's account rent (see `GRADUATION_RENT_BUDGET`).
///
/// remaining_accounts: appended verbatim to the PumpSwap CPI (forward compatibility).
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

    /// Pool authority's WSOL account: the raised SOL is wrapped here, deposited, and
    /// the account is closed again (rent back to `payer`).
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = wsol_mint,
        associated_token::authority = pool_authority,
        associated_token::token_program = quote_token_program,
    )]
    pub pool_authority_wsol: Box<InterfaceAccount<'info, TokenAccount>>,

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
    /// created by PumpSwap, emptied (burn) and closed here.
    #[account(mut)]
    pub pool_authority_lp: UncheckedAccount<'info>,

    /// CHECK: pool's base vault (ATA); validated by PumpSwap.
    #[account(mut)]
    pub pool_base_vault: UncheckedAccount<'info>,

    /// CHECK: pool's quote vault (ATA); validated by PumpSwap.
    #[account(mut)]
    pub pool_quote_vault: UncheckedAccount<'info>,

    /// CHECK: PumpSwap event authority; validated by PumpSwap.
    pub amm_event_authority: UncheckedAccount<'info>,

    /// CHECK: the PumpSwap program.
    #[account(address = PUMPSWAP_PROGRAM_ID @ FumpadError::WrongVenue)]
    pub amm_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token2022>,
    pub quote_token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_graduate<'info>(ctx: Context<'info, Graduate<'info>>) -> Result<()> {
    let a = &mut *ctx.accounts;
    require!(a.coin.status == CoinStatus::Complete, FumpadError::WrongCoinStatus);
    let now = Clock::get()?.unix_timestamp;

    let grad_fee = a.global.params.graduation_fee_lamports;
    let quote_amount = a.coin.real_sol_reserves.checked_sub(grad_fee).ok_or(FumpadError::InsufficientReserves)?;
    require!(quote_amount > 0, FumpadError::InsufficientReserves);
    let base_amount = a.curve_vault.amount;
    require!(base_amount > 0, FumpadError::InsufficientReserves);

    // ── Account checks for everything we store, burn from or close ──
    let pa_key = a.pool_authority.key();
    let mint_key = a.mint.key();
    let pool = pool_pda(POOL_INDEX, &pa_key, &mint_key, &WSOL_MINT);
    require_keys_eq!(a.amm_pool.key(), pool, FumpadError::WrongVenue);
    let lp_mint = lp_mint_pda(&pool);
    require_keys_eq!(a.lp_mint.key(), lp_mint, FumpadError::WrongVenue);
    let lp_ata = get_associated_token_address_with_program_id(&pa_key, &lp_mint, &a.token_program.key());
    require_keys_eq!(a.pool_authority_lp.key(), lp_ata, FumpadError::InvalidAccount);

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

    // ── 3. Wrap the raised SOL in the pool authority's WSOL account ──
    transfer(a.pool_authority.to_account_info(), a.pool_authority_wsol.to_account_info(), quote_amount, true)?;
    token_interface::sync_native(CpiContext::new(
        a.quote_token_program.key(),
        SyncNative { account: a.pool_authority_wsol.to_account_info() },
    ))?;
    a.pool_authority_wsol.reload()?;
    let wsol_before = a.pool_authority_wsol.amount;
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
            user_quote_token_account: &a.pool_authority_wsol.to_account_info(),
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
        ctx.remaining_accounts,
        signer,
    )?;

    // ── 5. Verify by balance deltas ──
    a.curve_vault.reload()?;
    a.pool_authority_wsol.reload()?;
    require!(a.curve_vault.amount == 0, FumpadError::GraduationMismatch);
    require!(
        wsol_before.checked_sub(a.pool_authority_wsol.amount) == Some(quote_amount),
        FumpadError::GraduationMismatch
    );
    require_keys_eq!(*a.amm_pool.owner, PUMPSWAP_PROGRAM_ID, FumpadError::WrongVenue);

    // ── 6. Burn every LP token, close the LP account ──
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
    token_interface::burn(
        CpiContext::new_with_signer(
            a.token_program.key(),
            Burn {
                mint: a.lp_mint.to_account_info(),
                from: a.pool_authority_lp.to_account_info(),
                authority: a.pool_authority.to_account_info(),
            },
            signer,
        ),
        lp_amount,
    )?;
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
            account: a.pool_authority_wsol.to_account_info(),
            destination: a.payer.to_account_info(),
            authority: a.pool_authority.to_account_info(),
        },
        signer,
    ))?;
    let leftover = a.pool_authority.lamports();
    if leftover > 0 {
        transfer(a.pool_authority.to_account_info(), a.payer.to_account_info(), leftover, true)?;
    }

    // ── 8. State ──
    let coin = &mut a.coin;
    coin.platform_fees_unclaimed =
        coin.platform_fees_unclaimed.checked_add(grad_fee).ok_or(FumpadError::MathOverflow)?;
    coin.real_sol_reserves = 0;
    coin.amm_pool = pool;
    coin.status = CoinStatus::Graduated;
    coin.graduated_at = now;

    emit_cpi!(Graduated {
        mint: mint_key,
        pool,
        sol_deposited: quote_amount,
        tokens_deposited: base_amount,
        ts: now,
    });
    Ok(())
}
