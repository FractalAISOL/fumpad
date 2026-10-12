//! Red-team findings (custody scope), fixed in v0.3. Each `regression_*` test replays the
//! original PoC scenario and asserts the attack now FAILS. `nofinding_*` tests document
//! attacks that were tried and FAIL against the code (kept as regression guards).

use anchor_lang::prelude::{AccountMeta as Meta, Pubkey};
use fumpad::{error::FumpadError, events::CurveReopened, external::pumpswap::WSOL_MINT, state::{CoinStatus, Params}};
use solana_keypair::Keypair;

use crate::flow::*;
use crate::*;

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

fn send_lamports_ix(from: &Pubkey, to: &Pubkey, lamports: u64) -> solana_instruction::Instruction {
    let mut data = vec![2, 0, 0, 0];
    data.extend_from_slice(&lamports.to_le_bytes());
    raw_ix(SYSTEM, vec![Meta::new(*from, true), w(*to)], data)
}

// ═════════════════════════════════════════════════════════════════════════════
// Findings
// ═════════════════════════════════════════════════════════════════════════════

/// [M] (fixed, D14 + D15) The PoC: the admin raised `graduation_fee_lamports` to almost all
/// raised SOL with one untimelocked `update_params`, then graduated the Complete coin with a
/// 1-lamport pool and swept the SOL to the treasury. Now: there is no `update_params`; a
/// change must be queued and waits 48h; the fee is capped at 1 SOL (and fee_bps at 200);
/// and a coin graduates with the fee snapshotted at its `create_coin`, so even a valid,
/// executed change never applies retroactively.
#[test]
fn regression_admin_cannot_retroactively_take_raised_sol() {
    let (mut f, _whale) = completed();
    let raised = f.coin_state().real_sol_reserves;
    assert!(raised > 84 * SOL);
    let platform_before = f.coin_state().platform_fees_unclaimed;
    // The PoC's params are refused outright (1 SOL cap), as is a fee_bps above 2%.
    let poc = Params { graduation_fee_lamports: raised - 1, graduation_lamports: u64::MAX, ..Params::default() };
    expect_err(f.env.queue_params(poc), FumpadError::InvalidParams);
    expect_err(f.env.queue_params(Params { fee_bps: 201, ..Params::default() }), FumpadError::InvalidParams);
    // Only the admin can queue.
    let rando = f.env.new_user(1);
    let i = ix(
        fumpad::accounts::QueueParams {
            admin: kp_pk(&rando),
            global: f.env.global_pda(),
            event_authority: event_authority(),
            program: fumpad::ID,
        },
        fumpad::instruction::QueueParams { params: Params::default() },
    );
    expect_err(f.env.send_as(&rando, &[i], &[&rando]), FumpadError::Unauthorized);
    // The maximum allowed fee, queued: not executable before 48h; cancellable.
    let max = Params { fee_bps: 200, ..crate::curve_tests::params_for_graduation_fee(SOL) };
    ok(f.env.queue_params(max));
    f.env.warp(fumpad::PARAMS_TIMELOCK_SECS - 1);
    expect_err(f.env.execute_params(), FumpadError::TimelockNotElapsed);
    let cancel = ix(
        fumpad::accounts::CancelParams {
            admin: kp_pk(&f.env.admin),
            global: f.env.global_pda(),
            event_authority: event_authority(),
            program: fumpad::ID,
        },
        fumpad::instruction::CancelParams {},
    );
    let admin = f.env.admin.insecure_clone();
    ok(f.env.send(&[cancel], &[&admin]));
    f.env.warp(1);
    expect_err(f.env.execute_params(), FumpadError::NoPendingParams);
    // Queue again and let it execute after 48h: Global changes…
    f.env.set_params_timelocked(max);
    let g: fumpad::state::Global = f.env.fetch(&f.env.global_pda());
    assert_eq!((g.params, g.pending_eta), (max, 0));
    // …but this coin keeps its snapshot (D20 default 0.65 SOL fee, 1%): only that fee stays
    // out of the pool, and it is spent on the setup rent, not swept.
    assert_eq!(f.coin_state().fees, Params::default().coin_fees());
    let snap = f.coin_state().fees.graduation_fee_lamports;
    assert_eq!(snap, fumpad::DEFAULT_GRADUATION_FEE_LAMPORTS);
    ok(f.graduate());
    assert_eq!(token_balance(&f.env, &f.pool_quote), raised - snap, "pool seeded with the raise minus the snapshot fee");
    let platform_gain = f.coin_state().platform_fees_unclaimed - platform_before;
    let prefunded = f.env.lamports(&f.observations) + f.env.lamports(&f.queue);
    assert!(prefunded > 0 && platform_gain + prefunded <= snap, "fee spent on setup first, remainder {platform_gain}");
    f.assert_invariant();
}

/// [M] (fixed, D13) The PoC: PumpSwap's admin sets `disable_create_pool`; `graduate`
/// fails forever and buy/sell require `Curve`, so the raised SOL and every holder are stuck.
/// Now: after 7 days in `Complete`, a curve sell reopens the coin as a plain curve
/// (`CurveReopened`), holders exit at curve prices, and if the curve is later bought out
/// again it re-completes and graduates normally once PumpSwap allows it.
#[test]
fn regression_complete_coin_reopens_curve_after_7_days() {
    let (mut f, whale) = completed();
    let completed_at = f.coin_state().completed_at;
    let mut gc = f.env.account(&fumpad::PUMPSWAP_GLOBAL_CONFIG).unwrap();
    gc.data[56] |= 1; // disable_create_pool
    f.env.svm.set_account(addr(&fumpad::PUMPSWAP_GLOBAL_CONFIG), gc.clone()).unwrap();
    assert!(f.graduate().is_err());
    let held = f.tokens(&kp_pk(&whale));
    assert!(held > 0);
    // Before the 7 days: still no trading.
    f.env.warp(fumpad::ESCAPE_HATCH_SECS - 1);
    expect_err(f.sell(&whale, held / 10), FumpadError::WrongCoinStatus);
    expect_err(f.buy(&whale, SOL), FumpadError::WrongCoinStatus);
    // At 7 days: the sell reopens the curve and pays out.
    f.env.warp(1);
    let sol0 = f.env.lamports(&kp_pk(&whale));
    let m = ok(f.sell(&whale, held / 2));
    let ev = events::<CurveReopened>(&m);
    assert_eq!((ev.len(), ev[0].completed_at), (1, completed_at));
    assert!(f.env.lamports(&kp_pk(&whale)) > sol0 + 40 * SOL, "holder exited with SOL");
    let c = f.coin_state();
    assert_eq!((c.status, c.completed_at), (CoinStatus::Curve, 0));
    assert!(c.real_token_reserves > 0 && c.real_sol_reserves < 50 * SOL);
    f.assert_invariant();
    // Other holders can keep exiting; graduation is not possible on a reopened curve.
    ok(f.sell(&whale, held / 4));
    expect_err(f.graduate(), FumpadError::WrongCoinStatus);
    // PumpSwap unblocks; the curve is bought out again → re-completes → graduates.
    gc.data[56] &= !1;
    f.env.svm.set_account(addr(&fumpad::PUMPSWAP_GLOBAL_CONFIG), gc).unwrap();
    ok(f.buy(&whale, 200 * SOL));
    let c = f.coin_state();
    assert_eq!((c.status, c.completed_at), (CoinStatus::Complete, f.now()));
    ok(f.graduate());
    assert_eq!(f.coin_state().status, CoinStatus::Graduated);
    f.assert_invariant();
}

/// [L] (fixed) The PoC: `graduate` closed ATA(pool_authority, WSOL) — `execute_buyback`'s
/// persistent `buyback_wsol` — to its caller, handing every graduation caller the buyback
/// cranker's rent + any wrapped dust. Now graduation wraps into its own PDA
/// ["graduation_wsol", mint], created and closed inside `graduate`; the buyback ATA is never
/// passed to it.
#[test]
fn regression_graduate_leaves_buyback_wsol_alone() {
    // Coin A graduates; its buyback crank runs once → ATA(pool_authority, WSOL) now persists
    // (rent paid by the buyback cranker).
    let (mut a, _) = graduated();
    let shared = ata(&pool_authority(), &WSOL_MINT, &TOKEN);
    let t = a.env.new_user(100);
    ok(a.swap_buy(&t, 20 * SOL));
    a.keeper_samples(130, 15);
    ok(a.execute_buyback(u64::MAX));
    let shared_lamports = a.env.lamports(&shared);
    assert!(shared_lamports > 0, "buyback WSOL ATA persists");
    // Coins B and C in the same deployment, both completed.
    let mut f = Flow { env: std::mem::replace(&mut a.env, Env::new()), ..fresh_coin_shell() };
    let whale = f.env.new_user(10_000);
    create_coin_in(&mut f);
    ok(f.buy(&whale, 200 * SOL));
    let b_ixs = graduate_ixs(&f, &Pubkey::default());
    create_coin_in(&mut f);
    ok(f.buy(&whale, 200 * SOL));
    let c_ixs = graduate_ixs(&f, &Pubkey::default());
    // Graduate B, then C, each by a fresh caller; measure each caller's net.
    let mut net = vec![];
    for mut ixs in [b_ixs, c_ixs] {
        let caller = f.env.new_user(1);
        let c = kp_pk(&caller);
        ixs[1].accounts[0].pubkey = addr(&c);
        let before = f.env.lamports(&c);
        ok(f.env.send_as(&caller, &ixs, &[&caller]));
        net.push(f.env.lamports(&c) as i128 - before as i128);
    }
    // Same accounts created both times → both callers net exactly the same; the buyback
    // WSOL ATA is untouched.
    assert_eq!(net[0], net[1], "no graduate caller pockets the buyback ATA");
    assert_eq!(f.env.lamports(&shared), shared_lamports, "buyback WSOL ATA intact");
    for mint in [&f.mint] {
        assert!(f.env.account(&fpda(&[fumpad::GRADUATION_WSOL_SEED, mint.as_ref()])).map_or(true, |x| x.lamports == 0));
    }
}

// ── helpers for multi-coin envs ─────────────────────────────────────────────────

fn fresh_coin_shell() -> Flow {
    // Placeholder fields; overwritten by create_coin_in.
    let k = Pubkey::default();
    Flow {
        env: Env::new(),
        creator: Keypair::new(),
        mint: k,
        coin: k,
        pool: k,
        pool_base: k,
        pool_quote: k,
        reward_vault: k,
        curve_vault: k,
        observations: k,
        queue: k,
        buyback_fee_recipient_ata: k,
    }
}

fn create_coin_in(f: &mut Flow) {
    use fumpad::external::pumpswap::pool_pda;
    let creator = f.env.new_user(10);
    let mint_kp = Keypair::new();
    let mint = kp_pk(&mint_kp);
    let pa = pool_authority();
    let pool = pool_pda(0, &pa, &mint, &WSOL_MINT);
    f.creator = creator.insecure_clone();
    f.mint = mint;
    f.coin = fpda(&[fumpad::COIN_SEED, mint.as_ref()]);
    f.reward_vault = fpda(&[fumpad::REWARD_VAULT_SEED, mint.as_ref()]);
    f.curve_vault = fpda(&[fumpad::CURVE_VAULT_SEED, mint.as_ref()]);
    f.observations = fpda(&[fumpad::OBSERVATIONS_SEED, mint.as_ref()]);
    f.queue = fpda(&[fumpad::CLAIM_QUEUE_SEED, mint.as_ref()]);
    f.pool = pool;
    f.pool_base = ata(&pool, &mint, &T22);
    f.pool_quote = ata(&pool, &WSOL_MINT, &TOKEN);
    let i = ix(
        fumpad::accounts::CreateCoin {
            creator: kp_pk(&creator),
            global: f.env.global_pda(),
            mint,
            mint_authority: fpda(&[fumpad::MINT_AUTHORITY_SEED]),
            coin: f.coin,
            pool_authority: pa,
            reward_vault: f.reward_vault,
            curve_vault: f.curve_vault,
            token_program: T22,
            system_program: SYSTEM,
            event_authority: event_authority(),
            program: fumpad::ID,
        },
        fumpad::instruction::CreateCoin { name: "B".into(), symbol: "B".into(), uri: "".into() },
    );
    ok(f.env.send(&[i], &[&creator, &mint_kp]));
    f.env.skip_snipe_window();
}

fn graduate_ixs(f: &Flow, payer: &Pubkey) -> Vec<solana_instruction::Instruction> {
    use fumpad::external::pumpswap::{event_authority_pda, lp_mint_pda};
    let pa = pool_authority();
    let lp_mint = lp_mint_pda(&f.pool);
    let (lock, auth, vault) = locker_accounts(&f.pool);
    vec![
        cu_limit(400_000),
        ix(
            fumpad::accounts::Graduate {
                payer: *payer,
                global: f.env.global_pda(),
                coin: f.coin,
                mint: f.mint,
                pool_authority: pa,
                curve_vault: f.curve_vault,
                wsol_mint: WSOL_MINT,
                graduation_wsol: fpda(&[fumpad::GRADUATION_WSOL_SEED, f.mint.as_ref()]),
                amm_pool: f.pool,
                amm_global_config: fumpad::PUMPSWAP_GLOBAL_CONFIG,
                lp_mint,
                pool_authority_lp: ata(&pa, &lp_mint, &T22),
                pool_base_vault: f.pool_base,
                pool_quote_vault: f.pool_quote,
                amm_event_authority: event_authority_pda(),
                amm_program: fumpad::PUMPSWAP_PROGRAM_ID,
                lp_lock: lock,
                lp_locker_authority: auth,
                lp_vault: vault,
                lp_locker_program: fumpad_lp_locker::ID,
                token_program: T22,
                quote_token_program: TOKEN,
                associated_token_program: ATA_PROGRAM,
                system_program: SYSTEM,
                observations: f.observations,
                claim_queue: f.queue,
                event_authority: event_authority(),
                program: fumpad::ID,
            },
            fumpad::instruction::Graduate {},
        ),
    ]
}

// ═════════════════════════════════════════════════════════════════════════════
// Attacks tried that FAIL (no finding) — regression guards
// ═════════════════════════════════════════════════════════════════════════════

/// Pre-creating the PumpSwap pool vault ATAs, and pre-funding every PDA graduation will
/// `init` (pool, LP mint, Lock, locker LP vault), does not block graduation.
#[test]
fn nofinding_graduate_survives_precreated_and_prefunded_accounts() {
    use fumpad::external::pumpswap::lp_mint_pda;
    let (mut f, _whale) = completed();
    let griefer = f.env.new_user(10);
    let g = kp_pk(&griefer);
    let mut i1 = create_ata_ix(&g, &f.pool, &f.mint, &T22);
    i1.data = vec![0];
    let mut i2 = create_ata_ix(&g, &f.pool, &WSOL_MINT, &TOKEN);
    i2.data = vec![0];
    ok(f.env.send_as(&griefer, &[i1, i2], &[&griefer]));
    let lp_mint = lp_mint_pda(&f.pool);
    let (lock, _, vault) = locker_accounts(&f.pool);
    let pa = pool_authority();
    let ixs: Vec<_> = [f.pool, lp_mint, lock, vault, ata(&pa, &lp_mint, &T22)]
        .iter()
        .map(|k| send_lamports_ix(&g, k, 1_000_000))
        .collect();
    ok(f.env.send_as(&griefer, &ixs, &[&griefer]));
    ok(f.graduate());
    assert_eq!(f.coin_state().status, CoinStatus::Graduated);
}

/// Anyone can `init_boost` a FUMPAD pool; then PumpSwap's boost authority (simulated) tries
/// `boost_buy_and_burn`.
fn try_boost(f: &mut Flow) -> litesvm::types::TransactionResult {
    let s = f.env.new_user(10);
    let bva = pda(&[b"boost_vault", f.pool.as_ref()], &fumpad::PUMPSWAP_PROGRAM_ID);
    let init = raw_ix(
        fumpad::PUMPSWAP_PROGRAM_ID,
        vec![
            w(f.pool),
            r(fumpad::PUMPSWAP_GLOBAL_CONFIG),
            Meta::new(kp_pk(&s), true),
            r(f.mint),
            r(WSOL_MINT),
            r(f.pool_base),
            w(f.pool_quote),
            r(bva),
            w(ata(&bva, &WSOL_MINT, &TOKEN)),
            r(TOKEN),
            r(SYSTEM),
            r(ATA_PROGRAM),
            r(fumpad::external::pumpswap::event_authority_pda()),
            r(fumpad::PUMPSWAP_PROGRAM_ID),
        ],
        vec![140, 233, 33, 94, 132, 90, 194, 143],
    );
    ok(f.env.send_as(&s, &[cu_limit(400_000), init], &[&s])); // stranger CAN init_boost
    // Even PumpSwap's boost authority can't boost it (simulated by taking that role).
    let mut gc = f.env.account(&fumpad::PUMPSWAP_GLOBAL_CONFIG).unwrap();
    gc.data[907..939].copy_from_slice(kp_pk(&s).as_ref());
    f.env.svm.set_account(addr(&fumpad::PUMPSWAP_GLOBAL_CONFIG), gc).unwrap();
    let bv = ata(&bva, &WSOL_MINT, &TOKEN);
    put_token_account(&mut f.env, bv, WSOL_MINT, bva, 10 * SOL, TOKEN);
    let mut data = vec![105, 68, 6, 175, 0, 7, 35, 162];
    data.extend_from_slice(&(10 * SOL).to_le_bytes());
    data.extend_from_slice(&0u64.to_le_bytes());
    let burn = raw_ix(
        fumpad::PUMPSWAP_PROGRAM_ID,
        vec![
            r(f.pool),
            Meta::new(kp_pk(&s), true),
            r(fumpad::PUMPSWAP_GLOBAL_CONFIG),
            w(f.mint),
            r(WSOL_MINT),
            w(f.pool_base),
            w(f.pool_quote),
            r(bva),
            w(bv),
            r(T22),
            r(TOKEN),
            r(fumpad::external::pumpswap::event_authority_pda()),
            r(fumpad::PUMPSWAP_PROGRAM_ID),
        ],
        data,
    );
    f.env.send_as(&s, &[cu_limit(400_000), burn], &[&s])
}

fn outside_volume(f: &mut Flow, n: usize, sol: u64) {
    let t = f.env.new_user(1000);
    let tk = kp_pk(&t);
    ok(f.env.send_as(&t, &[create_ata_ix(&tk, &tk, &f.mint, &T22)], &[&t]));
    for _ in 0..n {
        let i = f.direct_buy_ix(&tk, sol, true);
        ok(f.env.send_as(&t, &[cu_limit(400_000), i], &[&t]));
        let got = f.tokens(&tk);
        let i = f.direct_sell_ix(&tk, got);
        ok(f.env.send_as(&t, &[cu_limit(400_000), i], &[&t]));
        f.env.warp(1);
    }
}

/// Fresh FUMPAD pool (virtual reserves 0): PumpSwap refuses to boost it.
#[test]
fn nofinding_boost_fresh_pool() {
    let (mut f, _) = graduated();
    expect_custom(try_boost(&mut f), 6065); // PoolCannotBoost
}

/// After ordinary v2 volume the pool's virtual_quote_reserves is −protocol_fees ≠ 0.
/// Still not boostable (PumpSwap requires positive virtual reserves); skims keep working.
#[test]
fn nofinding_boost_after_volume() {
    let (mut f, _) = graduated();
    outside_volume(&mut f, 5, 50 * SOL);
    let p = f.env.account(&f.pool).unwrap().data;
    assert!(i128::from_le_bytes(p[245..261].try_into().unwrap()) < 0);
    expect_custom(try_boost(&mut f), 6065);
    outside_volume(&mut f, 5, 50 * SOL);
    ok(f.skim());
}
