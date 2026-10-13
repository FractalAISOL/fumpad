//! D31 attested tickets: `attest_sell`, `attest_rebuy`, `void_ticket`, `close_consumed` — happy paths and every
//! adversarial case of SPEC v0.7 §9 (forged / duplicate / replayed attestation, single keeper, keeper not in the
//! set, wrong or third-party pool, creator as trader, rate cap, challenge window, guardian void, rebuy debit, pause).

use crate::flow::*;
use crate::*;
use fumpad::attestation::{SellRecord, VENUE_ROUTED_BIT};
use fumpad::error::FumpadError;
use fumpad::events::{ConsumedClosed, TicketAttested, TicketDebited, TicketVoided};
use fumpad::state::{Consumed, Position, Ticket, TicketSource, TicketStatus};
use solana_keypair::Keypair;

const TOKENS: u64 = 10_000_000_000; // 10,000 tokens
const PRICE: u128 = 1 << 50; // arbitrary ticket price (Q64)

fn setup() -> (Env, TCoin) {
    let mut env = Env::new();
    let c = env.launch(SOL / 10);
    env.skip_launch_window();
    env.warp(60);
    (env, c)
}

fn ticket_of(env: &Env, r: &SellRecord, seq: u64) -> (Pubkey, Ticket) {
    let k = ticket_pda(&r.mint, &r.trader, seq);
    (k, env.fetch(&k))
}

#[test]
fn attest_sell_creates_ticket_position_and_marker() {
    let (mut env, c) = setup();
    let alice = Pubkey::new_unique();
    let mut r = env.sell_record(&c, &alice, TOKENS, PRICE);
    r.venue |= VENUE_ROUTED_BIT;
    let k0 = kp_pk(&env.keepers[0]);
    let before = env.lamports(&k0);
    let meta = ok(env.attest_sell(&r, &[0, 1]));
    let (tk, t) = ticket_of(&env, &r, 0);
    assert_eq!((t.owner, t.mint, t.seq, t.tokens, t.original_tokens), (alice, c.mint, 0, TOKENS, TOKENS));
    assert_eq!((t.sell_price_q64, t.sell_usd_cents, t.sell_ts), (PRICE, r.usd_cents, r.block_time));
    assert_eq!((t.status, t.source, t.venue), (TicketStatus::Open, TicketSource::Router, 0));
    assert_eq!((t.attested_at, t.rent_payer), (env.now(), k0));
    assert_eq!(t.consumed, sell_consumed_pda(&r.signature, r.ix_key));
    let pos: Position = env.fetch(&position_pda(&c.mint, &alice));
    assert_eq!((pos.wallet, pos.open_count, pos.next_ticket_seq, pos.rent_payer), (alice, 1, 1, k0));
    assert_eq!(pos.open_tickets[0], tk);
    let cm: Consumed = env.fetch(&t.consumed);
    assert_eq!((cm.ticket, cm.rent_payer, cm.block_time, cm.kind), (tk, k0, r.block_time, 0));
    assert!(before - env.lamports(&k0) > 0, "the submitting keeper pays the rent");
    let ev: TicketAttested = event(&meta);
    assert_eq!((ev.ticket, ev.owner, ev.tokens, ev.ix_key, ev.source), (tk, alice, TOKENS, r.ix_key, 1));
    assert_eq!(ev.signature, r.signature);
    assert_eq!(ev.keepers, [k0, kp_pk(&env.keepers[1])]);
    assert_eq!(env.coin(&c).tickets_created, 1);
    // A second sell of the same wallet: next seq, same position.
    let r2 = env.sell_record(&c, &alice, TOKENS, PRICE);
    ok(env.attest_sell(&r2, &[2, 1]));
    let (_, t2) = ticket_of(&env, &r2, 1);
    assert_eq!((t2.seq, t2.source), (1, TicketSource::Outside));
    println!("attest_sell CU {}", meta.compute_units_consumed);
}

#[test]
fn attestation_requires_two_distinct_active_keepers() {
    let (mut env, c) = setup();
    let r = env.sell_record(&c, &Pubkey::new_unique(), TOKENS, PRICE);
    // Single keeper.
    assert_fumpad_err(env.attest_sell(&r, &[0]), FumpadError::NotEnoughKeeperSignatures);
    // The same keeper twice.
    assert_fumpad_err(env.attest_sell(&r, &[1, 1]), FumpadError::NotEnoughKeeperSignatures);
    // A keeper + an outsider.
    let outsider = Keypair::new();
    let k0 = env.keepers[0].insecure_clone();
    let ixs = vec![Env::ed25519_ix(&r.encode(), &[&k0, &outsider]), env.attest_sell_ix(&kp_pk(&k0), &r)];
    assert_fumpad_err(env.send_as(&k0, &ixs, &[&k0]), FumpadError::NotEnoughKeeperSignatures);
    // Two keepers + an outsider: the outsider is ignored.
    let k1 = env.keepers[1].insecure_clone();
    let ixs = vec![Env::ed25519_ix(&r.encode(), &[&outsider, &k0, &k1]), env.attest_sell_ix(&kp_pk(&k0), &r)];
    ok(env.send_as(&k0, &ixs, &[&k0]));
}

#[test]
fn non_keeper_cannot_submit_and_new_keepers_are_frozen_for_6h() {
    let (mut env, c) = setup();
    // Two valid keeper signatures, submitted by an outsider → Unauthorized (rent payer must be a keeper).
    let r = env.sell_record(&c, &Pubkey::new_unique(), TOKENS, PRICE);
    let outsider = env.new_user(1);
    let (k0, k1) = (env.keepers[0].insecure_clone(), env.keepers[1].insecure_clone());
    let ixs = vec![Env::ed25519_ix(&r.encode(), &[&k0, &k1]), env.attest_sell_ix(&kp_pk(&outsider), &r)];
    assert_fumpad_err(env.send_as(&outsider, &ixs, &[&outsider]), FumpadError::Unauthorized);
    // Rotate keeper 2 → a new key: it can sample/submit, but its signature counts only after 6h.
    let fresh = env.new_user(10);
    ok(env.set_keepers([kp_pk(&k0), kp_pk(&k1), kp_pk(&fresh)]));
    let g: fumpad::state::Global = env.fetch(&env.global());
    assert_eq!(g.keeper_added_at[2], env.now());
    assert!(g.keeper_added_at[0] < env.now(), "unchanged keys keep their timestamp");
    env.keepers[2] = fresh.insecure_clone();
    let r = env.sell_record(&c, &Pubkey::new_unique(), TOKENS, PRICE);
    assert_fumpad_err(env.attest_sell(&r, &[2, 0]), FumpadError::NotEnoughKeeperSignatures);
    ok(env.attest_sell(&r, &[0, 1]));
    env.warp(fumpad::KEEPER_ATTEST_FREEZE_SECS);
    let r = env.sell_record(&c, &Pubkey::new_unique(), TOKENS, PRICE);
    ok(env.attest_sell(&r, &[2, 0]));
    // Duplicate keys in set_keepers are rejected.
    assert_fumpad_err(env.set_keepers([kp_pk(&k0), kp_pk(&k0), Pubkey::default()]), FumpadError::InvalidParams);
}

#[test]
fn forged_and_tampered_signatures_fail_in_the_precompile() {
    let (mut env, c) = setup();
    let r = env.sell_record(&c, &Pubkey::new_unique(), TOKENS, PRICE);
    let (k0, k1) = (env.keepers[0].insecure_clone(), env.keepers[1].insecure_clone());
    // Signature by another key, claimed to be keeper 1's.
    let thief = Keypair::new();
    let msg = r.encode();
    let sigs = vec![
        (kp_pk(&k0).to_bytes(), <[u8; 64]>::try_from(k0.sign_message(&msg).as_ref()).unwrap()),
        (kp_pk(&k1).to_bytes(), <[u8; 64]>::try_from(thief.sign_message(&msg).as_ref()).unwrap()),
    ];
    let forged = solana_instruction::Instruction {
        program_id: addr(&fumpad::ED25519_PROGRAM_ID),
        accounts: vec![],
        data: fumpad::attestation::build_ed25519_data(&sigs, &msg),
    };
    let res = env.send_as(&k0, &[forged, env.attest_sell_ix(&kp_pk(&k0), &r)], &[&k0]);
    assert_precompile_rejected(&res);
    // Keepers signed r, the submitter swaps in a bigger ticket: precompile rejects (bytes differ).
    let mut big = r;
    big.ticket_tokens *= 10;
    big.base_amount *= 10;
    let mut ed = Env::ed25519_ix(&r.encode(), &[&k0, &k1]);
    let off = ed.data.len() - msg.len();
    ed.data[off..].copy_from_slice(&big.encode());
    let res = env.send_as(&k0, &[ed, env.attest_sell_ix(&kp_pk(&k0), &big)], &[&k0]);
    assert_precompile_rejected(&res);
    assert!(!env.exists(&ticket_pda(&c.mint, &r.trader, 0)));
}

#[test]
fn ed25519_instruction_must_be_immediately_before_and_self_contained() {
    let (mut env, c) = setup();
    let r = env.sell_record(&c, &Pubkey::new_unique(), TOKENS, PRICE);
    let (k0, k1) = (env.keepers[0].insecure_clone(), env.keepers[1].insecure_clone());
    let ed = Env::ed25519_ix(&r.encode(), &[&k0, &k1]);
    let at = env.attest_sell_ix(&kp_pk(&k0), &r);
    // No Ed25519 instruction at all.
    assert_fumpad_err(env.send_as(&k0, &[at.clone()], &[&k0]), FumpadError::MissingAttestation);
    // Something between the Ed25519 instruction and attest_sell.
    assert_fumpad_err(
        env.send_as(&k0, &[ed.clone(), compute_budget_ix(400_000), at.clone()], &[&k0]),
        FumpadError::MissingAttestation,
    );
    // An Ed25519 instruction whose entries point at ANOTHER instruction's data (here: the first Ed25519 ix).
    let mut pointing = ed.clone();
    let n = pointing.data[0] as usize;
    for i in 0..n {
        let o = 2 + 14 * i;
        for idx in [o + 2, o + 6, o + 12] {
            pointing.data[idx..idx + 2].copy_from_slice(&0u16.to_le_bytes());
        }
    }
    assert_fumpad_err(env.send_as(&k0, &[ed.clone(), pointing, at.clone()], &[&k0]), FumpadError::InvalidAttestation);
    // One Ed25519 instruction can't serve two attest_sell instructions.
    let r2 = SellRecord { ix_key: r.ix_key + 1, ..r };
    let at2 = env.attest_sell_ix(&kp_pk(&k0), &r2);
    assert_fumpad_err(env.send_as(&k0, &[ed.clone(), at.clone(), at2], &[&k0]), FumpadError::MissingAttestation);
    ok(env.send_as(&k0, &[ed, at], &[&k0]));
}

#[test]
fn replayed_and_duplicate_attestations_are_rejected() {
    let (mut env, c) = setup();
    let alice = Pubkey::new_unique();
    let r = env.sell_record(&c, &alice, TOKENS, PRICE);
    ok(env.attest_sell(&r, &[0, 1]));
    // Same record again (another keeper pair) → consumed.
    assert_fumpad_err(env.attest_sell(&r, &[1, 2]), FumpadError::AlreadyConsumed);
    // Same trade (signature, ix_key) for another trader/amount → consumed.
    let r2 = SellRecord { trader: Pubkey::new_unique(), ticket_tokens: 1, ..r };
    assert_fumpad_err(env.attest_sell(&r2, &[0, 2]), FumpadError::AlreadyConsumed);
    // Same tx signature, another swap instruction in it (ix_key) → a separate ticket.
    let r3 = SellRecord { ix_key: r.ix_key + 1, ..r };
    ok(env.attest_sell(&r3, &[0, 2]));
    assert_eq!(env.fetch::<Position>(&position_pda(&c.mint, &alice)).open_count, 2);
}

#[test]
fn record_binding_rules() {
    let (mut env, c) = setup();
    let t = Pubkey::new_unique();
    let base = env.sell_record(&c, &t, TOKENS, PRICE);
    let cases: Vec<(SellRecord, FumpadError)> = vec![
        (SellRecord { cluster_tag: 0, ..base }, FumpadError::WrongCluster),
        (SellRecord { program_id: Pubkey::new_unique(), ..base }, FumpadError::WrongCluster),
        // A third-party pool for the mint (e.g. someone's own DAMM pool): never counts.
        (SellRecord { pool: Pubkey::new_unique(), ..base }, FumpadError::PoolNotOfCoin),
        // DAMM venue before graduation (no DAMM pool recorded).
        (SellRecord { venue: 1, ..base }, FumpadError::PoolNotOfCoin),
        (SellRecord { venue: 0x02, ..base }, FumpadError::InvalidAttestation),
        (SellRecord { trader: kp_pk(&c.creator), ..base }, FumpadError::CreatorSell),
        (SellRecord { trader: Pubkey::default(), ..base }, FumpadError::InvalidAttestation),
        (SellRecord { usd_cents: 4_999, ..base }, FumpadError::BelowMinimumUsd),
        (SellRecord { ticket_tokens: TOKENS + 1, ..base }, FumpadError::InvalidTicketAmount),
        (SellRecord { ticket_tokens: 0, ..base }, FumpadError::InvalidTicketAmount),
        (SellRecord { ticket_price_q64: 0, ..base }, FumpadError::InvalidTicketAmount),
        (SellRecord { quote_gross: 0, ..base }, FumpadError::InvalidTicketAmount),
        (SellRecord { block_time: env.now() + 120, pyth_publish_time: env.now() + 100, ..base }, FumpadError::InvalidAttestation),
        (SellRecord { block_time: env.now() - 2 * 86_400, pyth_publish_time: env.now() - 2 * 86_400, ..base }, FumpadError::InvalidAttestation),
        (SellRecord { pyth_publish_time: base.block_time + 1, ..base }, FumpadError::StalePythPrice),
        (SellRecord { pyth_publish_time: base.block_time - 61, ..base }, FumpadError::StalePythPrice),
        (SellRecord { slot: 0, ..base }, FumpadError::InvalidAttestation),
    ];
    for (i, (r, e)) in cases.into_iter().enumerate() {
        let mut r = r;
        r.ix_key = 1000 + i as u32;
        let res = env.attest_sell(&r, &[0, 1]);
        assert_eq!(err_code(&res), Some(fumpad_err(e)), "case {i} expected {e:?}");
    }
    // Pyth exactly 60 s before the trade is fine (max_price_age_secs = 60).
    ok(env.attest_sell(&SellRecord { pyth_publish_time: base.block_time - 60, ..base }, &[0, 1]));
    // 24h + 1 s later the same kind of record is too old.
    env.warp(fumpad::DEFAULT_MAX_ATTEST_AGE_SECS + 1);
    let old = SellRecord { ix_key: 9_999, ..base };
    assert_fumpad_err(env.attest_sell(&old, &[0, 1]), FumpadError::AttestationExpired);
}

/// M-1 design: the per-coin cap (20% of supply per hour) defers tickets past it — their challenge window starts
/// later — and never refuses one; once the backlog drains, tickets are effective immediately again.
#[test]
fn rate_cap_defers_tokens_beyond_the_hourly_cap() {
    let (mut env, c) = setup();
    let cap = meteora::TOTAL_SUPPLY / 5;
    let t0 = env.now();
    let r1 = env.sell_record(&c, &Pubkey::new_unique(), cap, PRICE);
    let meta = ok(env.attest_sell(&r1, &[0, 1]));
    let ev: TicketAttested = event(&meta);
    assert_eq!((ev.ts, ev.effective_at), (t0, t0), "one hour's cap is effective at once");
    // Half an hour of cap beyond it → effective 30 min later (claimable 30 min later too).
    let bob = Pubkey::new_unique();
    let r2 = env.sell_record(&c, &bob, cap / 2, PRICE);
    let meta = ok(env.attest_sell(&r2, &[0, 1]));
    let ev: TicketAttested = event(&meta);
    assert_eq!(ev.effective_at, t0 + 1_800);
    let (_, t) = ticket_of(&env, &r2, 0);
    assert_eq!(t.attested_at, t0 + 1_800);
    // Two hours later the backlog has drained: effective immediately.
    env.warp(2 * 3_600);
    let r3 = env.sell_record(&c, &Pubkey::new_unique(), cap, PRICE);
    let ev: TicketAttested = event(&ok(env.attest_sell(&r3, &[0, 1])));
    assert_eq!(ev.effective_at, env.now());
}

#[test]
fn open_ticket_limit_pause_and_status() {
    let (mut env, c) = setup();
    let alice = Pubkey::new_unique();
    for _ in 0..5 {
        let r = env.sell_record(&c, &alice, TOKENS, PRICE);
        ok(env.attest_sell(&r, &[0, 1]));
    }
    let r = env.sell_record(&c, &alice, TOKENS, PRICE);
    assert_fumpad_err(env.attest_sell(&r, &[0, 1]), FumpadError::TooManyOpenTickets);
    // PAUSE_ATTEST stops attestations (guardian/admin); lapses after 7 days.
    let admin = env.admin.insecure_clone();
    ok(env.set_pause(&admin, fumpad::state::PAUSE_ATTEST));
    let r = env.sell_record(&c, &Pubkey::new_unique(), TOKENS, PRICE);
    assert_fumpad_err(env.attest_sell(&r, &[0, 1]), FumpadError::Paused);
    ok(env.set_pause(&admin, 0));
    ok(env.attest_sell(&r, &[0, 1]));
}

#[test]
fn tickets_attested_in_every_status_and_venue() {
    let (mut env, c) = setup();
    let alice = Pubkey::new_unique();
    let pre = env.sell_record(&c, &alice, TOKENS, PRICE); // DBC sell before completion
    env.graduate_coin(&c);
    env.warp(60);
    // The DBC sell, attested after graduation, still counts (venue 0 = the coin's DBC pool).
    let pre = SellRecord { block_time: env.now() - 30, pyth_publish_time: env.now() - 31, slot: env.slot(), ..pre };
    ok(env.attest_sell(&pre, &[0, 1]));
    // A DAMM v2 sell.
    let post = env.sell_record(&c, &alice, TOKENS, PRICE);
    assert_eq!(post.venue, 1);
    ok(env.attest_sell(&post, &[1, 2]));
    let (_, t) = ticket_of(&env, &post, 1);
    assert_eq!(t.venue, 1);
    // DAMM pool of a third party for the same mint: rejected.
    let fake = SellRecord { pool: Pubkey::new_unique(), ix_key: 77, ..post };
    assert_fumpad_err(env.attest_sell(&fake, &[0, 1]), FumpadError::PoolNotOfCoin);
}

#[test]
fn rebuy_debits_voids_and_cannot_replay() {
    let (mut env, c) = setup();
    let alice = Pubkey::new_unique();
    let r = env.sell_record(&c, &alice, TOKENS, PRICE);
    ok(env.attest_sell(&r, &[0, 1]));
    let r2 = env.sell_record(&c, &alice, TOKENS, PRICE);
    ok(env.attest_sell(&r2, &[0, 1]));
    let (k0, t0) = ticket_of(&env, &r, 0);
    let (k1, t1) = ticket_of(&env, &r2, 1);
    // One buy debits two tickets (newest first is the engine's order; each (buy, ticket) consumed once).
    let rb = rebuy_record(&t1, k1, TOKENS / 4, env.now() - 5);
    let meta = ok(env.attest_rebuy(&rb, &[0, 2], false));
    let ev: TicketDebited = event(&meta);
    assert_eq!((ev.debited, ev.remaining, ev.voided), (TOKENS / 4, TOKENS - TOKENS / 4, false));
    let rb0 = fumpad::attestation::RebuyRecord { ticket: k0, ..rb };
    ok(env.attest_rebuy(&rb0, &[0, 2], false));
    assert_eq!(env.fetch::<Ticket>(&k0).tokens, TOKENS - TOKENS / 4);
    // Replay of the same (buy, ticket) → consumed.
    assert_fumpad_err(env.attest_rebuy(&rb, &[1, 2], false), FumpadError::AlreadyConsumed);
    // A big rebuy voids the ticket (capped at its tokens) and frees the open slot.
    let big = fumpad::attestation::RebuyRecord { ix_key: 2, debit_tokens: TOKENS * 9, ..rb };
    let meta = ok(env.attest_rebuy(&big, &[0, 1], false));
    let ev: TicketDebited = event(&meta);
    assert_eq!((ev.debited, ev.remaining, ev.voided), (TOKENS - TOKENS / 4, 0, true));
    assert_eq!(env.fetch::<Ticket>(&k1).status, TicketStatus::Voided);
    let pos: Position = env.fetch(&position_pda(&c.mint, &alice));
    assert_eq!(pos.open_count, 1);
    // Voided → no more debits.
    let again = fumpad::attestation::RebuyRecord { ix_key: 3, ..rb };
    assert_fumpad_err(env.attest_rebuy(&again, &[0, 1], false), FumpadError::TicketNotOpen);
    // Window: a buy before the sell or after 7 days doesn't debit.
    let early = fumpad::attestation::RebuyRecord { ticket: k0, ix_key: 4, block_time: t0.sell_ts - 1, ..rb };
    assert_fumpad_err(env.attest_rebuy(&early, &[0, 1], false), FumpadError::RebuyOutOfWindow);
    let late = fumpad::attestation::RebuyRecord { ticket: k0, ix_key: 5, block_time: t0.sell_ts + 7 * 86_400 + 1, ..rb };
    assert_fumpad_err(env.attest_rebuy(&late, &[0, 1], false), FumpadError::RebuyOutOfWindow);
    // Mismatched owner in the signed message (accounts are the real ticket's) / single keeper / zero debit.
    let right = fumpad::attestation::RebuyRecord { ticket: k0, ix_key: 6, ..rb };
    let wrong = fumpad::attestation::RebuyRecord { owner: Pubkey::new_unique(), ..right };
    let (ka, kb) = (env.keepers[0].insecure_clone(), env.keepers[1].insecure_clone());
    let ixs = vec![Env::ed25519_ix(&wrong.encode(), &[&ka, &kb]), env.attest_rebuy_ix(&kp_pk(&ka), &right, false)];
    assert_fumpad_err(env.send_as(&ka, &ixs, &[&ka]), FumpadError::InvalidAttestation);
    let single = fumpad::attestation::RebuyRecord { ticket: k0, ix_key: 7, ..rb };
    assert_fumpad_err(env.attest_rebuy(&single, &[0], false), FumpadError::NotEnoughKeeperSignatures);
    let zero = fumpad::attestation::RebuyRecord { ticket: k0, ix_key: 8, debit_tokens: 0, ..rb };
    assert_fumpad_err(env.attest_rebuy(&zero, &[0, 1], false), FumpadError::ZeroAmount);
    // A sell message can't be used as a rebuy (domain separation).
    let k = env.keepers[0].insecure_clone();
    let k_1 = env.keepers[1].insecure_clone();
    let ixs = vec![Env::ed25519_ix(&r.encode(), &[&k, &k_1]), env.attest_rebuy_ix(&kp_pk(&k), &single, false)];
    assert_fumpad_err(env.send_as(&k, &ixs, &[&k]), FumpadError::InvalidAttestation);
}

#[test]
fn guardian_voids_inside_the_challenge_window_only() {
    let (mut env, c) = setup();
    let alice = Pubkey::new_unique();
    let r = env.sell_record(&c, &alice, TOKENS, PRICE);
    ok(env.attest_sell(&r, &[0, 1]));
    let r2 = env.sell_record(&c, &alice, TOKENS, PRICE);
    ok(env.attest_sell(&r2, &[0, 1]));
    let (k0, _) = ticket_of(&env, &r, 0);
    let (k1, _) = ticket_of(&env, &r2, 1);
    let void = |env: &Env, who: &Pubkey, t: &Pubkey| env.void_ticket_ix(who, t, 3, false);
    let rando = env.new_user(1);
    let i = void(&env, &kp_pk(&rando), &k0);
    assert_fumpad_err(env.send_as(&rando, &[i], &[&rando]), FumpadError::Unauthorized);
    let admin = env.admin.insecure_clone();
    let i = void(&env, &kp_pk(&admin), &k0);
    let meta = ok(env.send(&[i], &[&admin]));
    let ev: TicketVoided = event(&meta);
    assert_eq!((ev.ticket, ev.reason, ev.authority), (k0, 3, kp_pk(&admin)));
    assert_eq!((ev.mint, ev.coin, ev.reopened), (c.mint, c.coin_pda(), false));
    assert_eq!(env.fetch::<Ticket>(&k0).status, TicketStatus::Voided);
    assert_eq!(env.fetch::<Position>(&position_pda(&c.mint, &alice)).open_count, 1);
    // Already voided → not open.
    let i = void(&env, &kp_pk(&admin), &k0);
    assert_fumpad_err(env.send(&[i], &[&admin]), FumpadError::TicketNotOpen);
    // After 6 h the attestation stands.
    env.warp(fumpad::DEFAULT_TICKET_CHALLENGE_SECS);
    let i = void(&env, &kp_pk(&admin), &k1);
    assert_fumpad_err(env.send(&[i], &[&admin]), FumpadError::ChallengeWindowOver);
}

#[test]
fn consumed_markers_close_only_after_ticket_and_max_age() {
    let (mut env, c) = setup();
    let alice = Pubkey::new_unique();
    let r = env.sell_record(&c, &alice, TOKENS, PRICE);
    ok(env.attest_sell(&r, &[0, 1]));
    let (tk, t) = ticket_of(&env, &r, 0);
    let close = |env: &Env| {
        ix(
            fumpad::accounts::CloseConsumed {
                caller: kp_pk(&env.payer),
                global: env.global(),
                consumed: t.consumed,
                rent_payer: t.rent_payer,
                ticket: tk,
                event_authority: ev_auth(),
                program: fumpad::ID,
            },
            fumpad::instruction::CloseConsumed {},
        )
    };
    assert_fumpad_err(env.send(&[close(&env)], &[]), FumpadError::ConsumedNotClosable);
    // Void + close the ticket (permissionless, rent → keeper).
    let admin = env.admin.insecure_clone();
    let v = env.void_ticket_ix(&kp_pk(&admin), &tk, 0, false);
    ok(env.send(&[v], &[&admin]));
    let ct = ix(
        fumpad::accounts::CloseTicket {
            caller: kp_pk(&env.payer),
            global: env.global(),
            ticket: tk,
            rent_payer: t.rent_payer,
            position: position_pda(&c.mint, &alice),
            claim_queue: None,
            coin: c.coin_pda(),
            event_authority: ev_auth(),
            program: fumpad::ID,
        },
        fumpad::instruction::CloseTicket {},
    );
    let keeper_before = env.lamports(&t.rent_payer);
    ok(env.send(&[ct], &[]));
    assert!(env.lamports(&t.rent_payer) > keeper_before);
    // Ticket gone, but the trade is still young enough to be re-attested → marker stays.
    assert_fumpad_err(env.send(&[close(&env)], &[]), FumpadError::ConsumedNotClosable);
    env.warp(fumpad::MAX_MAX_ATTEST_AGE_SECS + 1);
    let meta = ok(env.send(&[close(&env)], &[]));
    let ev: ConsumedClosed = event(&meta);
    assert_eq!((ev.ticket, ev.rent_payer), (tk, t.rent_payer));
    // The same trade can never be attested again: older than any allowed max age.
    assert_fumpad_err(env.attest_sell(&r, &[0, 1]), FumpadError::AttestationExpired);
}

/// The Ed25519 precompile (instruction 0) failed the transaction before fumpad ran.
#[track_caller]
fn assert_precompile_rejected(res: &litesvm::types::TransactionResult) {
    let e = res.as_ref().err().expect("must fail");
    assert!(format!("{:?}", e.err).starts_with("InstructionError(0,"), "{:?}", e.err);
}
