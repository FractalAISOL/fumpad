//! Pre-audit fixes (audit package "first questions", 2026-10-13 d): operators separate from attestors, DAMM v2 pool
//! status on samples / buybacks / claims, the D12 execution-price floor in `attest_sell`, and the claim paths for
//! otherwise-stranded value (unregistered pools' partner fees, DAMM v2 position farming rewards). All on the mainnet
//! DBC 0.2.1 / DAMM v2 0.2.4 binaries; DAMM pool status and reward slots are set by writing the pool / position
//! accounts (DAMM's admin keys are not available in LiteSVM).

use anchor_lang::{AccountDeserialize, AccountSerialize};
use fumpad::error::FumpadError;
use fumpad::events::{
    GlobalMigrated, OperatorsSet, PositionRewardClaimed, SampleRecorded, TicketAttested, UnregisteredFeesClaimed,
};
use fumpad::external::meteora as m;
use fumpad::state::{Coin, Global, Observations};
use litesvm::types::TransactionResult;
use solana_account::Account;
use solana_instruction::Instruction;
use solana_keypair::Keypair;

use crate::flow::*;
use crate::meteora::{self, WSOL};
use crate::rewards_tests::{World, M};
use crate::*;

/// Byte offset of `Global.operators` (the former `reserved [u8; 64]`).
const GLOBAL_OPERATORS_OFFSET: usize = 980;

fn migrate_global_ix(env: &Env, admin: &Pubkey) -> Instruction {
    ix(
        fumpad::accounts::MigrateGlobal {
            admin: *admin,
            global: env.global(),
            system_program: SYSTEM,
            event_authority: ev_auth(),
            program: fumpad::ID,
        },
        fumpad::instruction::MigrateGlobal {},
    )
}

fn sample_as(env: &mut Env, sampler: &Keypair, coins: &[&TCoin]) -> TransactionResult {
    let i = env.record_samples_ix(&kp_pk(sampler), coins);
    env.send_as(sampler, &[i], &[sampler])
}

fn set_pool_status(env: &mut Env, pool: &Pubkey, status: u8) {
    let mut acc = env.svm.get_account(&addr(pool)).unwrap();
    acc.data[m::DAMM_POOL_STATUS] = status;
    env.svm.set_account(addr(pool), acc).unwrap();
}

// ── 1. operators (jobs keys) are separate from attestors ────────────────────────────────────────────────────────

/// `set_operators` is admin-only, immediate, emits `OperatorsSet`, and never accepts an attestor key; `set_keepers`
/// never accepts an operator key. An operator can neither submit nor co-sign an attestation, and a rotated-out
/// operator loses its sampling power at once.
#[test]
fn operators_are_jobs_keys_and_never_attestors() {
    let mut env = Env::new();
    let ks: [Pubkey; 3] = [kp_pk(&env.keepers[0]), kp_pk(&env.keepers[1]), kp_pk(&env.keepers[2])];
    let ops = env.operator_keys();
    let g: Global = env.fetch(&env.global());
    assert_eq!(g.operators, ops);

    // Admin only.
    let rando = env.new_user(1);
    let i = ix(
        fumpad::accounts::AdminOnly { admin: kp_pk(&rando), global: env.global(), event_authority: ev_auth(), program: fumpad::ID },
        fumpad::instruction::SetOperators { operators: [kp_pk(&rando), Pubkey::default()] },
    );
    assert_fumpad_err(env.send_as(&rando, &[i], &[&rando]), FumpadError::Unauthorized);
    // An attestor key can't be an operator, and an operator key can't be an attestor.
    assert_fumpad_err(env.set_operators([ks[0], Pubkey::default()]), FumpadError::KeeperOperatorOverlap);
    assert_fumpad_err(env.set_operators([ops[0], ks[2]]), FumpadError::KeeperOperatorOverlap);
    assert_fumpad_err(env.set_keepers([ops[0], ks[1], ks[2]]), FumpadError::KeeperOperatorOverlap);
    assert_fumpad_err(env.set_operators([ops[0], ops[0]]), FumpadError::InvalidParams);

    let c = env.launch(SOL / 10);
    env.skip_launch_window();
    env.warp(60);
    // An operator can't submit an attestation (even with two valid attestor signatures) …
    let r = env.sell_record(&c, &Pubkey::new_unique(), 1_000 * M, 1 << 50);
    let op = env.op();
    let (k0, k1) = (env.keepers[0].insecure_clone(), env.keepers[1].insecure_clone());
    let ixs = vec![Env::ed25519_ix(&r.encode(), &[&k0, &k1]), env.attest_sell_ix(&kp_pk(&op), &r)];
    assert_fumpad_err(env.send_as(&op, &ixs, &[&op]), FumpadError::Unauthorized);
    // … and its signature never counts toward the 2-of-3.
    let ixs = vec![Env::ed25519_ix(&r.encode(), &[&k0, &op]), env.attest_sell_ix(&kp_pk(&k0), &r)];
    assert_fumpad_err(env.send_as(&k0, &ixs, &[&k0]), FumpadError::NotEnoughKeeperSignatures);
    ok(env.attest_sell(&r, &[0, 1]));

    // Rotation: immediate, event, the old key loses its jobs powers at once.
    let fresh = env.new_user(10);
    let meta = ok(env.set_operators([kp_pk(&fresh), Pubkey::default()]));
    println!("set_operators CU {}", meta.compute_units_consumed);
    assert_eq!(event::<OperatorsSet>(&meta).operators, [kp_pk(&fresh), Pubkey::default()]);
    assert_fumpad_err(sample_as(&mut env, &op, &[&c]), FumpadError::Unauthorized);
    ok(sample_as(&mut env, &fresh, &[&c]));
    // Clearing every operator is allowed (jobs stop; fallback samples only post-graduation).
    ok(env.set_operators([Pubkey::default(); 2]));
    env.warp(30);
    assert_fumpad_err(sample_as(&mut env, &fresh, &[&c]), FumpadError::Unauthorized);
}

/// `initialize_global` bootstraps the operators (no freeze; they have no attestation power anyway) and refuses an
/// operator that is also an attestor.
#[test]
fn initialize_global_bootstraps_operators() {
    let mut env = Env::uninit();
    let ks: [Pubkey; 3] = [kp_pk(&env.keepers[0]), kp_pk(&env.keepers[1]), kp_pk(&env.keepers[2])];
    let ops = env.operator_keys();
    let payer = kp_pk(&env.payer);
    let p = fumpad::state::Params::default();
    let i = env.initialize_global_ix_full(&payer, p, ks, [ks[1], Pubkey::default()], &[]);
    assert_fumpad_err(env.send(&[i], &[]), FumpadError::KeeperOperatorOverlap);
    let i = env.initialize_global_ix_full(&payer, p, ks, [ops[1], ops[1]], &[]);
    assert_fumpad_err(env.send(&[i], &[]), FumpadError::InvalidParams);
    let i = env.initialize_global_ix_full(&payer, p, ks, ops, &[]);
    let meta = ok(env.send(&[i], &[]));
    assert_eq!(event::<OperatorsSet>(&meta).operators, ops);
    let g: Global = env.fetch(&env.global());
    assert_eq!((g.operators, g.keepers), (ops, ks));
    assert!(g.is_operator(&ops[0]) && !g.is_keeper(&ops[0]) && !g.is_operator(&ks[0]));
}

/// Devnet upgrade path: a Global initialized before operators existed (zeros where `operators` now sits) is migrated
/// in place by the admin: `operators[0] = keepers[0]` (the key that ran the jobs keeper), so jobs keep running across
/// the program upgrade. The admin then moves the jobs keeper to its own key; until then `set_keepers` refuses to keep
/// the overlap. A second `migrate_global` changes nothing.
#[test]
fn migrate_global_fills_operators_from_keeper_0() {
    let mut env = Env::uninit();
    let config = env.create_dbc_config(&meteora::mainnet_config_params());
    env.config = config;
    let ks: [Pubkey; 3] = [kp_pk(&env.keepers[0]), kp_pk(&env.keepers[1]), kp_pk(&env.keepers[2])];
    let i = env.initialize_global_ix(fumpad::state::Params::default(), ks, &[config]);
    ok(env.send(&[i], &[]));
    let c = env.launch(SOL / 10);
    env.skip_launch_window();
    let k0 = env.keepers[0].insecure_clone();
    assert_fumpad_err(sample_as(&mut env, &k0, &[&c]), FumpadError::Unauthorized);
    // = the pre-operators, pre-fee-policy layout (devnet before 2026-10-14): 1,044 bytes, and the 64 bytes at the
    // operators offset are zero (they were `reserved`). Truncate the fresh Global to it (its fee-policy tail is
    // standard anyway, except the coin count, which the old layout didn't have).
    let g = env.global();
    let mut acc = env.svm.get_account(&addr(&g)).unwrap();
    acc.data.truncate(1_044);
    acc.lamports = env.rent(1_044);
    env.svm.set_account(addr(&g), acc).unwrap();
    let d = env.data(&g);
    assert_eq!(d.len(), 1_044);
    assert!(d[GLOBAL_OPERATORS_OFFSET..GLOBAL_OPERATORS_OFFSET + 64].iter().all(|b| *b == 0));
    // Until `migrate_global` grows it, nothing that loads Global works (run it right after the upgrade).
    assert!(sample_as(&mut env, &k0, &[&c]).is_err());

    let admin = env.admin.insecure_clone();
    let rando = env.new_user(1);
    let bad = migrate_global_ix(&env, &kp_pk(&rando));
    assert_fumpad_err(env.send(&[bad], &[&rando]), FumpadError::Unauthorized);
    let admin_before = env.lamports(&kp_pk(&admin));
    let meta = ok(env.send(&[migrate_global_ix(&env, &kp_pk(&admin))], &[&admin]));
    println!("migrate_global (grow 1,044 → 1,491 + fill operators) CU {}", meta.compute_units_consumed);
    let ev = event::<GlobalMigrated>(&meta);
    assert_eq!((ev.old_len, ev.new_len), (1_044, 1_491));
    let grown = env.data(&g);
    assert_eq!(grown.len(), 1_491);
    assert_eq!(grown[..GLOBAL_OPERATORS_OFFSET], d[..GLOBAL_OPERATORS_OFFSET], "every old byte before operators verbatim");
    assert!(grown[1_044..].iter().all(|b| *b == 0), "grown tail zero = standard policies, no counts");
    assert_eq!(env.lamports(&g), env.rent(1_491), "rent-exempt at the new size");
    assert_eq!(admin_before - env.lamports(&kp_pk(&admin)), env.rent(1_491) - env.rent(1_044), "the admin paid the extra rent");
    assert_eq!(event::<OperatorsSet>(&meta).operators, [ks[0], Pubkey::default()]);
    let after: Global = env.fetch(&g);
    assert_eq!(after.operators, [ks[0], Pubkey::default()]);
    assert_eq!((after.keepers, after.keeper_added_at, after.configs[0]), (ks, [0; 3], config), "nothing else moved");
    assert_eq!(after.config_policies, [fumpad::state::FeePolicy::default(); 8], "grown tail = standard policies");
    assert_eq!((after.config_coins, after.pending_config_policy), ([0; 8], fumpad::state::FeePolicy::default()));
    let c2 = env.launch(SOL / 10); // launches work again (Global loads) and count on slot 0
    assert_eq!(env.fetch::<Global>(&g).config_coins[0], 1);
    assert_eq!(env.coin(&c2).fee_policy_kind, fumpad::FEE_POLICY_STANDARD);
    // The old jobs keeper (attestor-1's key) keeps sampling right after the upgrade.
    ok(sample_as(&mut env, &k0, &[&c]));
    // Separate them: set_keepers can't keep the overlap; set_operators to a fresh key first.
    assert_fumpad_err(env.set_keepers(ks), FumpadError::KeeperOperatorOverlap);
    let ops = env.operator_keys();
    ok(env.set_operators(ops));
    let meta = ok(env.set_keepers(ks));
    assert_eq!(event::<fumpad::events::KeepersSet>(&meta).added_at, [0; 3], "bootstrap attestors keep no freeze");
    env.warp(30);
    assert_fumpad_err(sample_as(&mut env, &k0, &[&c]), FumpadError::Unauthorized);
    ok(env.sample(0, &[&c]));
    // Idempotent: a migrated Global stays as it is.
    let before = env.data(&g);
    let meta = ok(env.send(&[migrate_global_ix(&env, &kp_pk(&admin))], &[&admin]));
    assert!(events::<OperatorsSet>(&meta).is_empty());
    assert_eq!(env.data(&g), before);
}

// ── 2. DAMM v2 pool status ───────────────────────────────────────────────────────────────────────────────────────

/// D38: a DAMM v2 pool disabled by its operator is skipped by `record_samples` (no sample, no event, the rest of the
/// batch proceeds — fallback samplers too), refused by `execute_buyback` (`PoolDisabled`), and claims on the coin
/// wait: with no new samples the 30-min median loses coverage (`InsufficientSamples`) until the pool is re-enabled
/// and the window refills.
#[test]
fn disabled_damm_pool_is_never_sampled_bought_or_claimed() {
    let mut w = World::new();
    let other = w.env.launch(SOL / 10);
    w.env.skip_launch_window();
    w.env.graduate_coin(&other);
    let alice = w.user();
    let t = w.ticket(&kp_pk(&alice), 1_000 * M);
    w.ready();
    let c = TCoin { mint: w.c.mint, creator: w.c.creator.insecure_clone(), config: w.c.config, pool: w.c.pool };
    let pool = w.env.coin(&c).damm_pool;
    // Fund the coin's buyback balance (post-graduation DBC residual fees would be ~0): a launch-window-sized amount.
    let op = w.env.op();

    set_pool_status(&mut w.env, &pool, 1);
    w.env.warp(15);
    let len0 = w.env.fetch_zc::<Observations>(&c.observations()).len;
    let other_len0 = w.env.fetch_zc::<Observations>(&other.observations()).len;
    let meta = ok(w.env.sample(0, &[&c, &other]));
    let evs = events::<SampleRecorded>(&meta);
    assert_eq!(evs.len(), 1, "only the enabled coin is sampled");
    assert_eq!(evs[0].mint, other.mint);
    assert_eq!(w.env.fetch_zc::<Observations>(&c.observations()).len, len0);
    assert_eq!(w.env.fetch_zc::<Observations>(&other.observations()).len, other_len0 + 1);
    // A fallback sampler (no operator sample for > keeper_stale_secs) is skipped as well.
    w.env.warp(fumpad::DEFAULT_KEEPER_STALE_SECS + 1);
    let rando = w.env.new_user(1);
    let meta = ok(sample_as(&mut w.env, &rando, &[&c]));
    assert!(events::<SampleRecorded>(&meta).is_empty());
    assert_eq!(w.env.fetch_zc::<Observations>(&c.observations()).len, len0);
    // Buybacks refuse the frozen spot.
    assert_fumpad_err(w.env.buyback(&c, &op, SOL), FumpadError::PoolDisabled);
    // Claims wait: the window empties of samples.
    w.env.warp(1_800);
    assert_fumpad_err(w.claim(&alice, &t), FumpadError::InsufficientSamples);
    // Re-enabled → samples refill the window → the claim pays.
    set_pool_status(&mut w.env, &pool, 0);
    w.env.sample_for(&c, 1_800);
    ok(w.claim(&alice, &t));
}

// ── 3. D12 execution-price floor in attest_sell ──────────────────────────────────────────────────────────────────

/// D12: ticket price = max(execution, capped reference floor) ≥ execution = ⌊quote_gross × 2⁶⁴ / base_amount⌋ (the
/// engine's exact formula). One unit below → `TicketPriceBelowExecution`; exactly the execution price → accepted.
/// Also `quote_gross > 0`, `0 < ticket_tokens ≤ base_amount`.
#[test]
fn attest_sell_refuses_a_ticket_price_below_execution() {
    let mut env = Env::new();
    let c = env.launch(SOL / 10);
    env.skip_launch_window();
    env.warp(60);
    let alice = Pubkey::new_unique();
    let mut r = env.sell_record(&c, &alice, 1_000 * M, 1 << 50);
    r.base_amount = 3_000 * M;
    r.quote_gross = 1_234_567_891;
    let exec = fumpad::math::price_q64(r.quote_gross, r.base_amount).unwrap();
    r.ticket_price_q64 = exec - 1;
    assert_fumpad_err(env.attest_sell(&r, &[0, 1]), FumpadError::TicketPriceBelowExecution);
    // The 2-of-3 "tiny price" fabrication must now also fabricate a tiny quote_gross (the watcher compares both).
    r.ticket_price_q64 = 1;
    assert_fumpad_err(env.attest_sell(&r, &[0, 1]), FumpadError::TicketPriceBelowExecution);
    let mut z = r;
    z.quote_gross = 0;
    assert_fumpad_err(env.attest_sell(&z, &[0, 1]), FumpadError::InvalidTicketAmount);
    let mut z = r;
    z.ticket_tokens = z.base_amount + 1;
    z.ticket_price_q64 = exec;
    assert_fumpad_err(env.attest_sell(&z, &[0, 1]), FumpadError::InvalidTicketAmount);
    r.ticket_price_q64 = exec;
    let meta = ok(env.attest_sell(&r, &[0, 1]));
    assert_eq!(event::<TicketAttested>(&meta).sell_price_q64, exec);
    // Above execution (a D12 floor) is fine.
    let mut h = env.sell_record(&c, &alice, 1_000 * M, 1 << 50);
    h.ticket_price_q64 = fumpad::math::price_q64(h.quote_gross, h.base_amount).unwrap() * 3;
    ok(env.attest_sell(&h, &[1, 2]));
}

// ── 4a. partner fees of pools that never registered ─────────────────────────────────────────────────────────────

const DBC_PARTNER_QUOTE_FEE: usize = 272;

fn unregistered_fees_ix(env: &Env, c: &TCoin, caller: &Pubkey, treasury: &Pubkey) -> Instruction {
    ix(
        fumpad::accounts::ClaimUnregisteredFees {
            caller: *caller,
            global: env.global(),
            mint: c.mint,
            coin: c.coin_pda(),
            dbc_config: c.config,
            dbc_pool: c.pool,
            dbc_base_vault: c.base_vault(),
            dbc_quote_vault: c.quote_vault(),
            fee_claimer: env.fee_claimer(),
            fee_wsol: env.fee_wsol(),
            reward_vault: env.reward_vault(&c.mint),
            wsol_mint: WSOL,
            platform_treasury: *treasury,
            token_program: SPL_TOKEN,
            token_2022_program: TOKEN_2022,
            system_program: SYSTEM,
            dbc_pool_authority: m::DBC_POOL_AUTHORITY,
            dbc_event_authority: m::DBC_EVENT_AUTHORITY,
            dbc_program: meteora::DBC,
            event_authority: ev_auth(),
            program: fumpad::ID,
        },
        fumpad::instruction::ClaimUnregisteredFees {},
    )
}

/// A DBC pool on a FUMPAD config whose creator skipped `register_coin` (launch tx without it).
pub(crate) fn unregistered_pool(env: &mut Env, config: Pubkey) -> TCoin {
    let creator = env.new_user(1_000);
    let mint = Keypair::new();
    let mut ixs = env.launch_ixs(&config, &kp_pk(&creator), &kp_pk(&mint), 0);
    ixs.pop(); // no register_coin
    ok(env.send_as(&creator, &ixs, &[&creator, &mint]));
    let mint = kp_pk(&mint);
    TCoin { mint, creator, config, pool: meteora::dbc_pool_pda(&config, &mint) }
}

fn dbc_buy(env: &mut Env, c: &TCoin, user: &Keypair, lamports: u64, mode: u8) -> TransactionResult {
    let u = kp_pk(user);
    let mut ixs = meteora::wrap_sol_ixs(&u, lamports);
    ixs.push(meteora::create_ata_idempotent_ix(&u, &u, &c.mint, &TOKEN_2022));
    ixs.push(meteora::dbc_buy_ix(&c.config, &c.mint, &u, lamports, 0, mode, false));
    env.send_as(user, &ixs, &[user])
}

/// G4 (a): partner fees accrued on a pool that uses our config but never registered go to the platform treasury
/// (permissionless, no coin accounting); registered coins are refused (`PoolIsRegistered`, use `claim_fees`); the
/// treasury, pool, mint and config are pinned.
#[test]
fn unregistered_pool_fees_go_to_the_platform_treasury() {
    let mut env = Env::new();
    let config = env.config;
    let u = unregistered_pool(&mut env, config);
    let trader = env.new_user(100);
    ok(dbc_buy(&mut env, &u, &trader, 5 * SOL, 0));
    env.skip_launch_window();
    ok(dbc_buy(&mut env, &u, &trader, 5 * SOL, 0));
    let accrued = meteora::rd_u64(&env.data(&u.pool), DBC_PARTNER_QUOTE_FEE);
    assert!(accrued > 0);
    let caller = env.new_user(1);
    let (cp, treasury) = (kp_pk(&caller), kp_pk(&env.treasury));
    let create_vault = meteora::create_ata_idempotent_ix(&cp, &env.reward_pool(), &u.mint, &TOKEN_2022);
    // Pinned treasury.
    let mut bad = unregistered_fees_ix(&env, &u, &cp, &treasury);
    bad.accounts[12].pubkey = addr(&cp);
    assert_fumpad_err(env.send_as(&caller, &[create_vault.clone(), bad], &[&caller]), FumpadError::InvalidAccount);
    // Mint ≠ the pool's base mint (another unregistered pool's mint).
    let u2 = unregistered_pool(&mut env, config);
    let wrong = TCoin { mint: u2.mint, creator: u2.creator.insecure_clone(), config, pool: u.pool };
    let i = unregistered_fees_ix(&env, &wrong, &cp, &treasury);
    let cv2 = meteora::create_ata_idempotent_ix(&cp, &env.reward_pool(), &u2.mint, &TOKEN_2022);
    assert_fumpad_err(env.send_as(&caller, &[cv2, i], &[&caller]), FumpadError::WrongVenue);

    let t0 = env.lamports(&treasury);
    let c0 = env.lamports(&cp);
    let meta = ok(env.send_as(&caller, &[create_vault.clone(), unregistered_fees_ix(&env, &u, &cp, &treasury)], &[&caller]));
    println!("claim_unregistered_fees CU {}", meta.compute_units_consumed);
    let ev: UnregisteredFeesClaimed = event(&meta);
    assert_eq!((ev.mint, ev.dbc_pool, ev.dbc_config, ev.claimed, ev.platform_treasury), (u.mint, u.pool, config, accrued, treasury));
    assert_eq!(env.lamports(&treasury) - t0, accrued);
    let ata_rent = env.rent(170);
    assert!(c0 - env.lamports(&cp) <= meta.fee + ata_rent, "the caller pays only the tx fee (+ the vault ATA it created)");
    assert_eq!(env.lamports(&env.fee_claimer()), 0, "fee_claimer keeps nothing");
    assert!(!env.exists(&env.fee_wsol()));
    assert_eq!(meteora::rd_u64(&env.data(&u.pool), DBC_PARTNER_QUOTE_FEE), 0);
    // Nothing left.
    assert_fumpad_err(env.send_as(&caller, &[unregistered_fees_ix(&env, &u, &cp, &treasury)], &[&caller]), FumpadError::NothingToClaim);

    // A registered coin's fees are its own (claim_fees splits them; launch window → reward pool).
    let reg = env.launch(SOL / 10);
    let i = unregistered_fees_ix(&env, &reg, &cp, &treasury);
    assert_fumpad_err(env.send_as(&caller, &[i], &[&caller]), FumpadError::PoolIsRegistered);

    // A config with our fee claimer but not the FUMPAD shape (creator trading fee) → InvalidConfig.
    let mut p = meteora::mainnet_config_params();
    p.creator_trading_fee_percentage = 10;
    let odd = env.create_dbc_config(&p);
    let o = unregistered_pool(&mut env, odd);
    ok(dbc_buy(&mut env, &o, &trader, SOL, 0));
    let cvo = meteora::create_ata_idempotent_ix(&cp, &env.reward_pool(), &o.mint, &TOKEN_2022);
    let i = unregistered_fees_ix(&env, &o, &cp, &treasury);
    assert_fumpad_err(env.send_as(&caller, &[cvo, i], &[&caller]), FumpadError::InvalidConfig);
}

// ── 4b. DAMM v2 position farming rewards ────────────────────────────────────────────────────────────────────────

const POSITION_REWARD_INFOS: usize = 216;
const USER_REWARD_INFO_LEN: usize = 48;

fn reward_vault_pda(pool: &Pubkey, index: u8) -> Pubkey {
    Pubkey::find_program_address(&[b"reward_vault", pool.as_ref(), &[index]], &meteora::DAMM).0
}

/// Initialize reward slot `index` of `pool` (as DAMM's admin would) with `vault` and no emission (rate 0).
fn write_reward_slot(env: &mut Env, pool: &Pubkey, index: usize, mint: &Pubkey, vault: &Pubkey, token_flag: u8) {
    let mut acc = env.svm.get_account(&addr(pool)).unwrap();
    let o = m::DAMM_POOL_REWARD_INFOS + index * m::DAMM_REWARD_INFO_LEN;
    let d = &mut acc.data;
    d[o..o + m::DAMM_REWARD_INFO_LEN].fill(0);
    d[o] = 1; // initialized
    d[o + 1] = token_flag;
    d[o + 16..o + 48].copy_from_slice(mint.as_ref());
    d[o + 48..o + 80].copy_from_slice(vault.as_ref());
    d[o + 80..o + 112].copy_from_slice(Pubkey::new_unique().as_ref()); // funder
    d[o + 112..o + 120].copy_from_slice(&86_400u64.to_le_bytes()); // reward_duration
    let now = env.now() as u64;
    d[o + 120..o + 128].copy_from_slice(&(now + 86_400).to_le_bytes()); // reward_duration_end
    d[o + 176..o + 184].copy_from_slice(&now.to_le_bytes()); // last_update_time
    env.svm.set_account(addr(pool), acc).unwrap();
}

/// Accrued (pending) rewards of `position` in slot `index`.
fn write_pending_reward(env: &mut Env, position: &Pubkey, index: usize, amount: u64) {
    let mut acc = env.svm.get_account(&addr(position)).unwrap();
    let o = POSITION_REWARD_INFOS + index * USER_REWARD_INFO_LEN + 32;
    acc.data[o..o + 8].copy_from_slice(&amount.to_le_bytes());
    env.svm.set_account(addr(position), acc).unwrap();
}

/// A copy of token account `src` at address `dst` (same owner program, data and lamports).
fn clone_account(env: &mut Env, src: &Pubkey, dst: &Pubkey) {
    let acc = env.svm.get_account(&addr(src)).unwrap();
    env.svm.set_account(addr(dst), acc).unwrap();
}

/// SPL Token native (WSOL) account owned by `owner` holding `amount`.
fn native_wsol_account(env: &mut Env, key: &Pubkey, owner: &Pubkey, amount: u64) {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(WSOL.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1; // initialized
    let rent = env.rent(165);
    d[109..113].copy_from_slice(&1u32.to_le_bytes()); // is_native = Some(rent)
    d[113..121].copy_from_slice(&rent.to_le_bytes());
    env.svm
        .set_account(addr(key), Account { lamports: rent + amount, data: d, owner: addr(&SPL_TOKEN), executable: false, rent_epoch: 0 })
        .unwrap();
}

#[allow(clippy::too_many_arguments)]
fn claim_rewards_ix(
    env: &Env,
    c: &TCoin,
    pool: &Pubkey,
    nft: &Pubkey,
    index: u8,
    reward_mint: &Pubkey,
    reward_vault: &Pubkey,
    destination: &Pubkey,
    token_program: &Pubkey,
) -> Instruction {
    ix(
        fumpad::accounts::ClaimPositionRewards {
            caller: kp_pk(&env.payer),
            global: env.global(),
            coin: c.coin_pda(),
            mint: c.mint,
            damm_pool: *pool,
            damm_position: meteora::damm_position(nft),
            position_nft_account: meteora::damm_position_nft_account(nft),
            damm_reward_vault: *reward_vault,
            reward_mint: *reward_mint,
            destination: *destination,
            fee_claimer: env.fee_claimer(),
            reward_token_program: *token_program,
            damm_pool_authority: m::DAMM_POOL_AUTHORITY,
            damm_event_authority: m::DAMM_EVENT_AUTHORITY,
            damm_program: meteora::DAMM,
            event_authority: ev_auth(),
            program: fumpad::ID,
        },
        fumpad::instruction::ClaimPositionRewards { reward_index: index },
    )
}

/// SPL Token-2022 `transfer_checked`.
fn t22_transfer_ix(src: &Pubkey, mint: &Pubkey, dst: &Pubkey, owner: &Pubkey, amount: u64) -> Instruction {
    let mut data = vec![12u8];
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(fumpad::TOKEN_DECIMALS);
    raw_ix(&TOKEN_2022, &[rw(*src), ro(*mint), rw(*dst), sg(*owner)], data)
}

/// G4 (b): DAMM v2 farming rewards accrued to our locked position are claimable by anyone: rewards in the coin's own
/// mint land in the coin's reward vault (they add to the reward pool), any other mint in the platform treasury's ATA.
/// Destination, slot, vault, token program and the position's pool are pinned.
#[test]
fn position_farming_rewards_go_to_the_reward_pool_or_treasury() {
    let mut env = Env::new();
    let c = env.launch(SOL / 10);
    env.skip_launch_window();
    let nft = env.graduate_coin(&c);
    let pool = c.damm_pool();
    let treasury = kp_pk(&env.treasury);
    let reward_vault = env.reward_vault(&c.mint);

    // Slot 0: rewards in the coin's own mint. Its DAMM vault = a Token-2022 account of the DAMM pool authority.
    let funder = env.new_user(100);
    ok(env.direct_buy(&c, &funder, 5 * SOL));
    let f = kp_pk(&funder);
    let amount0 = env.base_balance(&f, &c.mint) / 2;
    let staging = base_ata(&m::DAMM_POOL_AUTHORITY, &c.mint);
    let fund = vec![
        meteora::create_ata_idempotent_ix(&f, &m::DAMM_POOL_AUTHORITY, &c.mint, &TOKEN_2022),
        t22_transfer_ix(&base_ata(&f, &c.mint), &c.mint, &staging, &f, amount0),
    ];
    ok(env.send_as(&funder, &fund, &[&funder]));
    let vault0 = reward_vault_pda(&pool, 0);
    clone_account(&mut env, &staging, &vault0);
    // Uninitialized slot → refused.
    let i = claim_rewards_ix(&env, &c, &pool, &nft, 0, &c.mint, &vault0, &reward_vault, &TOKEN_2022);
    assert_fumpad_err(env.send(&[i], &[]), FumpadError::WrongVenue);
    write_reward_slot(&mut env, &pool, 0, &c.mint, &vault0, 1);
    write_pending_reward(&mut env, &meteora::damm_position(&nft), 0, amount0);

    // Pinned destination: not the caller's (or anyone else's) account.
    let p = kp_pk(&env.payer);
    ok(env.send(&[meteora::create_ata_idempotent_ix(&p, &p, &c.mint, &TOKEN_2022)], &[]));
    let i = claim_rewards_ix(&env, &c, &pool, &nft, 0, &c.mint, &vault0, &base_ata(&p, &c.mint), &TOKEN_2022);
    assert_fumpad_err(env.send(&[i], &[]), FumpadError::InvalidAccount);
    // Wrong token program / slot index / vault.
    let i = claim_rewards_ix(&env, &c, &pool, &nft, 0, &c.mint, &vault0, &reward_vault, &SPL_TOKEN);
    assert_fumpad_err(env.send(&[i], &[]), FumpadError::WrongVenue);
    let i = claim_rewards_ix(&env, &c, &pool, &nft, 2, &c.mint, &vault0, &reward_vault, &TOKEN_2022);
    assert_fumpad_err(env.send(&[i], &[]), FumpadError::WrongVenue);
    let i = claim_rewards_ix(&env, &c, &pool, &nft, 0, &c.mint, &staging, &reward_vault, &TOKEN_2022);
    assert_fumpad_err(env.send(&[i], &[]), FumpadError::WrongVenue);
    // Another coin's position under this coin.
    let other = env.launch(SOL / 10);
    env.skip_launch_window();
    let other_nft = env.graduate_coin(&other);
    let i = claim_rewards_ix(&env, &c, &pool, &other_nft, 0, &c.mint, &vault0, &reward_vault, &TOKEN_2022);
    assert_fumpad_err(env.send(&[i], &[]), FumpadError::WrongVenue);
    // A curve coin has no DAMM pool yet (`coin.damm_pool` is the default key, which can't even be passed writable).
    let curve = env.launch(SOL / 10);
    let i = claim_rewards_ix(&env, &curve, &Pubkey::default(), &nft, 0, &c.mint, &vault0, &reward_vault, &TOKEN_2022);
    assert!(env.send(&[i], &[]).is_err());

    let before = env.token_balance(&reward_vault);
    let meta = ok(env.send(&[claim_rewards_ix(&env, &c, &pool, &nft, 0, &c.mint, &vault0, &reward_vault, &TOKEN_2022)], &[]));
    println!("claim_position_rewards (Token-2022, coin mint) CU {}", meta.compute_units_consumed);
    let ev: PositionRewardClaimed = event(&meta);
    assert_eq!((ev.mint, ev.reward_index, ev.reward_mint, ev.destination, ev.amount, ev.to_reward_pool), (c.mint, 0, c.mint, reward_vault, amount0, true));
    assert_eq!(env.token_balance(&reward_vault) - before, amount0, "the rewards joined the coin's reward pool");
    assert_eq!(env.token_balance(&vault0), 0);
    // Nothing pending any more.
    let i = claim_rewards_ix(&env, &c, &pool, &nft, 0, &c.mint, &vault0, &reward_vault, &TOKEN_2022);
    assert_fumpad_err(env.send(&[i], &[]), FumpadError::NothingToClaim);

    // Slot 1: rewards in another mint (WSOL, SPL Token) → the platform treasury's ATA (created by the caller).
    let amount1 = 3 * SOL;
    let vault1 = reward_vault_pda(&pool, 1);
    native_wsol_account(&mut env, &vault1, &m::DAMM_POOL_AUTHORITY, amount1);
    write_reward_slot(&mut env, &pool, 1, &WSOL, &vault1, 0);
    write_pending_reward(&mut env, &meteora::damm_position(&nft), 1, amount1);
    let dest = wsol_ata(&treasury);
    // The coin's reward vault is not a valid destination for a foreign mint.
    let i = claim_rewards_ix(&env, &c, &pool, &nft, 1, &WSOL, &vault1, &reward_vault, &SPL_TOKEN);
    assert_fumpad_err(env.send(&[i], &[]), FumpadError::InvalidAccount);
    let create = meteora::create_ata_idempotent_ix(&p, &treasury, &WSOL, &SPL_TOKEN);
    let meta = ok(env.send(&[create, claim_rewards_ix(&env, &c, &pool, &nft, 1, &WSOL, &vault1, &dest, &SPL_TOKEN)], &[]));
    println!("claim_position_rewards (SPL WSOL, + treasury ATA create) CU {}", meta.compute_units_consumed);
    let ev: PositionRewardClaimed = event(&meta);
    assert_eq!((ev.reward_index, ev.reward_mint, ev.destination, ev.amount, ev.to_reward_pool), (1, WSOL, dest, amount1, false));
    assert_eq!(env.token_balance(&dest), amount1);
    assert_eq!(env.lamports(&env.fee_claimer()), 0);
    env.assert_coin_invariant(&c);
}

// ── error paths the suite didn't assert before (TEST-COVERAGE §4.1) ──────────────────────────────────────────────

/// `NoPendingConfig`: execute / cancel with no queued allow-list change.
#[test]
fn error_no_pending_config() {
    let mut env = Env::new();
    // Nothing pending: `pending_config` is the default key.
    assert_fumpad_err(env.execute_config(Pubkey::default()), FumpadError::NoPendingConfig);
    let admin = env.admin.insecure_clone();
    let i = ix(
        fumpad::accounts::GuardianOrAdmin { authority: kp_pk(&admin), global: env.global(), event_authority: ev_auth(), program: fumpad::ID },
        fumpad::instruction::CancelConfig {},
    );
    assert_fumpad_err(env.send(&[i], &[&admin]), FumpadError::NoPendingConfig);
}

/// `PoolNotFresh`: a pool on our config whose curve already completed can't be registered afterwards.
#[test]
fn error_pool_not_fresh() {
    let mut env = Env::new();
    let config = env.config;
    let u = unregistered_pool(&mut env, config);
    env.skip_launch_window();
    let whale = env.new_user(1_000);
    ok(dbc_buy(&mut env, &u, &whale, 100 * SOL, m::SWAP_MODE_PARTIAL_FILL));
    assert!(meteora::rd_u64(&env.data(&u.pool), m::DBC_POOL_QUOTE_RESERVE) >= meteora::MAINNET_THRESHOLD);
    let i = env.register_coin_ix(&config, &u.pool, &kp_pk(&u.creator), &u.mint);
    let creator = u.creator.insecure_clone();
    assert_fumpad_err(env.send_as(&creator, &[i], &[&creator]), FumpadError::PoolNotFresh);
}

/// `NothingToBuyBack`: every guard passes but the spend is 0 (`max_in = 0`).
#[test]
fn error_nothing_to_buy_back() {
    let mut env = Env::new();
    let c = env.launch(SOL / 10);
    let sniper = env.new_user(100);
    ok(env.direct_buy(&c, &sniper, 2 * SOL));
    env.skip_launch_window();
    ok(env.claim_fees(&c));
    env.pregrad_warmup(&c);
    let op = env.op();
    assert_fumpad_err(env.buyback(&c, &op, 0), FumpadError::NothingToBuyBack);
    ok(env.buyback(&c, &op, SOL / 100));
}

/// `NoEscrow`: `withdraw_escrow` needs an `Escrowed` ticket. An escrow account only exists while its ticket is
/// `Escrowed` (created with the status, closed by the withdrawal), so this is defense in depth: the ticket's status is
/// rewound on purpose here.
#[test]
fn error_no_escrow() {
    let mut w = World::new();
    let alice = w.user();
    let t = w.ticket(&kp_pk(&alice), 1_000 * M);
    w.ready();
    w.remove_ata(&kp_pk(&alice));
    ok(w.claim_for(0, &t));
    assert_eq!(w.t(&t).status, fumpad::state::TicketStatus::Escrowed);
    let mut acc = w.env.svm.get_account(&addr(&t)).unwrap();
    let mut tk = fumpad::state::Ticket::try_deserialize(&mut acc.data.as_slice()).unwrap();
    tk.status = fumpad::state::TicketStatus::Open;
    let mut data: Vec<u8> = vec![];
    tk.try_serialize(&mut data).unwrap();
    acc.data[..data.len()].copy_from_slice(&data);
    w.env.svm.set_account(addr(&t), acc).unwrap();
    let p = kp_pk(&alice);
    ok(w.env.send_as(&alice, &[meteora::create_ata_idempotent_ix(&p, &p, &w.c.mint, &TOKEN_2022)], &[&alice]));
    let dest = base_ata(&p, &w.c.mint);
    assert_fumpad_err(w.withdraw_escrow(&alice, &t, &dest), FumpadError::NoEscrow);
}

/// `LamportInvariant`: if a Coin's ledgers ever claimed more lamports than the account holds, withdrawals refuse
/// instead of paying out tracked funds (the state is corrupted on purpose here; no instruction path produces it).
#[test]
fn error_lamport_invariant_guards_withdrawals() {
    let mut env = Env::new();
    let c = env.launch(SOL / 10);
    env.skip_launch_window();
    ok(env.claim_fees(&c));
    let alice = env.new_user(100);
    ok(env.router_buy(&c, &alice, 20 * SOL));
    ok(env.claim_fees(&c));
    let k = c.coin_pda();
    let mut acc = env.svm.get_account(&addr(&k)).unwrap();
    let mut coin = Coin::try_deserialize(&mut acc.data.as_slice()).unwrap();
    assert!(coin.platform_fees_unclaimed > 0);
    coin.buyback_lamports += 1; // one lamport more tracked than held
    let mut data: Vec<u8> = vec![];
    coin.try_serialize(&mut data).unwrap();
    acc.data[..data.len()].copy_from_slice(&data);
    env.svm.set_account(addr(&k), acc).unwrap();
    let p = ix(
        fumpad::accounts::WithdrawPlatformFees {
            caller: kp_pk(&env.payer),
            global: env.global(),
            coin: k,
            platform_treasury: kp_pk(&env.treasury),
            event_authority: ev_auth(),
            program: fumpad::ID,
        },
        fumpad::instruction::WithdrawPlatformFees {},
    );
    assert_fumpad_err(env.send(&[p], &[]), FumpadError::LamportInvariant);
}

/// `MathOverflow`: an attested `pyth_publish_time` that makes `block_time − publish_time` overflow i64.
#[test]
fn error_math_overflow_in_attested_times() {
    let mut env = Env::new();
    let c = env.launch(SOL / 10);
    env.skip_launch_window();
    env.warp(60);
    let mut r = env.sell_record(&c, &Pubkey::new_unique(), 1_000 * M, 1 << 50);
    r.pyth_publish_time = i64::MIN;
    assert_fumpad_err(env.attest_sell(&r, &[0, 1]), FumpadError::MathOverflow);
}

/// `SlippageExceeded`: a router trade that moves nothing on one side (a dust sell worth 0 lamports) is refused
/// instead of being recorded as a trade.
#[test]
fn error_router_trade_that_moves_nothing() {
    let mut env = Env::new();
    let c = env.launch(SOL / 10);
    env.skip_launch_window();
    let alice = env.new_user(100);
    ok(env.router_buy(&c, &alice, SOL));
    assert_fumpad_err(env.router_sell(&c, &alice, 1), FumpadError::SlippageExceeded);
}
