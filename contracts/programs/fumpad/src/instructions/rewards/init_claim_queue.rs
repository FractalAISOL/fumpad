use anchor_lang::{prelude::*, system_program, Discriminator};

use crate::{
    constants::*,
    error::FumpadError,
    state::{ClaimQueue, Coin, CoinStatus},
};

use super::hooks::create_pda_account;

/// Max growth of an account's data per instruction (CPI-created accounts and `resize`).
pub const MAX_DATA_INCREASE: usize = 10_240;

/// Total account size of the ClaimQueue PDA (81,976 bytes at capacity 1024).
pub const CLAIM_QUEUE_SPACE: usize = 8 + core::mem::size_of::<ClaimQueue>();
/// `init_claim_queue` calls needed to build the queue: ⌈CLAIM_QUEUE_SPACE / 10 KiB⌉ = 9 at
/// capacity 1024. They fit one transaction (each is 4 accounts, no args, ~5k CU).
pub const CLAIM_QUEUE_INIT_CALLS: usize = CLAIM_QUEUE_SPACE.div_ceil(MAX_DATA_INCREASE);

/// Creates the per-coin ClaimQueue PDA ["claim_queue", mint] for a graduated coin.
/// Permissionless; the payer funds rent.
///
/// The queue (~80 KB) is larger than the 10 KiB a program may allocate per instruction,
/// and a PDA can't be pre-allocated by the client (create_account needs the address to
/// sign), so `#[account(zero)]` can't be used with a PDA. Instead this instruction is
/// idempotent and *grows* the account by ≤10 KiB per call; call it until it reports
/// complete (`CLAIM_QUEUE_INIT_CALLS` = 9 calls for the default capacity — they fit in one
/// transaction). The
/// discriminator + header are written only once the account has its full size, so a
/// half-built queue can never be loaded by `claim`/`process_queue`.
#[derive(Accounts)]
pub struct InitClaimQueue<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [COIN_SEED, coin.mint.as_ref()], bump = coin.bump)]
    pub coin: Account<'info, Coin>,
    /// CHECK: PDA created / grown / initialized here; seeds verified.
    #[account(mut, seeds = [CLAIM_QUEUE_SEED, coin.mint.as_ref()], bump)]
    pub claim_queue: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_claim_queue(ctx: Context<InitClaimQueue>) -> Result<()> {
    require!(ctx.accounts.coin.status == CoinStatus::Graduated, FumpadError::WrongCoinStatus);
    let mint = ctx.accounts.coin.mint;
    let bump = ctx.bumps.claim_queue;
    let q = ctx.accounts.claim_queue.to_account_info();
    let payer = ctx.accounts.payer.to_account_info();
    let system = ctx.accounts.system_program.to_account_info();

    if q.owner == &system_program::ID {
        create_pda_account(
            &payer,
            &q,
            &system,
            CLAIM_QUEUE_SPACE.min(MAX_DATA_INCREASE),
            &[CLAIM_QUEUE_SEED, mint.as_ref(), &[bump]],
        )?;
    } else {
        require_keys_eq!(*q.owner, crate::ID, FumpadError::InvalidAccount);
        let len = q.data_len();
        if len < CLAIM_QUEUE_SPACE {
            let new_len = (len + MAX_DATA_INCREASE).min(CLAIM_QUEUE_SPACE);
            let need = Rent::get()?.minimum_balance(new_len).saturating_sub(q.lamports());
            if need > 0 {
                system_program::transfer(
                    CpiContext::new(system_program::ID, system_program::Transfer { from: payer, to: q.clone() }),
                    need,
                )?;
            }
            q.resize(new_len)?;
        } else {
            // Already full size: error if already initialized.
            require!(q.try_borrow_data()?[..8] == [0u8; 8], FumpadError::InvalidAccount);
        }
    }

    if q.data_len() == CLAIM_QUEUE_SPACE {
        let mut d = q.try_borrow_mut_data()?;
        // Newly grown bytes are zeroed by the runtime; set discriminator + header.
        d[..8].copy_from_slice(ClaimQueue::DISCRIMINATOR);
        d[8..40].copy_from_slice(mint.as_ref()); // mint
        d[40..42].copy_from_slice(&0u16.to_le_bytes()); // len
        d[42] = bump; // bump
    }
    Ok(())
}
