//! Helpers shared by the venue instructions. OWNER: venue/oracle module.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token;

use crate::{error::FumpadError, math::FeeSplit, state::Coin};

/// Credit a fee split to the coin's ledgers. The caller must move exactly `f.total`
/// lamports into the Coin account so the lamport invariant (state/coin.rs) holds:
/// pool share → `buyback_lamports` (post-graduation buyback), platform/creator → their
/// unclaimed balances.
pub fn accrue_fee(coin: &mut Coin, f: &FeeSplit) -> Result<()> {
    coin.buyback_lamports = coin.buyback_lamports.checked_add(f.pool).ok_or(FumpadError::MathOverflow)?;
    coin.platform_fees_unclaimed =
        coin.platform_fees_unclaimed.checked_add(f.platform).ok_or(FumpadError::MathOverflow)?;
    coin.creator_fees_unclaimed =
        coin.creator_fees_unclaimed.checked_add(f.creator).ok_or(FumpadError::MathOverflow)?;
    Ok(())
}

pub fn record_volume(coin: &mut Coin, lamports: u64) {
    coin.volume_lamports = coin.volume_lamports.saturating_add(lamports);
    coin.trade_count = coin.trade_count.saturating_add(1);
}

/// System transfer of native SOL from a signer.
pub fn transfer_sol<'info>(
    system_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    lamports: u64,
) -> Result<()> {
    if lamports == 0 {
        return Ok(());
    }
    system_program::transfer(
        CpiContext::new(
            system_program.key(),
            system_program::Transfer { from: from.clone(), to: to.clone() },
        ),
        lamports,
    )
}

pub fn sync_native<'info>(token_program: &AccountInfo<'info>, wsol: &AccountInfo<'info>) -> Result<()> {
    token::sync_native(CpiContext::new(token_program.key(), token::SyncNative { account: wsol.clone() }))
}

/// Move `lamports` from a program-owned account (`from`, e.g. the Coin) into a WSOL token
/// account owned by the PDA `signer`, and wrap them.
///
/// `from` can only be debited directly (it carries data), and the runtime only syncs a
/// caller's direct lamport edits for accounts that appear in the NEXT CPI. So: debit
/// `from` → credit `signer` (a data-less system account), then a signed system transfer
/// `signer` → `wsol` that carries `from` as an extra writable account (the system
/// program reads only its first two accounts). Every edit is thus visible to the runtime
/// at the first CPI boundary, then `sync_native`.
pub fn wrap_from_program_account<'info>(
    from: &AccountInfo<'info>,
    signer: &AccountInfo<'info>,
    signer_seeds: &[&[u8]],
    wsol: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    lamports: u64,
) -> Result<()> {
    use anchor_lang::solana_program::{program::invoke_signed, system_instruction};
    require_keys_eq!(*from.owner, crate::ID, FumpadError::InvalidAccount);
    require_keys_eq!(*signer.owner, system_program::ID, FumpadError::InvalidAccount);
    from.sub_lamports(lamports)?;
    signer.add_lamports(lamports)?;
    let mut ix = system_instruction::transfer(&signer.key(), &wsol.key(), lamports);
    ix.accounts.push(AccountMeta::new(from.key(), false));
    invoke_signed(&ix, &[signer.clone(), wsol.clone(), from.clone(), system_program.clone()], &[signer_seeds])?;
    sync_native(token_program, wsol)
}

/// Close a native (WSOL) token account owned by `authority`: its whole balance + rent
/// returns to `destination` as SOL.
pub fn unwrap_wsol<'info>(
    token_program: &AccountInfo<'info>,
    wsol: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
) -> Result<()> {
    token::close_account(CpiContext::new(
        token_program.key(),
        token::CloseAccount { account: wsol.clone(), destination: destination.clone(), authority: authority.clone() },
    ))
}
