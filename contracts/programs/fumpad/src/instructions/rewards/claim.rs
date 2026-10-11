use anchor_lang::prelude::*;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::{
    constants::*,
    error::FumpadError,
    events::{ClaimPaid, ClaimQueued},
    math::price::meets_multiple,
    state::{ClaimQueue, Coin, CoinStatus, Global, Observations, Position, QueueEntry, Ticket, TicketStatus, PAUSE_CLAIMS},
};

use super::{logic, queue};

/// Claim a ticket once the coin has held `trigger_multiple` × the sell price (30-min
/// median of keeper samples). Pays immediately when the amount fits the per-claim cap
/// and no older fitting claim is waiting; otherwise enters the claim queue.
///
/// Queued tickets stay in `position.open_tickets` (the rebuy rule still applies to them,
/// SPEC §5.3) until paid or voided. Paid tickets leave the open list.
#[event_cpi]
#[derive(Accounts)]
pub struct Claim<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    #[account(mut, seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump, has_one = mint)]
    pub coin: Box<Account<'info, Coin>>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        seeds = [TICKET_SEED, mint.key().as_ref(), owner.key().as_ref(), &ticket.seq.to_le_bytes()],
        bump = ticket.bump,
        has_one = owner @ FumpadError::Unauthorized,
        has_one = mint,
    )]
    pub ticket: Box<Account<'info, Ticket>>,
    #[account(mut, seeds = [POSITION_SEED, mint.key().as_ref(), owner.key().as_ref()], bump = position.bump)]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, seeds = [CLAIM_QUEUE_SEED, mint.key().as_ref()], bump)]
    pub claim_queue: AccountLoader<'info, ClaimQueue>,
    #[account(seeds = [OBSERVATIONS_SEED, mint.key().as_ref()], bump)]
    pub observations: AccountLoader<'info, Observations>,
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
    #[account(
        mut,
        token::mint = mint,
        token::authority = owner,
        token::token_program = token_program,
    )]
    pub owner_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = anchor_spl::token_2022::ID)]
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_claim(ctx: Context<Claim>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let p = ctx.accounts.global.params;
    require!(!ctx.accounts.global.is_paused(PAUSE_CLAIMS), FumpadError::Paused);
    require!(ctx.accounts.coin.status == CoinStatus::Graduated, FumpadError::WrongCoinStatus);

    let ticket_key = ctx.accounts.ticket.key();
    let t = &ctx.accounts.ticket;
    require!(t.status == TicketStatus::Open, FumpadError::TicketNotOpen);
    let deadline = t.sell_ts.checked_add(p.claim_window_secs).ok_or(FumpadError::MathOverflow)?;
    require!(now <= deadline, FumpadError::TicketExpired);

    let median = {
        let obs = ctx.accounts.observations.load()?;
        require_keys_eq!(obs.mint, ctx.accounts.mint.key(), FumpadError::InvalidAccount);
        obs.median_price_q64(now, p.oracle_window_secs, p.oracle_min_samples)
            .ok_or(FumpadError::InsufficientSamples)?
    };
    require!(meets_multiple(median, t.sell_price_q64, p.trigger_multiple_bps), FumpadError::TriggerNotMet);

    let amount = logic::claim_amount(t.tokens, p.claim_bps);
    require!(amount > 0, FumpadError::ZeroAmount);
    let (sell_ts, owner) = (t.sell_ts, t.owner);

    let pool = ctx.accounts.reward_vault.amount;
    let mut q = ctx.accounts.claim_queue.load_mut()?;
    require_keys_eq!(q.mint, ctx.accounts.mint.key(), FumpadError::InvalidAccount);
    let pay_now = logic::fits(amount, pool, p.max_claim_pool_bps)
        && !queue::has_older_fitting(&q, sell_ts, &ticket_key, pool, p.max_claim_pool_bps);

    let t = &mut ctx.accounts.ticket;
    t.claim_amount = amount;
    if pay_now {
        drop(q);
        t.status = TicketStatus::Claimed;
        t.claimed_at = now;
        logic::remove_open(&mut ctx.accounts.position, &ticket_key);
        let coin = &mut ctx.accounts.coin;
        coin.tokens_paid_out = coin.tokens_paid_out.saturating_add(amount);
        pay_from_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.reward_vault,
            &ctx.accounts.mint,
            &ctx.accounts.owner_token_account.to_account_info(),
            &ctx.accounts.pool_authority,
            ctx.bumps.pool_authority,
            amount,
        )?;
        emit_cpi!(ClaimPaid {
            mint: ctx.accounts.mint.key(),
            ticket: ticket_key,
            owner,
            amount,
            from_queue: false,
            median_price_q64: median,
            ts: now,
        });
    } else {
        let queue_len = queue::insert(&mut q, QueueEntry { ticket: ticket_key, owner, amount, sell_ts })?;
        drop(q);
        t.status = TicketStatus::Queued;
        t.queued_at = now;
        emit_cpi!(ClaimQueued { mint: ctx.accounts.mint.key(), ticket: ticket_key, owner, amount, queue_len, ts: now });
    }
    Ok(())
}

/// Token-2022 transfer_checked from the reward vault, signed by the pool authority PDA.
pub fn pay_from_vault<'info>(
    token_program: &Interface<'info, TokenInterface>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    to: &AccountInfo<'info>,
    pool_authority: &UncheckedAccount<'info>,
    pool_authority_bump: u8,
    amount: u64,
) -> Result<()> {
    let seeds: &[&[&[u8]]] = &[&[POOL_AUTHORITY_SEED, &[pool_authority_bump]]];
    transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: vault.to_account_info(),
                mint: mint.to_account_info(),
                to: to.clone(),
                authority: pool_authority.to_account_info(),
            },
            seeds,
        ),
        amount,
        mint.decimals,
    )
}
