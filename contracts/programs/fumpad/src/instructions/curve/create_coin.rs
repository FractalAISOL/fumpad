use anchor_lang::{prelude::*, system_program};
use anchor_spl::{
    token_2022::{spl_token_2022::instruction::AuthorityType, Token2022},
    token_interface::{
        self, spl_pod::optional_keys::OptionalNonZeroPubkey, spl_token_metadata_interface::state::TokenMetadata,
        Mint, MintTo, SetAuthority, TokenAccount, TokenMetadataInitialize, TokenMetadataUpdateAuthority,
    },
};

use super::{MAX_NAME_LEN, MAX_SYMBOL_LEN, MAX_URI_LEN};
use crate::{
    constants::*,
    error::FumpadError,
    events::CoinCreated,
    math::{price::price_q64, reference::ReferencePrice},
    state::{Coin, CoinStatus, Global, PAUSE_LAUNCH},
};

/// Launch a coin: Token-2022 mint (metadata pointer + token metadata, both immutable;
/// no freeze authority), full supply minted to the reward vault and the curve vault,
/// mint authority revoked. The creator pays all rent.
#[event_cpi]
#[derive(Accounts)]
pub struct CreateCoin<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,

    /// Fresh keypair (allows vanity mints). Metadata lives in the mint itself.
    #[account(
        init,
        payer = creator,
        mint::decimals = TOKEN_DECIMALS,
        mint::authority = mint_authority,
        mint::token_program = token_program,
        extensions::metadata_pointer::metadata_address = mint,
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: PDA; mint + metadata authority during this instruction only (both revoked).
    #[account(seeds = [MINT_AUTHORITY_SEED], bump)]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = creator,
        space = 8 + Coin::INIT_SPACE,
        seeds = [COIN_SEED, mint.key().as_ref()],
        bump,
    )]
    pub coin: Box<Account<'info, Coin>>,

    /// CHECK: PDA; token authority of both vaults and creator of the PumpSwap pool.
    #[account(seeds = [POOL_AUTHORITY_SEED], bump)]
    pub pool_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = creator,
        seeds = [REWARD_VAULT_SEED, mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = pool_authority,
        token::token_program = token_program,
    )]
    pub reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,
        payer = creator,
        seeds = [CURVE_VAULT_SEED, mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = pool_authority,
        token::token_program = token_program,
    )]
    pub curve_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_coin(ctx: Context<CreateCoin>, name: String, symbol: String, uri: String) -> Result<()> {
    let a = &mut *ctx.accounts;
    let p = a.global.params;
    require!(!a.global.is_paused(PAUSE_LAUNCH), FumpadError::Paused);
    require!(
        name.len() <= MAX_NAME_LEN && symbol.len() <= MAX_SYMBOL_LEN && uri.len() <= MAX_URI_LEN,
        FumpadError::MetadataTooLong
    );
    require!(!name.trim().is_empty() && !symbol.trim().is_empty(), FumpadError::EmptyMetadata);

    let mint_key = a.mint.key();
    let token_program = a.token_program.key();
    let ma_bump = [ctx.bumps.mint_authority];
    let ma_seeds: &[&[u8]] = &[MINT_AUTHORITY_SEED, &ma_bump];
    let signer: &[&[&[u8]]] = &[ma_seeds];

    // ── Token metadata (stored in the mint; Token-2022 reallocs, we pre-fund rent) ──
    let meta = TokenMetadata {
        update_authority: OptionalNonZeroPubkey::try_from(Some(a.mint_authority.key()))?,
        mint: mint_key,
        name: name.clone(),
        symbol: symbol.clone(),
        uri: uri.clone(),
        additional_metadata: vec![],
    };
    let mint_info = a.mint.to_account_info();
    let new_len = mint_info.data_len().checked_add(meta.tlv_size_of()?).ok_or(FumpadError::MathOverflow)?;
    let needed = Rent::get()?.minimum_balance(new_len).saturating_sub(mint_info.lamports());
    if needed > 0 {
        system_program::transfer(
            CpiContext::new(
                a.system_program.key(),
                system_program::Transfer { from: a.creator.to_account_info(), to: mint_info.clone() },
            ),
            needed,
        )?;
    }
    token_interface::token_metadata_initialize(
        CpiContext::new_with_signer(
            token_program,
            TokenMetadataInitialize {
                program_id: a.token_program.to_account_info(),
                metadata: mint_info.clone(),
                update_authority: a.mint_authority.to_account_info(),
                mint_authority: a.mint_authority.to_account_info(),
                mint: mint_info.clone(),
            },
            signer,
        ),
        name.clone(),
        symbol.clone(),
        uri.clone(),
    )?;
    // Immutable metadata: no instruction could ever use the authority anyway.
    token_interface::token_metadata_update_authority(
        CpiContext::new_with_signer(
            token_program,
            TokenMetadataUpdateAuthority {
                program_id: a.token_program.to_account_info(),
                metadata: mint_info.clone(),
                current_authority: a.mint_authority.to_account_info(),
                new_authority: a.mint_authority.to_account_info(), // unused by the CPI builder
            },
            signer,
        ),
        OptionalNonZeroPubkey::default(),
    )?;

    // ── Supply ──
    let lp_and_curve = p.curve_supply.checked_add(p.lp_supply).ok_or(FumpadError::MathOverflow)?;
    for (to, amount) in [
        (a.reward_vault.to_account_info(), p.reward_pool_supply),
        (a.curve_vault.to_account_info(), lp_and_curve),
    ] {
        if amount > 0 {
            token_interface::mint_to(
                CpiContext::new_with_signer(
                    token_program,
                    MintTo { mint: mint_info.clone(), to, authority: a.mint_authority.to_account_info() },
                    signer,
                ),
                amount,
            )?;
        }
    }
    token_interface::set_authority(
        CpiContext::new_with_signer(
            token_program,
            SetAuthority { current_authority: a.mint_authority.to_account_info(), account_or_mint: mint_info },
            signer,
        ),
        AuthorityType::MintTokens,
        None,
    )?;

    // ── Coin ──
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let creator = a.creator.key();
    let coin = &mut a.coin;
    coin.bump = ctx.bumps.coin;
    coin.mint = mint_key;
    coin.creator = creator;
    coin.status = CoinStatus::Curve;
    coin.created_at = now;
    coin.virtual_sol_reserves = p.initial_virtual_sol;
    coin.virtual_token_reserves = p.initial_virtual_token;
    coin.real_sol_reserves = 0;
    coin.real_token_reserves = p.curve_supply;
    coin.completed_at = 0;
    coin.graduated_at = 0;
    coin.amm_pool = Pubkey::default();
    coin.creator_fees_unclaimed = 0;
    coin.platform_fees_unclaimed = 0;
    coin.buyback_lamports = 0;
    coin.volume_lamports = 0;
    coin.trade_count = 0;
    coin.tickets_created = 0;
    coin.tokens_paid_out = 0;
    // D10: the reference starts at the initial curve price.
    let initial_spot =
        price_q64(p.initial_virtual_sol, p.initial_virtual_token).ok_or(FumpadError::MathOverflow)?;
    coin.reference = ReferencePrice::new(initial_spot, now);
    // D14: fee params are fixed per coin at launch.
    coin.fees = p.coin_fees();
    // D19: launch slot + snipe schedule, likewise fixed at launch.
    coin.snipe = p.snipe_config(clock.slot);
    coin.reserved = [0; 60];

    emit_cpi!(CoinCreated { mint: mint_key, creator, name, symbol, uri, ts: now });
    Ok(())
}
