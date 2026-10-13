//! End to end on one coin (SPEC v0.7 §9): launch (real init + top-level creator swap + register_coin in one tx) →
//! curve (router + third-party swaps) → launch-window fees → pre-grad samples + buyback → attested tickets
//! (outside + routed) + rebuy debit → completion (PartialFill) → migration → graduation (8%) → LP fees →
//! post-grad samples + buyback → claims / queue / escrow / auto-claim → expiry → withdrawals → closes.

use crate::flow::*;
use crate::meteora;
use crate::*;
use fumpad::attestation::VENUE_ROUTED_BIT;
use fumpad::events::{ClaimPaid, ClaimQueued, FeesClaimed, Graduated};
use fumpad::external::meteora as m;
use fumpad::state::{CoinStatus, Ticket, TicketSource, TicketStatus};

const M: u64 = 1_000_000;

#[test]
fn full_lifecycle_one_coin() {
    let mut env = Env::new();
    let c = env.launch(SOL / 2);
    let creator = kp_pk(&c.creator);
    let (alice, bob, carol) = (env.new_user(500), env.new_user(500), env.new_user(500));
    // A sniper in the launch window pays 99%.
    let sniper = env.new_user(100);
    ok(env.direct_buy(&c, &sniper, SOL));
    env.skip_launch_window();
    env.warp(30);

    // Curve trading: router and third-party.
    ok(env.router_buy(&c, &alice, 10 * SOL));
    ok(env.direct_buy(&c, &bob, 8 * SOL));
    ok(env.router_buy(&c, &carol, 4 * SOL));
    let a_tokens = env.base_balance(&kp_pk(&alice), &c.mint);
    let b_tokens = env.base_balance(&kp_pk(&bob), &c.mint);

    // Launch-window fees → 100% buyback, then normal split.
    let meta = ok(env.claim_fees(&c));
    let ev: FeesClaimed = event(&meta);
    assert!(ev.launch_window && ev.to_buyback == ev.claimed);
    // Pre-graduation sample + keeper buyback into the reward vault.
    env.pregrad_warmup(&c);
    let k0 = env.keepers[0].insecure_clone();
    ok(env.buyback(&c, &k0, u64::MAX));
    let pre_grad_bought = env.token_balance(&env.reward_vault(&c.mint));
    assert!(pre_grad_bought > 0);

    // Alice sells via the router; Bob sells on DBC directly (outside FUMPAD). Keepers attest both.
    env.warp(600);
    ok(env.router_sell(&c, &alice, a_tokens / 10));
    ok(env.direct_sell(&c, &bob, b_tokens / 10));
    let spot_q64 = sqrt_to_q64(meteora::rd_u128(&env.dbc_pool_data(&c), m::DBC_POOL_SQRT_PRICE));
    let mut ra = env.sell_record(&c, &kp_pk(&alice), a_tokens / 10, spot_q64);
    ra.venue |= VENUE_ROUTED_BIT;
    ok(env.attest_sell(&ra, &[0, 1]));
    let mut rb = env.sell_record(&c, &kp_pk(&bob), b_tokens / 10, spot_q64);
    rb.ix_key = 2;
    ok(env.attest_sell(&rb, &[1, 2]));
    // The creator's own sell never makes a ticket.
    let mut rc = env.sell_record(&c, &creator, 1_000 * M, spot_q64);
    rc.ix_key = 3;
    assert!(env.attest_sell(&rc, &[0, 2]).is_err());
    let ta = ticket_pda(&c.mint, &kp_pk(&alice), 0);
    let tb = ticket_pda(&c.mint, &kp_pk(&bob), 0);
    assert_eq!(env.fetch::<Ticket>(&ta).source, TicketSource::Router);
    assert_eq!(env.fetch::<Ticket>(&tb).source, TicketSource::Outside);
    // Bob rebuys a quarter of what he sold within 7 days → debit.
    let tk = env.fetch::<Ticket>(&tb);
    let reb = rebuy_record(&tk, tb, tk.tokens / 4, env.now() - 5);
    ok(env.attest_rebuy(&reb, &[0, 1], false));
    assert_eq!(env.fetch::<Ticket>(&tb).tokens, tk.tokens - tk.tokens / 4);

    // Completion (PartialFill) → migration (wrapper) → graduation.
    let whale = env.complete_curve(&c);
    assert_eq!(env.coin(&c).status, CoinStatus::Complete);
    let k1 = env.keepers[1].insecure_clone();
    let (r, nft) = env.migrate(&c, &k1);
    ok(r);
    let meta = ok(env.graduate(&c, &k1, &nft));
    let g: Graduated = event(&meta);
    crate::lifecycle_tests::assert_reward_pool_8pct(g.leftover_tokens);
    assert_eq!(env.token_balance(&env.reward_vault(&c.mint)), pre_grad_bought + g.leftover_tokens);
    env.post_grad_setup(&c, &k0);

    // Post-graduation volume (router + third party) → LP fees → split.
    ok(env.router_buy(&c, &carol, 5 * SOL));
    ok(env.direct_sell(&c, &whale, env.base_balance(&kp_pk(&whale), &c.mint) / 10));
    ok(env.claim_fees(&c)); // residual DBC partner fees
    let meta = ok(env.claim_lp_fees(&c, &nft));
    assert!(event::<FeesClaimed>(&meta).claimed > 0);
    env.assert_coin_invariant(&c);

    // The coin keeps running after graduation (a large DAMM v2 buy): it now trades ≥ 10x the curve sells.
    let fomo = env.new_user(1_000);
    ok(env.direct_buy(&c, &fomo, 300 * SOL));
    env.warp(fumpad::DEFAULT_TICKET_CHALLENGE_SECS);
    env.sample_for(&c, 1_800);
    let damm_spot = sqrt_to_q64(meteora::rd_u128(&env.data(&env.coin(&c).damm_pool), m::DAMM_POOL_SQRT_PRICE));
    assert!(damm_spot >= spot_q64 * 10, "pool trades ≥ 10x the curve sell price");
    // Post-grad buyback against the median.
    ok(env.buyback(&c, &k0, u64::MAX));

    // Alice claims herself; Bob's ticket is auto-claimed by a keeper.
    let w_a = env.base_balance(&kp_pk(&alice), &c.mint);
    let claim = |env: &Env, owner: &Pubkey, t: &Pubkey| {
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
    };
    let i = claim(&env, &kp_pk(&alice), &ta);
    let meta = ok(env.send_as(&alice, &[i], &[&alice]));
    let paid: ClaimPaid = event(&meta);
    assert_eq!(paid.amount, env.fetch::<Ticket>(&ta).original_tokens / 10);
    assert_eq!(env.base_balance(&kp_pk(&alice), &c.mint), w_a + paid.amount);
    let ck = ix(
        fumpad::accounts::ClaimFor {
            keeper: kp_pk(&k1),
            global: env.global(),
            coin: c.coin_pda(),
            mint: c.mint,
            ticket: tb,
            position: position_pda(&c.mint, &kp_pk(&bob)),
            claim_queue: c.claim_queue(),
            observations: c.observations(),
            reward_pool: env.reward_pool(),
            reward_vault: env.reward_vault(&c.mint),
            owner_ata: base_ata(&kp_pk(&bob), &c.mint),
            escrow: escrow_pda(&tb),
            token_program: TOKEN_2022,
            system_program: SYSTEM,
            event_authority: ev_auth(),
            program: fumpad::ID,
        },
        fumpad::instruction::ClaimFor {},
    );
    let meta = ok(env.send_as(&k1, &[ck], &[&k1]));
    let ev = events::<ClaimPaid>(&meta);
    let evq = events::<ClaimQueued>(&meta);
    assert!(ev.len() + evq.len() == 1);
    assert!(matches!(env.fetch::<Ticket>(&tb).status, TicketStatus::Claimed | TicketStatus::Queued));

    // Creator + platform withdraw; invariant.
    let w = ix(
        fumpad::accounts::WithdrawCreatorFees { creator, coin: c.coin_pda(), event_authority: ev_auth(), program: fumpad::ID },
        fumpad::instruction::WithdrawCreatorFees {},
    );
    let cr = c.creator.insecure_clone();
    ok(env.send_as(&cr, &[w], &[&cr]));
    env.assert_coin_invariant(&c);
    assert_eq!(env.coin(&c).creator_fees_unclaimed, 0);
    println!(
        "e2e: reward pool {} tokens, tickets {}, paid {}",
        env.token_balance(&env.reward_vault(&c.mint)) / M,
        env.coin(&c).tickets_created,
        env.coin(&c).tokens_paid_out / M
    );
}
