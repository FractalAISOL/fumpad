//! Token / lamport helpers shared by the venue instructions.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed, system_instruction};
use anchor_lang::system_program;
use anchor_spl::token;

use crate::{constants::*, error::FumpadError, instructions::rewards::util::create_pda_account_owned};

/// SPL-Token / Token-2022 account (owner checked) → amount.
pub fn token_amount(acc: &AccountInfo) -> Result<u64> {
    require!(
        *acc.owner == anchor_spl::token::ID || *acc.owner == anchor_spl::token_2022::ID,
        FumpadError::InvalidAccount
    );
    let d = acc.try_borrow_data()?;
    require!(d.len() >= 165, FumpadError::InvalidAccount);
    Ok(u64::from_le_bytes(d[64..72].try_into().unwrap()))
}

/// SPL-Token / Token-2022 account → (mint, owner).
pub fn token_mint_owner(acc: &AccountInfo) -> Result<(Pubkey, Pubkey)> {
    require!(
        *acc.owner == anchor_spl::token::ID || *acc.owner == anchor_spl::token_2022::ID,
        FumpadError::InvalidAccount
    );
    let d = acc.try_borrow_data()?;
    require!(d.len() >= 165, FumpadError::InvalidAccount);
    Ok((Pubkey::new_from_array(d[0..32].try_into().unwrap()), Pubkey::new_from_array(d[32..64].try_into().unwrap())))
}

/// Create the transient WSOL account PDA ["fee_wsol"] (SPL Token, authority `fee_claimer`), rent paid by `payer`.
pub fn open_fee_wsol<'info>(
    payer: &AccountInfo<'info>,
    fee_wsol: &AccountInfo<'info>,
    fee_wsol_bump: u8,
    fee_claimer: &AccountInfo<'info>,
    wsol_mint: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
) -> Result<()> {
    create_pda_account_owned(payer, fee_wsol, system, 165, &[FEE_WSOL_SEED, &[fee_wsol_bump]], &token::ID)?;
    token::initialize_account3(CpiContext::new(
        token_program.key(),
        token::InitializeAccount3 { account: fee_wsol.clone(), mint: wsol_mint.clone(), authority: fee_claimer.clone() },
    ))
}

/// Close the transient WSOL account into `fee_claimer` (a data-less system PDA). Returns `(amount, rent)`: the
/// WSOL it held and the rest of the lamports the close added (its rent, owed back to whoever opened it). The
/// caller then pays both out of `fee_claimer` with `signed_system_transfer` (never leaving lamports behind).
pub fn close_fee_wsol<'info>(
    fee_wsol: &AccountInfo<'info>,
    fee_claimer: &AccountInfo<'info>,
    fee_claimer_bump: u8,
    token_program: &AccountInfo<'info>,
) -> Result<(u64, u64)> {
    let seeds: &[&[u8]] = &[FEE_CLAIMER_SEED, &[fee_claimer_bump]];
    let amount = token_amount(fee_wsol)?;
    let before = fee_claimer.lamports();
    token::close_account(CpiContext::new_with_signer(
        token_program.key(),
        token::CloseAccount { account: fee_wsol.clone(), destination: fee_claimer.clone(), authority: fee_claimer.clone() },
        &[seeds],
    ))?;
    let added = fee_claimer.lamports().checked_sub(before).ok_or(FumpadError::MathOverflow)?;
    let rent = added.checked_sub(amount).ok_or(FumpadError::MathOverflow)?;
    Ok((amount, rent))
}

pub fn signed_system_transfer<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    seeds: &[&[u8]],
    lamports: u64,
) -> Result<()> {
    if lamports == 0 {
        return Ok(());
    }
    system_program::transfer(
        CpiContext::new_with_signer(
            system.key(),
            system_program::Transfer { from: from.clone(), to: to.clone() },
            &[seeds],
        ),
        lamports,
    )
}

/// Move `lamports` from the program-owned Coin into a WSOL token account owned by the system PDA `signer`, and
/// wrap them. The Coin can only be debited directly, and the runtime only syncs direct lamport edits of accounts
/// that appear in the NEXT CPI: debit Coin → credit `signer`, then a signed system transfer `signer` → `wsol`
/// carrying the Coin as an extra writable account, then `sync_native`.
pub fn wrap_from_coin<'info>(
    coin: &AccountInfo<'info>,
    signer: &AccountInfo<'info>,
    signer_seeds: &[&[u8]],
    wsol: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    lamports: u64,
) -> Result<()> {
    require_keys_eq!(*coin.owner, crate::ID, FumpadError::InvalidAccount);
    require_keys_eq!(*signer.owner, system_program::ID, FumpadError::InvalidAccount);
    coin.sub_lamports(lamports)?;
    signer.add_lamports(lamports)?;
    let mut ix = system_instruction::transfer(&signer.key(), &wsol.key(), lamports);
    ix.accounts.push(AccountMeta::new(coin.key(), false));
    invoke_signed(&ix, &[signer.clone(), wsol.clone(), coin.clone(), system.clone()], &[signer_seeds])?;
    token::sync_native(CpiContext::new(token_program.key(), token::SyncNative { account: wsol.clone() }))
}
