//! Final internal pre-mainnet review (2026-10-12, v0.5). Each `issue_*` test demonstrates a
//! finding and PASSES WHILE THE ISSUE EXISTS — when a fix lands, flip the assertions into a
//! `regression_*` test (as `review_*.rs` / `redteam_custody.rs` do). No program code was
//! changed for this review.
//!
//! The PumpSwap-dependent tests also pass against the MAINNET PumpSwap + pump-fees binaries
//! and mainnet GlobalConfig / FeeConfig (dumped 2026-10-12; swap them into `fixtures/`).

use anchor_lang::prelude::{AccountMeta as Meta, Pubkey};
use fumpad::{
    error::FumpadError,
    external::pumpswap::{event_authority_pda, WSOL_MINT},
    math::price::price_q64,
    state::{CoinStatus, Global, Params, TicketStatus, PAUSE_TRADE},
    PUMPSWAP_PROGRAM_ID,
};
use solana_keypair::Keypair;

use crate::flow::*;
use crate::rewards_tests::World;
use crate::*;

const M: u64 = 1_000_000; // 1 token (6 decimals)
const DAY: i64 = 86_400;

fn completed() -> (Flow, Keypair) {
    let mut f = Flow::new();
    let whale = f.env.new_user(10_000);
    ok(f.buy(&whale, 200 * SOL));
    assert_eq!(f.coin_state().status, CoinStatus::Complete);
    (f, whale)
}

fn graduated() -> (Flow, Keypair) {
    let (mut f, whale) = completed();
    ok(f.graduate());
    f.post_graduation_setup();
    (f, whale)
}

/// Round trips straight on PumpSwap (outside FUMPAD): LP-fee growth for the locker.
fn outside_round_trips(f: &mut Flow, trader: &Keypair, n: usize, sol: u64) {
    let tk = kp_pk(trader);
    let payer = kp_pk(&f.env.payer);
    ok(f.env.send(&[create_ata_ix(&payer, &tk, &f.mint, &T22)], &[]));
    for _ in 0..n {
        let before = f.tokens(&tk);
        let i = f.direct_buy_ix(&tk, sol, true);
        ok(f.env.send_as(trader, &[cu_limit(400_000), i], &[trader]));
        let got = f.tokens(&tk) - before;
        let i = f.direct_sell_ix(&tk, got);
        ok(f.env.send_as(trader, &[cu_limit(400_000), i], &[trader]));
    }
}

/// PumpSwap `extend_account(account, user)`: permissionless (PUMP_SWAP_README: "allows any
/// user to extend the data array of a program-owned account (GlobalConfig or Pool)").
fn extend_account_ix(account: &Pubkey, user: &Pubkey) -> solana_instruction::Instruction {
    raw_ix(
        PUMPSWAP_PROGRAM_ID,
        vec![w(*account), Meta::new(*user, true), r(SYSTEM), r(event_authority_pda()), r(PUMPSWAP_PROGRAM_ID)],
        vec![234, 102, 194, 203, 150, 72, 62, 229],
    )
}

fn admin_only_ix(admin: &Pubkey, global: Pubkey, data: impl anchor_lang::InstructionData) -> solana_instruction::Instruction {
    ix(fumpad::accounts::AdminOnly { admin: *admin, global }, data)
}

// ═════════════════════════════════════════════════════════════════════════════
// HIGH
// ═════════════════════════════════════════════════════════════════════════════

/// [H-1] Anyone can permanently disable LP-fee skimming for any FUMPAD pool (D11).
///
/// `fumpad_lp_locker::parse_pool` requires the Pool account to be EXACTLY `POOL_LEN` = 287
/// bytes (fail-closed). PumpSwap ships a permissionless `extend_account` that grows any Pool
/// to the program's current size (301 bytes on both the devnet and the mainnet binary; every
/// mainnet pool sampled on 2026-10-12 is already 301 bytes). One ~0.0001 SOL call by anyone
/// makes `skim` fail with `UnknownPoolLayout` forever: accounts can't shrink, and the locker is
/// immutable (`--final`), so the LP fee (0.20% of all post-graduation volume → reward pool +
/// platform/creator SOL) is lost for that pool for good. Principal stays locked (no theft).
/// The FUMPAD router/oracle are unaffected (`fumpad::external::pumpswap::parse_pool` accepts
/// longer pools).
///
/// FIXED (v0.6): the locker accepts `len >= POOL_LEN` (PumpSwap only appends fields; the
/// offsets used — creator, mints, lp_mint, vaults, lp_supply, virtual_quote, protocol/creator
/// fees — are in the stable prefix) and cross-checks identity instead of the size: pool key ==
/// PDA(["pool", index, creator, base, quote]), lp_mint == PDA(["pool_lp_mint", pool]), vaults ==
/// ATAs of the pool. `UnknownPoolLayout` stays for len < 287 / shifted fields; wrong
/// discriminator → `WrongAccount`. More cases: `locker_tests::regression_skim_*`.
#[test]
fn regression_extend_account_no_longer_bricks_lp_skim() {
    let (mut f, whale) = graduated();
    assert_eq!(f.env.account(&f.pool).unwrap().data.len(), fumpad_lp_locker::POOL_LEN);
    outside_round_trips(&mut f, &whale, 5, 20 * SOL);
    assert!(f.locked_value() > f.lp_principal() * 1.001, "fee growth waiting to be skimmed");

    // A griefer (any wallet) extends the pool.
    let g = f.env.new_user(1);
    let gk = kp_pk(&g);
    ok(f.env.send_as(&g, &[extend_account_ix(&f.pool, &gk)], &[&g]));
    assert_eq!(f.env.account(&f.pool).unwrap().data.len(), 301);

    // Skims keep working on the extended pool, and keep working as fees accrue.
    ok(f.skim());
    let skimmed1 = f.lock_state().lp_skimmed;
    assert!(skimmed1 > 0);
    outside_round_trips(&mut f, &whale, 5, 20 * SOL);
    ok(f.skim());
    assert!(f.lock_state().lp_skimmed > skimmed1);
    assert!(f.locked_value() >= f.lp_principal() * (1.0 - 1e-12), "principal intact");

    // FUMPAD itself keeps working on the extended pool.
    let t = f.env.new_user(10);
    ok(f.swap_buy(&t, SOL));
    ok(f.keeper_sample());
}

// ═════════════════════════════════════════════════════════════════════════════
// MEDIUM
// ═════════════════════════════════════════════════════════════════════════════

/// [M-1] Reward/oracle params are NOT snapshotted per coin and `Params::is_valid` barely
/// bounds them, so one timelocked params change re-prices every live ticket of every coin.
///
/// Only fees (D14) and the snipe schedule (D19) are snapshotted. `trigger_multiple_bps` only
/// needs to be > 10_000, `claim_bps` / `max_claim_pool_bps` may be 10_000. A compromised (or
/// mistaken) admin queues {trigger 1.0001x, claim 100%, cap 100%}; 48h later every Open ticket
/// at ≥ 1.0001x is claimable for 100% of its tokens, each claim may take the whole pool:
/// reward pools are drained by whoever holds tickets (e.g. the attacker's own wallets). The
/// timelock only gives 48h notice, and there is nothing a holder can do with it.
///
/// FIXED (v0.6): (1) `is_valid` bounds every reward term (trigger 5x–50x, claim 1–25%, cap
/// 1–25%, …, constants.rs) — the draining change can't even be queued; (2) the reward terms
/// are snapshotted per coin at `create_coin` (`Coin.rewards`), so even the most generous VALID
/// change (5x trigger, 25% claims, 25% cap) leaves live tickets on their coin's terms and only
/// applies to coins created afterwards.
#[test]
fn regression_params_changes_cannot_reprice_live_tickets() {
    let mut w = World::new(); // graduated, 50M pool, coin snapshotted the default terms
    let now = w.now();
    let u = w.user(0);
    assert_eq!(w.coin_state().rewards, Params::default().reward_terms());
    let price_now = price_q64(10_000, M).unwrap(); // World's samples sit here
    // A ticket at 6x of today's median: under the coin's 10x trigger it is not claimable.
    let t = w.add_ticket(&u.key, 40_000_000 * M, price_q64(1_666, M).unwrap(), now - DAY);
    expect_err(w.claim(&u, t), FumpadError::TriggerNotMet);

    // (1) The draining change is refused at queue time.
    let mut evil = Params::default();
    evil.trigger_multiple_bps = 10_001;
    evil.claim_bps = 10_000;
    evil.max_claim_pool_bps = 10_000;
    assert!(!evil.is_valid());
    expect_err(w.env.queue_params(evil), FumpadError::InvalidParams);

    // (2) The loosest valid change executes, but this coin keeps its snapshot.
    let loose = Params { trigger_multiple_bps: 50_000, claim_bps: 2_500, max_claim_pool_bps: 2_500, ..Params::default() };
    assert!(loose.is_valid());
    w.env.set_params_timelocked(loose);
    w.set_samples(120, price_now);
    expect_err(w.claim(&u, t), FumpadError::TriggerNotMet);
    assert_eq!(w.ticket(&t).status, TicketStatus::Open);
    assert_eq!(w.coin_state().rewards, Params::default().reward_terms());

    // New coins snapshot the new terms.
    let f = crate::flow::Flow::with_params(loose);
    assert_eq!(f.coin_state().rewards, loose.reward_terms());
}

/// [M-2] The 48h timelock has no canceller once the admin key is compromised: `set_admin`
/// is immediate and single-step (no accept, no timelock), so an attacker holding the admin
/// key rotates admin to itself, queues params, and the team's old key can't `cancel_params`.
/// `set_pause` and `set_keepers` are immediate too.
///
/// Fix: separate roles — a guardian (multisig) that can `cancel_params` and pause but not
/// queue; timelock or two-step (`propose`/`accept`) `set_admin`; and put the program upgrade
/// authority behind a Squads time lock ≥ the params timelock (otherwise an upgrade bypasses
/// everything instantly).
#[test]
fn issue_admin_rotation_is_immediate_so_timelock_cannot_be_cancelled() {
    let mut env = Env::new();
    let global = env.global_pda();
    let stolen = env.admin.insecure_clone(); // attacker has a copy of the admin key
    let attacker = Keypair::new();
    let ak = kp_pk(&attacker);
    env.svm.airdrop(&solana_signer::Signer::pubkey(&attacker), SOL).unwrap();

    // 1. Rotate admin to the attacker, immediately (no timelock, no acceptance).
    let i = admin_only_ix(&kp_pk(&stolen), global, fumpad::instruction::SetAdmin { new_admin: ak, platform_treasury: ak });
    ok(env.send(&[i], &[&stolen]));
    // 2. Attacker queues a change (here: fee to the 2% cap, every coin launched later).
    let mut p = Params::default();
    p.fee_bps = 200;
    let q = ix(
        fumpad::accounts::QueueParams { admin: ak, global, event_authority: event_authority(), program: fumpad::ID },
        fumpad::instruction::QueueParams { params: p },
    );
    ok(env.send(&[q], &[&attacker]));
    // 3. The team (old admin key) can no longer cancel.
    let c = ix(
        fumpad::accounts::CancelParams { admin: kp_pk(&stolen), global, event_authority: event_authority(), program: fumpad::ID },
        fumpad::instruction::CancelParams {},
    );
    expect_err(env.send(&[c], &[&stolen]), FumpadError::Unauthorized);
    // 4. 48h later anyone executes it; treasury already redirected at step 1.
    env.warp(fumpad::PARAMS_TIMELOCK_SECS);
    ok(env.execute_params());
    let g: Global = env.fetch(&global);
    assert_eq!((g.admin, g.platform_treasury, g.params.fee_bps), (ak, ak, 200));
}

/// [M-3] `PAUSE_TRADE` freezes curve holders with no exit and no expiry — including the D13
/// escape hatch. Before graduation the curve is the ONLY venue for these tokens, so an
/// immediate, untimelocked, indefinite pause (compromised or coerced admin) locks every
/// pre-graduation coin's SOL (~85 SOL per complete coin). SPEC §6 only promises that graduated
/// coins stay sellable on PumpSwap.
///
/// Fix: never block curve `sell` (or at least the D13 path) with `PAUSE_TRADE`, or give pauses
/// an on-chain expiry (e.g. `paused_until ≤ now + 72h`, renewable only through the timelock).
#[test]
fn issue_pause_trade_freezes_curve_sells_and_escape_hatch_indefinitely() {
    let (mut f, whale) = completed();
    f.env.warp(fumpad::ESCAPE_HATCH_SECS + 1); // D13 hatch is open
    let global = f.env.global_pda();
    let admin = f.env.admin.insecure_clone();
    let i = admin_only_ix(&kp_pk(&admin), global, fumpad::instruction::SetPause { paused: PAUSE_TRADE });
    ok(f.env.send(&[i], &[&admin]));
    f.env.warp(365 * DAY);
    let tokens = f.tokens(&kp_pk(&whale));
    expect_err(f.sell(&whale, tokens / 10), FumpadError::Paused);
    assert_eq!(f.coin_state().status, CoinStatus::Complete, "still frozen a year later");
    assert!(f.coin_state().real_sol_reserves > 84 * SOL);
}

/// [M-4] Default `max_price_age_secs` = 60 s equals the heartbeat of the sponsored mainnet
/// SOL/USD account (7UVimf…, `PYTH_SOL_USD`): its age was measured cycling ~10 → ~55 s on
/// 2026-10-12. Any publish delay or validator-clock skew pushes the age past 60 s and the sell
/// silently gets NO ticket (by design Pyth problems never block a sell) — the seller cannot
/// retry the same sell, the eligibility is consumed. Not attacker-exploitable, but a regular,
/// invisible loss for honest users.
///
/// FIXED (v0.6): default 150 s (bounded 30–300 s by `is_valid`). A price one or two
/// heartbeats late still files the ticket; only a genuinely stale price (> 150 s) doesn't.
#[test]
fn regression_late_pyth_heartbeat_still_files_the_ticket() {
    assert_eq!(Params::default().max_price_age_secs, 150);
    assert!(!Params { max_price_age_secs: 29, ..Params::default() }.is_valid());
    assert!(!Params { max_price_age_secs: 301, ..Params::default() }.is_valid());
    assert!(Params { max_price_age_secs: 30, ..Params::default() }.is_valid());
    assert!(Params { max_price_age_secs: 300, ..Params::default() }.is_valid());
    let mut f = Flow::new();
    for (age, files) in [(61i64, true), (120, true), (150, true), (151, false)] {
        let u = f.env.new_user(100);
        let uk = kp_pk(&u);
        ok(f.buy(&u, 5 * SOL));
        f.env.warp(601);
        let i = f.sell_ix(&uk, f.tokens(&uk) / 2); // writes a fresh price (publish = now)…
        // …then the sponsored account is `age` seconds old.
        let mut acc = f.env.account(&PYTH_SOL_USD).unwrap();
        let published = f.now() - age;
        acc.data[41 + 52..41 + 60].copy_from_slice(&published.to_le_bytes());
        f.env.svm.set_account(addr(&PYTH_SOL_USD), acc).unwrap();
        let m = ok(f.env.send_as(&u, &[i], &[&u]));
        assert_eq!(events::<fumpad::events::TicketCreated>(&m).len(), files as usize, "age {age}s");
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// LOW
// ═════════════════════════════════════════════════════════════════════════════

/// [L-1] The `pool_authority` PDA — authority of EVERY coin's reward vault, curve vault and
/// D16 escrow — signs CPIs into PumpSwap (a third-party, upgradeable program) with
/// caller-chosen pass-through accounts: `execute_buyback` (permissionless) forwards any extra
/// accounts of the venue slice (≤ 40), `graduate` appends its `remaining_accounts` verbatim.
/// Today PumpSwap ignores them, so nothing is exploitable; but a malicious or buggy PumpSwap
/// upgrade gets a signature valid over other coins' vaults, i.e. it could move every reward
/// pool and every pre-graduation curve's tokens — far beyond the pools PumpSwap already
/// custodies.
///
/// Fix: sign PumpSwap CPIs with a role-specific PDA that owns nothing else (e.g. a buyback
/// PDA per coin that only owns its WSOL account; a pool-creator PDA that only holds the
/// in-flight graduation funds), cap the forwarded slice to PumpSwap's exact account count,
/// and never forward caller-supplied extras under a PDA signature.
#[test]
fn issue_pool_authority_signs_pumpswap_cpi_with_foreign_vaults_attached() {
    let (mut f, _) = graduated();
    // A second coin: its reward vault is owned by the same pool_authority PDA.
    let other_mint = Keypair::new();
    let om = kp_pk(&other_mint);
    let creator = f.env.new_user(10);
    let other_vault = fpda(&[fumpad::REWARD_VAULT_SEED, om.as_ref()]);
    let i = ix(
        fumpad::accounts::CreateCoin {
            creator: kp_pk(&creator),
            global: f.env.global_pda(),
            mint: om,
            mint_authority: fpda(&[fumpad::MINT_AUTHORITY_SEED]),
            coin: fpda(&[fumpad::COIN_SEED, om.as_ref()]),
            pool_authority: pool_authority(),
            reward_vault: other_vault,
            curve_vault: fpda(&[fumpad::CURVE_VAULT_SEED, om.as_ref()]),
            token_program: T22,
            system_program: SYSTEM,
            event_authority: event_authority(),
            program: fumpad::ID,
        },
        fumpad::instruction::CreateCoin { name: "Other".into(), symbol: "OTH".into(), uri: "".into() },
    );
    ok(f.env.send(&[i], &[&creator, &other_mint]));
    assert_eq!(token_balance(&f.env, &other_vault), Params::default().reward_pool_supply);

    // Build buyback fees, then the keeper median.
    let t = f.env.new_user(100);
    ok(f.swap_buy(&t, 30 * SOL));
    f.keeper_samples(124, 15);
    assert!(f.coin_state().buyback_lamports > 0);

    // Permissionless crank whose venue slice carries the OTHER coin's reward vault (writable)
    // and curve vault as extra accounts: they reach PumpSwap inside the pool_authority-signed CPI.
    let pa = pool_authority();
    let cranker = f.env.new_user(1);
    let mut venue = f.venue(pa, f.reward_vault, ata(&pa, &WSOL_MINT, &TOKEN));
    venue.push(w(other_vault));
    venue.push(w(fpda(&[fumpad::CURVE_VAULT_SEED, om.as_ref()])));
    let i = ix_with_remaining(
        fumpad::accounts::ExecuteBuyback {
            cranker: kp_pk(&cranker),
            global: f.env.global_pda(),
            coin: f.coin,
            mint: f.mint,
            observations: f.observations,
            reward_vault: f.reward_vault,
            pool_authority: pa,
            buyback_wsol: ata(&pa, &WSOL_MINT, &TOKEN),
            wsol_mint: WSOL_MINT,
            pumpswap_program: PUMPSWAP_PROGRAM_ID,
            token_program: TOKEN,
            token_2022_program: T22,
            associated_token_program: ATA_PROGRAM,
            system_program: SYSTEM,
            event_authority: event_authority(),
            program: fumpad::ID,
        },
        fumpad::instruction::ExecuteBuyback { max_lamports: u64::MAX },
        &venue,
    );
    // Accepted: the whole slice (incl. the foreign vaults, writable) is forwarded to PumpSwap
    // in the CPI that pool_authority signs (`invoke_venue` forwards up to 40 accounts).
    let m = ok(f.env.send_as(&cranker, &[cu_limit(1_400_000), i], &[&cranker]));
    assert_eq!(events::<fumpad::events::BuybackExecuted>(&m).len(), 1);
    assert_eq!(token_balance(&f.env, &other_vault), Params::default().reward_pool_supply, "untouched — today");
}

/// [L-2] `Params::is_valid` accepts values that silently disable or break protocol features
/// (see M-1 for the drain variant). None of these needs a code path to be wrong — a typo in a
/// queued change is enough, and the review window is the only safeguard.
///
/// FIXED (v0.6): every case below is rejected (bounds in constants.rs, `Params::is_valid`,
/// `Params::curve_consistent`); `graduation_lamports` is enforced as the raise the curve
/// constants imply. Edges of every range are accepted (second half of the test).
#[test]
fn regression_params_is_valid_rejects_degenerate_values() {
    let base = Params::default();
    let tiny_curve = Params { initial_virtual_sol: 100_000_000, ..base };
    let tiny_raise = {
        let t1 = (base.initial_virtual_token - base.curve_supply) as u128;
        ((100_000_000u128 * base.initial_virtual_token as u128 / t1) - 100_000_000) as u64
    };
    let cases: Vec<(&str, Params)> = vec![
        ("max_open_tickets = 0 → no ticket is ever created", Params { max_open_tickets: 0, ..base }),
        ("rebuy_window_secs = 0 → rebuy rule off (sell, ticket, rebuy at once)", Params { rebuy_window_secs: 0, ..base }),
        ("min_hold_secs = 0 / negative → no hold period", Params { min_hold_secs: -1, ..base }),
        ("claim_window_secs = 0 → every ticket expires instantly", Params { claim_window_secs: 0, ..base }),
        ("claim_window_secs = i64::MAX → claim/close revert MathOverflow", Params { claim_window_secs: i64::MAX, ..base }),
        ("min_sell_usd_cents = 0 → dust tickets", Params { min_sell_usd_cents: 0, ..base }),
        ("max_price_age_secs = u64::MAX → any stale Pyth price", Params { max_price_age_secs: u64::MAX, ..base }),
        ("sol_usd_feed_id = any feed (e.g. a $0.01 asset)", Params { sol_usd_feed_id: [7; 32], ..base }),
        (
            "1-sample, 6-second oracle window → median = one keeper sample",
            Params { oracle_window_secs: 6, oracle_min_spacing_secs: 1, oracle_min_samples: 1, ..base },
        ),
        ("keeper_stale_secs = -1 → fallback sampling always open", Params { keeper_stale_secs: -1, ..base }),
        ("buyback_max_deviation_bps = 10_000 → execute_buyback always InvalidParams", Params { buyback_max_deviation_bps: 10_000, ..base }),
        ("buyback_max_pool_bps = 5_000 → 50%-of-depth slices; haircut ≥ 100% → buybacks always InvalidParams", Params { buyback_max_pool_bps: 5_000, ..base }),
        (
            "graduation fee 1 SOL with the 0.65-SOL curve constants → LP opens ~0.4% below the curve (D20 continuity)",
            Params { graduation_fee_lamports: 1_000_000_000, ..base },
        ),
        (
            "curve whose completion raise (~0.3 SOL) < graduation fee → coins can never graduate",
            Params { graduation_lamports: 85_000_000_000, ..tiny_curve },
        ),
        ("… even with graduation_lamports set to that raise", Params { graduation_lamports: tiny_raise, ..tiny_curve }),
        ("graduation_lamports not the curve's raise (unused before v0.6)", Params { graduation_lamports: 90 * SOL, ..base }),
        ("trigger below 5x", Params { trigger_multiple_bps: 49_999, ..base }),
        ("trigger above 50x", Params { trigger_multiple_bps: 500_001, ..base }),
        ("claim > 25%", Params { claim_bps: 2_501, ..base }),
        ("claim 0", Params { claim_bps: 0, ..base }),
        ("per-claim cap > 25%", Params { max_claim_pool_bps: 2_501, ..base }),
        ("oracle window < 10 min", Params { oracle_window_secs: 599, ..base }),
        ("too few samples for the window (< 1/min)", Params { oracle_min_samples: 29, ..base }),
        ("more samples than the window can hold", Params { oracle_window_secs: 600, oracle_min_samples: 61, ..base }),
        ("keeper_stale_secs 0", Params { keeper_stale_secs: 0, ..base }),
        ("zero reward pool", Params { reward_pool_supply: 0, curve_supply: base.curve_supply + base.reward_pool_supply, ..base }),
    ];
    for (why, p) in cases {
        assert!(!p.is_valid(), "still accepted: {why}");
    }
    // Every range's edges are accepted.
    let edges = [
        Params { trigger_multiple_bps: 50_000, claim_bps: 100, max_claim_pool_bps: 100, ..base },
        Params { trigger_multiple_bps: 500_000, claim_bps: 2_500, max_claim_pool_bps: 2_500, ..base },
        Params { min_sell_usd_cents: 500, min_hold_secs: 60, rebuy_window_secs: DAY, claim_window_secs: 7 * DAY, max_open_tickets: 1, ..base },
        Params { min_sell_usd_cents: 100_000, min_hold_secs: DAY, rebuy_window_secs: 30 * DAY, claim_window_secs: 365 * DAY, ..base },
        Params { oracle_window_secs: 600, oracle_min_spacing_secs: 5, oracle_min_samples: 10, keeper_stale_secs: 60, ..base },
        Params { oracle_window_secs: 7_200, oracle_min_spacing_secs: 25, oracle_min_samples: 120, keeper_stale_secs: 3_600, ..base },
        Params { buyback_max_deviation_bps: 10, buyback_max_pool_bps: 1, ..base },
        Params { buyback_max_deviation_bps: 1_000, buyback_max_pool_bps: 200, ..base },
        crate::curve_tests::params_for_graduation_fee(0),
        crate::curve_tests::params_for_graduation_fee(SOL),
    ];
    for (i, p) in edges.iter().enumerate() {
        assert!(p.is_valid(), "edge case {i} rejected");
    }
}

/// [L-3] Admin state changes emit no event: `set_pause`, `set_keepers`, `set_admin` (and
/// `initialize_global`, `init_observations`, `init_claim_queue`) have no `emit_cpi!`, although
/// CONTRACTS.md / SPEC §6 say every state change emits one and the indexer is event-sourced.
/// A pause, a keeper swap or an admin/treasury rotation is invisible to event-based monitoring.
/// Fix: `#[event_cpi]` on `AdminOnly` + `PauseSet`, `KeepersSet`, `AdminSet` events.
#[test]
fn issue_admin_changes_emit_no_events() {
    let mut env = Env::new();
    let global = env.global_pda();
    let admin = env.admin.insecure_clone();
    let ak = kp_pk(&admin);
    for data in [
        admin_only_ix(&ak, global, fumpad::instruction::SetPause { paused: 7 }),
        admin_only_ix(&ak, global, fumpad::instruction::SetKeepers { keepers: [Pubkey::new_unique(); fumpad::MAX_KEEPERS] }),
        admin_only_ix(&ak, global, fumpad::instruction::SetAdmin { new_admin: ak, platform_treasury: Pubkey::new_unique() }),
    ] {
        let m = ok(env.send(&[data], &[&admin]));
        assert!(m.inner_instructions.iter().all(|v| v.is_empty()), "no event self-CPI");
    }
}

/// [L-4] `Position` accounts can never be closed (no instruction does it): every wallet that
/// ever touched a coin through FUMPAD keeps its Position rent locked forever, even
/// after a full exit with no open tickets (330-byte account ≈ 0.0023 SOL). Fix: `close_position` (owner-signed, requires
/// open_count == 0, rent → wallet).
#[test]
fn issue_positions_are_never_closable() {
    let mut f = Flow::new();
    let u = f.env.new_user(10);
    let uk = kp_pk(&u);
    ok(f.buy(&u, SOL));
    let all = f.tokens(&uk);
    ok(f.sell(&u, all)); // unmatured → no ticket
    let p = f.position(&uk).expect("position");
    assert_eq!((p.open_count, p.matured, p.pending, f.tokens(&uk)), (0, 0, 0, 0));
    let rent = f.env.lamports(&f.position_key(&uk));
    assert!(rent > 2_000_000, "{rent} lamports of user rent stranded");
}

// ═════════════════════════════════════════════════════════════════════════════
// INFO (documented behaviour worth an auditor's eye; tests pin it down)
// ═════════════════════════════════════════════════════════════════════════════

/// [I-1] The coin mint's MetadataPointer extension: authority must be None (nobody can repoint
/// the metadata). Pins the current behaviour.
#[test]
fn info_metadata_pointer_has_no_authority() {
    let f = Flow::new();
    let d = f.env.account(&f.mint).unwrap().data;
    // Token-2022 mint: base 82 + padding to 165, account type at 165, TLV from 166.
    let mut off = 166;
    let mut found = false;
    while off + 4 <= d.len() {
        let ty = u16::from_le_bytes([d[off], d[off + 1]]);
        let len = u16::from_le_bytes([d[off + 2], d[off + 3]]) as usize;
        if ty == 18 {
            // MetadataPointer: authority (32, zero = None) | metadata_address (32)
            assert_eq!(&d[off + 4..off + 36], &[0u8; 32], "metadata pointer authority must be None");
            assert_eq!(&d[off + 36..off + 68], f.mint.as_ref());
            found = true;
        }
        if ty == 0 && len == 0 {
            break;
        }
        off += 4 + len;
    }
    assert!(found, "MetadataPointer extension present");
}
