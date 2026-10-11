use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::get_associated_token_address_with_program_id,
    token_2022::spl_token_2022::{
        extension::{memo_transfer::memo_required, StateWithExtensions},
        state::{Account as SplTokenAccount, AccountState},
    },
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::*,
    error::FumpadError,
    events::ClaimPaid,
    state::{ClaimQueue, Coin, Global, Position, TicketStatus, PAUSE_CLAIMS},
};

use super::{
    claim::pay_from_vault,
    hooks::{read_ticket, write_ticket},
    logic,
};

/// Permissionless crank. Walks the queue in (sell_ts, ticket) order and pays, in order,
/// every entry whose amount fits the per-claim cap of the *current* (shrinking) pool,
/// skipping entries that don't fit (skip-ahead, D4). Entries never expire (D5).
///
/// remaining_accounts: triples `[ticket (mut), owner's position (mut), owner's canonical
/// Token-2022 ATA (mut)]` for a subsequence of queue entries, **in queue order**. For each
/// queue entry the program checks whether the next unconsumed triple is for that entry:
/// - triple present → the entry is re-synced from its ticket (an entry whose ticket was
///   voided / shrunk by the rebuy rule is dropped / reduced), then paid if it fits;
/// - no triple and the entry fits → the walk stops paying (`halted`): a later entry can
///   never be paid ahead of an earlier fitting one, so a crank can't reorder the queue;
/// - every triple must be consumed by the walk, else the instruction fails (rejects
///   unknown tickets, duplicates and out-of-order triples).
/// An entry whose ATA requires incoming-transfer memos (an owner-only setting) is skipped,
/// so it can't block the queue. A missing (closed) ATA fails the crank: the cranker must
/// create it first (permissionless, idempotent).
///
/// `max_entries` caps the number of payments in this call.
#[event_cpi]
#[derive(Accounts)]
pub struct ProcessQueue<'info> {
    pub cranker: Signer<'info>,
    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    #[account(mut, seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump, has_one = mint)]
    pub coin: Box<Account<'info, Coin>>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [CLAIM_QUEUE_SEED, mint.key().as_ref()], bump)]
    pub claim_queue: AccountLoader<'info, ClaimQueue>,
    /// CHECK: PDA signer that owns the reward vault.
    #[account(seeds = [POOL_AUTHORITY_SEED], bump)]
    pub pool_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [REWARD_VAULT_SEED, mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = pool_authority,
        token::token_program = token_program,
    )]
    pub reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = anchor_spl::token_2022::ID)]
    pub token_program: Interface<'info, TokenInterface>,
}

enum Dest {
    Payable,
    /// Owner's ATA refuses plain incoming transfers (memo required / frozen).
    Refuses,
}

pub fn handle_process_queue<'info>(ctx: Context<'info, ProcessQueue<'info>>, max_entries: u8) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let p = ctx.accounts.global.params;
    require!(!ctx.accounts.global.is_paused(PAUSE_CLAIMS), FumpadError::Paused);
    let mint = ctx.accounts.mint.key();
    let rem = ctx.remaining_accounts;
    require!(rem.len() % 3 == 0, FumpadError::InvalidAccount);

    let mut pool = ctx.accounts.reward_vault.amount;
    let mut q = ctx.accounts.claim_queue.load_mut()?;
    require_keys_eq!(q.mint, mint, FumpadError::InvalidAccount);

    let len = q.len as usize;
    let (mut r, mut write, mut paid, mut halted) = (0usize, 0usize, 0u8, false);
    let mut paid_total: u64 = 0;
    for i in 0..len {
        let mut e = q.entries[i];
        let loaded = r < rem.len() && rem[r].key() == e.ticket;
        let mut triple = None;
        if loaded {
            let (ti, pi, ai) = (&rem[r], &rem[r + 1], &rem[r + 2]);
            r += 3;
            // Re-sync the entry from its ticket.
            if *ti.owner != crate::ID || ti.data_is_empty() {
                q.total_owed = q.total_owed.saturating_sub(e.amount);
                continue; // ticket closed → drop entry
            }
            let t = read_ticket(ti)?;
            require_keys_eq!(t.owner, e.owner, FumpadError::InvalidAccount);
            require_keys_eq!(t.mint, mint, FumpadError::InvalidAccount);
            if t.status != TicketStatus::Queued || t.claim_amount == 0 {
                q.total_owed = q.total_owed.saturating_sub(e.amount);
                continue; // voided by the rebuy rule → drop entry
            }
            if t.claim_amount < e.amount {
                q.total_owed = q.total_owed.saturating_sub(e.amount - t.claim_amount);
                e.amount = t.claim_amount;
            }
            triple = Some((ti, pi, ai, t));
        }

        if !halted && paid < max_entries && logic::fits(e.amount, pool, p.max_claim_pool_bps) {
            match triple {
                None => halted = true,
                Some((ti, pi, ai, mut t)) => {
                    if let Dest::Payable = check_destination(ai, &e.owner, &mint)? {
                        let mut pos = read_position(pi, &e.owner, &mint)?;
                        logic::remove_open(&mut pos, &e.ticket);
                        write_position(pi, &pos)?;
                        t.status = TicketStatus::Claimed;
                        t.claimed_at = now;
                        t.claim_amount = e.amount;
                        write_ticket(ti, &t)?;
                        pay_from_vault(
                            &ctx.accounts.token_program,
                            &ctx.accounts.reward_vault,
                            &ctx.accounts.mint,
                            ai,
                            &ctx.accounts.pool_authority,
                            ctx.bumps.pool_authority,
                            e.amount,
                        )?;
                        pool -= e.amount; // fits() ⇒ amount ≤ pool
                        paid += 1;
                        paid_total = paid_total.saturating_add(e.amount);
                        q.total_owed = q.total_owed.saturating_sub(e.amount);
                        emit_cpi!(ClaimPaid {
                            mint,
                            ticket: e.ticket,
                            owner: e.owner,
                            amount: e.amount,
                            from_queue: true,
                            median_price_q64: 0,
                            ts: now,
                        });
                        continue; // paid → drop entry
                    }
                }
            }
        }
        q.entries[write] = e;
        write += 1;
    }
    require!(r == rem.len(), FumpadError::InvalidAccount);
    for slot in q.entries[write..len].iter_mut() {
        *slot = bytemuck::Zeroable::zeroed();
    }
    q.len = write as u16;
    drop(q);

    let coin = &mut ctx.accounts.coin;
    coin.tokens_paid_out = coin.tokens_paid_out.saturating_add(paid_total);
    Ok(())
}

/// The destination must be the owner's canonical Token-2022 ATA for this mint, initialized.
fn check_destination(ata: &AccountInfo, owner: &Pubkey, mint: &Pubkey) -> Result<Dest> {
    let expected = get_associated_token_address_with_program_id(owner, mint, &anchor_spl::token_2022::ID);
    require_keys_eq!(ata.key(), expected, FumpadError::InvalidAccount);
    require_keys_eq!(*ata.owner, anchor_spl::token_2022::ID, FumpadError::InvalidAccount);
    let data = ata.try_borrow_data()?;
    let st = StateWithExtensions::<SplTokenAccount>::unpack(&data).map_err(|_| FumpadError::InvalidAccount)?;
    require_keys_eq!(st.base.mint, *mint, FumpadError::InvalidAccount);
    require_keys_eq!(st.base.owner, *owner, FumpadError::InvalidAccount);
    if st.base.state != AccountState::Initialized || memo_required(&st) {
        return Ok(Dest::Refuses);
    }
    Ok(Dest::Payable)
}

fn read_position(info: &AccountInfo, owner: &Pubkey, mint: &Pubkey) -> Result<Position> {
    require_keys_eq!(*info.owner, crate::ID, FumpadError::InvalidAccount);
    let pos = {
        let data = info.try_borrow_data()?;
        Position::try_deserialize(&mut &data[..])?
    };
    require_keys_eq!(pos.wallet, *owner, FumpadError::InvalidAccount);
    require_keys_eq!(pos.mint, *mint, FumpadError::InvalidAccount);
    let expected =
        Pubkey::create_program_address(&[POSITION_SEED, mint.as_ref(), owner.as_ref(), &[pos.bump]], &crate::ID)
            .map_err(|_| FumpadError::InvalidAccount)?;
    require_keys_eq!(info.key(), expected, FumpadError::InvalidAccount);
    Ok(pos)
}

fn write_position(info: &AccountInfo, pos: &Position) -> Result<()> {
    let mut data = info.try_borrow_mut_data()?;
    let mut w: &mut [u8] = &mut data[..];
    pos.try_serialize(&mut w)
}
