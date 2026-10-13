//! D31 `attest_sell`: a ticket for any qualifying sell (any app, before and after graduation), created from a
//! 2-of-3 keeper attestation verified by Ed25519 introspection (SPEC v0.7 §5.2). The record is read from the
//! Ed25519 instruction right before this one (INTERFACE §4.1/§4.3).

use anchor_lang::prelude::*;
use anchor_lang::compat::solana_instructions_sysvar as ix_sysvar;

use crate::{
    attestation::{self, SellRecord},
    constants::*,
    error::FumpadError,
    events::TicketAttested,
    instructions::rewards::{
        logic,
        util::{create_pda_account, write_account},
    },
    state::*,
};

#[event_cpi]
#[derive(Accounts)]
pub struct AttestSell<'info> {
    /// A registered keeper; pays the rent of the position (if new), the ticket and the consumed marker.
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    #[account(mut, seeds = [COIN_SEED, coin.mint.as_ref()], bump = coin.bump)]
    pub coin: Box<Account<'info, Coin>>,
    /// CHECK: PDA ["position", mint, trader] (created if missing); verified in the handler.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: PDA ["ticket", mint, trader, position.next_ticket_seq] (created); verified in the handler.
    #[account(mut)]
    pub ticket: UncheckedAccount<'info>,
    /// CHECK: PDA ["consumed", sha256(signature), ix_key] (created); verified in the handler.
    #[account(mut)]
    pub consumed: UncheckedAccount<'info>,
    /// CHECK: address-checked instructions sysvar.
    #[account(address = ix_sysvar::ID @ FumpadError::InvalidAccount)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// The ≥ threshold distinct active keepers that signed `message`, or an error.
pub(crate) fn verified_attesters(global: &Global, signers: &[Pubkey], now: i64) -> Result<[Pubkey; 2]> {
    let (n, first) = attestation::count_attesters(signers, |k| global.is_active_attester(k, now));
    let threshold = global.params.attest_threshold.max(ATTEST_THRESHOLD) as usize;
    require!(n >= threshold, FumpadError::NotEnoughKeeperSignatures);
    Ok(first)
}

pub fn sell_consumed_seeds_hash(signature: &[u8; 64]) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[signature]).to_bytes()
}

/// `Consumed.message_hash` of a sell marker: sha256(message)[..16].
pub fn sell_message_hash(message: &[u8]) -> [u8; 16] {
    solana_sha256_hasher::hashv(&[message]).to_bytes()[..16].try_into().unwrap()
}

pub fn handle_attest_sell(ctx: Context<AttestSell>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let g = &ctx.accounts.global;
    require!(!g.is_paused(PAUSE_ATTEST, now), FumpadError::Paused);
    let keeper = ctx.accounts.keeper.key();
    require!(g.is_keeper(&keeper), FumpadError::Unauthorized);

    let v = attestation::load_attestation(&ctx.accounts.instructions)?;
    let r = SellRecord::decode(&v.message).ok_or(FumpadError::InvalidAttestation)?;
    let keepers = verified_attesters(g, &v.signers, now)?;

    // Binding: this program, this cluster, this coin, one of its two pools.
    require!(r.program_id == crate::ID && r.cluster_tag == g.cluster_tag, FumpadError::WrongCluster);
    require!(r.venue_valid(), FumpadError::InvalidAttestation);
    let coin = &ctx.accounts.coin;
    require_keys_eq!(r.mint, coin.mint, FumpadError::PoolNotOfCoin);
    let pool_ok = if r.is_damm() {
        coin.damm_pool != Pubkey::default() && r.pool == coin.damm_pool
    } else {
        r.pool == coin.dbc_pool
    };
    require!(pool_ok, FumpadError::PoolNotOfCoin);

    // Record rules.
    let p = coin.reward_params(&g.params);
    require!(r.trader != Pubkey::default(), FumpadError::InvalidAttestation);
    require_keys_neq!(r.trader, coin.creator, FumpadError::CreatorSell);
    require!(r.usd_cents >= p.min_sell_usd_cents, FumpadError::BelowMinimumUsd);
    require!(
        r.ticket_tokens > 0 && r.ticket_tokens <= r.base_amount && r.quote_gross > 0 && r.ticket_price_q64 > 0,
        FumpadError::InvalidTicketAmount
    );
    require!(r.slot >= coin.launch_slot, FumpadError::InvalidAttestation);
    require!(
        r.block_time >= coin.created_at.saturating_sub(ATTEST_CLOCK_SKEW_SECS)
            && r.block_time <= now.saturating_add(ATTEST_CLOCK_SKEW_SECS),
        FumpadError::InvalidAttestation
    );
    require!(now.saturating_sub(r.block_time) <= p.max_attest_age_secs, FumpadError::AttestationExpired);
    let pyth_age = r.block_time.checked_sub(r.pyth_publish_time).ok_or(FumpadError::MathOverflow)?;
    require!(pyth_age >= 0 && pyth_age as u64 <= p.max_price_age_secs, FumpadError::StalePythPrice);

    // Replay marker. An existing marker refuses the trade, unless the guardian reopened it (L-2) and this is a
    // different (corrected) message than the voided one.
    let sig_hash = sell_consumed_seeds_hash(&r.signature);
    let message_hash = sell_message_hash(&v.message);
    let ix_key = r.ix_key.to_le_bytes();
    let (consumed_key, consumed_bump) =
        Pubkey::find_program_address(&[CONSUMED_SEED, &sig_hash, &ix_key], &crate::ID);
    let a = &ctx.accounts;
    require_keys_eq!(a.consumed.key(), consumed_key, FumpadError::InvalidAccount);
    let reopened = if *a.consumed.owner == crate::ID {
        let m = Consumed::try_deserialize(&mut &a.consumed.try_borrow_data()?[..])?;
        require!(
            m.kind == CONSUMED_KIND_SELL_REOPENED && m.message_hash != message_hash,
            FumpadError::AlreadyConsumed
        );
        Some(m)
    } else {
        None
    };

    // Position (created on the wallet's first ticket on this coin).
    let mint = r.mint;
    let trader = r.trader;
    let (position_key, position_bump) =
        Pubkey::find_program_address(&[POSITION_SEED, mint.as_ref(), trader.as_ref()], &crate::ID);
    require_keys_eq!(a.position.key(), position_key, FumpadError::InvalidAccount);
    let (keeper_info, system) = (a.keeper.to_account_info(), a.system_program.to_account_info());
    let position_info = a.position.to_account_info();
    let mut pos = if *position_info.owner == crate::ID {
        Position::try_deserialize(&mut &position_info.try_borrow_data()?[..])?
    } else {
        create_pda_account(
            &keeper_info,
            &position_info,
            &system,
            8 + Position::INIT_SPACE,
            &[POSITION_SEED, mint.as_ref(), trader.as_ref(), &[position_bump]],
        )?;
        Position {
            bump: position_bump,
            wallet: trader,
            mint,
            next_ticket_seq: 0,
            open_tickets: [Pubkey::default(); MAX_OPEN_TICKETS],
            open_count: 0,
            auto_claim_opt_out: 0,
            rent_payer: keeper,
            tickets_created: 0,
            reserved: [0; 32],
        }
    };
    require!(pos.open_count < p.max_open_tickets, FumpadError::TooManyOpenTickets);

    // Rate cap (% of supply per hour): over the cap the ticket is deferred, never refused (M-1).
    let coin = &mut ctx.accounts.coin;
    let effective_at = coin.schedule_attest(now, r.ticket_tokens, p.max_attest_tokens_per_hour_bps);
    coin.tickets_created = coin.tickets_created.saturating_add(1);

    // Ticket.
    let a = &ctx.accounts;
    let seq = pos.next_ticket_seq;
    let seq_bytes = seq.to_le_bytes();
    let (ticket_key, ticket_bump) =
        Pubkey::find_program_address(&[TICKET_SEED, mint.as_ref(), trader.as_ref(), &seq_bytes], &crate::ID);
    require_keys_eq!(a.ticket.key(), ticket_key, FumpadError::InvalidAccount);
    let ticket_info = a.ticket.to_account_info();
    create_pda_account(
        &keeper_info,
        &ticket_info,
        &system,
        8 + Ticket::INIT_SPACE,
        &[TICKET_SEED, mint.as_ref(), trader.as_ref(), &seq_bytes, &[ticket_bump]],
    )?;
    let venue = if r.is_damm() { 1 } else { 0 };
    let source = if r.is_routed() { TicketSource::Router } else { TicketSource::Outside };
    let t = Ticket {
        bump: ticket_bump,
        owner: trader,
        mint,
        seq,
        tokens: r.ticket_tokens,
        original_tokens: r.ticket_tokens,
        sell_price_q64: r.ticket_price_q64,
        sell_usd_cents: r.usd_cents,
        sell_ts: r.block_time,
        status: TicketStatus::Open,
        queued_at: 0,
        claim_amount: 0,
        claimed_at: 0,
        escrow_payer: Pubkey::default(),
        source,
        venue,
        attested_at: effective_at,
        rent_payer: keeper,
        consumed: consumed_key,
        reserved: [0; 16],
    };
    write_account(&ticket_info, &t)?;

    let consumed_info = a.consumed.to_account_info();
    let marker_payer = match reopened {
        // Re-attestation of a reopened trade: the marker (and its original rent payer) is reused.
        Some(m) => m.rent_payer,
        None => {
            create_pda_account(
                &keeper_info,
                &consumed_info,
                &system,
                8 + Consumed::INIT_SPACE,
                &[CONSUMED_SEED, &sig_hash, &ix_key, &[consumed_bump]],
            )?;
            keeper
        }
    };
    write_account(
        &consumed_info,
        &Consumed {
            bump: consumed_bump,
            kind: CONSUMED_KIND_SELL,
            ticket: ticket_key,
            rent_payer: marker_payer,
            block_time: r.block_time,
            message_hash,
        },
    )?;

    pos.next_ticket_seq = seq.checked_add(1).ok_or(FumpadError::MathOverflow)?;
    pos.tickets_created = pos.tickets_created.saturating_add(1);
    require!(logic::push_open(&mut pos, ticket_key), FumpadError::InvalidAccount);
    write_account(&position_info, &pos)?;

    emit_event!(ctx, TicketAttested {
        mint,
        owner: trader,
        ticket: ticket_key,
        seq,
        pool: r.pool,
        venue,
        source: source as u8,
        signature: r.signature,
        ix_key: r.ix_key,
        base_amount: r.base_amount,
        quote_gross: r.quote_gross,
        tokens: r.ticket_tokens,
        sell_price_q64: r.ticket_price_q64,
        sell_usd_cents: r.usd_cents,
        pyth_publish_time: r.pyth_publish_time,
        slot: r.slot,
        sell_ts: r.block_time,
        keepers,
        submitter: keeper,
        ts: now,
        effective_at,
    });
    Ok(())
}
