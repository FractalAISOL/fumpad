//! Cross-module hooks. OWNER: rewards module. CALLERS: curve `buy`/`sell`, router `swap_buy`/`swap_sell`.
//!
//! The signatures here are the contract between modules — don't change them without
//! updating every caller. Callers include these accounts in their own Accounts structs:
//!
//!   position:       Account<Position>   — init_if_needed, seeds ["position", mint, user], payer = user
//!                                          (call `position.init_if_new(..)` before the hook)
//!   ticket:         UncheckedAccount     — mut; PDA ["ticket", mint, user, position.next_ticket_seq]
//!                                          (created by `on_sell` only if the sell qualifies)
//!   sol_usd_price:  UncheckedAccount     — Pyth PriceUpdateV2 (validated in `on_sell` only when
//!                                          a ticket would otherwise be created)
//!
//! and, for buys, the wallet's open tickets as the FIRST `position.open_count`
//! entries of `remaining_accounts` (router: venue accounts follow them), all writable.
//!
//! The hooks make CPIs (system create_account for the ticket, event self-CPI). Call them
//! BEFORE any direct `sub_lamports`/`add_lamports` move in the caller.
//!
//! Both hooks also take `event_authority` (the caller's `#[event_cpi]` account,
//! `ctx.accounts.event_authority`) so they can emit TicketCreated / TicketDebited.

use anchor_lang::{
    prelude::*,
    solana_program::{instruction::Instruction, program::invoke_signed},
    system_program,
};

use crate::{
    constants::TICKET_SEED,
    error::FumpadError,
    events::{TicketCreated, TicketDebited},
    external::pyth,
    math::{price::price_q64, reference::ticket_price_q64},
    state::{Coin, Global, Params, Position, Ticket, TicketStatus},
};

use super::logic::{self, NoTicket, RebuyView};

pub struct SellHookAccounts<'a, 'info> {
    pub global: &'a Global,
    pub coin: &'a Account<'info, Coin>,
    pub position: &'a mut Account<'info, Position>,
    pub ticket: &'a AccountInfo<'info>,
    pub sol_usd_price: &'a AccountInfo<'info>,
    /// The seller; pays ticket rent.
    pub seller: &'a AccountInfo<'info>,
    pub system_program: &'a AccountInfo<'info>,
    pub program_id: &'a Pubkey,
    /// The caller's `#[event_cpi]` event authority.
    pub event_authority: &'a AccountInfo<'info>,
}

#[derive(Clone, Copy, Debug)]
pub struct SellInfo {
    pub tokens_sold: u64,
    /// SOL received for the tokens before FUMPAD's fee (execution value).
    pub gross_lamports_out: u64,
    /// Seller's token balance immediately BEFORE the sell (caps eligibility).
    pub balance_before: u64,
    /// D10: the coin's reference average AFTER this sell's touch point
    /// (`coin.reference.avg_q64`, see `math/reference.rs`). Callers must update the
    /// reference before the hook.
    pub reference_price_q64: u128,
    /// D12: spot right BEFORE this sell (Q64): curve spot (curve) / effective PumpSwap
    /// spot (router). 0 = unknown → D10 floor. Ticket price =
    /// max(execution, reference × execution ÷ pre_trade_spot).
    pub pre_trade_spot_q64: u128,
    pub now: i64,
}

/// Called AFTER a sell executes. Settles the position, debits eligibility, and — if the
/// sell qualifies (USD ≥ min, seller ≠ creator, matured tokens, < max open tickets) —
/// creates the ticket. Never fails the sell for eligibility reasons: returns Ok(None).
/// Errors only on malformed accounts (wrong position, wrong ticket PDA, ticket address
/// already taken by a non-system account). Oracle problems (wrong/stale/uncertain Pyth
/// account) mean "no ticket", never a failed sell: the sell path must not depend on Pyth
/// liveness.
pub fn on_sell(a: SellHookAccounts, info: SellInfo) -> Result<Option<Pubkey>> {
    let p = &a.global.params;
    let mint = a.coin.mint;
    let seller = a.seller.key();
    {
        let pos = &**a.position;
        require_keys_eq!(pos.wallet, seller, FumpadError::InvalidAccount);
        require_keys_eq!(pos.mint, mint, FumpadError::InvalidAccount);
    }
    require_keys_eq!(*a.program_id, crate::ID, FumpadError::InvalidAccount);
    let seq = a.position.next_ticket_seq;
    let seq_bytes = seq.to_le_bytes();
    let (ticket_key, ticket_bump) =
        Pubkey::find_program_address(&[TICKET_SEED, mint.as_ref(), seller.as_ref(), &seq_bytes], &crate::ID);
    require_keys_eq!(a.ticket.key(), ticket_key, FumpadError::InvalidAccount);

    let is_creator = seller == a.coin.creator;
    let plan = match evaluate_sell(a.position, p, is_creator, &info, || {
        pyth::load_sol_usd(a.sol_usd_price, &p.sol_usd_feed_id, info.now, p.max_price_age_secs)
    }) {
        Ok(plan) => plan,
        Err(_) => return Ok(None),
    };
    let TicketPlan { tokens: ticket_tokens, sell_price_q64, sell_usd_cents } = plan;

    let space = 8 + Ticket::INIT_SPACE;
    create_pda_account(
        a.seller,
        a.ticket,
        a.system_program,
        space,
        &[TICKET_SEED, mint.as_ref(), seller.as_ref(), &seq_bytes, &[ticket_bump]],
    )?;
    let t = Ticket {
        bump: ticket_bump,
        owner: seller,
        mint,
        seq,
        tokens: ticket_tokens,
        original_tokens: ticket_tokens,
        sell_price_q64,
        sell_usd_cents,
        sell_ts: info.now,
        status: TicketStatus::Open,
        queued_at: 0,
        claim_amount: 0,
        claimed_at: 0,
        reserved: [0; 32],
    };
    write_ticket(a.ticket, &t)?;

    let pos = &mut **a.position;
    pos.next_ticket_seq = seq.checked_add(1).ok_or(FumpadError::MathOverflow)?;
    require!(logic::push_open(pos, ticket_key), FumpadError::InvalidAccount);

    emit_event(
        a.event_authority,
        &TicketCreated {
            mint,
            owner: seller,
            ticket: ticket_key,
            tokens: ticket_tokens,
            sell_price_q64,
            sell_usd_cents,
            ts: info.now,
        },
    )?;
    Ok(Some(ticket_key))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TicketPlan {
    pub tokens: u64,
    pub sell_price_q64: u128,
    /// USD value of the ticket's tokens at the sell price (the $50 check is on this).
    pub sell_usd_cents: u64,
}

/// Pure decision for a sell: mutates the position (settle, cap to balance, debit every
/// sold token) and returns the ticket to create, or why none. The oracle is only
/// consulted when everything else qualifies.
///
/// The minimum-USD rule is applied to the *ticket's* tokens (the matured part of the
/// sell), not the whole sell — stricter than "sell ≥ $50", so a big sell of mostly
/// unmatured tokens can't mint a dust ticket. It uses the execution value.
///
/// Ticket price (D12, refining D10) = max(execution price, reference × execution ÷
/// pre-trade spot): an honest seller gets their real fill in a flat market, while a crash
/// staged inside one bundle (ratio ≈ 1) can't lower the price the 10x is measured against.
pub fn evaluate_sell(
    pos: &mut Position,
    p: &Params,
    is_creator: bool,
    info: &SellInfo,
    sol_usd: impl FnOnce() -> core::result::Result<pyth::UsdPrice, pyth::OracleIssue>,
) -> core::result::Result<TicketPlan, NoTicket> {
    let tokens = logic::plan_sell(pos, p, is_creator, info.tokens_sold, info.balance_before, info.now)?;
    let execution_q64 = price_q64(info.gross_lamports_out, info.tokens_sold)
        .filter(|&x| x > 0)
        .ok_or(NoTicket::ZeroPrice)?;
    let sell_price_q64 = ticket_price_q64(execution_q64, info.reference_price_q64, info.pre_trade_spot_q64);
    let usd = sol_usd().map_err(|_| NoTicket::OracleUnavailable)?;
    // Pro-rata share of the proceeds (exact floor; avoids double Q64 rounding).
    let ticket_lamports = (info.gross_lamports_out as u128) * (tokens as u128) / (info.tokens_sold as u128);
    let sell_usd_cents = u64::try_from(ticket_lamports)
        .ok()
        .and_then(|l| pyth::lamports_to_usd_cents(l, &usd))
        .ok_or(NoTicket::OracleUnavailable)?;
    if sell_usd_cents < p.min_sell_usd_cents {
        return Err(NoTicket::BelowMinimumUsd);
    }
    Ok(TicketPlan { tokens, sell_price_q64, sell_usd_cents })
}

pub struct BuyHookAccounts<'a, 'info> {
    pub global: &'a Global,
    pub coin: &'a Account<'info, Coin>,
    pub position: &'a mut Account<'info, Position>,
    /// Exactly the position's open tickets, in any order, writable.
    pub open_tickets: &'a [AccountInfo<'info>],
    /// The caller's `#[event_cpi]` event authority.
    pub event_authority: &'a AccountInfo<'info>,
}

/// Called AFTER a buy executes. Applies the rebuy rule to open tickets whose sell was
/// within the rebuy window, then adds `tokens_bought` to the position's pending bucket.
pub fn on_buy(a: BuyHookAccounts, tokens_bought: u64, now: i64) -> Result<()> {
    require_keys_eq!(a.position.mint, a.coin.mint, FumpadError::InvalidAccount);
    apply_rebuy(&a.global.params, a.position, a.open_tickets, tokens_bought, now, a.event_authority)?;
    a.position.add(tokens_bought, now, a.global.params.min_hold_secs);
    Ok(())
}

/// Rebuy rule shared by `on_buy` and `register_holdings`. `open_tickets` must be exactly
/// the position's open set. Debits newest-first, voids at zero (and removes voided
/// tickets from the open list), emits TicketDebited per touched ticket.
pub fn apply_rebuy(
    p: &Params,
    position: &mut Position,
    open_tickets: &[AccountInfo<'_>],
    amount: u64,
    now: i64,
    event_authority: &AccountInfo<'_>,
) -> Result<()> {
    let keys: Vec<Pubkey> = open_tickets.iter().map(|t| t.key()).collect();
    require!(logic::open_set_matches(position, &keys), FumpadError::OpenTicketsMismatch);
    if open_tickets.is_empty() {
        return Ok(());
    }
    let mut tickets = Vec::with_capacity(open_tickets.len());
    for info in open_tickets {
        let t = read_ticket(info)?;
        require_keys_eq!(t.owner, position.wallet, FumpadError::InvalidAccount);
        require_keys_eq!(t.mint, position.mint, FumpadError::InvalidAccount);
        tickets.push(t);
    }
    if amount == 0 {
        return Ok(());
    }
    let views: Vec<RebuyView> = tickets
        .iter()
        .map(|t| RebuyView { sell_ts: t.sell_ts, seq: t.seq, tokens: t.tokens, status: t.status })
        .collect();
    let debits = logic::plan_rebuy(&views, amount, now, p.rebuy_window_secs);
    for ((info, t), d) in open_tickets.iter().zip(tickets.iter_mut()).zip(debits) {
        if d == 0 {
            continue;
        }
        require!(info.is_writable, FumpadError::InvalidAccount);
        t.tokens -= d;
        let owed = logic::claim_amount(t.tokens, p.claim_bps);
        if t.status == TicketStatus::Queued {
            // The queue entry is re-synced (or dropped) by process_queue / close_ticket.
            t.claim_amount = owed;
        }
        let voided = t.tokens == 0 || owed == 0;
        if voided {
            t.status = TicketStatus::Voided;
            logic::remove_open(position, &info.key());
        }
        write_ticket(info, t)?;
        emit_event(
            event_authority,
            &TicketDebited { ticket: info.key(), debited: d, remaining: t.tokens, voided, ts: now },
        )?;
    }
    Ok(())
}

// ── helpers ──────────────────────────────────────────────────────────────────

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

/// Create a program-owned PDA paid by `payer`. Like Anchor's `init`, it tolerates the
/// address having been pre-funded (a griefer sending lamports to a predictable PDA
/// can't block creation): top up + allocate + assign instead of create_account.
pub fn create_pda_account<'info>(
    payer: &AccountInfo<'info>,
    target: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    space: usize,
    seeds: &[&[u8]],
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
            &crate::ID,
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
            CpiContext::new_with_signer(
                system_program::ID,
                system_program::Assign { account_to_assign: target.clone() },
                signer,
            ),
            &crate::ID,
        )
    }
}

/// `emit_cpi!` without a `ctx` in scope (hooks run inside other modules' handlers).
pub fn emit_event<E: anchor_lang::Event>(event_authority: &AccountInfo, event: &E) -> Result<()> {
    let (authority, bump) = crate::EVENT_AUTHORITY_AND_BUMP;
    require_keys_eq!(event_authority.key(), authority, FumpadError::InvalidAccount);
    let data: Vec<u8> = anchor_lang::event::EVENT_IX_TAG_LE.iter().copied().chain(event.data()).collect();
    let ix = Instruction::new_with_bytes(crate::ID, &data, vec![AccountMeta::new_readonly(authority, true)]);
    invoke_signed(&ix, &[event_authority.clone()], &[&[b"__event_authority", &[bump]]])
        .map_err(anchor_lang::error::Error::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::external::pyth::{OracleIssue, UsdPrice};

    const USD_150: UsdPrice = UsdPrice { price: 150_00000000, exponent: -8 };

    fn matured_position(amount: u64) -> Position {
        let mut s = Position {
            bump: 0,
            wallet: Pubkey::new_unique(),
            mint: Pubkey::new_unique(),
            matured: 0,
            pending: 0,
            pending_since: 0,
            next_ticket_seq: 0,
            open_tickets: [Pubkey::default(); crate::constants::MAX_OPEN_TICKETS],
            open_count: 0,
            reserved: [0; 64],
        };
        s.add(amount, 0, 600);
        s
    }

    fn sell(tokens: u64, lamports: u64) -> SellInfo {
        SellInfo {
            tokens_sold: tokens,
            gross_lamports_out: lamports,
            balance_before: tokens,
            reference_price_q64: 0,
            pre_trade_spot_q64: 0,
            now: 10_000,
        }
    }

    #[test]
    fn ticket_price_floored_at_reference() {
        let p = Params::default();
        let exec = price_q64(1_000_000_000, 1_000_000).unwrap();
        // Reference below execution (rising market / no crash): execution price.
        let mut i = sell(1_000_000, 1_000_000_000);
        i.reference_price_q64 = exec / 2;
        let t = evaluate_sell(&mut matured_position(1_000_000), &p, false, &i, || Ok(USD_150)).unwrap();
        assert_eq!(t.sell_price_q64, exec);
        // Staged crash: execution 20x below the reference → ticket at the reference.
        let crashed = sell(1_000_000, 50_000_000);
        let mut i = crashed;
        i.reference_price_q64 = exec;
        let usd_hi = UsdPrice { price: 3_000_00000000, exponent: -8 }; // keep ≥ $50 at crash
        let t = evaluate_sell(&mut matured_position(1_000_000), &p, false, &i, || Ok(usd_hi)).unwrap();
        assert_eq!(t.sell_price_q64, exec);
        // The $50 minimum still uses the execution value, not the floored price.
        assert_eq!(t.sell_usd_cents, 15_000);
        // D12, same crash with the pre-trade spot known: the sell filled 1% under the
        // crashed spot → ticket at 99% of the reference (rounded up), not the crash.
        let mut i = crashed;
        i.reference_price_q64 = exec;
        i.pre_trade_spot_q64 = price_q64(50_505_051, 1_000_000).unwrap();
        let t = evaluate_sell(&mut matured_position(1_000_000), &p, false, &i, || Ok(usd_hi)).unwrap();
        assert!(t.sell_price_q64 * 1_000 >= exec * 989 && t.sell_price_q64 <= exec, "{}", t.sell_price_q64);
        // D12, honest big sell in a flat market (reference = pre-trade spot, 10% impact):
        // ticket = execution price exactly.
        let mut i = sell(1_000_000, 900_000_000);
        i.reference_price_q64 = exec;
        i.pre_trade_spot_q64 = exec;
        let t = evaluate_sell(&mut matured_position(1_000_000), &p, false, &i, || Ok(USD_150)).unwrap();
        assert_eq!(t.sell_price_q64, price_q64(900_000_000, 1_000_000).unwrap());
        let mut i = crashed;
        i.reference_price_q64 = exec;
        assert_eq!(
            evaluate_sell(&mut matured_position(1_000_000), &p, false, &i, || Ok(USD_150)),
            Err(NoTicket::BelowMinimumUsd)
        );
    }

    #[test]
    fn fifty_dollar_minimum_on_ticket_value() {
        let p = Params::default();
        // $50 at $150/SOL = 0.33333334 SOL.
        let plan =
            evaluate_sell(&mut matured_position(1_000_000), &p, false, &sell(1_000_000, 333_333_334), || Ok(USD_150))
                .unwrap();
        assert_eq!(plan.tokens, 1_000_000);
        assert_eq!(plan.sell_usd_cents, 5_000);
        assert_eq!(plan.sell_price_q64, price_q64(333_333_334, 1_000_000).unwrap());
        let low =
            evaluate_sell(&mut matured_position(1_000_000), &p, false, &sell(1_000_000, 333_000_000), || Ok(USD_150));
        assert_eq!(low, Err(NoTicket::BelowMinimumUsd));
        // $100 sell where only half the tokens matured → ticket worth $50 → ok;
        // a third matured → $33 → no ticket.
        let r = evaluate_sell(&mut matured_position(500_000), &p, false, &sell(1_000_000, 666_666_668), || {
            Ok(USD_150)
        });
        assert_eq!(r.map(|t| t.tokens), Ok(500_000));
        let r = evaluate_sell(&mut matured_position(333_333), &p, false, &sell(1_000_000, 666_666_668), || {
            Ok(USD_150)
        });
        assert_eq!(r, Err(NoTicket::BelowMinimumUsd));
    }

    #[test]
    fn oracle_failure_means_no_ticket_and_is_lazy() {
        let p = Params::default();
        let r = evaluate_sell(&mut matured_position(1_000), &p, false, &sell(1_000, 10 * 1_000_000_000), || {
            Err(OracleIssue::Stale)
        });
        assert_eq!(r, Err(NoTicket::OracleUnavailable));
        // Creator: oracle never consulted, position still debited.
        let mut s = matured_position(1_000);
        let r = evaluate_sell(&mut s, &p, true, &sell(1_000, 1), || panic!("oracle must not be read"));
        assert_eq!(r, Err(NoTicket::Creator));
        assert_eq!(s.matured, 0);
        // Unmatured: oracle never consulted.
        let mut s = matured_position(1_000);
        let mut i = sell(1_000, 1);
        i.now = 599;
        assert_eq!(evaluate_sell(&mut s, &p, false, &i, || panic!("no oracle")), Err(NoTicket::NotMatured));
        // Zero proceeds → no ticket (a zero sell price would make the 10x trivially true).
        let r = evaluate_sell(&mut matured_position(1_000), &p, false, &sell(1_000, 0), || Ok(USD_150));
        assert_eq!(r, Err(NoTicket::ZeroPrice));
    }

    #[test]
    fn with_live_pyth_fixture() {
        let u = pyth::parse_price_update(&crate::external::pyth::tests::MAINNET_SOL_USD).unwrap();
        let p = Params::default();
        let usd = pyth::validate(&u, &p.sol_usd_feed_id, u.publish_time + 30, p.max_price_age_secs).unwrap();
        // ~$111.78/SOL (lower bound) → $50 needs ≥ 0.4473 SOL.
        let r = evaluate_sell(&mut matured_position(1_000), &p, false, &sell(1_000, 447_400_000), || Ok(usd));
        assert!(r.is_ok());
        let r = evaluate_sell(&mut matured_position(1_000), &p, false, &sell(1_000, 447_000_000), || Ok(usd));
        assert_eq!(r, Err(NoTicket::BelowMinimumUsd));
    }
}
