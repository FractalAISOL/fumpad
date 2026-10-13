//! Account helpers shared by the rewards / tickets instructions.

use anchor_lang::{prelude::*, system_program, Discriminator};

use crate::{
    constants::CLAIM_QUEUE_SEED,
    error::FumpadError,
    state::{ClaimQueue, Ticket},
};

/// Read a program-owned Ticket from a raw account (owner + discriminator checked).
pub fn read_ticket(info: &AccountInfo) -> Result<Ticket> {
    require_keys_eq!(*info.owner, crate::ID, FumpadError::InvalidAccount);
    let data = info.try_borrow_data()?;
    Ticket::try_deserialize(&mut &data[..])
}

pub fn write_ticket(info: &AccountInfo, t: &Ticket) -> Result<()> {
    let mut data = info.try_borrow_mut_data()?;
    let mut w: &mut [u8] = &mut data[..];
    t.try_serialize(&mut w)
}

/// Serialize an Anchor account into a raw (already allocated, program-owned) account.
pub fn write_account<T: AccountSerialize>(info: &AccountInfo, v: &T) -> Result<()> {
    let mut data = info.try_borrow_mut_data()?;
    let mut w: &mut [u8] = &mut data[..];
    v.try_serialize(&mut w)
}

/// Create a program-owned PDA paid by `payer`. Like Anchor's `init`, it tolerates the address having been
/// pre-funded (a griefer sending lamports to a predictable PDA can't block creation).
pub fn create_pda_account<'info>(
    payer: &AccountInfo<'info>,
    target: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    space: usize,
    seeds: &[&[u8]],
) -> Result<()> {
    create_pda_account_owned(payer, target, system, space, seeds, &crate::ID)
}

/// `create_pda_account` for an arbitrary owner program (e.g. a token account at a fumpad PDA).
pub fn create_pda_account_owned<'info>(
    payer: &AccountInfo<'info>,
    target: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    space: usize,
    seeds: &[&[u8]],
    owner: &Pubkey,
) -> Result<()> {
    require_keys_eq!(system.key(), system_program::ID, FumpadError::InvalidAccount);
    require!(target.owner == &system_program::ID && target.data_is_empty(), FumpadError::InvalidAccount);
    let rent = Rent::get()?.minimum_balance(space);
    let current = target.lamports();
    let signer: &[&[&[u8]]] = &[seeds];
    if current == 0 {
        system_program::create_account(
            CpiContext::new_with_signer(
                system_program::ID,
                system_program::CreateAccount { from: payer.clone(), to: target.clone() },
                signer,
            ),
            rent,
            space as u64,
            owner,
        )
    } else {
        if rent > current {
            system_program::transfer(
                CpiContext::new(system_program::ID, system_program::Transfer { from: payer.clone(), to: target.clone() }),
                rent - current,
            )?;
        }
        system_program::allocate(
            CpiContext::new_with_signer(
                system_program::ID,
                system_program::Allocate { account_to_allocate: target.clone() },
                signer,
            ),
            space as u64,
        )?;
        system_program::assign(
            CpiContext::new_with_signer(system_program::ID, system_program::Assign { account_to_assign: target.clone() }, signer),
            owner,
        )
    }
}

/// The coin's canonical, initialized ClaimQueue: owner, writable, size, discriminator, mint, PDA.
pub fn check_claim_queue(info: &AccountInfo, mint: &Pubkey) -> Result<()> {
    require_keys_eq!(*info.owner, crate::ID, FumpadError::InvalidAccount);
    require!(info.is_writable, FumpadError::InvalidAccount);
    let mut data = info.try_borrow_mut_data()?;
    let q = claim_queue_mut(&mut data)?;
    require_keys_eq!(q.mint, *mint, FumpadError::InvalidAccount);
    let pda = Pubkey::create_program_address(&[CLAIM_QUEUE_SEED, mint.as_ref(), &[q.bump]], &crate::ID)
        .map_err(|_| error!(FumpadError::InvalidAccount))?;
    require_keys_eq!(info.key(), pda, FumpadError::InvalidAccount);
    Ok(())
}

/// View raw ClaimQueue account data (discriminator + Pod body) as the zero-copy struct.
pub fn claim_queue_mut(data: &mut [u8]) -> Result<&mut ClaimQueue> {
    let size = core::mem::size_of::<ClaimQueue>();
    require!(data.len() >= 8 + size, FumpadError::InvalidAccount);
    require!(data[..8] == *ClaimQueue::DISCRIMINATOR, FumpadError::InvalidAccount);
    bytemuck::try_from_bytes_mut(&mut data[8..8 + size]).map_err(|_| error!(FumpadError::InvalidAccount))
}

/// `emit_event!` without a `ctx` in scope.
pub fn emit_event<E: anchor_lang::Event>(event_authority: &AccountInfo, event: &E) -> Result<()> {
    require_keys_eq!(event_authority.key(), crate::EVENT_AUTHORITY_AND_BUMP.0, FumpadError::InvalidAccount);
    crate::events::emit_cpi_data(event_authority, event.data())
}
