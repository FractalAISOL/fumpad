use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::get_associated_token_address_with_program_id,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::*,
    error::FumpadError,
    events::{ClaimEscrowed, ClaimPaid, ClaimQueued},
    state::{ClaimQueue, Coin, Global, Observations, Position, Ticket, TicketStatus},
};

use super::{
    claim::{decide_claim, pay_from_vault, Decision},
    process_queue::{check_destination, open_escrow, Dest},
};

/// D17 auto-claim: a registered keeper (`Global.keepers`) claims a ticket on its owner's
/// behalf. Exactly the rules of `claim` (shared `decide_claim`: pause, graduated, Open,
/// 90 days, keeper median ≥ trigger with coverage, D16 per-wallet queue limit, capacity).
///
/// Funds can only go to the owner: a payout lands in the owner's **canonical** Token-2022
/// ATA (address enforced), or — if that ATA can't receive a plain transfer (missing/closed,
/// frozen, memo required) — in the ticket's D16 escrow ["escrow", ticket], created with
/// the keeper's lamports (`Ticket.escrow_payer` = keeper, refunded by `withdraw_escrow`).
/// The owner pays nothing: the keeper creates a missing ATA itself (idempotent ATA create
/// earlier in its transaction) and pays the escrow rent if one is needed.
///
/// The owner can opt out per coin (`set_auto_claim(false)` → `AutoClaimDisabled`); the
/// owner-signed `claim` is unaffected either way.
#[event_cpi]
#[derive(Accounts)]
pub struct ClaimFor<'info> {
    /// A registered keeper; pays the escrow rent when one is needed.
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    #[account(mut, seeds = [COIN_SEED, mint.key().as_ref()], bump = coin.bump, has_one = mint)]
    pub coin: Box<Account<'info, Coin>>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        seeds = [TICKET_SEED, mint.key().as_ref(), ticket.owner.as_ref(), &ticket.seq.to_le_bytes()],
        bump = ticket.bump,
        has_one = mint,
    )]
    pub ticket: Box<Account<'info, Ticket>>,
    #[account(mut, seeds = [POSITION_SEED, mint.key().as_ref(), ticket.owner.as_ref()], bump = position.bump)]
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
    /// CHECK: the ticket owner's canonical Token-2022 ATA for the mint (address enforced);
    /// may be missing, in which case a payout is escrowed.
    #[account(
        mut,
        address = get_associated_token_address_with_program_id(&ticket.owner, &mint.key(), &anchor_spl::token_2022::ID)
            @ FumpadError::InvalidAccount,
    )]
    pub owner_ata: UncheckedAccount<'info>,
    /// CHECK: the ticket's D16 escrow PDA ["escrow", ticket]; created only if the ATA refuses.
    #[account(mut, seeds = [ESCROW_SEED, ticket.key().as_ref()], bump)]
    pub escrow: UncheckedAccount<'info>,
    #[account(address = anchor_spl::token_2022::ID)]
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handle_claim_for(ctx: Context<ClaimFor>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let keeper = ctx.accounts.keeper.key();
    require!(ctx.accounts.global.is_keeper(&keeper), FumpadError::Unauthorized);
    require!(ctx.accounts.position.auto_claim_enabled(), FumpadError::AutoClaimDisabled);
    let ticket_key = ctx.accounts.ticket.key();
    let mint = ctx.accounts.mint.key();
    let owner = ctx.accounts.ticket.owner;
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
    let (amount, median) = match decision {
        Decision::Queued { amount, queue_len } => {
            emit_cpi!(ClaimQueued { mint, ticket: ticket_key, owner, amount, queue_len, ts: now, triggered_by: keeper });
            return Ok(());
        }
        Decision::PayNow { amount, median } => (amount, median),
    };

    let a = &ctx.accounts;
    let ata = a.owner_ata.to_account_info();
    let escrow = a.escrow.to_account_info();
    let dest = check_destination(&ata, &owner, &mint)?;
    if let Dest::Refuses = dest {
        open_escrow(
            &a.keeper.to_account_info(),
            &escrow,
            &a.system_program.to_account_info(),
            &a.token_program.key(),
            &a.mint.to_account_info(),
            &a.pool_authority.to_account_info(),
            &ticket_key,
        )?;
    }
    let to = match dest {
        Dest::Payable => &ata,
        Dest::Refuses => &escrow,
    };
    pay_from_vault(&a.token_program, &a.reward_vault, &a.mint, to, &a.pool_authority, ctx.bumps.pool_authority, amount)?;

    let a = &mut *ctx.accounts;
    a.coin.tokens_paid_out = a.coin.tokens_paid_out.saturating_add(amount);
    match dest {
        Dest::Payable => emit_cpi!(ClaimPaid {
            mint,
            ticket: ticket_key,
            owner,
            amount,
            from_queue: false,
            median_price_q64: median,
            ts: now,
            triggered_by: keeper,
        }),
        Dest::Refuses => {
            // decide_claim marked it Claimed; it is Escrowed until `withdraw_escrow`.
            a.ticket.status = TicketStatus::Escrowed;
            a.ticket.escrow_payer = keeper;
            emit_cpi!(ClaimEscrowed {
                mint,
                ticket: ticket_key,
                owner,
                escrow: escrow.key(),
                amount,
                ts: now,
                triggered_by: keeper,
            });
        }
    }
    Ok(())
}
