//! Internal pre-audit review of the v0.7 program (`contracts/REVIEW-v0.7.md`). Each finding was first reproduced by
//! an `issue_*` test on the MAINNET DBC 0.2.1 / DAMM v2 0.2.4 binaries; after the fix it is a `regression_*` test
//! asserting the fixed behaviour. The `regression_*` tests at the end cover the review's notes and the contract
//! items of the off-chain review (`security-review/REPORT-v0.7.md` L1, L3).

use anchor_lang::prelude::Pubkey;
use fumpad::attestation::SellRecord;
use fumpad::error::FumpadError;
use fumpad::events::{FeesClaimed, Graduated, SampleRecorded, TicketAttested, TicketVoided};
use fumpad::external::meteora as m;
use fumpad::state::{
    CoinStatus, Consumed, Params, Position, Ticket, TicketStatus, CONSUMED_KIND_SELL, CONSUMED_KIND_SELL_REOPENED,
};
use solana_instruction::Instruction;
use solana_keypair::Keypair;

use crate::flow::*;
use crate::meteora::{self, WSOL};
use crate::*;

const TOKENS: u64 = 10_000_000_000; // 10,000 tokens
const PRICE: u128 = 1 << 50;

// ── DAMM v2 / Token-2022 builders (IDL 0.2.x) ────────────────────────────────
const IX_DAMM_CREATE_POSITION: [u8; 8] = [48, 215, 197, 153, 96, 203, 180, 133];
const IX_DAMM_ADD_LIQUIDITY: [u8; 8] = [181, 157, 89, 67, 143, 182, 52, 72];
const IX_DAMM_PERMANENT_LOCK_POSITION: [u8; 8] = [165, 176, 125, 6, 231, 171, 186, 213];

fn damm_create_position_ix(owner: &Pubkey, nft_mint: &Pubkey, pool: &Pubkey, payer: &Pubkey) -> Instruction {
    raw_ix(
        &meteora::DAMM,
        &[
            ro(*owner),
            sgw(*nft_mint),
            rw(meteora::damm_position_nft_account(nft_mint)),
            rw(*pool),
            rw(meteora::damm_position(nft_mint)),
            ro(m::DAMM_POOL_AUTHORITY),
            sgw(*payer),
            ro(TOKEN_2022),
            ro(SYSTEM),
            ro(m::DAMM_EVENT_AUTHORITY),
            ro(meteora::DAMM),
        ],
        IX_DAMM_CREATE_POSITION.to_vec(),
    )
}

fn damm_add_liquidity_ix(owner: &Pubkey, nft_mint: &Pubkey, pool: &Pubkey, mint: &Pubkey, liquidity: u128) -> Instruction {
    let mut data = IX_DAMM_ADD_LIQUIDITY.to_vec();
    data.extend_from_slice(&liquidity.to_le_bytes());
    data.extend_from_slice(&u64::MAX.to_le_bytes());
    data.extend_from_slice(&u64::MAX.to_le_bytes());
    raw_ix(
        &meteora::DAMM,
        &[
            rw(*pool),
            rw(meteora::damm_position(nft_mint)),
            rw(base_ata(owner, mint)),
            rw(wsol_ata(owner)),
            rw(meteora::damm_vault(mint, pool)),
            rw(meteora::damm_vault(&WSOL, pool)),
            ro(*mint),
            ro(WSOL),
            ro(meteora::damm_position_nft_account(nft_mint)),
            sg(*owner),
            ro(TOKEN_2022),
            ro(SPL_TOKEN),
            ro(m::DAMM_EVENT_AUTHORITY),
            ro(meteora::DAMM),
        ],
        data,
    )
}

fn damm_permanent_lock_ix(owner: &Pubkey, nft_mint: &Pubkey, pool: &Pubkey, liquidity: u128) -> Instruction {
    let mut data = IX_DAMM_PERMANENT_LOCK_POSITION.to_vec();
    data.extend_from_slice(&liquidity.to_le_bytes());
    raw_ix(
        &meteora::DAMM,
        &[
            rw(*pool),
            rw(meteora::damm_position(nft_mint)),
            ro(meteora::damm_position_nft_account(nft_mint)),
            sg(*owner),
            ro(m::DAMM_EVENT_AUTHORITY),
            ro(meteora::DAMM),
        ],
        data,
    )
}

/// Token-2022 `SetAuthority(AccountOwner)`: hand a token account to `new_owner`.
fn set_account_owner_ix(account: &Pubkey, owner: &Pubkey, new_owner: &Pubkey) -> Instruction {
    let mut data = vec![6u8, 2, 1];
    data.extend_from_slice(new_owner.as_ref());
    raw_ix(&TOKEN_2022, &[rw(*account), sg(*owner)], data)
}

/// A curve coin whose DBC pool was completed and migrated to DAMM v2 directly on DBC (as Meteora's mainnet migration
/// keepers do), but not yet `graduate`d by fumpad. Returns (env, coin, attacker holding tokens + WSOL, nft mint).
fn migrated_not_graduated() -> (Env, TCoin, Keypair, Pubkey) {
    let mut env = Env::new();
    let c = env.launch(SOL / 10);
    env.skip_launch_window();
    let attacker = env.new_user(100);
    ok(env.direct_buy(&c, &attacker, SOL));
    env.complete_curve(&c);
    // Anyone may migrate directly on DBC (no fumpad involved).
    let migrator = env.new_user(10);
    let nft = Keypair::new();
    let i = meteora::dbc_migration_ix(&c.config, &c.mint, &kp_pk(&nft), &kp_pk(&migrator));
    ok(env.send_as(&migrator, &[compute_budget_ix(1_000_000), i], &[&migrator, &nft]));
    env.fund_wsol(&attacker, SOL);
    (env, c, attacker, kp_pk(&nft))
}

// ── H-1 ──────────────────────────────────────────────────────────────────────
/// H-1 (fixed): `graduate` no longer compares our position with the pool's liquidity. A third party adding
/// liquidity to the DAMM v2 pool between the DBC migration and `graduate` (≈0.02% here, any amount works) doesn't
/// block graduation: the coin graduates, DAMM sells are attestable and the router trades on DAMM v2.
#[test]
fn regression_third_party_damm_liquidity_cannot_block_graduate() {
    let (mut env, c, attacker, nft) = migrated_not_graduated();
    let pool = c.damm_pool();
    let liquidity = meteora::rd_u128(&env.data(&pool), m::DAMM_POOL_LIQUIDITY);
    let a = kp_pk(&attacker);
    let a_nft = Keypair::new();
    let ixs = [
        damm_create_position_ix(&a, &kp_pk(&a_nft), &pool, &a),
        damm_add_liquidity_ix(&a, &kp_pk(&a_nft), &pool, &c.mint, liquidity / 5_000),
    ];
    ok(env.send_as(&attacker, &ixs, &[&attacker, &a_nft]));
    // Even more liquidity than ours: still no effect on graduate.
    ok(env.send_as(&attacker, &[damm_add_liquidity_ix(&a, &kp_pk(&a_nft), &pool, &c.mint, liquidity / 1_000)], &[&attacker]));
    // The attacker's own (unlocked, not fee_claimer-held) position is refused as ours.
    let k = env.keepers[0].insecure_clone();
    assert_fumpad_err(env.graduate(&c, &k, &kp_pk(&a_nft)), FumpadError::InvalidMigratedPool);

    ok(env.graduate(&c, &k, &nft));
    let coin = env.coin(&c);
    assert_eq!((coin.status, coin.damm_pool, coin.damm_position), (CoinStatus::Graduated, pool, meteora::damm_position(&nft)));
    let seller = Pubkey::new_unique();
    let r = env.sell_record(&c, &seller, TOKENS, PRICE);
    assert_eq!(r.pool, pool);
    ok(env.attest_sell(&r, &[0, 1]));
    ok(env.router_buy(&c, &attacker, SOL / 10));
}

/// H-1 hardening: the DAMM v2 position NFT account has no ImmutableOwner extension, so a third party can lock some
/// liquidity of its own permanently and hand the NFT account to `fee_claimer`; an early `graduate` then records THAT
/// position. This only costs the attacker its locked liquidity: `claim_lp_fees` accepts every `fee_claimer`-held
/// position of the coin's pool, so the fees of our 100% position are still claimed and split.
#[test]
fn regression_position_handed_to_fee_claimer_cannot_strand_our_lp_fees() {
    let (mut env, c, attacker, nft) = migrated_not_graduated();
    let pool = c.damm_pool();
    let liquidity = meteora::rd_u128(&env.data(&pool), m::DAMM_POOL_LIQUIDITY);
    let a = kp_pk(&attacker);
    let a_nft = Keypair::new();
    let dust = liquidity / 1_000_000;
    let ixs = [
        damm_create_position_ix(&a, &kp_pk(&a_nft), &pool, &a),
        damm_add_liquidity_ix(&a, &kp_pk(&a_nft), &pool, &c.mint, dust),
        damm_permanent_lock_ix(&a, &kp_pk(&a_nft), &pool, dust),
        set_account_owner_ix(&meteora::damm_position_nft_account(&kp_pk(&a_nft)), &a, &env.fee_claimer()),
    ];
    ok(env.send_as(&attacker, &ixs, &[&attacker, &a_nft]));
    let k = env.keepers[0].insecure_clone();
    ok(env.graduate(&c, &k, &kp_pk(&a_nft)));
    assert_eq!(env.coin(&c).damm_position, meteora::damm_position(&kp_pk(&a_nft)), "front-run recorded");

    ok(env.claim_fees(&c)); // settles the launch flag
    let bob = env.new_user(100);
    ok(env.router_buy(&c, &bob, 5 * SOL));
    ok(env.direct_buy(&c, &bob, 5 * SOL));
    // Our real position (DBC's, 100% of the migrated liquidity) keeps paying the coin.
    let ev: FeesClaimed = event(&ok(env.claim_lp_fees(&c, &nft)));
    assert!(ev.claimed > 5 * SOL / 100, "LP fees {}", ev.claimed);
    env.assert_coin_invariant(&c);
    // A position whose NFT isn't held by fee_claimer can't be claimed (DAMM checks the owner signs).
    let b = kp_pk(&bob);
    let b_nft = Keypair::new();
    env.fund_wsol(&bob, SOL);
    ok(env.send_as(&bob, &[damm_create_position_ix(&b, &kp_pk(&b_nft), &pool, &b)], &[&bob, &b_nft]));
    assert!(env.claim_lp_fees(&c, &kp_pk(&b_nft)).is_err());
    // Another coin's position is refused.
    let other = env.launch(SOL / 10);
    env.skip_launch_window();
    let other_nft = env.graduate_coin(&other);
    let mut i = env.claim_lp_fees_ix(&c, &kp_pk(&k), &other_nft);
    i.accounts[5].pubkey = addr(&meteora::damm_position(&other_nft));
    assert_fumpad_err(env.send_as(&k, &[i], &[&k]), FumpadError::WrongVenue);
}

// ── M-1 ──────────────────────────────────────────────────────────────────────
fn curve_coin() -> (Env, TCoin) {
    let mut env = Env::new();
    let c = env.launch(SOL / 10);
    env.skip_launch_window();
    env.warp(60);
    (env, c)
}

/// M-1 (fixed): the per-coin cap is a leaky bucket that DEFERS tickets beyond 20% of supply per hour (their
/// challenge window starts later) and never refuses one, and rebuy debits / guardian voids give their capacity
/// back. A wallet that sells and buys back each hour no longer starves honest sellers, and organic volume over the
/// cap only delays claimability — no honest sell is lost to `AttestationExpired`.
#[test]
fn regression_rate_cap_releases_cancelled_tickets_and_never_loses_honest_sells() {
    let (mut env, c) = curve_coin();
    let cap = meteora::TOTAL_SUPPLY / 5;
    let whale = Pubkey::new_unique();
    for _ in 0..3 {
        // The whale sells a full hour's cap and buys it back (the rebuy voids its ticket).
        let r = env.sell_record(&c, &whale, cap, PRICE);
        ok(env.attest_sell(&r, &[0, 1]));
        let seq = env.fetch::<Position>(&position_pda(&c.mint, &whale)).next_ticket_seq - 1;
        let tk = ticket_pda(&c.mint, &whale, seq);
        let t: Ticket = env.fetch(&tk);
        ok(env.attest_rebuy(&rebuy_record(&t, tk, cap, env.now() - 5), &[0, 1], false));
        assert_eq!(env.fetch::<Ticket>(&tk).status, TicketStatus::Voided);
        // An honest sell right after is effective immediately (the whale's capacity was released).
        let h = env.sell_record(&c, &Pubkey::new_unique(), TOKENS, PRICE);
        let ev: TicketAttested = event(&ok(env.attest_sell(&h, &[0, 1])));
        assert_eq!(ev.effective_at, env.now());
        env.warp(3_600);
    }
    // A guardian void releases too.
    let r = env.sell_record(&c, &Pubkey::new_unique(), cap, PRICE);
    let ev: TicketAttested = event(&ok(env.attest_sell(&r, &[0, 1])));
    let admin = env.admin.insecure_clone();
    ok(env.send(&[env.void_ticket_ix(&kp_pk(&admin), &ev.ticket, 1, false)], &[&admin]));
    let h = env.sell_record(&c, &Pubkey::new_unique(), TOKENS, PRICE);
    let ev: TicketAttested = event(&ok(env.attest_sell(&h, &[0, 1])));
    assert_eq!(ev.effective_at, env.now());

    // Real (kept) tickets worth 3 hours of cap: the next honest sell is deferred ≈ 2 h, not refused.
    env.warp(3_600);
    for _ in 0..3 {
        let r = env.sell_record(&c, &Pubkey::new_unique(), cap, PRICE);
        ok(env.attest_sell(&r, &[0, 1]));
    }
    let honest = Pubkey::new_unique();
    let h = env.sell_record(&c, &honest, TOKENS, PRICE);
    let ev: TicketAttested = event(&ok(env.attest_sell(&h, &[0, 1])));
    let now = env.now();
    assert!(ev.effective_at > now + 2 * 3_600 - 10 && ev.effective_at <= now + 2 * 3_600 + 1, "{}", ev.effective_at - now);
    assert_eq!(env.fetch::<Ticket>(&ev.ticket).attested_at, ev.effective_at);
    // Its challenge window runs from the effective time: the guardian can still void it after 6 h.
    env.warp(fumpad::DEFAULT_TICKET_CHALLENGE_SECS + 3_600);
    ok(env.send(&[env.void_ticket_ix(&kp_pk(&admin), &ev.ticket, 1, false)], &[&admin]));
}

// ── L-1 ──────────────────────────────────────────────────────────────────────
/// L-1 (fixed): the attesting keeper (`rent_payer`) can no longer close a Position whose wallet opted out of
/// auto-claim, so the D17 opt-out survives; the wallet itself still can. A Position that never opted out stays
/// closable by its rent payer (rent recovery; re-creation restores the same default).
#[test]
fn regression_keeper_cannot_reset_a_wallets_auto_claim_opt_out() {
    let (mut env, c) = curve_coin();
    let alice = env.new_user(1);
    let a = kp_pk(&alice);
    let r = env.sell_record(&c, &a, TOKENS, PRICE);
    ok(env.attest_sell(&r, &[0, 1]));
    let pos_key = position_pda(&c.mint, &a);
    let opt_out = ix(
        fumpad::accounts::SetAutoClaim { wallet: a, position: pos_key, event_authority: ev_auth(), program: fumpad::ID },
        fumpad::instruction::SetAutoClaim { enabled: false },
    );
    ok(env.send_as(&alice, &[opt_out], &[&alice]));

    let keeper = env.keepers[0].insecure_clone();
    let end_ticket = |env: &mut Env, seq: u64| {
        let tk = ticket_pda(&c.mint, &a, seq);
        let t: Ticket = env.fetch(&tk);
        ok(env.attest_rebuy(&rebuy_record(&t, tk, TOKENS, env.now() - 5), &[0, 1], false));
        let close_t = ix(
            fumpad::accounts::CloseTicket {
                caller: kp_pk(&env.payer),
                global: env.global(),
                ticket: tk,
                rent_payer: t.rent_payer,
                position: position_pda(&c.mint, &t.owner),
                claim_queue: None,
                coin: c.coin_pda(),
                event_authority: ev_auth(),
                program: fumpad::ID,
            },
            fumpad::instruction::CloseTicket {},
        );
        ok(env.send(&[close_t], &[]));
        tk
    };
    let close_pos = |signer: &Pubkey, wallet: &Pubkey, rent_payer: &Pubkey, tickets: &[Pubkey]| {
        let rem: Vec<_> = tickets.iter().map(|t| ro(*t)).collect();
        ix_rem(
            fumpad::accounts::ClosePosition {
                signer: *signer,
                position: position_pda(&c.mint, wallet),
                rent_payer: *rent_payer,
                event_authority: ev_auth(),
                program: fumpad::ID,
            },
            fumpad::instruction::ClosePosition {},
            &rem,
        )
    };
    let tk0 = end_ticket(&mut env, 0);
    let k = kp_pk(&keeper);
    assert_fumpad_err(env.send_as(&keeper, &[close_pos(&k, &a, &k, &[tk0])], &[&keeper]), FumpadError::Unauthorized);
    // Next qualifying sell: the position (and the opt-out) is still there.
    let r2 = env.sell_record(&c, &a, TOKENS, PRICE);
    ok(env.attest_sell(&r2, &[0, 1]));
    assert_eq!(env.fetch::<Position>(&pos_key).auto_claim_opt_out, 1, "opt-out kept");
    // The wallet itself may close it (rent → the keeper that paid it).
    let tk1 = end_ticket(&mut env, 1);
    let before = env.lamports(&k);
    ok(env.send_as(&alice, &[close_pos(&a, &a, &k, &[tk0, tk1])], &[&alice]));
    assert!(env.lamports(&k) > before);

    // A wallet that never opted out: the keeper may close its empty position.
    let bob = Pubkey::new_unique();
    let rb = env.sell_record(&c, &bob, TOKENS, PRICE);
    ok(env.attest_sell(&rb, &[0, 1]));
    let tb = ticket_pda(&c.mint, &bob, 0);
    let t: Ticket = env.fetch(&tb);
    ok(env.attest_rebuy(&rebuy_record(&t, tb, TOKENS, env.now() - 5), &[0, 1], false));
    let close_t = ix(
        fumpad::accounts::CloseTicket {
            caller: kp_pk(&env.payer),
            global: env.global(),
            ticket: tb,
            rent_payer: k,
            position: position_pda(&c.mint, &bob),
            claim_queue: None,
            coin: c.coin_pda(),
            event_authority: ev_auth(),
            program: fumpad::ID,
        },
        fumpad::instruction::CloseTicket {},
    );
    ok(env.send(&[close_t], &[]));
    ok(env.send_as(&keeper, &[close_pos(&k, &bob, &k, &[tb])], &[&keeper]));
    assert!(!env.exists(&position_pda(&c.mint, &bob)));
}

// ── L-2 ──────────────────────────────────────────────────────────────────────
/// L-2 (fixed): `void_ticket(reason, reopen = true)` voids a wrong attestation (engine bug) and reopens the trade's
/// replay marker, so the corrected record of the SAME trade can be attested once. The voided message itself stays
/// refused, a live ticket still blocks every replay, and `reopen = false` (fraud) keeps the trade consumed.
#[test]
fn regression_voided_attestation_can_be_corrected() {
    let (mut env, c) = curve_coin();
    let alice = Pubkey::new_unique();
    let wrong = env.sell_record(&c, &alice, TOKENS / 10, PRICE); // engine bug: 10× too few tokens
    ok(env.attest_sell(&wrong, &[0, 1]));
    let tk0 = ticket_pda(&c.mint, &alice, 0);
    let marker = sell_consumed_pda(&wrong.signature, wrong.ix_key);
    let payer0 = env.fetch::<Consumed>(&marker).rent_payer;
    let admin = env.admin.insecure_clone();
    let ev: TicketVoided = event(&ok(env.send(&[env.void_ticket_ix(&kp_pk(&admin), &tk0, 1, true)], &[&admin])));
    assert!(ev.reopened);
    assert_eq!(env.fetch::<Consumed>(&marker).kind, CONSUMED_KIND_SELL_REOPENED);
    // The voided message can't be replayed (by any keeper pair).
    assert_fumpad_err(env.attest_sell(&wrong, &[1, 2]), FumpadError::AlreadyConsumed);
    // The corrected record of the same trade is accepted.
    let fixed = SellRecord { ticket_tokens: TOKENS, base_amount: TOKENS, ..wrong };
    ok(env.attest_sell(&fixed, &[0, 1]));
    let tk1 = ticket_pda(&c.mint, &alice, 1);
    let t1: Ticket = env.fetch(&tk1);
    assert_eq!((t1.tokens, t1.status, t1.consumed), (TOKENS, TicketStatus::Open, marker));
    let m: Consumed = env.fetch(&marker);
    assert_eq!((m.kind, m.ticket, m.rent_payer), (CONSUMED_KIND_SELL, tk1, payer0));
    // While that ticket lives, no other attestation of the trade gets in.
    let other = SellRecord { usd_cents: fixed.usd_cents + 1, ..fixed };
    assert_fumpad_err(env.attest_sell(&other, &[0, 1]), FumpadError::AlreadyConsumed);
    // A fraud void (no reopen) keeps the trade consumed for good.
    ok(env.send(&[env.void_ticket_ix(&kp_pk(&admin), &tk1, 2, false)], &[&admin]));
    assert_eq!(env.fetch::<Consumed>(&marker).kind, CONSUMED_KIND_SELL);
    assert_fumpad_err(env.attest_sell(&other, &[0, 1]), FumpadError::AlreadyConsumed);
}

// ── I-1 ──────────────────────────────────────────────────────────────────────
/// I-1 (fixed): when anyone calls DBC's permissionless `withdraw_leftover` before `graduate`, `Graduated` and the
/// Coin still record the 8% (vault balance less this coin's buybacks).
#[test]
fn regression_leftover_withdrawn_by_third_party_is_recorded() {
    let mut env = Env::new();
    let c = env.launch(SOL / 10);
    env.skip_launch_window();
    env.complete_curve(&c);
    let k = env.keepers[0].insecure_clone();
    let (r, nft) = env.migrate(&c, &k);
    ok(r);
    let rando = env.new_user(1);
    let i = meteora::dbc_withdraw_leftover_ix(&c.config, &c.mint, &env.reward_pool());
    ok(env.send_as(&rando, &[i], &[&rando]));
    let ev: Graduated = event(&ok(env.graduate(&c, &k, &nft)));
    let vault = env.token_balance(&env.reward_vault(&c.mint));
    crate::lifecycle_tests::assert_reward_pool_8pct(vault);
    let coin = env.coin(&c);
    assert_eq!(ev.leftover_tokens, vault - coin.buyback_tokens);
    assert_eq!(coin.leftover_tokens, ev.leftover_tokens);
    crate::lifecycle_tests::assert_reward_pool_8pct(ev.leftover_tokens);
}

// ── review notes + off-chain review items with contract changes ─────────────
/// Note: `record_samples` skips a coin that turned `Complete` (any router buy can do that) instead of failing the
/// whole keeper batch.
#[test]
fn regression_record_samples_skips_a_complete_coin() {
    let mut env = Env::new();
    let a = env.launch(SOL / 10);
    let b = env.launch(SOL / 10);
    env.skip_launch_window();
    env.complete_curve(&b);
    assert_eq!(env.coin(&b).status, CoinStatus::Complete);
    let meta = ok(env.sample(0, &[&b, &a]));
    let evs: Vec<SampleRecorded> = events(&meta);
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0].mint, a.mint);
    assert_eq!(env.coin(&a).pregrad_sample_ts, env.now());
    assert_eq!(env.coin(&b).pregrad_sample_ts, 0);
}

/// Note: lamports pre-funded into the transient `fee_wsol` PDA aren't reported as partner surplus nor spent as the
/// setup budget; they go back to the caller with the account's rent.
#[test]
fn regression_graduated_surplus_ignores_a_prefunded_fee_wsol() {
    let mut env = Env::new();
    let c = env.launch(SOL / 10);
    env.skip_launch_window();
    env.complete_curve(&c);
    let k = env.keepers[0].insecure_clone();
    let (r, nft) = env.migrate(&c, &k);
    ok(r);
    let donor = env.new_user(100);
    let gift = 50 * SOL;
    ok(env.send_as(&donor, &[meteora::system_transfer_ix(&kp_pk(&donor), &env.fee_wsol(), gift)], &[&donor]));
    let before = env.lamports(&kp_pk(&k));
    let meta = ok(env.graduate(&c, &k, &nft));
    let ev: Graduated = event(&meta);
    assert_eq!(ev.migration_fee, meteora::MAINNET_THRESHOLD / 100);
    assert!(ev.surplus < SOL, "surplus {}", ev.surplus);
    assert_eq!(ev.migrator_refund + ev.caller_refund + ev.setup_prefunded + ev.platform_fee, ev.migration_fee + ev.surplus);
    assert_eq!(env.coin(&c).migration_fee_lamports, ev.migration_fee + ev.surplus);
    let gained = env.lamports(&kp_pk(&k)) + meta.fee - before;
    assert!(gained >= gift && gained <= gift + ev.caller_refund + ev.migrator_refund, "caller got {gained}");
    assert!(!env.exists(&env.fee_wsol()));
    env.assert_coin_invariant(&c);
}

/// Note (D38): a DAMM v2 pool disabled by its operator is refused by the router with `PoolDisabled`.
#[test]
fn regression_router_refuses_a_disabled_damm_pool() {
    let mut env = Env::new();
    let c = env.launch(SOL / 10);
    env.skip_launch_window();
    env.graduate_coin(&c);
    let bob = env.new_user(100);
    ok(env.router_buy(&c, &bob, SOL));
    let pool = c.damm_pool();
    let mut acc = env.svm.get_account(&addr(&pool)).unwrap();
    acc.data[m::DAMM_POOL_STATUS] = 1;
    env.svm.set_account(addr(&pool), acc).unwrap();
    assert_fumpad_err(env.router_buy(&c, &bob, SOL), FumpadError::PoolDisabled);
    let tokens = env.base_balance(&kp_pk(&bob), &c.mint);
    assert_fumpad_err(env.router_sell(&c, &bob, tokens / 2), FumpadError::PoolDisabled);
}

/// Off-chain review L1: with `Global.params.launch_signer` set, `register_coin` needs that key's signature, so only
/// API-built launch transactions register coins. Unset (default) keeps v0.7 behaviour.
#[test]
fn regression_launch_signer_binds_register_coin() {
    let launch_key = Keypair::new();
    let mut env = Env::new();
    let params = Params { launch_signer: kp_pk(&launch_key), ..Params::default() };
    env.set_params_timelocked(params);
    let cfg = env.config;
    let creator = env.new_user(100);
    let launch = |env: &Env, signer: Option<&Keypair>, mint: &Pubkey| {
        let mut ixs = env.launch_ixs(&cfg, &kp_pk(&creator), mint, 0);
        let reg = ixs.last_mut().unwrap();
        // Optional accounts `launch_signer`, `fee_policy` sit right before the event-CPI pair.
        let at = reg.accounts.len() - 4;
        if let Some(s) = signer {
            reg.accounts[at] = solana_instruction::AccountMeta::new_readonly(addr(&kp_pk(s)), true);
        }
        ixs
    };
    let mint = Keypair::new();
    let ixs = launch(&env, None, &kp_pk(&mint));
    assert_fumpad_err(env.send_as(&creator, &ixs, &[&creator, &mint]), FumpadError::Unauthorized);
    let rando = Keypair::new();
    let ixs = launch(&env, Some(&rando), &kp_pk(&mint));
    assert_fumpad_err(env.send_as(&creator, &ixs, &[&creator, &mint, &rando]), FumpadError::Unauthorized);
    let ixs = launch(&env, Some(&launch_key), &kp_pk(&mint));
    ok(env.send_as(&creator, &ixs, &[&creator, &mint, &launch_key]));
    assert!(env.exists(&env.coin_pda(&kp_pk(&mint))));
}

/// Off-chain review L1 (UNVERIFIED → verified on the mainnet DBC 0.2.1 binary): DBC's
/// `enable_first_swap_with_min_fee` gives the min fee to ONE swap of the pool-creation transaction. Two more
/// top-level sybil swaps in the same launch tx (with or without the instructions sysvar) pay the 99% scheduler fee,
/// so `register_coin` needs no "only one swap" introspection.
#[test]
fn verify_dbc_min_fee_goes_to_one_swap_per_launch_tx() {
    let mut env = Env::new();
    let cfg = env.config;
    let creator = env.new_user(1_000);
    let s1 = env.new_user(100);
    let s2 = env.new_user(100);
    let mint = Keypair::new();
    let mpk = kp_pk(&mint);
    for u in [&creator, &s1, &s2] {
        env.fund_wsol(u, SOL);
    }
    let mut ixs = env.launch_ixs(&cfg, &kp_pk(&creator), &mpk, SOL);
    let reg = ixs.pop().unwrap();
    for (s, sysvar) in [(&s1, true), (&s2, false)] {
        ixs.push(meteora::create_ata_idempotent_ix(&kp_pk(s), &kp_pk(s), &mpk, &TOKEN_2022));
        ixs.push(meteora::dbc_buy_ix(&cfg, &mpk, &kp_pk(s), SOL, 0, 0, sysvar));
    }
    ixs.push(reg);
    ok(env.send_as(&creator, &ixs, &[&creator, &mint, &s1, &s2]));
    let first = env.base_balance(&kp_pk(&creator), &mpk);
    for s in [&s1, &s2] {
        let got = env.base_balance(&kp_pk(s), &mpk);
        // 99% fee: ~1% of the creator's (min-fee) output for the same 1 SOL.
        assert!(got * 50 < first, "sybil got {got} vs creator {first}");
    }
}
