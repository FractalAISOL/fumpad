//! Internal pre-audit review of the v0.7 program (`contracts/REVIEW-v0.7.md`). Every `issue_*` test reproduces one
//! finding on the MAINNET DBC 0.2.1 / DAMM v2 0.2.4 binaries and PASSES WHILE THE ISSUE EXISTS (turn each into a
//! `regression_*` test asserting the fixed behaviour when it is fixed).

use anchor_lang::prelude::Pubkey;
use fumpad::attestation::SellRecord;
use fumpad::error::FumpadError;
use fumpad::external::meteora as m;
use fumpad::state::{CoinStatus, Position, Ticket, TicketStatus};
use solana_instruction::Instruction;
use solana_keypair::Keypair;

use crate::flow::*;
use crate::meteora::{self, WSOL};
use crate::*;

const TOKENS: u64 = 10_000_000_000; // 10,000 tokens
const PRICE: u128 = 1 << 50;

// ── DAMM v2 builders (IDL 0.2.x: create_position, add_liquidity) ─────────────
const IX_DAMM_CREATE_POSITION: [u8; 8] = [48, 215, 197, 153, 96, 203, 180, 133];
const IX_DAMM_ADD_LIQUIDITY: [u8; 8] = [181, 157, 89, 67, 143, 182, 52, 72];

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
/// H-1: `graduate` requires our permanently-locked position to hold ≥ 99.99% of the DAMM v2 pool's liquidity. DAMM v2
/// `create_position` + `add_liquidity` are permissionless, so anyone adding > 0.01% of the pool's liquidity (≈0.01
/// SOL + tokens at 85 SOL) between the DBC migration and `graduate` blocks graduation for as long as the liquidity
/// stays — the coin is stuck in `Curve`: no claims, no LP-fee claims, no router, no post-grad buybacks/samples, and
/// DAMM sells can't be attested. The attacker keeps (and can later withdraw) the liquidity.
#[test]
fn issue_third_party_damm_liquidity_blocks_graduate_forever() {
    let (mut env, c, attacker, nft) = migrated_not_graduated();
    let pool = c.damm_pool();
    let liquidity = meteora::rd_u128(&env.data(&pool), m::DAMM_POOL_LIQUIDITY);
    // Control: our position holds 100% right after migration.
    let ours = meteora::rd_u128(&env.data(&meteora::damm_position(&nft)), m::DAMM_POSITION_PERMANENT_LOCKED);
    assert_eq!(ours, liquidity);

    // Attacker: own position, 0.02% of the pool's liquidity.
    let a = kp_pk(&attacker);
    let a_nft = Keypair::new();
    let wsol_before = env.token_balance(&wsol_ata(&a));
    let ixs = [
        damm_create_position_ix(&a, &kp_pk(&a_nft), &pool, &a),
        damm_add_liquidity_ix(&a, &kp_pk(&a_nft), &pool, &c.mint, liquidity / 5_000),
    ];
    ok(env.send_as(&attacker, &ixs, &[&attacker, &a_nft]));
    let cost = wsol_before - env.token_balance(&wsol_ata(&a));
    assert!(cost < SOL / 50, "griefing costs {cost} lamports (+ tokens), all withdrawable");

    // graduate now fails, for every caller, at any later time.
    let k = env.keepers[0].insecure_clone();
    assert_fumpad_err(env.graduate(&c, &k, &nft), FumpadError::InvalidMigratedPool);
    env.warp(30 * 86_400);
    assert_fumpad_err(env.graduate(&c, &k, &nft), FumpadError::InvalidMigratedPool);
    assert_ne!(env.coin(&c).status, CoinStatus::Graduated);

    // Knock-on: DAMM sells can't be ticketed (the coin has no damm_pool), the router is dead (DBC refuses swaps).
    let seller = Pubkey::new_unique();
    let mut r = env.sell_record(&c, &seller, TOKENS, PRICE);
    r.pool = pool;
    r.venue = 1;
    assert_fumpad_err(env.attest_sell(&r, &[0, 1]), FumpadError::PoolNotOfCoin);
    assert!(env.router_buy(&c, &attacker, SOL / 10).is_err());
}

// ── M-1 ──────────────────────────────────────────────────────────────────────
fn curve_coin() -> (Env, TCoin) {
    let mut env = Env::new();
    let c = env.launch(SOL / 10);
    env.skip_launch_window();
    env.warp(60);
    (env, c)
}

/// Warp to `bucket_start + offset` of the next rate-cap bucket (sliding hour, `ATTEST_BUCKET_SECS`).
fn warp_to_bucket_offset(env: &mut Env, offset: i64) {
    let now = env.now();
    let next = (now.div_euclid(3_600) + 1) * 3_600;
    env.warp(next + offset - now);
}

/// M-1: the per-coin hourly cap counts attested `ticket_tokens` and never gives them back when a rebuy debit (or a
/// guardian void) cancels the ticket. A wallet that sells → gets a ticket → buys back fills the cap at the cost of
/// trading fees only (its own tickets are voided by the rebuy rule), and every honest sell that doesn't fit is
/// refused with `AttestRateLimited`; after `max_attest_age_secs` (24 h) it is `AttestationExpired` forever. This
/// contradicts SPEC §5.2 ("excess → retry later, never lost"); hot coins can also hit it organically (≥ 20% of
/// supply/hour of qualifying sells).
#[test]
fn issue_rate_cap_counts_voided_tickets_and_starves_honest_sells_until_they_expire() {
    let (mut env, c) = curve_coin();
    let cap = meteora::TOTAL_SUPPLY / 5;
    let whale = Pubkey::new_unique();
    let honest = Pubkey::new_unique();
    warp_to_bucket_offset(&mut env, 1_800);
    let honest_sell = env.sell_record(&c, &honest, TOKENS, PRICE);
    // Each hour (mid-bucket) the whale sells exactly what still fits the cap and buys it back; keepers attest both,
    // correctly.
    let mut hour = 0;
    loop {
        let mut coin = env.coin(&c);
        let now = env.now();
        coin.roll_attest_buckets(now);
        let into = (now - coin.attest_bucket_start).clamp(0, 3_600) as u128;
        let used = coin.attest_prev_bucket_tokens as u128 * (3_600 - into) / 3_600 + coin.attest_bucket_tokens as u128;
        let chunk = (cap as u128 - used) as u64;
        assert!(chunk > 0);
        let r = env.sell_record(&c, &whale, chunk, PRICE);
        ok(env.attest_sell(&r, &[0, 1]));
        let seq = env.fetch::<Position>(&position_pda(&c.mint, &whale)).next_ticket_seq - 1;
        let tk = ticket_pda(&c.mint, &whale, seq);
        let t: Ticket = env.fetch(&tk);
        let rb = rebuy_record(&t, tk, chunk, env.now() - 5);
        ok(env.attest_rebuy(&rb, &[0, 1], false));
        assert_eq!(env.fetch::<Ticket>(&tk).status, TicketStatus::Voided, "the whale holds no ticket");
        // The honest seller's attestation can't get in.
        let res = env.attest_sell(&honest_sell, &[0, 1]);
        if env.now() - honest_sell.block_time > fumpad::DEFAULT_MAX_ATTEST_AGE_SECS {
            assert_fumpad_err(res, FumpadError::AttestationExpired);
            break;
        }
        assert_fumpad_err(res, FumpadError::AttestRateLimited);
        hour += 1;
        env.warp(3_600);
    }
    assert!(hour >= 24, "honest ticket starved for {hour} h, then lost");
}

// ── L-1 ──────────────────────────────────────────────────────────────────────
/// L-1 (regression vs v0.6): v0.6 let only the wallet close its Position, and only the owner close Claimed/Voided
/// tickets. v0.7 makes `close_ticket` permissionless for every terminal state and lets the attesting keeper
/// (`rent_payer`) close the Position, which deletes the wallet's D17 auto-claim opt-out: the next attestation
/// re-creates the Position with auto-claim ENABLED, without the wallet's consent.
#[test]
fn issue_keeper_can_reset_a_wallets_auto_claim_opt_out() {
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
    assert_eq!(env.fetch::<Position>(&pos_key).auto_claim_opt_out, 1);

    // The ticket ends (here: a rebuy voids it); a third party closes it; the keeper closes the position.
    let tk = ticket_pda(&c.mint, &a, 0);
    let t: Ticket = env.fetch(&tk);
    ok(env.attest_rebuy(&rebuy_record(&t, tk, TOKENS, env.now() - 5), &[0, 1], false));
    let close_t = ix(
        fumpad::accounts::CloseTicket {
            caller: kp_pk(&env.payer),
            global: env.global(),
            ticket: tk,
            rent_payer: t.rent_payer,
            position: pos_key,
            claim_queue: None,
            coin: c.coin_pda(),
            event_authority: ev_auth(),
            program: fumpad::ID,
        },
        fumpad::instruction::CloseTicket {},
    );
    ok(env.send(&[close_t], &[]));
    let keeper = env.keepers[0].insecure_clone();
    assert_eq!(t.rent_payer, kp_pk(&keeper));
    let close_p = ix_rem(
        fumpad::accounts::ClosePosition { signer: kp_pk(&keeper), position: pos_key, rent_payer: kp_pk(&keeper), event_authority: ev_auth(), program: fumpad::ID },
        fumpad::instruction::ClosePosition {},
        &[ro(tk)],
    );
    ok(env.send_as(&keeper, &[close_p], &[&keeper]));

    // Next qualifying sell: the position is back with auto-claim on.
    let r2 = env.sell_record(&c, &a, TOKENS, PRICE);
    ok(env.attest_sell(&r2, &[0, 1]));
    assert_eq!(env.fetch::<Position>(&pos_key).auto_claim_opt_out, 0, "opt-out silently reset");
}

// ── L-2 ──────────────────────────────────────────────────────────────────────
/// L-2: `void_ticket` is final for the TRADE, not just the ticket: the sell's consumed marker stays, so when the
/// guardian voids an attestation because the keepers got a field wrong (amount, price, venue bit…), the corrected
/// attestation of the same sell is refused (`AlreadyConsumed`) and the honest seller loses the ticket.
#[test]
fn issue_voided_attestation_cannot_be_corrected() {
    let (mut env, c) = curve_coin();
    let alice = Pubkey::new_unique();
    let wrong = env.sell_record(&c, &alice, TOKENS / 10, PRICE); // engine bug: 10× too few tokens
    ok(env.attest_sell(&wrong, &[0, 1]));
    let tk = ticket_pda(&c.mint, &alice, 0);
    let admin = env.admin.insecure_clone();
    let void = ix(
        fumpad::accounts::VoidTicket { authority: kp_pk(&admin), global: env.global(), ticket: tk, position: position_pda(&c.mint, &alice), event_authority: ev_auth(), program: fumpad::ID },
        fumpad::instruction::VoidTicket { reason: 1 },
    );
    ok(env.send(&[void], &[&admin]));
    let fixed = SellRecord { ticket_tokens: TOKENS, base_amount: TOKENS, ..wrong };
    assert_fumpad_err(env.attest_sell(&fixed, &[0, 1]), FumpadError::AlreadyConsumed);
}

// ── I-1 ──────────────────────────────────────────────────────────────────────
/// I-1: DBC `withdraw_leftover` is permissionless. When anyone calls it before `graduate`, the 8% still lands in the
/// reward vault, but `Coin.leftover_tokens` and `Graduated.leftover_tokens` report 0 (event-sourced consumers show
/// an empty reward pool).
#[test]
fn issue_leftover_withdrawn_by_third_party_is_recorded_as_zero() {
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
    let meta = ok(env.graduate(&c, &k, &nft));
    let ev: fumpad::events::Graduated = event(&meta);
    let vault = env.token_balance(&env.reward_vault(&c.mint));
    crate::lifecycle_tests::assert_reward_pool_8pct(vault);
    assert_eq!(ev.leftover_tokens, 0);
    assert_eq!(env.coin(&c).leftover_tokens, 0);
}
