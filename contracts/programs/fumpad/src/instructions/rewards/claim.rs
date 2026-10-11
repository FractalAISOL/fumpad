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
/// and no older fitting claim is waiting; otherwise enters the claim queue — unless the
/// wallet already has `MAX_QUEUED_PER_WALLET` (2) entries there (D16: reverts with
/// `WalletQueueLimit`, the ticket stays Open).
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

/// Outcome of the checks shared by `claim` and `claim_for` (D17).
pub(crate) enum Decision {
    /// Pay `amount` now. The ticket is already `Claimed` and off the open list; the caller
    /// transfers, bumps `coin.tokens_paid_out` and emits.
    PayNow { amount: u64, median: u128 },
    /// The ticket entered the queue (`Queued`) at position `queue_len`.
    Queued { amount: u64, queue_len: u16 },
}

/// Every claim rule, identical for owner-signed and keeper auto-claims: pause, graduated
/// coin, ticket `Open`, 90-day window, 30-min keeper median ≥ trigger with coverage,
/// non-zero amount; then pay now iff it fits the per-claim cap and no older fitting entry
/// waits, else queue (D16 per-wallet limit, capacity).
#[allow(clippy::too_many_arguments)]
pub(crate) fn decide_claim(
    global: &Global,
    coin: &Coin,
    mint: &Pubkey,
    ticket_key: &Pubkey,
    t: &mut Ticket,
    position: &mut Position,
    claim_queue: &AccountLoader<ClaimQueue>,
    observations: &AccountLoader<Observations>,
    pool: u64,
    now: i64,
) -> Result<Decision> {
    let p = global.params;
    require!(!global.is_paused(PAUSE_CLAIMS), FumpadError::Paused);
    require!(coin.status == CoinStatus::Graduated, FumpadError::WrongCoinStatus);
    require!(t.status == TicketStatus::Open, FumpadError::TicketNotOpen);
    let deadline = t.sell_ts.checked_add(p.claim_window_secs).ok_or(FumpadError::MathOverflow)?;
    require!(now <= deadline, FumpadError::TicketExpired);

    let median = {
        let obs = observations.load()?;
        require_keys_eq!(obs.mint, *mint, FumpadError::InvalidAccount);
        obs.median_price_q64(now, p.oracle_window_secs, p.oracle_min_samples)
            .ok_or(FumpadError::InsufficientSamples)?
    };
    require!(meets_multiple(median, t.sell_price_q64, p.trigger_multiple_bps), FumpadError::TriggerNotMet);

    let amount = logic::claim_amount(t.tokens, p.claim_bps);
    require!(amount > 0, FumpadError::ZeroAmount);

    let mut q = claim_queue.load_mut()?;
    require_keys_eq!(q.mint, *mint, FumpadError::InvalidAccount);
    let pay_now = logic::fits(amount, pool, p.max_claim_pool_bps)
        && !queue::has_older_fitting(&q, t.sell_ts, ticket_key, pool, p.max_claim_pool_bps);

    t.claim_amount = amount;
    if pay_now {
        t.status = TicketStatus::Claimed;
        t.claimed_at = now;
        logic::remove_open(position, ticket_key);
        Ok(Decision::PayNow { amount, median })
    } else {
        // D16: at most MAX_QUEUED_PER_WALLET entries per wallet per coin (the ticket stays Open).
        require!(queue::count_owner(&q, &t.owner) < MAX_QUEUED_PER_WALLET, FumpadError::WalletQueueLimit);
        let queue_len =
            queue::insert(&mut q, QueueEntry { ticket: *ticket_key, owner: t.owner, amount, sell_ts: t.sell_ts })?;
        t.status = TicketStatus::Queued;
        t.queued_at = now;
        Ok(Decision::Queued { amount, queue_len })
    }
}

pub fn handle_claim(ctx: Context<Claim>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let ticket_key = ctx.accounts.ticket.key();
    let mint = ctx.accounts.mint.key();
    let owner = ctx.accounts.owner.key();
    let a = &mut *ctx.accounts;
    let decision = decide_claim(
        &a.global,
        &a.coin,
        &mint,
        &ticket_key,
        &mut a.ticket,
        &mut a.position,
        &a.claim_queue,
        &a.observations,
        a.reward_vault.amount,
        now,
    )?;
    match decision {
        Decision::PayNow { amount, median } => {
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
                mint,
                ticket: ticket_key,
                owner,
                amount,
                from_queue: false,
                median_price_q64: median,
                ts: now,
                triggered_by: owner,
            });
        }
        Decision::Queued { amount, queue_len } => {
            emit_cpi!(ClaimQueued { mint, ticket: ticket_key, owner, amount, queue_len, ts: now, triggered_by: owner });
        }
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
