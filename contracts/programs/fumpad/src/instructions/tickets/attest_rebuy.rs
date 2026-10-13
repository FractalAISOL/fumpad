//! D31 `attest_rebuy`: an attested buy (any venue) or incoming transfer within the rebuy window debits a ticket
//! (SPEC v0.7 §5.3). Same 2-of-3 Ed25519 scheme; the replay marker is per (trade, ticket) because one buy can debit
//! several tickets (newest first, decided by the engine).

use anchor_lang::prelude::*;
use anchor_lang::compat::solana_instructions_sysvar as ix_sysvar;

use crate::{
    attestation::{self, RebuyRecord},
    constants::*,
    error::FumpadError,
    events::TicketDebited,
    instructions::rewards::{
        logic, queue,
        util::{check_claim_queue, claim_queue_mut, create_pda_account, write_account},
    },
    state::*,
};

use super::attest_sell::{sell_consumed_seeds_hash, verified_attesters};

#[event_cpi]
#[derive(Accounts)]
pub struct AttestRebuy<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    /// Writable since M-1: a debit gives its tokens' rate-cap capacity back.
    #[account(mut, seeds = [COIN_SEED, coin.mint.as_ref()], bump = coin.bump)]
    pub coin: Box<Account<'info, Coin>>,
    #[account(
        mut,
        seeds = [TICKET_SEED, ticket.mint.as_ref(), ticket.owner.as_ref(), &ticket.seq.to_le_bytes()],
        bump = ticket.bump,
    )]
    pub ticket: Box<Account<'info, Ticket>>,
    #[account(mut, seeds = [POSITION_SEED, ticket.mint.as_ref(), ticket.owner.as_ref()], bump = position.bump)]
    pub position: Box<Account<'info, Position>>,
    /// CHECK: PDA ["consumed", sha256(signature), ix_key, ticket] (created); verified in the handler.
    #[account(mut)]
    pub consumed: UncheckedAccount<'info>,
    /// CHECK: the coin's ClaimQueue, required iff the ticket is Queued (pass the fumpad program id otherwise).
    #[account(mut)]
    pub claim_queue: Option<UncheckedAccount<'info>>,
    /// CHECK: address-checked instructions sysvar.
    #[account(address = ix_sysvar::ID @ FumpadError::InvalidAccount)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_attest_rebuy(ctx: Context<AttestRebuy>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let g = &ctx.accounts.global;
    require!(!g.is_paused(PAUSE_ATTEST, now), FumpadError::Paused);
    let keeper = ctx.accounts.keeper.key();
    require!(g.is_keeper(&keeper), FumpadError::Unauthorized);

    let v = attestation::load_attestation(&ctx.accounts.instructions)?;
    let r = RebuyRecord::decode(&v.message).ok_or(FumpadError::InvalidAttestation)?;
    verified_attesters(g, &v.signers, now)?;
    require!(r.program_id == crate::ID && r.cluster_tag == g.cluster_tag, FumpadError::WrongCluster);

    let ticket_key = ctx.accounts.ticket.key();
    let t = &ctx.accounts.ticket;
    require!(
        r.ticket == ticket_key && r.mint == t.mint && r.owner == t.owner && t.mint == ctx.accounts.coin.mint,
        FumpadError::InvalidAttestation
    );
    require!(matches!(t.status, TicketStatus::Open | TicketStatus::Queued), FumpadError::TicketNotOpen);
    require!(r.debit_tokens > 0, FumpadError::ZeroAmount);
    let p = ctx.accounts.coin.reward_params(&g.params);
    require!(
        r.block_time >= t.sell_ts && r.block_time <= t.sell_ts.saturating_add(p.rebuy_window_secs),
        FumpadError::RebuyOutOfWindow
    );
    require!(r.block_time <= now.saturating_add(ATTEST_CLOCK_SKEW_SECS), FumpadError::InvalidAttestation);
    require!(now.saturating_sub(r.block_time) <= p.max_attest_age_secs, FumpadError::AttestationExpired);

    // Replay marker per (trade, ticket).
    let sig_hash = sell_consumed_seeds_hash(&r.signature);
    let ix_key = r.ix_key.to_le_bytes();
    let (consumed_key, consumed_bump) =
        Pubkey::find_program_address(&[CONSUMED_SEED, &sig_hash, &ix_key, ticket_key.as_ref()], &crate::ID);
    let a = &ctx.accounts;
    require_keys_eq!(a.consumed.key(), consumed_key, FumpadError::InvalidAccount);
    require!(*a.consumed.owner != crate::ID, FumpadError::AlreadyConsumed);
    let consumed_info = a.consumed.to_account_info();
    create_pda_account(
        &a.keeper.to_account_info(),
        &consumed_info,
        &a.system_program.to_account_info(),
        8 + Consumed::INIT_SPACE,
        &[CONSUMED_SEED, &sig_hash, &ix_key, ticket_key.as_ref(), &[consumed_bump]],
    )?;
    write_account(
        &consumed_info,
        &Consumed {
            bump: consumed_bump,
            kind: CONSUMED_KIND_REBUY,
            ticket: ticket_key,
            rent_payer: keeper,
            block_time: r.block_time,
            message_hash: [0; 16],
        },
    )?;

    // Debit (newest-first ordering across tickets is the engine's job; here: this ticket, capped at its tokens).
    let queued = a.ticket.status == TicketStatus::Queued;
    let queue_info = if queued {
        let q = a.claim_queue.as_ref().ok_or(FumpadError::QueueAccountRequired)?;
        check_claim_queue(&q.to_account_info(), &a.ticket.mint)?;
        Some(q.to_account_info())
    } else {
        None
    };
    let t = &mut ctx.accounts.ticket;
    let debited = r.debit_tokens.min(t.tokens);
    t.tokens -= debited;
    let owed = logic::claim_amount(t.tokens, p.claim_bps);
    let voided = t.tokens == 0 || owed == 0;
    if let Some(qi) = queue_info {
        t.claim_amount = owed;
        let mut data = qi.try_borrow_mut_data()?;
        let q = claim_queue_mut(&mut data)?;
        if voided {
            queue::remove(q, &ticket_key);
        } else {
            queue::set_amount(q, &ticket_key, owed);
        }
    }
    if voided {
        t.status = TicketStatus::Voided;
        logic::remove_open(&mut ctx.accounts.position, &ticket_key);
    }
    let (mint, owner, remaining, effective_at) =
        (ctx.accounts.ticket.mint, ctx.accounts.ticket.owner, ctx.accounts.ticket.tokens, ctx.accounts.ticket.attested_at);
    // M-1: debited tokens no longer count toward the coin's hourly attestation cap.
    ctx.accounts.coin.release_attest(now, debited, p.max_attest_tokens_per_hour_bps, effective_at);
    emit_event!(ctx, TicketDebited {
        ticket: ticket_key,
        mint,
        owner,
        signature: r.signature,
        ix_key: r.ix_key,
        debited,
        remaining,
        voided,
        ts: now,
    });
    Ok(())
}
