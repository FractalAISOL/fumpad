//! Invariant I2 (no cross-coin fund movement) with two live coins interleaved through every step that touches a
//! shared PDA — `fee_claimer` (+ transient `fee_wsol`), `buyback` (+ `ATA(buyback, WSOL)`), `reward_pool` — in the
//! SAME transaction wherever a legacy transaction fits both coins' instructions, otherwise in the same slot:
//! launch → trades → fee claims (launch window, then 50/30/20) → pre-graduation buybacks → attestations →
//! graduation → LP-fee claims → post-graduation buybacks → claims. After each step every value delta of coin A is
//! fully explained by coin A's own events, and the same for B; the shared PDAs end every transaction empty.

use fumpad::error::FumpadError;
use fumpad::events::{BuybackExecuted, ClaimPaid, FeesClaimed, Graduated};
use fumpad::state::Coin;
use solana_instruction::Instruction;

use crate::flow::*;
use crate::meteora;
use crate::rewards_tests::M;
use crate::*;

const DBC_PARTNER_QUOTE_FEE: usize = 272;

fn partner_fee(env: &Env, c: &TCoin) -> u64 {
    meteora::rd_u64(&env.dbc_pool_data(c), DBC_PARTNER_QUOTE_FEE)
}

/// The shared PDAs hold nothing between instructions (the buyback WSOL ATA may keep rounding dust, checked apart).
#[track_caller]
fn shared_pdas_empty(env: &Env) {
    assert_eq!(env.lamports(&env.fee_claimer()), 0, "fee_claimer");
    assert!(!env.exists(&env.fee_wsol()), "fee_wsol exists only inside an instruction");
    assert_eq!(env.lamports(&env.buyback_pda()), 0, "buyback PDA");
    assert_eq!(env.lamports(&env.reward_pool()), 0, "reward_pool PDA");
}

#[track_caller]
fn invariants(env: &Env, a: &TCoin, b: &TCoin) {
    env.assert_coin_invariant(a);
    env.assert_coin_invariant(b);
    shared_pdas_empty(env);
}

/// Each coin's ledger moved by exactly its own `FeesClaimed`.
#[track_caller]
fn assert_split_applied(before: &Coin, after: &Coin, ev: &FeesClaimed) {
    assert_eq!(ev.mint, after.mint);
    assert_eq!(ev.to_buyback + ev.to_platform + ev.to_creator, ev.claimed);
    assert_eq!(after.buyback_lamports - before.buyback_lamports, ev.to_buyback);
    assert_eq!(after.platform_fees_unclaimed - before.platform_fees_unclaimed, ev.to_platform);
    assert_eq!(after.creator_fees_unclaimed - before.creator_fees_unclaimed, ev.to_creator);
    assert_eq!(after.fees_claimed_lamports - before.fees_claimed_lamports, ev.claimed);
}

fn claim_ix(env: &Env, c: &TCoin, owner: &Pubkey, t: &Pubkey) -> Instruction {
    ix(
        fumpad::accounts::Claim {
            owner: *owner,
            global: env.global(),
            coin: c.coin_pda(),
            mint: c.mint,
            ticket: *t,
            position: position_pda(&c.mint, owner),
            claim_queue: c.claim_queue(),
            observations: c.observations(),
            reward_pool: env.reward_pool(),
            reward_vault: env.reward_vault(&c.mint),
            owner_token_account: base_ata(owner, &c.mint),
            token_program: TOKEN_2022,
            event_authority: ev_auth(),
            program: fumpad::ID,
        },
        fumpad::instruction::Claim {},
    )
}

#[test]
fn two_coins_share_pdas_without_moving_each_others_funds() {
    let mut env = Env::new();
    let a = env.launch(SOL / 10);
    let b = env.launch(SOL / 5);
    let op = env.op();
    let opk = kp_pk(&op);
    let (va, vb) = (env.reward_vault(&a.mint), env.reward_vault(&b.mint));

    // ── launch window: snipers of different sizes on both coins, then normal trading ──
    let sniper = env.new_user(1_000);
    ok(env.direct_buy(&a, &sniper, 2 * SOL));
    ok(env.direct_buy(&b, &sniper, 3 * SOL));
    env.skip_launch_window();
    let alice = env.new_user(1_000);
    let bob = env.new_user(1_000);
    ok(env.router_buy(&a, &alice, 20 * SOL));
    ok(env.direct_buy(&b, &bob, 30 * SOL));

    // ── 1. launch-window fee claims of both coins in ONE transaction (100% → each coin's own buyback) ──
    let (fa, fb) = (partner_fee(&env, &a), partner_fee(&env, &b));
    assert!(fa > 0 && fb > 0 && fa != fb);
    let ixs = [env.claim_fees_ix(&a, &opk), env.claim_fees_ix(&b, &opk)];
    let meta = ok(env.send_as(&op, &ixs, &[&op]));
    let ev = events::<FeesClaimed>(&meta);
    assert_eq!((ev[0].mint, ev[0].claimed, ev[0].to_buyback, ev[0].launch_window), (a.mint, fa, fa, true));
    assert_eq!((ev[1].mint, ev[1].claimed, ev[1].to_buyback, ev[1].launch_window), (b.mint, fb, fb, true));
    assert_eq!((env.coin(&a).buyback_lamports, env.coin(&b).buyback_lamports), (fa, fb));
    assert_eq!((partner_fee(&env, &a), partner_fee(&env, &b)), (0, 0));
    invariants(&env, &a, &b);

    // ── 1b. 50/30/20 claims of both in one transaction, B listed first ──
    ok(env.router_buy(&a, &alice, 5 * SOL));
    let bob_tokens = env.base_balance(&kp_pk(&bob), &b.mint);
    ok(env.direct_sell(&b, &bob, bob_tokens / 3));
    let (fa, fb) = (partner_fee(&env, &a), partner_fee(&env, &b));
    let (ca, cb) = (env.coin(&a), env.coin(&b));
    let ixs = [env.claim_fees_ix(&b, &opk), env.claim_fees_ix(&a, &opk)];
    let meta = ok(env.send_as(&op, &ixs, &[&op]));
    let ev = events::<FeesClaimed>(&meta);
    assert_eq!((ev[0].mint, ev[0].claimed, ev[1].mint, ev[1].claimed), (b.mint, fb, a.mint, fa));
    assert_split_applied(&cb, &env.coin(&b), &ev[0]);
    assert_split_applied(&ca, &env.coin(&a), &ev[1]);
    invariants(&env, &a, &b);

    // ── 2. operator samples both coins in one batch; pre-graduation buybacks of both in ONE transaction ──
    for i in 0..fumpad::PREGRAD_MIN_SAMPLES {
        if i > 0 {
            env.warp(20);
        }
        ok(env.sample(0, &[&a, &b]));
    }
    let bb_wsol = wsol_ata(&env.buyback_pda());
    let (ca, cb) = (env.coin(&a), env.coin(&b));
    let (va0, vb0) = (env.token_balance(&va), env.token_balance(&vb));
    let w0 = env.token_balance(&bb_wsol);
    let ixs = [compute_budget_ix(1_400_000), env.buyback_ix(&a, &opk, u64::MAX), env.buyback_ix(&b, &opk, u64::MAX)];
    let meta = ok(env.send_as(&op, &ixs, &[&op]));
    let ev = events::<BuybackExecuted>(&meta);
    assert_eq!((ev[0].mint, ev[1].mint), (a.mint, b.mint));
    for (e, before, after, v0, v) in [(&ev[0], &ca, env.coin(&a), va0, va), (&ev[1], &cb, env.coin(&b), vb0, vb)] {
        assert!(e.tokens_out > 0);
        assert_eq!(env.token_balance(&v) - v0, e.tokens_out, "tokens land only in the coin's own vault");
        assert_eq!(before.buyback_lamports - after.buyback_lamports, e.lamports_in, "spent from its own balance");
        assert_eq!(after.buyback_tokens - before.buyback_tokens, e.tokens_out);
    }
    // Rounding dust stays in ATA(buyback, WSOL); it never exceeds what the two coins themselves sent in.
    let dust = env.token_balance(&bb_wsol) - w0;
    assert!(dust <= 2, "buyback WSOL dust {dust}");
    invariants(&env, &a, &b);

    // ── 3. one wallet sells both coins; attested tickets on both ──
    env.warp(600);
    let carol = env.new_user(10);
    let ck = kp_pk(&carol);
    let pa = env.dbc_spot_q64(&a) / 20;
    let pb = env.dbc_spot_q64(&b) / 20;
    let ra = env.sell_record(&a, &ck, 1_000 * M, pa);
    let mut rb = env.sell_record(&b, &ck, 2_000 * M, pb);
    rb.ix_key = 7;
    ok(env.attest_sell(&ra, &[0, 1]));
    ok(env.attest_sell(&rb, &[1, 2]));
    let (ta, tb) = (ticket_pda(&a.mint, &ck, 0), ticket_pda(&b.mint, &ck, 0));

    // ── 4. graduation of both (same slot): each 8% leftover lands only in its own vault ──
    let (va0, vb0) = (env.token_balance(&va), env.token_balance(&vb));
    env.complete_curve(&a);
    env.complete_curve(&b);
    let (r, nft_a) = env.migrate(&a, &op);
    ok(r);
    let (r, nft_b) = env.migrate(&b, &op);
    ok(r);
    let ga: Graduated = event(&ok(env.graduate(&a, &op, &nft_a)));
    let gb: Graduated = event(&ok(env.graduate(&b, &op, &nft_b)));
    assert_eq!((ga.mint, gb.mint), (a.mint, b.mint));
    crate::lifecycle_tests::assert_reward_pool_8pct(ga.leftover_tokens);
    crate::lifecycle_tests::assert_reward_pool_8pct(gb.leftover_tokens);
    assert_eq!(env.token_balance(&va), va0 + ga.leftover_tokens);
    assert_eq!(env.token_balance(&vb), vb0 + gb.leftover_tokens);
    env.post_grad_setup(&a, &op);
    env.post_grad_setup(&b, &op);
    invariants(&env, &a, &b);

    // ── 5. LP fees of both coins' locked positions in ONE transaction ──
    ok(env.router_buy(&a, &alice, 10 * SOL));
    ok(env.router_buy(&b, &alice, 3 * SOL));
    let (ca, cb) = (env.coin(&a), env.coin(&b));
    let ixs = [env.claim_lp_fees_ix(&a, &opk, &nft_a), env.claim_lp_fees_ix(&b, &opk, &nft_b)];
    let meta = ok(env.send_as(&op, &ixs, &[&op]));
    let ev = events::<FeesClaimed>(&meta);
    assert!(ev[0].claimed > ev[1].claimed && ev[1].claimed > 0, "A traded more than B");
    assert_split_applied(&ca, &env.coin(&a), &ev[0]);
    assert_split_applied(&cb, &env.coin(&b), &ev[1]);
    // Swapping the positions (A's coin with B's position) is refused: a position must belong to the coin's pool.
    let swapped = env.claim_lp_fees_ix(&a, &opk, &nft_b);
    assert_fumpad_err(env.send_as(&op, &[swapped], &[&op]), FumpadError::WrongVenue);
    invariants(&env, &a, &b);

    // ── 6. challenge window, then 30 min of operator samples of both; post-grad buybacks of both in one tx ──
    env.warp(fumpad::DEFAULT_TICKET_CHALLENGE_SECS);
    let mut t = 0;
    while t <= 1_800 {
        ok(env.sample(0, &[&a, &b]));
        env.warp(15);
        t += 15;
    }
    ok(env.sample(0, &[&a, &b]));
    let stranger = env.new_user(10);
    let sk = kp_pk(&stranger);
    let (ca, cb) = (env.coin(&a), env.coin(&b));
    let (va0, vb0) = (env.token_balance(&va), env.token_balance(&vb));
    let ixs = [compute_budget_ix(1_400_000), env.buyback_ix(&a, &sk, u64::MAX), env.buyback_ix(&b, &sk, u64::MAX)];
    let meta = ok(env.send_as(&stranger, &ixs, &[&stranger]));
    let ev = events::<BuybackExecuted>(&meta);
    for (e, before, after, v0, v) in [(&ev[0], &ca, env.coin(&a), va0, va), (&ev[1], &cb, env.coin(&b), vb0, vb)] {
        assert_eq!(e.mint, after.mint);
        assert_eq!(env.token_balance(&v) - v0, e.tokens_out);
        assert_eq!(before.buyback_lamports - after.buyback_lamports, e.lamports_in);
    }
    invariants(&env, &a, &b);

    // ── 7. the same wallet claims on both coins in ONE transaction: each pays only from its own vault ──
    let create = [
        meteora::create_ata_idempotent_ix(&ck, &ck, &a.mint, &TOKEN_2022),
        meteora::create_ata_idempotent_ix(&ck, &ck, &b.mint, &TOKEN_2022),
    ];
    ok(env.send_as(&carol, &create, &[&carol]));
    let (va0, vb0) = (env.token_balance(&va), env.token_balance(&vb));
    let ixs = [claim_ix(&env, &a, &ck, &ta), claim_ix(&env, &b, &ck, &tb)];
    let meta = ok(env.send_as(&carol, &ixs, &[&carol]));
    let ev = events::<ClaimPaid>(&meta);
    assert_eq!((ev[0].mint, ev[0].amount), (a.mint, 100 * M));
    assert_eq!((ev[1].mint, ev[1].amount), (b.mint, 200 * M));
    assert_eq!(va0 - env.token_balance(&va), 100 * M);
    assert_eq!(vb0 - env.token_balance(&vb), 200 * M);
    assert_eq!(env.base_balance(&ck, &a.mint), 100 * M);
    assert_eq!(env.base_balance(&ck, &b.mint), 200 * M);
    // A's ticket against B's vault (or B's coin) is refused.
    let mut cross = claim_ix(&env, &a, &ck, &ta);
    cross.accounts[9].pubkey = addr(&vb);
    assert!(env.send_as(&carol, &[cross], &[&carol]).is_err());
    invariants(&env, &a, &b);
}
