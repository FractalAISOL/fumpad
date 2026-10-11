//! D11 — the immutable LP locker (`programs/fumpad_lp_locker`) on a real graduated coin and
//! the real PumpSwap program: principal (√k per LP × LP held at lock) is never touched by
//! skims, whatever happens in the pool — third-party deposits/withdrawals/burns, big swaps
//! both ways by non-FUMPAD traders, donations, repeated skims, price moves — and skimmed
//! fees land in the coin's reward vault (base) and, via `settle_lp_fees`, 60/40 in the
//! platform/creator fee counters (SOL).

use anchor_lang::prelude::{AccountMeta as Meta, Pubkey};
use fumpad::{error::FumpadError, events::LpFeesSettled, external::pumpswap::WSOL_MINT, PUMPSWAP_PROGRAM_ID};
use fumpad_lp_locker::{LockerError, Skimmed, MIN_SKIM_LP};
use litesvm::types::TransactionMetadata;
use solana_keypair::Keypair;

use crate::flow::*;
use crate::*;

const M: u64 = 1_000_000; // one token

// ── helpers ──────────────────────────────────────────────────────────────────

/// Graduated coin with observations/queue set up. Returns (flow, whale holding ~550M).
fn graduated() -> (Flow, Keypair) {
    let mut f = Flow::new();
    let whale = f.env.new_user(10_000);
    ok(f.buy(&whale, 200 * SOL));
    ok(f.graduate());
    f.post_graduation_setup();
    (f, whale)
}

fn skimmed(m: &TransactionMetadata) -> Skimmed {
    let mut v = locker_events::<Skimmed>(m);
    assert_eq!(v.len(), 1);
    v.remove(0)
}

#[track_caller]
fn assert_principal_intact(f: &Flow) {
    let (p, v) = (f.lp_principal(), f.locked_value());
    assert!(v >= p * (1.0 - 1e-12), "locked value {v} < principal {p}");
    let (s, l) = f.sqrt_k();
    // Not the post-skim guarantee (that one has the 2⁻²⁰ margin) — just "≥ principal up to
    // the √-rounding of one unit".
    assert!(v + (f.locked_lp() as f64 / l as f64) >= p, "{s} {l}");
}

fn transfer_tokens_ix(f: &Flow, from: &Pubkey, to: &Pubkey, amount: u64) -> solana_instruction::Instruction {
    let mut data = vec![12u8];
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(fumpad::TOKEN_DECIMALS);
    raw_ix(T22, vec![w(ata(from, &f.mint, &T22)), r(f.mint), w(*to), Meta::new(*from, true)], data)
}

/// Non-FUMPAD traffic (e.g. Jupiter routing straight to PumpSwap): `n` round trips of
/// `sol` each — buy with WSOL, sell every token bought.
fn outside_round_trips(f: &mut Flow, trader: &Keypair, n: usize, sol: u64) {
    let t = kp_pk(trader);
    let i = create_ata_ix(&t, &t, &f.mint, &T22);
    ok(f.env.send_as(trader, &[i], &[trader]));
    for _ in 0..n {
        let before = f.tokens(&t);
        let i = f.direct_buy_ix(&t, sol, true);
        ok(f.env.send_as(trader, &[cu_limit(400_000), i], &[trader]));
        let got = f.tokens(&t) - before;
        let i = f.direct_sell_ix(&t, got);
        ok(f.env.send_as(trader, &[cu_limit(400_000), i], &[trader]));
        f.env.warp(1);
    }
}

/// A third-party LP: base tokens from the whale, 5,000 SOL wrapped, LP ATA created.
fn third_party_lp(f: &mut Flow, whale: &Keypair, tokens: u64) -> Keypair {
    let lp = f.env.new_user(10);
    let k = kp_pk(&lp);
    let lp_mint = f.lp_mint();
    let ixs = [create_ata_ix(&k, &k, &f.mint, &T22), create_ata_ix(&k, &k, &lp_mint, &T22)];
    ok(f.env.send_as(&lp, &ixs, &[&lp]));
    let i = transfer_tokens_ix(f, &kp_pk(whale), &ata(&k, &f.mint, &T22), tokens);
    ok(f.env.send_as(whale, &[i], &[whale]));
    put_token_account(&mut f.env, ata(&k, &WSOL_MINT, &TOKEN), WSOL_MINT, k, 5_000 * SOL, TOKEN);
    lp
}

fn lp_ix(f: &Flow, user: &Pubkey, disc: [u8; 8], lp: u64, a: u64, b: u64) -> solana_instruction::Instruction {
    let mut data = disc.to_vec();
    for v in [lp, a, b] {
        data.extend_from_slice(&v.to_le_bytes());
    }
    let mut metas =
        f.liquidity_metas(*user, ata(user, &f.mint, &T22), ata(user, &WSOL_MINT, &TOKEN), ata(user, &f.lp_mint(), &T22));
    metas[2] = Meta::new_readonly(*user, true);
    raw_ix(PUMPSWAP_PROGRAM_ID, metas, data)
}

fn deposit(f: &mut Flow, who: &Keypair, lp_out: u64) {
    let i = lp_ix(f, &kp_pk(who), [242, 35, 198, 137, 82, 225, 242, 182], lp_out, u64::MAX, u64::MAX);
    ok(f.env.send_as(who, &[cu_limit(400_000), i], &[who]));
}

fn withdraw(f: &mut Flow, who: &Keypair, lp_in: u64) {
    let i = lp_ix(f, &kp_pk(who), [183, 18, 70, 156, 148, 109, 161, 34], lp_in, 0, 0);
    ok(f.env.send_as(who, &[cu_limit(400_000), i], &[who]));
}

fn lp_balance(f: &Flow, who: &Keypair) -> u64 {
    token_balance(&f.env, &ata(&kp_pk(who), &f.lp_mint(), &T22))
}

fn nothing_to_skim(f: &mut Flow) {
    expect_custom(f.skim(), locker_code(LockerError::NothingToSkim));
}

// ═════════════════════════════════════════════════════════════════════════════

/// Fresh lock: nothing to skim; the principal is exactly what graduation deposited.
#[test]
fn fresh_lock_has_nothing_to_skim() {
    let (mut f, _) = graduated();
    let l = f.lock_state();
    assert_eq!(l.lp_locked, f.locked_lp());
    assert_eq!(f.env.lamports(&f.lp_fee_wsol()), 0);
    let (s, lp_supply) = f.sqrt_k();
    assert_eq!(lp_supply, l.lp_supply_at_lock);
    // P = held · ⌈√k⌉ / L ≥ held · √k / L.
    assert!(l.principal_num >= l.lp_locked as u128 * s);
    nothing_to_skim(&mut f);
    // FUMPAD's own router traffic is ordinary PumpSwap volume too, but a little of it isn't
    // enough to clear the dust threshold… (one tiny round trip)
    let t = f.env.new_user(10);
    ok(f.swap_buy(&t, SOL / 100));
    nothing_to_skim(&mut f);
    assert_eq!((f.lock_state().lp_skimmed, f.locked_lp()), (0, l.lp_locked));
}

/// The headline flow: non-FUMPAD traders (Jupiter-style, straight to PumpSwap) trade both
/// ways → skim withdraws only the fee growth (base → reward vault, WSOL → ATA(coin, WSOL))
/// → settle credits 60/40 → principal intact; an immediate second skim finds nothing.
#[test]
fn outside_volume_is_skimmed_and_settled_principal_intact() {
    let (mut f, _) = graduated();
    let trader = f.env.new_user(10);
    let p0 = f.lp_principal();
    let v0 = f.locked_value();
    outside_round_trips(&mut f, &trader, 10, 50 * SOL);
    let v1 = f.locked_value();
    assert!(v1 > v0 * 1.002, "LP fees grew the locked value: {v0} → {v1}");

    let reward0 = f.pool_tokens();
    let (base_pool, lp_supply) = (token_balance(&f.env, &f.pool_base), f.lp_supply());
    let held0 = f.locked_lp();
    let m = ok(f.skim());
    println!("CU: skim = {}", m.compute_units_consumed);
    let ev = skimmed(&m);
    assert_eq!(ev.lp_held, f.locked_lp());
    assert_eq!(held0 - ev.lp_withdrawn, ev.lp_held);
    assert!(ev.base_out > 0 && ev.quote_out > 0);
    // PumpSwap pays withdraws pro rata to Pool.lp_supply (the locker's denominator).
    assert_eq!(ev.base_out as u128, ev.lp_withdrawn as u128 * base_pool as u128 / lp_supply as u128);
    assert_eq!(f.pool_tokens(), reward0 + ev.base_out, "base → reward vault");
    assert_eq!(token_balance(&f.env, &f.lp_fee_wsol()), ev.quote_out, "WSOL → ATA(coin, WSOL)");
    // Principal intact, and the skim took (almost) all of the growth: what's left is the
    // principal plus the 2⁻²⁰ margin.
    assert_principal_intact(&f);
    let v2 = f.locked_value();
    assert!(v2 <= p0 * (1.0 + 3e-6), "left {v2} vs principal {p0}");
    // Skimmed share of the position ≈ the value growth.
    let skim_frac = ev.lp_withdrawn as f64 / held0 as f64;
    assert!((skim_frac - (1.0 - p0 / v1)).abs() < 1e-5, "{skim_frac} vs {}", 1.0 - p0 / v1);
    let lock = f.lock_state();
    assert_eq!((lock.lp_skimmed, lock.base_skimmed, lock.quote_skimmed), (ev.lp_withdrawn, ev.base_out, ev.quote_out));
    nothing_to_skim(&mut f);

    // Settle: unwrap and credit 60% platform / 40% creator; the cranker keeps the rent.
    let c0 = f.coin_state();
    let payer = kp_pk(&f.env.payer);
    let payer0 = f.env.lamports(&payer);
    let rent = f.env.lamports(&f.lp_fee_wsol()) - ev.quote_out;
    let m = ok(f.settle_lp_fees());
    println!("CU: settle_lp_fees = {}", m.compute_units_consumed);
    let s = &events::<LpFeesSettled>(&m)[0];
    assert_eq!(s.lamports, ev.quote_out);
    assert_eq!(s.platform, ev.quote_out * 6 / 10);
    assert_eq!(s.platform + s.creator, ev.quote_out);
    let c1 = f.coin_state();
    assert_eq!(c1.platform_fees_unclaimed, c0.platform_fees_unclaimed + s.platform);
    assert_eq!(c1.creator_fees_unclaimed, c0.creator_fees_unclaimed + s.creator);
    assert_eq!(c1.buyback_lamports, c0.buyback_lamports);
    f.assert_invariant();
    assert_eq!(f.env.lamports(&f.lp_fee_wsol()), 0, "ATA closed");
    assert_eq!(f.env.lamports(&payer), payer0 + rent - 5_000, "cranker keeps the rent (minus tx fee)");
    // Nothing left to settle (ATA gone); a later skim re-creates the ATA.
    assert!(f.settle_lp_fees().is_err());
    outside_round_trips(&mut f, &trader, 5, 50 * SOL);
    ok(f.skim());
    ok(f.settle_lp_fees());
    assert_principal_intact(&f);
    f.assert_invariant();
}

/// Third-party LPs deposit (doubling the pool), trade fees accrue to everyone, the third
/// party withdraws everything, burns aside — skims only ever take the locker's own growth.
#[test]
fn third_party_deposits_and_withdrawals_never_expose_principal() {
    let (mut f, whale) = graduated();
    let trader = f.env.new_user(10);
    let lp = third_party_lp(&mut f, &whale, 300_000_000 * M);
    let p0 = f.lp_principal();
    // Deposit as many LP as the locker holds: the pool doubles; r unchanged (ceil rounding
    // favours the pool) → nothing to skim.
    let held = f.locked_lp();
    deposit(&mut f, &lp, held);
    assert_eq!(lp_balance(&f, &lp), held);
    nothing_to_skim(&mut f);
    assert_principal_intact(&f);
    // Fees accrue pro rata to both LPs; the locker skims only its share.
    outside_round_trips(&mut f, &trader, 10, 50 * SOL);
    let v_before = f.locked_value();
    let m = ok(f.skim());
    let ev = skimmed(&m);
    assert!(ev.lp_withdrawn > 0);
    assert_principal_intact(&f);
    assert!(f.locked_value() <= p0 * (1.0 + 3e-6) && v_before > p0);
    // The third party's LP is untouched and still worth its deposit plus its fee share.
    assert_eq!(lp_balance(&f, &lp), held);
    // Third party withdraws half, then everything: nothing to skim either time.
    withdraw(&mut f, &lp, held / 2);
    nothing_to_skim(&mut f);
    withdraw(&mut f, &lp, held - held / 2);
    nothing_to_skim(&mut f);
    assert_principal_intact(&f);
    assert_eq!(f.lp_supply() as u128, f.lock_state().lp_supply_at_lock as u128 - ev.lp_withdrawn as u128);
}

/// A third party burns LP directly: Pool.lp_supply ignores it (the burned share stays in
/// the pool, owned by no one), so the locker's per-LP value doesn't jump and nothing is
/// skimmed. Using the mint supply instead would have let the locker withdraw principal.
#[test]
fn direct_lp_burns_do_not_inflate_value() {
    let (mut f, whale) = graduated();
    let lp = third_party_lp(&mut f, &whale, 300_000_000 * M);
    let held = f.locked_lp();
    deposit(&mut f, &lp, held / 2);
    let supply_before = f.lp_supply();
    let lp_mint = f.lp_mint();
    let mut data = vec![8u8]; // Token-2022 Burn
    data.extend_from_slice(&(held / 2).to_le_bytes());
    let k = kp_pk(&lp);
    let burn = raw_ix(T22, vec![w(ata(&k, &lp_mint, &T22)), w(lp_mint), Meta::new(k, true)], data);
    ok(f.env.send_as(&lp, &[burn], &[&lp]));
    assert_eq!(f.lp_supply(), supply_before, "lp_supply ignores direct burns");
    let mint_supply = u64::from_le_bytes(f.env.account(&lp_mint).unwrap().data[36..44].try_into().unwrap());
    assert_eq!(mint_supply, held);
    // With the mint supply as denominator the locker would look 50% richer:
    let (s, _) = f.sqrt_k();
    assert!((held as f64 * s as f64 / mint_supply as f64) > f.lp_principal() * 1.4);
    nothing_to_skim(&mut f);
    assert_principal_intact(&f);
}

/// Donations straight into the pool vaults are fee growth like any other: skimmed, and
/// the principal stays. (A one-sided donation is captured in √k units, i.e. withdrawn at
/// the pool's ratio: ≈ half of its value comes back as the other token.)
#[test]
fn donations_are_skimmed_principal_stays() {
    let (mut f, whale) = graduated();
    let donor = f.env.new_user(10);
    let d = kp_pk(&donor);
    let p0 = f.lp_principal();
    // 1 SOL of WSOL into the quote vault…
    put_token_account(&mut f.env, ata(&d, &WSOL_MINT, &TOKEN), WSOL_MINT, d, SOL, TOKEN);
    let mut data = vec![3u8]; // SPL Token Transfer
    data.extend_from_slice(&SOL.to_le_bytes());
    let i = raw_ix(TOKEN, vec![w(ata(&d, &WSOL_MINT, &TOKEN)), w(f.pool_quote), Meta::new(d, true)], data);
    ok(f.env.send_as(&donor, &[i], &[&donor]));
    // … and 1M tokens into the base vault.
    let i = transfer_tokens_ix(&f, &kp_pk(&whale), &f.pool_base, 1_000_000 * M);
    ok(f.env.send_as(&whale, &[i], &[&whale]));
    let m = ok(f.skim());
    let ev = skimmed(&m);
    // ≈ the full value of both donations (at spot), minus the share of PumpSwap's locked
    // minimum LP and second-order √ effects.
    let spot = f.spot_q64();
    let value = |sol: u64, tokens: u64| sol as u128 + ((tokens as u128 * spot) >> 64);
    let (donated, got) = (value(SOL, 1_000_000 * M), value(ev.quote_out, ev.base_out));
    assert!(got * 1_000 <= donated * 1_002 && got * 1_000 >= donated * 995, "skimmed {got} of {donated}");
    assert_principal_intact(&f);
    assert!(f.locked_value() <= p0 * (1.0 + 3e-6));
    nothing_to_skim(&mut f);
}

/// Repeated skims while the price moves far both ways (non-FUMPAD whales pumping and
/// dumping, FUMPAD router trades in between): every skim leaves the principal intact, a
/// skim right after a skim finds nothing, and the total withdrawn tracks the fee growth.
#[test]
fn repeated_skims_across_big_price_moves() {
    let (mut f, whale) = graduated();
    let wk = kp_pk(&whale);
    let trader = f.env.new_user(1_000);
    let tk = kp_pk(&trader);
    ok(f.env.send_as(&trader, &[create_ata_ix(&tk, &tk, &f.mint, &T22)], &[&trader]));
    let p0 = f.lp_principal();
    let spot0 = f.spot_q64();
    let mut skims = 0;
    for round in 0..6 {
        match round % 3 {
            // Pump ~4x with a big outside buy, skim at the high.
            0 => {
                let i = f.direct_buy_ix(&kp_pk(&trader), 85 * SOL, true);
                ok(f.env.send_as(&trader, &[cu_limit(400_000), i], &[&trader]));
                assert!(f.spot_q64() > spot0 * 3);
            }
            // Dump below the start with the whale's tokens (outside FUMPAD), skim at the low.
            1 => {
                let t = f.tokens(&kp_pk(&trader));
                let i = f.direct_sell_ix(&kp_pk(&trader), t);
                ok(f.env.send_as(&trader, &[cu_limit(400_000), i], &[&trader]));
                let i = f.direct_sell_ix(&wk, 150_000_000 * M);
                ok(f.env.send_as(&whale, &[cu_limit(400_000), i], &[&whale]));
                assert!(f.spot_q64() < spot0);
            }
            // Back up with FUMPAD router buys (also PumpSwap volume).
            _ => {
                ok(f.swap_buy(&trader, 30 * SOL));
                outside_round_trips(&mut f, &trader, 3, 20 * SOL);
            }
        }
        match f.skim() {
            Ok(m) => {
                skims += 1;
                assert!(skimmed(&m).lp_withdrawn >= MIN_SKIM_LP);
                nothing_to_skim(&mut f);
            }
            Err(e) => assert!(format!("{:?}", e.err).contains(&format!("Custom({})", locker_code(LockerError::NothingToSkim)))),
        }
        assert_principal_intact(&f);
        assert!(f.locked_value() >= p0);
        f.env.warp(30);
    }
    assert!(skims >= 4, "only {skims} skims");
    let l = f.lock_state();
    assert_eq!(l.lp_locked - l.lp_skimmed, f.locked_lp());
    assert!(f.locked_value() <= p0 * (1.0 + 3e-6));
    ok(f.settle_lp_fees());
    f.assert_invariant();
}

/// Every account `skim` trusts is pinned; nothing the caller passes can redirect the
/// proceeds or the LP. No skim variant moves LP if it doesn't go through.
#[test]
fn skim_rejects_bad_accounts() {
    let (mut f, whale) = graduated();
    let trader = f.env.new_user(10);
    outside_round_trips(&mut f, &trader, 5, 50 * SOL);
    let held = f.locked_lp();
    let payer = kp_pk(&f.env.payer);
    let attacker = kp_pk(&whale);
    let wrong = locker_code(LockerError::WrongAccount);
    let run = |f: &mut Flow, edit: &dyn Fn(&mut solana_instruction::Instruction)| {
        let mut ixs = f.skim_ixs(&payer);
        edit(&mut ixs[1]);
        let mut all = vec![cu_limit(400_000)];
        all.extend(ixs);
        f.env.send(&all, &[])
    };
    let set = |i: &mut solana_instruction::Instruction, pos: usize, key: Pubkey| {
        i.accounts[3 + pos].pubkey = addr(&key); // 3 named accounts precede the venue slice
    };
    let attacker_base = ata(&attacker, &f.mint, &T22);
    let attacker_wsol = ata(&attacker, &WSOL_MINT, &TOKEN);
    let attacker_lp = ata(&attacker, &f.lp_mint(), &T22);
    put_token_account(&mut f.env, attacker_wsol, WSOL_MINT, attacker, 0, TOKEN);
    // Proceeds to the attacker instead of the FUMPAD destinations.
    expect_custom(run(&mut f, &|i| set(i, 6, attacker_base)), wrong);
    expect_custom(run(&mut f, &|i| set(i, 7, attacker_wsol)), wrong);
    // Another LP account / pool / mint / "user".
    expect_custom(run(&mut f, &|i| set(i, 8, attacker_lp)), wrong);
    expect_custom(run(&mut f, &|i| set(i, 0, Pubkey::new_unique())), wrong);
    expect_custom(run(&mut f, &|i| set(i, 3, WSOL_MINT)), wrong);
    expect_custom(run(&mut f, &|i| set(i, 2, attacker)), wrong);
    // Wrong pool vaults (measurement inputs).
    expect_custom(run(&mut f, &|i| set(i, 9, attacker_base)), wrong);
    expect_custom(run(&mut f, &|i| set(i, 10, attacker_wsol)), wrong);
    // Fake PumpSwap program (named account), short venue slice.
    expect_custom(run(&mut f, &|i| i.accounts[2].pubkey = addr(&Pubkey::new_unique())), wrong);
    expect_custom(run(&mut f, &|i| i.accounts.truncate(3 + 10)), wrong);
    // Wrong Lock PDA / authority.
    assert!(run(&mut f, &|i| i.accounts[0].pubkey = addr(&locker_accounts(&Pubkey::new_unique()).0)).is_err());
    expect_custom(
        run(&mut f, &|i| i.accounts[1].pubkey = addr(&attacker)),
        anchor_lang::error::ErrorCode::ConstraintSeeds as u32,
    );
    assert_eq!(f.locked_lp(), held, "no failed variant moved LP");
    // The honest call still works.
    ok(f.skim());
    assert_principal_intact(&f);
}

/// `lock` only accepts FUMPAD's pool-authority PDA as signer. Someone creates their own
/// PumpSwap pool for a FUMPAD coin and tries to lock it (to get a Lock PDA whose skims pay
/// FUMPAD's reward vault / fee ATA from a pool they control) — rejected, as is passing the
/// real PDA without its signature. (FUMPAD only signs for it inside `graduate`.)
#[test]
fn lock_is_only_callable_by_fumpad_graduate() {
    let (mut f, whale) = graduated();
    let rando = third_party_lp(&mut f, &whale, 10_000_000 * M);
    let rk = kp_pk(&rando);
    let pool = fumpad::external::pumpswap::pool_pda(1, &rk, &f.mint, &WSOL_MINT);
    let lp_mint = fumpad::external::pumpswap::lp_mint_pda(&pool);
    let (pool_base, pool_quote) = (ata(&pool, &f.mint, &T22), ata(&pool, &WSOL_MINT, &TOKEN));
    let mut data = vec![233, 146, 209, 142, 207, 104, 64, 188]; // create_pool
    data.extend_from_slice(&1u16.to_le_bytes());
    data.extend_from_slice(&(10_000_000 * M).to_le_bytes());
    data.extend_from_slice(&(5 * SOL).to_le_bytes());
    data.extend_from_slice(Pubkey::default().as_ref());
    data.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    let metas = vec![
        w(pool),
        r(fumpad::PUMPSWAP_GLOBAL_CONFIG),
        Meta::new(rk, true),
        r(f.mint),
        r(WSOL_MINT),
        w(lp_mint),
        w(ata(&rk, &f.mint, &T22)),
        w(ata(&rk, &WSOL_MINT, &TOKEN)),
        w(ata(&rk, &lp_mint, &T22)),
        w(pool_base),
        w(pool_quote),
        r(SYSTEM),
        r(T22),
        r(T22),
        r(TOKEN),
        r(ATA_PROGRAM),
        r(fumpad::external::pumpswap::event_authority_pda()),
        r(PUMPSWAP_PROGRAM_ID),
    ];
    ok(f.env.send_as(&rando, &[cu_limit(400_000), raw_ix(PUMPSWAP_PROGRAM_ID, metas, data)], &[&rando]));
    assert!(token_balance(&f.env, &ata(&rk, &lp_mint, &T22)) > 0);

    let (lock, authority, lp_vault) = locker_accounts(&pool);
    let accounts = |fa: Pubkey| fumpad_lp_locker::accounts::LockLp {
        payer: rk,
        fumpad_authority: fa,
        pool,
        lp_mint,
        source_lp: ata(&rk, &lp_mint, &T22),
        lock,
        authority,
        lp_vault,
        pool_base_vault: pool_base,
        pool_quote_vault: pool_quote,
        token_program: T22,
        associated_token_program: ATA_PROGRAM,
        system_program: SYSTEM,
    };
    // Signing as "FUMPAD's authority" with their own key.
    let i = locker_ix(accounts(rk), fumpad_lp_locker::instruction::Lock {}, &[]);
    expect_custom(f.env.send_as(&rando, &[i], &[&rando]), anchor_lang::error::ErrorCode::ConstraintSeeds as u32);
    // The real PDA, unsigned.
    let mut i = locker_ix(accounts(pool_authority()), fumpad_lp_locker::instruction::Lock {}, &[]);
    for m in i.accounts.iter_mut() {
        m.is_signer = m.pubkey == addr(&rk);
    }
    assert!(f.env.send_as(&rando, &[i], &[&rando]).is_err());
    assert!(f.env.account(&lock).map_or(true, |a| a.lamports == 0), "no Lock created");
    assert_eq!(f.lock_state().lp_locked, f.locked_lp());
}

/// settle_lp_fees: nothing to settle → error; wrong ATA (another coin's, a user's) →
/// constraint error; coins not graduated → WrongCoinStatus.
#[test]
fn settle_rejections() {
    let (mut f, whale) = graduated();
    let payer = kp_pk(&f.env.payer);
    // ATA doesn't exist yet.
    assert!(f.settle_lp_fees().is_err());
    // Exists but empty.
    let i = create_ata_ix(&payer, &f.coin, &WSOL_MINT, &TOKEN);
    ok(f.env.send(&[i], &[]));
    expect_err(f.settle_lp_fees(), FumpadError::NothingToSettle);
    // Someone else's WSOL account.
    let wk = kp_pk(&whale);
    put_token_account(&mut f.env, ata(&wk, &WSOL_MINT, &TOKEN), WSOL_MINT, wk, SOL, TOKEN);
    let mut i = f.settle_ix(&payer);
    i.accounts[3].pubkey = addr(&ata(&wk, &WSOL_MINT, &TOKEN));
    assert!(f.env.send(&[i], &[]).is_err());
    // A coin still on its curve: its ATA(coin, WSOL) can be created and funded by anyone,
    // but settling is only for graduated coins.
    let mut g = Flow::new();
    let gp = kp_pk(&g.env.payer);
    let i = create_ata_ix(&gp, &g.coin, &WSOL_MINT, &TOKEN);
    ok(g.env.send(&[i], &[]));
    let (gw, gc) = (g.lp_fee_wsol(), g.coin);
    put_token_account(&mut g.env, gw, WSOL_MINT, gc, SOL, TOKEN);
    expect_err(g.settle_lp_fees(), FumpadError::WrongCoinStatus);
    // Donated WSOL in the graduated coin's ATA is settled like fees.
    let (fw, fc) = (f.lp_fee_wsol(), f.coin);
    put_token_account(&mut f.env, fw, WSOL_MINT, fc, SOL, TOKEN);
    let m = ok(f.settle_lp_fees());
    assert_eq!(events::<LpFeesSettled>(&m)[0].lamports, SOL);
    f.assert_invariant();
}

/// Graduate grew by 4 locker accounts; it and skim (+ its ATA create) must still fit a
/// legacy transaction (1232-byte packets).
#[test]
fn graduate_and_skim_fit_a_legacy_transaction() {
    let (f, _) = {
        let mut f = Flow::new();
        let whale = f.env.new_user(10_000);
        ok(f.buy(&whale, 200 * SOL));
        (f, whale)
    };
    let size = |ixs: &[solana_instruction::Instruction], signers: usize| {
        let msg = solana_message::Message::new(ixs, Some(&solana_signer::Signer::pubkey(&f.env.payer)));
        1 + 64 * signers + msg.serialize().len()
    };
    let pa = pool_authority();
    let lp_mint = f.lp_mint();
    let grad = crate::ix(
        fumpad::accounts::Graduate {
            payer: kp_pk(&f.env.payer),
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
            amm_event_authority: fumpad::external::pumpswap::event_authority_pda(),
            amm_program: PUMPSWAP_PROGRAM_ID,
            lp_lock: locker_accounts(&f.pool).0,
            lp_locker_authority: locker_accounts(&f.pool).1,
            lp_vault: locker_accounts(&f.pool).2,
            lp_locker_program: fumpad_lp_locker::ID,
            token_program: T22,
            quote_token_program: TOKEN,
            associated_token_program: ATA_PROGRAM,
            system_program: SYSTEM,
            event_authority: event_authority(),
            program: fumpad::ID,
        },
        fumpad::instruction::Graduate {},
    );
    let g = size(&[cu_limit(400_000), grad], 1);
    let mut skim = vec![cu_limit(400_000)];
    skim.extend(f.skim_ixs(&kp_pk(&f.env.payer)));
    let mut with_settle = skim.clone();
    with_settle.push(f.settle_ix(&kp_pk(&f.env.payer)));
    let (s, ss) = (size(&skim, 1), size(&with_settle, 1));
    println!("tx bytes: graduate {g}, skim {s}, skim + settle {ss}");
    assert!(g <= 1232 && s <= 1232 && ss <= 1232);
}

/// C-Info4: the locker fails closed on an unexpected PumpSwap `Pool` size (e.g. PumpSwap
/// reallocating its pools for a new layout): `skim` refuses with `UnknownPoolLayout` and the
/// LP stays where it is; with the known layout back, skims resume.
#[test]
fn regression_skim_fails_closed_on_unknown_pool_layout() {
    let (mut f, whale) = graduated();
    outside_round_trips(&mut f, &whale, 5, 20 * SOL);
    let lp0 = f.locked_lp();
    let orig = f.env.account(&f.pool).unwrap();
    assert_eq!(orig.data.len(), fumpad_lp_locker::POOL_LEN);
    for len in [fumpad_lp_locker::POOL_LEN + 8, 300, fumpad_lp_locker::POOL_LEN - 1] {
        let mut p = orig.clone();
        p.data.resize(len, 0);
        f.env.svm.set_account(addr(&f.pool), p).unwrap();
        expect_custom(f.skim(), locker_code(LockerError::UnknownPoolLayout));
        assert_eq!(f.locked_lp(), lp0, "principal untouched");
    }
    f.env.svm.set_account(addr(&f.pool), orig).unwrap();
    let m = ok(f.skim());
    assert!(skimmed(&m).lp_withdrawn > 0);
    assert_principal_intact(&f);
}
