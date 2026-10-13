//! fumpad_dbc_spike — DEVNET feasibility spike, NOT production code.
//!
//! Proves that a FUMPAD program can sit in front of Meteora DBC / DAMM v2 via raw CPI
//! (no Meteora crates; discriminators hard-coded from their IDLs):
//!   * `routed_swap`      — user-signed buy/sell on DBC (curve) or DAMM v2 (graduated pool); the exact
//!                          amounts in/out are measured as balance deltas of the user's token accounts
//!                          (what ticket logic needs) and returned via return-data + an event.
//!   * `claim_and_split`  — claims partner trading fees on DBC (`claim_trading_fee`) or position fees on
//!                          DAMM v2 (`claim_position_fee`) with the `["fee_claimer"]` PDA as signer, then splits
//!                          the claimed quote 50/30/20 (buyback / platform / creator) in the same instruction.
//!   * `buyback_swap`     — same as routed_swap but the payer is the `["buyback"]` PDA (fee-funded buyback).
//!   * `pay_reward`       — pays tokens out of the reward pool (ATA of the `["reward_pool"]` PDA = DBC
//!                          `leftover_receiver`) with the PDA as signer (Token-2022 transfer_checked).
//!   * `read_price`       — reads sqrt_price straight from DBC VirtualPool / DAMM v2 Pool account bytes.
//!
//! Spike shortcuts (documented in REPORT.md): CPI account lists are passed through `remaining_accounts`
//! and only the program id + discriminator + the accounts we measure are validated; no admin, no state.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed, set_return_data},
};

declare_id!("8zt6gZTFwn6Dn5YRhu7jsywR5tQnZZCx1YmrbqLVTbeW");

pub const DBC_PROGRAM: Pubkey = pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
pub const DAMM_V2_PROGRAM: Pubkey = pubkey!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
pub const SPL_TOKEN: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

// sha256("global:<name>")[..8]
pub const IX_SWAP: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];
pub const IX_SWAP2: [u8; 8] = [65, 75, 63, 76, 235, 91, 91, 136];
pub const IX_DBC_CLAIM_TRADING_FEE: [u8; 8] = [8, 236, 89, 49, 152, 125, 177, 81];
pub const IX_DAMM_CLAIM_POSITION_FEE: [u8; 8] = [180, 38, 154, 17, 133, 33, 162, 211];

// sqrt_price byte offsets inside the account data (8-byte Anchor discriminator included).
// DBC VirtualPool: VolatilityTracker(64) + 5 pubkeys(160) + 6 u64(48) => 272 (+8)
pub const DBC_POOL_SQRT_PRICE_OFFSET: usize = 8 + 272;
// DAMM v2 Pool: PoolFeesStruct(160) + 5 pubkeys(160) + pad(32) + liquidity(16) + pad(16) + 3 u64 + pad(8)
//               + sqrt_min(16) + sqrt_max(16) => 448 (+8)
pub const DAMM_POOL_SQRT_PRICE_OFFSET: usize = 8 + 448;

pub const FEE_CLAIMER_SEED: &[u8] = b"fee_claimer";
pub const REWARD_POOL_SEED: &[u8] = b"reward_pool";
pub const BUYBACK_SEED: &[u8] = b"buyback";

#[program]
pub mod fumpad_dbc_spike {
    use super::*;

    /// User-signed swap on DBC or DAMM v2 through FUMPAD. `data` is the venue's swap/swap2 instruction data;
    /// remaining_accounts = the venue's exact account list. `in_idx`/`out_idx` index the user's input/output
    /// token accounts inside remaining_accounts.
    pub fn routed_swap<'info>(
        ctx: Context<'info, RoutedSwap<'info>>,
        data: Vec<u8>,
        in_idx: u8,
        out_idx: u8,
    ) -> Result<()> {
        let venue = check_swap_target(&ctx.accounts.target_program.key(), &data)?;
        let rem = ctx.remaining_accounts;
        let (input, output) = (&rem[in_idx as usize], &rem[out_idx as usize]);
        require_keys_eq!(token_owner(input)?, ctx.accounts.user.key(), SpikeError::NotUserAccount);
        require_keys_eq!(token_owner(output)?, ctx.accounts.user.key(), SpikeError::NotUserAccount);
        let (spent, received) = measured_cpi(&ctx.accounts.target_program, rem, data, input, output, None)?;
        finish_swap(venue, ctx.accounts.user.key(), input, output, spent, received)
    }

    /// Fee-funded buyback: same as `routed_swap` but the venue's payer is the `["buyback"]` PDA.
    /// The output account may be the reward pool's ATA (tokens bought land directly in the reward pool).
    pub fn buyback_swap<'info>(
        ctx: Context<'info, BuybackSwap<'info>>,
        data: Vec<u8>,
        in_idx: u8,
        out_idx: u8,
    ) -> Result<()> {
        let venue = check_swap_target(&ctx.accounts.target_program.key(), &data)?;
        let rem = ctx.remaining_accounts;
        let (input, output) = (&rem[in_idx as usize], &rem[out_idx as usize]);
        require_keys_eq!(token_owner(input)?, ctx.accounts.buyback.key(), SpikeError::NotUserAccount);
        let bump = ctx.bumps.buyback;
        let seeds: &[&[u8]] = &[BUYBACK_SEED, &[bump]];
        let (spent, received) =
            measured_cpi(&ctx.accounts.target_program, rem, data, input, output, Some((ctx.accounts.buyback.key(), seeds)))?;
        finish_swap(venue, ctx.accounts.buyback.key(), input, output, spent, received)
    }

    /// Claim partner fees (DBC `claim_trading_fee`) or locked-position fees (DAMM v2 `claim_position_fee`)
    /// with the fee_claimer PDA as signer, then split the claimed quote 50/30/20 in the same instruction.
    pub fn claim_and_split<'info>(
        ctx: Context<'info, ClaimAndSplit<'info>>,
        data: Vec<u8>,
        base_idx: u8,
        quote_idx: u8,
    ) -> Result<()> {
        let target = ctx.accounts.target_program.key();
        require!(data.len() >= 8, SpikeError::BadInstruction);
        let disc: [u8; 8] = data[..8].try_into().unwrap();
        require!(
            (target == DBC_PROGRAM && disc == IX_DBC_CLAIM_TRADING_FEE)
                || (target == DAMM_V2_PROGRAM && disc == IX_DAMM_CLAIM_POSITION_FEE),
            SpikeError::BadInstruction
        );
        let rem = ctx.remaining_accounts;
        let base_acc = &rem[base_idx as usize];
        let quote_acc = &rem[quote_idx as usize];
        require_keys_eq!(quote_acc.key(), ctx.accounts.fee_quote.key(), SpikeError::BadAccount);
        let fee_claimer = ctx.accounts.fee_claimer.key();
        require_keys_eq!(token_owner(base_acc)?, fee_claimer, SpikeError::BadAccount);

        let bump = ctx.bumps.fee_claimer;
        let seeds: &[&[u8]] = &[FEE_CLAIMER_SEED, &[bump]];
        // measured_cpi returns (a_before - a_after, b_after - b_before): for a claim both balances grow,
        // so the base delta comes back negated.
        let (neg_base, quote_delta) =
            measured_cpi(&ctx.accounts.target_program, rem, data, base_acc, quote_acc, Some((fee_claimer, seeds)))?;
        let base_claimed = u64::try_from(-neg_base).map_err(|_| SpikeError::BadAccount)?;
        let quote_claimed = u64::try_from(quote_delta).map_err(|_| SpikeError::BadAccount)?;

        // 50 / 30 / 20 split of the claimed quote (rounding dust stays with the creator share's remainder logic)
        let to_buyback = quote_claimed / 2;
        let to_platform = quote_claimed * 3 / 10;
        let to_creator = quote_claimed - to_buyback - to_platform;
        let mint = &ctx.accounts.quote_mint;
        for (dst, amt) in [
            (&ctx.accounts.buyback_quote, to_buyback),
            (&ctx.accounts.platform_quote, to_platform),
            (&ctx.accounts.creator_quote, to_creator),
        ] {
            if amt == 0 {
                continue;
            }
            let ix = spl_transfer_checked(
                &ctx.accounts.quote_token_program.key(),
                &ctx.accounts.fee_quote.key(),
                &mint.key(),
                &dst.key(),
                &fee_claimer,
                amt,
                9,
            );
            invoke_signed(
                &ix,
                &[
                    ctx.accounts.fee_quote.to_account_info(),
                    mint.to_account_info(),
                    dst.to_account_info(),
                    ctx.accounts.fee_claimer.to_account_info(),
                    ctx.accounts.quote_token_program.to_account_info(),
                ],
                &[seeds],
            )?;
        }
        msg!(
            "FUMPAD_CLAIM venue={} quote_claimed={} buyback={} platform={} creator={} base_claimed={}",
            if target == DBC_PROGRAM { "dbc" } else { "damm_v2" },
            quote_claimed,
            to_buyback,
            to_platform,
            to_creator,
            base_claimed
        );
        emit!(FeesSplit { venue: venue_id(&target), quote_claimed, base_claimed, to_buyback, to_platform, to_creator });
        Ok(())
    }

    /// Pay `amount` base tokens out of the reward pool (ATA of the ["reward_pool"] PDA, which is the DBC
    /// config's leftover_receiver) to `destination` — the payout path of a fumble-ticket claim.
    pub fn pay_reward(ctx: Context<PayReward>, amount: u64) -> Result<()> {
        let bump = ctx.bumps.reward_pool;
        let seeds: &[&[u8]] = &[REWARD_POOL_SEED, &[bump]];
        let ix = spl_transfer_checked(
            &ctx.accounts.token_program.key(),
            &ctx.accounts.reward_vault.key(),
            &ctx.accounts.mint.key(),
            &ctx.accounts.destination.key(),
            &ctx.accounts.reward_pool.key(),
            amount,
            ctx.accounts.decimals(),
        );
        invoke_signed(
            &ix,
            &[
                ctx.accounts.reward_vault.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.destination.to_account_info(),
                ctx.accounts.reward_pool.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
            &[seeds],
        )?;
        msg!("FUMPAD_PAY_REWARD amount={}", amount);
        Ok(())
    }

    /// Read the spot sqrt_price (Q64.64, raw units) of a DBC virtual pool or DAMM v2 pool from account bytes.
    pub fn read_price(ctx: Context<ReadPrice>) -> Result<()> {
        let pool = &ctx.accounts.pool;
        let owner = *pool.owner;
        let off = if owner == DBC_PROGRAM {
            DBC_POOL_SQRT_PRICE_OFFSET
        } else if owner == DAMM_V2_PROGRAM {
            DAMM_POOL_SQRT_PRICE_OFFSET
        } else {
            return err!(SpikeError::BadAccount);
        };
        let data = pool.try_borrow_data()?;
        let sqrt_price = u128::from_le_bytes(data[off..off + 16].try_into().unwrap());
        msg!("FUMPAD_PRICE venue={} sqrt_price_x64={}", venue_id(&owner), sqrt_price);
        set_return_data(&sqrt_price.to_le_bytes());
        Ok(())
    }
}

fn venue_id(p: &Pubkey) -> u8 {
    if *p == DBC_PROGRAM {
        0
    } else {
        1
    }
}

fn check_swap_target(target: &Pubkey, data: &[u8]) -> Result<u8> {
    require!(*target == DBC_PROGRAM || *target == DAMM_V2_PROGRAM, SpikeError::BadProgram);
    require!(data.len() >= 8, SpikeError::BadInstruction);
    let disc: [u8; 8] = data[..8].try_into().unwrap();
    require!(disc == IX_SWAP || disc == IX_SWAP2, SpikeError::BadInstruction);
    Ok(venue_id(target))
}

fn finish_swap(venue: u8, trader: Pubkey, input: &AccountInfo, output: &AccountInfo, spent: i128, received: i128) -> Result<()> {
    require!(spent > 0 && received > 0, SpikeError::NoFill);
    let (spent, received) = (spent as u64, received as u64);
    let slot = Clock::get()?.slot;
    msg!(
        "FUMPAD_SWAP venue={} trader={} in_mint={} out_mint={} spent={} received={} slot={}",
        if venue == 0 { "dbc" } else { "damm_v2" },
        trader,
        token_mint(input)?,
        token_mint(output)?,
        spent,
        received,
        slot
    );
    let mut rd = [0u8; 16];
    rd[..8].copy_from_slice(&spent.to_le_bytes());
    rd[8..].copy_from_slice(&received.to_le_bytes());
    set_return_data(&rd);
    emit!(RoutedSwapMeasured { venue, trader, in_mint: token_mint(input)?, out_mint: token_mint(output)?, spent, received, slot });
    Ok(())
}

/// Invoke `target` with `rem` as the account list (optionally signing for `pda`), returning
/// (a_before - a_after, b_after - b_before) measured on two token accounts.
fn measured_cpi<'info>(
    target: &AccountInfo<'info>,
    rem: &[AccountInfo<'info>],
    data: Vec<u8>,
    a: &AccountInfo<'info>,
    b: &AccountInfo<'info>,
    pda: Option<(Pubkey, &[&[u8]])>,
) -> Result<(i128, i128)> {
    let a0 = token_amount(a)? as i128;
    let b0 = token_amount(b)? as i128;
    let metas: Vec<AccountMeta> = rem
        .iter()
        .map(|acc| AccountMeta {
            pubkey: acc.key(),
            is_signer: acc.is_signer || pda.map(|(k, _)| k == acc.key()).unwrap_or(false),
            is_writable: acc.is_writable,
        })
        .collect();
    let ix = Instruction { program_id: target.key(), accounts: metas, data };
    let mut infos: Vec<AccountInfo<'info>> = rem.to_vec();
    infos.push(target.clone());
    match pda {
        Some((_, seeds)) => invoke_signed(&ix, &infos, &[seeds])?,
        None => invoke(&ix, &infos)?,
    }
    let a1 = token_amount(a)? as i128;
    let b1 = token_amount(b)? as i128;
    Ok((a0 - a1, b1 - b0))
}

fn check_token_account(acc: &AccountInfo) -> Result<()> {
    require!(*acc.owner == SPL_TOKEN || *acc.owner == TOKEN_2022, SpikeError::BadAccount);
    require!(acc.data_len() >= 165, SpikeError::BadAccount);
    Ok(())
}
fn token_amount(acc: &AccountInfo) -> Result<u64> {
    check_token_account(acc)?;
    let d = acc.try_borrow_data()?;
    Ok(u64::from_le_bytes(d[64..72].try_into().unwrap()))
}
fn token_owner(acc: &AccountInfo) -> Result<Pubkey> {
    check_token_account(acc)?;
    let d = acc.try_borrow_data()?;
    Ok(Pubkey::new_from_array(d[32..64].try_into().unwrap()))
}
fn token_mint(acc: &AccountInfo) -> Result<Pubkey> {
    check_token_account(acc)?;
    let d = acc.try_borrow_data()?;
    Ok(Pubkey::new_from_array(d[0..32].try_into().unwrap()))
}

/// spl-token / token-2022 TransferChecked (tag 12) built by hand (same wire format for both programs).
fn spl_transfer_checked(program: &Pubkey, src: &Pubkey, mint: &Pubkey, dst: &Pubkey, auth: &Pubkey, amount: u64, decimals: u8) -> Instruction {
    let mut data = vec![12u8];
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    Instruction {
        program_id: *program,
        accounts: vec![
            AccountMeta::new(*src, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new(*dst, false),
            AccountMeta::new_readonly(*auth, true),
        ],
        data,
    }
}

#[derive(Accounts)]
pub struct RoutedSwap<'info> {
    pub user: Signer<'info>,
    /// CHECK: validated in handler (DBC or DAMM v2 program id)
    pub target_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct BuybackSwap<'info> {
    /// CHECK: PDA signer for the venue's `payer`
    #[account(seeds = [BUYBACK_SEED], bump)]
    pub buyback: UncheckedAccount<'info>,
    /// CHECK: validated in handler
    pub target_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ClaimAndSplit<'info> {
    /// CHECK: PDA = DBC config fee_claimer = owner of the migrated DAMM v2 position NFT
    #[account(seeds = [FEE_CLAIMER_SEED], bump)]
    pub fee_claimer: UncheckedAccount<'info>,
    /// CHECK: validated in handler
    pub target_program: UncheckedAccount<'info>,
    /// CHECK: fee_claimer's quote (WSOL) token account; must be the venue's quote destination
    #[account(mut)]
    pub fee_quote: UncheckedAccount<'info>,
    /// CHECK: 50% destination (buyback PDA's WSOL account)
    #[account(mut)]
    pub buyback_quote: UncheckedAccount<'info>,
    /// CHECK: 30% destination
    #[account(mut)]
    pub platform_quote: UncheckedAccount<'info>,
    /// CHECK: 20% destination
    #[account(mut)]
    pub creator_quote: UncheckedAccount<'info>,
    /// CHECK: quote mint (WSOL)
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: spl-token
    #[account(address = SPL_TOKEN)]
    pub quote_token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct PayReward<'info> {
    /// CHECK: PDA = DBC config leftover_receiver
    #[account(seeds = [REWARD_POOL_SEED], bump)]
    pub reward_pool: UncheckedAccount<'info>,
    /// CHECK: reward pool token account (ATA of reward_pool for the mint)
    #[account(mut)]
    pub reward_vault: UncheckedAccount<'info>,
    /// CHECK: base mint
    pub mint: UncheckedAccount<'info>,
    /// CHECK: payout destination token account
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    /// CHECK: token program of the mint
    pub token_program: UncheckedAccount<'info>,
}
impl<'info> PayReward<'info> {
    fn decimals(&self) -> u8 {
        // spl mint layout: decimals at byte 44 (same prefix for Token-2022)
        self.mint.try_borrow_data().map(|d| d[44]).unwrap_or(0)
    }
}

#[derive(Accounts)]
pub struct ReadPrice<'info> {
    /// CHECK: DBC VirtualPool or DAMM v2 Pool (owner checked in handler)
    pub pool: UncheckedAccount<'info>,
}

#[event]
pub struct RoutedSwapMeasured {
    pub venue: u8,
    pub trader: Pubkey,
    pub in_mint: Pubkey,
    pub out_mint: Pubkey,
    pub spent: u64,
    pub received: u64,
    pub slot: u64,
}

#[event]
pub struct FeesSplit {
    pub venue: u8,
    pub quote_claimed: u64,
    pub base_claimed: u64,
    pub to_buyback: u64,
    pub to_platform: u64,
    pub to_creator: u64,
}

#[error_code]
pub enum SpikeError {
    #[msg("target program must be DBC or DAMM v2")]
    BadProgram,
    #[msg("instruction not allowed")]
    BadInstruction,
    #[msg("token account not owned by the trader")]
    NotUserAccount,
    #[msg("bad account")]
    BadAccount,
    #[msg("swap did not fill")]
    NoFill,
}
