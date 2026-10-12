//! Curve module integration tests: create_coin → buy/sell → completion → graduate
//! against the real PumpSwap program, plus every rejection path.
//! Helpers live here (not in the shared harness).

use anchor_lang::{prelude::Pubkey, AnchorDeserialize, Discriminator};
use fumpad::{
    error::FumpadError,
    events::{CoinCreated, CurveCompleted, Graduated, Trade},
    external::pumpswap::{event_authority_pda, lp_mint_pda, pool_pda, WSOL_MINT},
    instructions::curve::{GRADUATION_RENT_BUDGET, MAX_NAME_LEN, MAX_SYMBOL_LEN, MAX_URI_LEN},
    math::{
        curve::{quote_buy, quote_sell, sol_for_tokens, BuyQuote, CurveReserves},
        fees::{compute_fee, snipe_curve_offer, snipe_tax},
        price::price_q64,
    },
    state::{Coin, CoinStatus, Params, Position, SnipeConfig, PAUSE_CLAIMS, PAUSE_LAUNCH, PAUSE_TRADE},
};
use litesvm::types::{FailedTransactionMetadata, TransactionMetadata, TransactionResult};
use solana_keypair::Keypair;

use crate::*;

// ── Program ids / PDAs ───────────────────────────────────────────────────────

const TOKEN_2022: Pubkey = anchor_lang::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const SPL_TOKEN: Pubkey = anchor_lang::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM: Pubkey = anchor_lang::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM: Pubkey = anchor_lang::system_program::ID;

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &fumpad::ID).0
}
fn ata(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), token_program.as_ref(), mint.as_ref()], &ATA_PROGRAM).0
}
fn event_authority() -> Pubkey {
    pda(&[b"__event_authority"])
}
fn coin_pda(mint: &Pubkey) -> Pubkey {
    pda(&[fumpad::COIN_SEED, mint.as_ref()])
}
fn curve_vault(mint: &Pubkey) -> Pubkey {
    pda(&[fumpad::CURVE_VAULT_SEED, mint.as_ref()])
}
fn reward_vault(mint: &Pubkey) -> Pubkey {
    pda(&[fumpad::REWARD_VAULT_SEED, mint.as_ref()])
}
fn pool_authority() -> Pubkey {
    pda(&[fumpad::POOL_AUTHORITY_SEED])
}
fn position_pda(mint: &Pubkey, user: &Pubkey) -> Pubkey {
    pda(&[fumpad::POSITION_SEED, mint.as_ref(), user.as_ref()])
}

// ── Raw account readers ──────────────────────────────────────────────────────

fn token_amount(env: &Env, acct: &Pubkey) -> u64 {
    let a = env.account(acct).unwrap_or_else(|| panic!("token account {acct} missing"));
    u64::from_le_bytes(a.data[64..72].try_into().unwrap())
}
fn mint_supply(env: &Env, mint: &Pubkey) -> u64 {
    let a = env.account(mint).unwrap();
    u64::from_le_bytes(a.data[36..44].try_into().unwrap())
}
fn exists(env: &Env, key: &Pubkey) -> bool {
    env.account(key).map(|a| a.lamports > 0).unwrap_or(false)
}

/// Coin lamports == rent + real_sol + creator fees + platform fees + buyback lamports.
fn assert_lamport_invariant(env: &Env, mint: &Pubkey) {
    let key = coin_pda(mint);
    let acc = env.account(&key).unwrap();
    let c: Coin = env.fetch(&key);
    let rent = env.svm.minimum_balance_for_rent_exemption(acc.data.len());
    assert_eq!(
        acc.lamports,
        rent + c.real_sol_reserves + c.creator_fees_unclaimed + c.platform_fees_unclaimed + c.buyback_lamports,
        "coin lamport invariant broken"
    );
}

/// Curve vault holds exactly the unsold curve tokens + the LP reserve (pre-graduation).
fn assert_vault_invariant(env: &Env, mint: &Pubkey, p: &Params) {
    let c: Coin = env.fetch(&coin_pda(mint));
    assert_eq!(token_amount(env, &curve_vault(mint)), c.real_token_reserves + p.lp_supply);
    assert_eq!(c.virtual_sol_reserves - c.real_sol_reserves, p.initial_virtual_sol);
    assert_eq!(c.virtual_token_reserves - c.real_token_reserves, p.initial_virtual_token - p.curve_supply);
}

fn reserves(c: &Coin) -> CurveReserves {
    CurveReserves {
        virtual_sol: c.virtual_sol_reserves,
        virtual_token: c.virtual_token_reserves,
        real_sol: c.real_sol_reserves,
        real_token: c.real_token_reserves,
    }
}

// ── Errors & events ──────────────────────────────────────────────────────────

fn code_of(e: FumpadError) -> u32 {
    anchor_lang::error::ERROR_CODE_OFFSET + e as u32
}

#[track_caller]
fn assert_custom(res: TransactionResult, code: u32) -> FailedTransactionMetadata {
    let f = res.expect_err("transaction should fail");
    let s = format!("{:?}", f.err);
    assert!(s.contains(&format!("Custom({code})")), "expected Custom({code}), got {s}\nlogs: {:#?}", f.meta.logs);
    f
}

#[track_caller]
fn assert_fumpad_err(res: TransactionResult, e: FumpadError) {
    assert_custom(res, code_of(e));
}

#[track_caller]
fn ok(res: TransactionResult) -> TransactionMetadata {
    match res {
        Ok(m) => m,
        Err(f) => panic!("tx failed: {:?}\nlogs: {:#?}", f.err, f.meta.logs),
    }
}

/// Decode every `emit_cpi!` event of type T from a transaction's inner instructions.
fn events<T: anchor_lang::Event + AnchorDeserialize + Discriminator>(m: &TransactionMetadata) -> Vec<T> {
    let mut out = vec![];
    for ixs in &m.inner_instructions {
        for ix in ixs {
            let d = &ix.instruction.data;
            if d.len() >= 8 && &d[..8] == anchor_lang::event::EVENT_IX_TAG_LE {
                let rest = &d[8..];
                if rest.starts_with(T::DISCRIMINATOR) {
                    out.push(T::deserialize(&mut &rest[T::DISCRIMINATOR.len()..]).unwrap());
                }
            }
        }
    }
    out
}

// ── Instruction builders ─────────────────────────────────────────────────────

fn create_coin_ix(creator: &Pubkey, mint: &Pubkey, name: &str, symbol: &str, uri: &str, env: &Env) -> solana_instruction::Instruction {
    ix(
        fumpad::accounts::CreateCoin {
            creator: *creator,
            global: env.global_pda(),
            mint: *mint,
            mint_authority: pda(&[fumpad::MINT_AUTHORITY_SEED]),
            coin: coin_pda(mint),
            pool_authority: pool_authority(),
            reward_vault: reward_vault(mint),
            curve_vault: curve_vault(mint),
            token_program: TOKEN_2022,
            system_program: SYSTEM,
            event_authority: event_authority(),
            program: fumpad::ID,
        },
        fumpad::instruction::CreateCoin { name: name.into(), symbol: symbol.into(), uri: uri.into() },
    )
}

fn create_coin_with(env: &mut Env, creator: &Keypair, name: &str, symbol: &str, uri: &str) -> (Keypair, TransactionResult) {
    let mint = Keypair::new();
    let i = create_coin_ix(&kp_pk(creator), &kp_pk(&mint), name, symbol, uri, env);
    let res = env.send(&[i], &[creator, &mint]);
    (mint, res)
}

fn create_coin(env: &mut Env, creator: &Keypair) -> Pubkey {
    let (mint, res) = create_coin_with(env, creator, "Fumble Coin", "FUMB", "https://fumpad.fun/m/fumb.json");
    ok(res);
    env.skip_snipe_window();
    kp_pk(&mint)
}

fn buy_accounts(env: &Env, user: &Pubkey, mint: &Pubkey) -> fumpad::accounts::Buy {
    fumpad::accounts::Buy {
        user: *user,
        global: env.global_pda(),
        coin: coin_pda(mint),
        mint: *mint,
        pool_authority: pool_authority(),
        curve_vault: curve_vault(mint),
        reward_vault: reward_vault(mint),
        user_token_account: ata(user, mint, &TOKEN_2022),
        position: position_pda(mint, user),
        token_program: TOKEN_2022,
        associated_token_program: ATA_PROGRAM,
        system_program: SYSTEM,
        event_authority: event_authority(),
        program: fumpad::ID,
    }
}

fn buy(env: &mut Env, user: &Keypair, mint: &Pubkey, sol_in: u64, min_out: u64) -> TransactionResult {
    let i = ix(buy_accounts(env, &kp_pk(user), mint), fumpad::instruction::Buy { sol_in, min_tokens_out: min_out });
    env.send(&[i], &[user])
}

fn sell_accounts(env: &Env, user: &Pubkey, mint: &Pubkey) -> fumpad::accounts::Sell {
    let pos = position_pda(mint, user);
    let seq = if exists(env, &pos) { env.fetch::<Position>(&pos).next_ticket_seq } else { 0 };
    fumpad::accounts::Sell {
        user: *user,
        global: env.global_pda(),
        coin: coin_pda(mint),
        mint: *mint,
        pool_authority: pool_authority(),
        curve_vault: curve_vault(mint),
        reward_vault: reward_vault(mint),
        user_token_account: ata(user, mint, &TOKEN_2022),
        position: pos,
        ticket: pda(&[fumpad::TICKET_SEED, mint.as_ref(), user.as_ref(), &seq.to_le_bytes()]),
        sol_usd_price: Pubkey::new_from_array([7u8; 32]),
        token_program: TOKEN_2022,
        system_program: SYSTEM,
        event_authority: event_authority(),
        program: fumpad::ID,
    }
}

fn sell(env: &mut Env, user: &Keypair, mint: &Pubkey, tokens_in: u64, min_out: u64) -> TransactionResult {
    let i = ix(sell_accounts(env, &kp_pk(user), mint), fumpad::instruction::Sell { tokens_in, min_sol_out: min_out });
    env.send(&[i], &[user])
}

/// Sell with a fresh Pyth SOL/USD price ($150) so a qualifying sell creates a ticket.
fn sell_priced(env: &mut Env, user: &Keypair, mint: &Pubkey, tokens_in: u64) -> TransactionResult {
    env.set_sol_usd(150);
    let mut a = sell_accounts(env, &kp_pk(user), mint);
    a.sol_usd_price = PYTH_SOL_USD;
    let i = ix(a, fumpad::instruction::Sell { tokens_in, min_sol_out: 0 });
    env.send(&[i], &[user])
}

fn graduate_accounts(env: &Env, payer: &Pubkey, mint: &Pubkey) -> fumpad::accounts::Graduate {
    let pa = pool_authority();
    let pool = pool_pda(0, &pa, mint, &WSOL_MINT);
    let lp_mint = lp_mint_pda(&pool);
    fumpad::accounts::Graduate {
        payer: *payer,
        global: env.global_pda(),
        coin: coin_pda(mint),
        mint: *mint,
        pool_authority: pa,
        curve_vault: curve_vault(mint),
        wsol_mint: WSOL_MINT,
        graduation_wsol: Pubkey::find_program_address(&[fumpad::GRADUATION_WSOL_SEED, mint.as_ref()], &fumpad::ID).0,
        amm_pool: pool,
        amm_global_config: fumpad::PUMPSWAP_GLOBAL_CONFIG,
        lp_mint,
        pool_authority_lp: ata(&pa, &lp_mint, &TOKEN_2022),
        pool_base_vault: ata(&pool, mint, &TOKEN_2022),
        pool_quote_vault: ata(&pool, &WSOL_MINT, &SPL_TOKEN),
        amm_event_authority: event_authority_pda(),
        amm_program: fumpad::PUMPSWAP_PROGRAM_ID,
        lp_lock: crate::flow::locker_accounts(&pool).0,
        lp_locker_authority: crate::flow::locker_accounts(&pool).1,
        lp_vault: crate::flow::locker_accounts(&pool).2,
        lp_locker_program: fumpad_lp_locker::ID,
        token_program: TOKEN_2022,
        quote_token_program: SPL_TOKEN,
        associated_token_program: ATA_PROGRAM,
        system_program: SYSTEM,
        observations: pda(&[fumpad::OBSERVATIONS_SEED, mint.as_ref()]),
        claim_queue: pda(&[fumpad::CLAIM_QUEUE_SEED, mint.as_ref()]),
        event_authority: event_authority(),
        program: fumpad::ID,
    }
}

/// ComputeBudget SetComputeUnitLimit — graduation (PumpSwap create_pool) needs > 200k CU.
fn cu_limit(units: u32) -> solana_instruction::Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    solana_instruction::Instruction {
        program_id: addr(&anchor_lang::pubkey!("ComputeBudget111111111111111111111111111111")),
        accounts: vec![],
        data,
    }
}

const GRADUATE_CU: u32 = 400_000;

fn graduate(env: &mut Env, mint: &Pubkey) -> TransactionResult {
    let payer = kp_pk(&env.payer);
    let i = ix(graduate_accounts(env, &payer, mint), fumpad::instruction::Graduate {});
    env.send(&[cu_limit(GRADUATE_CU), i], &[])
}

fn set_pause(env: &mut Env, flags: u8) {
    let i = ix(
        fumpad::accounts::AdminOnly { admin: kp_pk(&env.admin), global: env.global_pda() },
        fumpad::instruction::SetPause { paused: flags },
    );
    let admin = env.admin.insecure_clone();
    ok(env.send(&[i], &[&admin]));
}

/// Env with the WSOL mint loaded (needed by graduation).
fn env_with(params: Params) -> Env {
    let mut env = Env::with_params(params);
    load_account_fixture(&mut env.svm, "wsol_mint.json");
    env
}
fn env() -> Env {
    env_with(Params::default())
}

/// Default params with the curve re-derived (constants.rs formula, SPEC §3) for initial
/// virtual SOL `v0`, raise `raise` and graduation fee `fee`, so the LP opens at the curve's
/// final price — `Params::is_valid` enforces that continuity since v0.6 (L-2).
pub fn curve_params(v0: u64, raise: u64, fee: u64) -> Params {
    let d = Params::default();
    let n = d.total_supply - d.reward_pool_supply;
    let (v0f, rf, ff) = (v0 as f64, raise as f64, fee as f64);
    let v1 = v0f + rf;
    let t1 = n as f64 / (rf / v0f + (rf - ff) / v1);
    let curve = (t1 * rf / v0f).round() as u64;
    Params {
        initial_virtual_sol: v0,
        initial_virtual_token: (t1 * v1 / v0f).round() as u64,
        curve_supply: curve,
        lp_supply: n - curve,
        graduation_lamports: raise,
        graduation_fee_lamports: fee,
        ..d
    }
}

/// `curve_params` for the default 30 SOL virtual / 85 SOL raise and graduation fee `fee`.
pub fn params_for_graduation_fee(fee: u64) -> Params {
    if fee == fumpad::DEFAULT_GRADUATION_FEE_LAMPORTS {
        return Params::default(); // the exact constants (rounded the same way)
    }
    curve_params(fumpad::DEFAULT_INITIAL_VIRTUAL_SOL, fumpad::DEFAULT_GRADUATION_LAMPORTS, fee)
}

/// Fill the curve with one big buy from `whale`; returns the tx metadata.
fn complete_curve(env: &mut Env, mint: &Pubkey, whale: &Keypair) -> TransactionMetadata {
    ok(buy(env, whale, mint, 200 * SOL, 1))
}

// ═════════════════════════════════════════════════════════════════════════════
// create_coin
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn create_coin_mints_supply_and_revokes_authorities() {
    let mut env = env();
    let p = Params::default();
    let creator = env.new_user(10);
    let (mint_kp, res) = create_coin_with(&mut env, &creator, "Fumble Coin", "FUMB", "https://fumpad.fun/m/fumb.json");
    let meta = ok(res);
    let mint = kp_pk(&mint_kp);

    // Mint: Token-2022, decimals 6, full supply, no mint/freeze authority.
    let m = env.account(&mint).unwrap();
    assert_eq!(pk(&m.owner), TOKEN_2022);
    assert_eq!(&m.data[0..4], &[0, 0, 0, 0], "mint authority must be revoked");
    assert_eq!(m.data[44], fumpad::TOKEN_DECIMALS);
    assert_eq!(&m.data[46..50], &[0, 0, 0, 0], "no freeze authority");
    assert_eq!(mint_supply(&env, &mint), p.total_supply);
    // Metadata stored in the mint (TokenMetadata TLV) with no update authority.
    let hay = &m.data;
    for needle in [&b"Fumble Coin"[..], b"FUMB", b"https://fumpad.fun/m/fumb.json"] {
        assert!(hay.windows(needle.len()).any(|w| w == needle), "metadata missing {needle:?}");
    }

    // Allocation.
    assert_eq!(token_amount(&env, &reward_vault(&mint)), p.reward_pool_supply);
    assert_eq!(token_amount(&env, &curve_vault(&mint)), p.curve_supply + p.lp_supply);

    // Coin state.
    let c: Coin = env.fetch(&coin_pda(&mint));
    assert_eq!(c.mint, mint);
    assert_eq!(c.creator, kp_pk(&creator));
    assert_eq!(c.status, CoinStatus::Curve);
    assert_eq!(c.virtual_sol_reserves, p.initial_virtual_sol);
    assert_eq!(c.virtual_token_reserves, p.initial_virtual_token);
    assert_eq!((c.real_sol_reserves, c.real_token_reserves), (0, p.curve_supply));
    // D19: launch slot + snipe schedule snapshotted.
    let slot = env.svm.get_sysvar::<litesvm_clock::Clock>().slot;
    assert_eq!(c.snipe, p.snipe_config(slot));
    assert_eq!((c.snipe.window_slots, c.snipe.start_bps), (4, 9_900));
    assert_lamport_invariant(&env, &mint);
    assert_vault_invariant(&env, &mint, &p);

    let ev = events::<CoinCreated>(&meta);
    assert_eq!(ev.len(), 1);
    assert_eq!((ev[0].mint, ev[0].creator, ev[0].symbol.as_str()), (mint, kp_pk(&creator), "FUMB"));
}

#[test]
fn create_coin_rejects_bad_metadata() {
    let mut env = env();
    let creator = env.new_user(10);
    let long = |n: usize| "x".repeat(n);
    for (name, symbol, uri) in [
        (long(MAX_NAME_LEN + 1), "SYM".to_string(), "u".to_string()),
        ("Name".to_string(), long(MAX_SYMBOL_LEN + 1), "u".to_string()),
        ("Name".to_string(), "SYM".to_string(), long(MAX_URI_LEN + 1)),
    ] {
        let (_, res) = create_coin_with(&mut env, &creator, &name, &symbol, &uri);
        assert_fumpad_err(res, FumpadError::MetadataTooLong);
    }
    let (_, res) = create_coin_with(&mut env, &creator, "  ", "SYM", "u");
    assert_fumpad_err(res, FumpadError::EmptyMetadata);
    let (_, res) = create_coin_with(&mut env, &creator, "Name", "", "u");
    assert_fumpad_err(res, FumpadError::EmptyMetadata);
    // Exactly at the limits is fine (and an empty URI is allowed).
    let (_, res) = create_coin_with(&mut env, &creator, &long(MAX_NAME_LEN), &long(MAX_SYMBOL_LEN), &long(MAX_URI_LEN));
    ok(res);
    let (_, res) = create_coin_with(&mut env, &creator, "N", "S", "");
    ok(res);
}

#[test]
fn create_coin_respects_pause_launch() {
    let mut env = env();
    let creator = env.new_user(10);
    set_pause(&mut env, PAUSE_LAUNCH);
    let (_, res) = create_coin_with(&mut env, &creator, "Name", "SYM", "u");
    assert_fumpad_err(res, FumpadError::Paused);
    // Other flags don't block launches.
    set_pause(&mut env, PAUSE_TRADE | PAUSE_CLAIMS);
    let (_, res) = create_coin_with(&mut env, &creator, "Name", "SYM", "u");
    ok(res);
}

#[test]
fn create_coin_cannot_reuse_mint() {
    let mut env = env();
    let creator = env.new_user(10);
    let (mint, res) = create_coin_with(&mut env, &creator, "Name", "SYM", "u");
    ok(res);
    let i = create_coin_ix(&kp_pk(&creator), &kp_pk(&mint), "Name", "SYM", "u", &env);
    assert!(env.send(&[i], &[&creator, &mint]).is_err());
}

// ═════════════════════════════════════════════════════════════════════════════
// buy / sell
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn buy_charges_fee_on_top_and_buys_back_inline() {
    let mut env = env();
    let p = Params::default();
    let creator = env.new_user(10);
    let mint = create_coin(&mut env, &creator);
    let alice = env.new_user(100);
    // Pre-create alice's ATA + position so her lamport delta is exactly the trade.
    ok(buy(&mut env, &alice, &mint, SOL / 100, 1));

    let before: Coin = env.fetch(&coin_pda(&mint));
    let sol_in = 5 * SOL;
    let q = quote_buy(&reserves(&before), sol_in).unwrap();
    let fee = compute_fee(q.sol_used, &p.coin_fees()).unwrap();
    let mut after_user = reserves(&before);
    after_user.apply_buy(&q).unwrap();
    let bb = quote_buy(&after_user, fee.pool).unwrap();

    let alice_lamports = env.lamports(&kp_pk(&alice));
    let alice_tokens = token_amount(&env, &ata(&kp_pk(&alice), &mint, &TOKEN_2022));
    let pool_tokens = token_amount(&env, &reward_vault(&mint));
    let meta = ok(buy(&mut env, &alice, &mint, sol_in, q.tokens_out));

    assert_eq!(alice_lamports - env.lamports(&kp_pk(&alice)), sol_in + fee.total, "fee is charged on top");
    assert_eq!(token_amount(&env, &ata(&kp_pk(&alice), &mint, &TOKEN_2022)) - alice_tokens, q.tokens_out);
    assert_eq!(token_amount(&env, &reward_vault(&mint)) - pool_tokens, bb.tokens_out);
    assert!(bb.tokens_out > 0);

    let c: Coin = env.fetch(&coin_pda(&mint));
    assert_eq!(c.platform_fees_unclaimed - before.platform_fees_unclaimed, fee.platform);
    assert_eq!(c.creator_fees_unclaimed - before.creator_fees_unclaimed, fee.creator);
    assert_eq!(c.real_sol_reserves - before.real_sol_reserves, q.sol_used + bb.sol_used);
    assert_eq!(c.buyback_lamports - before.buyback_lamports, fee.pool - bb.sol_used);
    assert_eq!(c.trade_count, 2);
    assert_lamport_invariant(&env, &mint);
    assert_vault_invariant(&env, &mint, &p);

    let t = &events::<Trade>(&meta)[0];
    assert!(t.is_buy && !t.on_amm);
    assert_eq!((t.token_amount, t.sol_amount), (q.tokens_out, q.sol_used));
    assert_eq!((t.fee_pool, t.fee_platform, t.fee_creator), (fee.pool, fee.platform, fee.creator));
    assert_eq!(t.pool_tokens_bought, bb.tokens_out);
    assert_eq!(t.price_q64, price_q64(q.sol_used, q.tokens_out).unwrap());
    assert_eq!((t.virtual_sol_reserves, t.virtual_token_reserves), (c.virtual_sol_reserves, c.virtual_token_reserves));
    assert!(events::<CurveCompleted>(&meta).is_empty());

    let pos: Position = env.fetch(&position_pda(&mint, &kp_pk(&alice)));
    assert_eq!((pos.wallet, pos.mint), (kp_pk(&alice), mint));
}

#[test]
fn sell_deducts_fee_and_buys_back_inline() {
    let mut env = env();
    let p = Params::default();
    let creator = env.new_user(10);
    let mint = create_coin(&mut env, &creator);
    let bob = env.new_user(100);
    ok(buy(&mut env, &bob, &mint, 10 * SOL, 1));
    let bob_ata = ata(&kp_pk(&bob), &mint, &TOKEN_2022);
    let held = token_amount(&env, &bob_ata);

    let before: Coin = env.fetch(&coin_pda(&mint));
    let tokens_in = held / 3;
    let gross = quote_sell(&reserves(&before), tokens_in).unwrap();
    let fee = compute_fee(gross, &p.coin_fees()).unwrap();
    let net = gross - fee.total;
    let mut after_user = reserves(&before);
    after_user.apply_sell(tokens_in, gross).unwrap();
    let bb = quote_buy(&after_user, fee.pool).unwrap();

    let lamports = env.lamports(&kp_pk(&bob));
    let pool_tokens = token_amount(&env, &reward_vault(&mint));
    let meta = ok(sell(&mut env, &bob, &mint, tokens_in, net));
    assert_eq!(env.lamports(&kp_pk(&bob)) - lamports, net, "fee deducted from proceeds");
    assert_eq!(held - token_amount(&env, &bob_ata), tokens_in);
    assert_eq!(token_amount(&env, &reward_vault(&mint)) - pool_tokens, bb.tokens_out);

    let c: Coin = env.fetch(&coin_pda(&mint));
    assert_eq!(c.platform_fees_unclaimed - before.platform_fees_unclaimed, fee.platform);
    assert_eq!(c.creator_fees_unclaimed - before.creator_fees_unclaimed, fee.creator);
    assert_eq!(before.real_sol_reserves - c.real_sol_reserves, gross - bb.sol_used);
    assert_lamport_invariant(&env, &mint);
    assert_vault_invariant(&env, &mint, &p);

    let t = &events::<Trade>(&meta)[0];
    assert!(!t.is_buy);
    assert_eq!((t.token_amount, t.sol_amount, t.pool_tokens_bought), (tokens_in, gross, bb.tokens_out));
    assert_eq!(t.price_q64, price_q64(gross, tokens_in).unwrap());
}

/// Many users trading randomly: fee split + lamport + vault invariants after every step,
/// and the round trip never profits.
#[test]
fn random_trading_keeps_invariants() {
    let mut env = env();
    let p = Params::default();
    let creator = env.new_user(10);
    let mint = create_coin(&mut env, &creator);
    let users: Vec<Keypair> = (0..4).map(|_| env.new_user(100)).collect();
    let mut seed = 0x1234_5678_9abc_def0u64;
    let mut rnd = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let mut spent = vec![0u64; users.len()];
    let mut got = vec![0u64; users.len()];
    for _ in 0..60 {
        let i = (rnd() % users.len() as u64) as usize;
        let u = &users[i];
        let u_ata = ata(&kp_pk(u), &mint, &TOKEN_2022);
        let bal = if exists(&env, &u_ata) { token_amount(&env, &u_ata) } else { 0 };
        let before: Coin = env.fetch(&coin_pda(&mint));
        let lam = env.lamports(&kp_pk(u));
        if bal == 0 || rnd() % 3 != 0 {
            let sol_in = 1 + rnd() % (3 * SOL);
            let q = quote_buy(&reserves(&before), sol_in).unwrap();
            if q.tokens_out == 0 || q.completes {
                continue;
            }
            let had_accounts = exists(&env, &u_ata);
            ok(buy(&mut env, u, &mint, sol_in, q.tokens_out));
            let fee = compute_fee(q.sol_used, &p.coin_fees()).unwrap();
            if had_accounts {
                assert_eq!(lam - env.lamports(&kp_pk(u)), q.sol_used + fee.total);
            }
            spent[i] += q.sol_used + fee.total;
            let c: Coin = env.fetch(&coin_pda(&mint));
            assert_eq!(c.platform_fees_unclaimed - before.platform_fees_unclaimed, fee.platform);
            assert_eq!(c.creator_fees_unclaimed - before.creator_fees_unclaimed, fee.creator);
        } else {
            let t = 1 + rnd() % bal;
            let gross = quote_sell(&reserves(&before), t).unwrap();
            if gross == 0 {
                continue;
            }
            ok(sell(&mut env, u, &mint, t, 0));
            let fee = compute_fee(gross, &p.coin_fees()).unwrap();
            assert_eq!(env.lamports(&kp_pk(u)) - lam, gross - fee.total);
            got[i] += gross - fee.total;
        }
        assert_lamport_invariant(&env, &mint);
        assert_vault_invariant(&env, &mint, &p);
    }
    // Everyone dumps: nobody ends up with more SOL than they put in.
    for (i, u) in users.iter().enumerate() {
        let u_ata = ata(&kp_pk(u), &mint, &TOKEN_2022);
        if !exists(&env, &u_ata) {
            continue;
        }
        let bal = token_amount(&env, &u_ata);
        if bal > 0 {
            let lam = env.lamports(&kp_pk(u));
            ok(sell(&mut env, u, &mint, bal, 0));
            got[i] += env.lamports(&kp_pk(u)) - lam;
        }
        assert_lamport_invariant(&env, &mint);
    }
    // Individuals may profit from each other, but the traders as a group cannot
    // extract more SOL than they put in (fees + rounding stay with the protocol).
    let (spent_all, got_all): (u64, u64) = (spent.iter().sum(), got.iter().sum());
    assert!(got_all <= spent_all, "traders extracted value: in {spent_all} out {got_all}");
    // All circulating tokens are back except the reward pool's buybacks.
    let c: Coin = env.fetch(&coin_pda(&mint));
    let pool_bought = token_amount(&env, &reward_vault(&mint)) - p.reward_pool_supply;
    assert_eq!(c.real_token_reserves + pool_bought, p.curve_supply);
}

#[test]
fn final_buy_is_partially_filled_and_completes_curve() {
    let mut env = env();
    let p = Params::default();
    let creator = env.new_user(10);
    let mint = create_coin(&mut env, &creator);
    let whale = env.new_user(1_000);
    ok(buy(&mut env, &whale, &mint, 40 * SOL, 1));

    let before: Coin = env.fetch(&coin_pda(&mint));
    let need = sol_for_tokens(&reserves(&before), before.real_token_reserves).unwrap();
    let fee = compute_fee(need, &p.coin_fees()).unwrap();
    let lam = env.lamports(&kp_pk(&whale));
    let tokens = token_amount(&env, &ata(&kp_pk(&whale), &mint, &TOKEN_2022));
    // Offer far more than needed, with min_out = everything left.
    let meta = ok(buy(&mut env, &whale, &mint, 500 * SOL, before.real_token_reserves));

    // Charged only for what was filled.
    assert_eq!(lam - env.lamports(&kp_pk(&whale)), need + fee.total);
    assert_eq!(token_amount(&env, &ata(&kp_pk(&whale), &mint, &TOKEN_2022)) - tokens, before.real_token_reserves);
    let c: Coin = env.fetch(&coin_pda(&mint));
    assert_eq!(c.status, CoinStatus::Complete);
    assert_eq!(c.real_token_reserves, 0);
    assert_eq!(c.completed_at, env.now());
    // The pool share could not be spent on an empty curve: it waits for the post-grad crank.
    assert_eq!(c.buyback_lamports - before.buyback_lamports, fee.pool);
    // ≈ 85 SOL raised.
    assert!(c.real_sol_reserves.abs_diff(p.graduation_lamports) < SOL / 1_000, "raised {}", c.real_sol_reserves);
    assert_lamport_invariant(&env, &mint);
    assert_eq!(token_amount(&env, &curve_vault(&mint)), p.lp_supply);

    let t = &events::<Trade>(&meta)[0];
    assert_eq!((t.sol_amount, t.token_amount, t.pool_tokens_bought), (need, before.real_token_reserves, 0));
    let done = events::<CurveCompleted>(&meta);
    assert_eq!(done.len(), 1);
    assert_eq!(done[0].mint, mint);

    // No more curve trading once complete.
    assert_fumpad_err(buy(&mut env, &whale, &mint, SOL, 1), FumpadError::WrongCoinStatus);
    assert_fumpad_err(sell(&mut env, &whale, &mint, 1_000_000, 0), FumpadError::WrongCoinStatus);
}

#[test]
fn trade_rejections() {
    let mut env = env();
    let creator = env.new_user(10);
    let mint = create_coin(&mut env, &creator);
    let u = env.new_user(100);

    // Zero amounts.
    assert_fumpad_err(buy(&mut env, &u, &mint, 0, 0), FumpadError::ZeroAmount);
    // (A dust buy can't round to zero tokens with default params: even at the final
    // price one lamport buys >2,000 base units. The ZeroAmount guard is covered by
    // the math tests.)

    // Slippage (buy).
    let c: Coin = env.fetch(&coin_pda(&mint));
    let q = quote_buy(&reserves(&c), SOL).unwrap();
    assert_fumpad_err(buy(&mut env, &u, &mint, SOL, q.tokens_out + 1), FumpadError::SlippageExceeded);
    ok(buy(&mut env, &u, &mint, SOL, q.tokens_out));

    // Slippage (sell) — min applies to the net amount.
    let held = token_amount(&env, &ata(&kp_pk(&u), &mint, &TOKEN_2022));
    let c: Coin = env.fetch(&coin_pda(&mint));
    let gross = quote_sell(&reserves(&c), held).unwrap();
    let net = gross - compute_fee(gross, &Params::default().coin_fees()).unwrap().total;
    assert_fumpad_err(sell(&mut env, &u, &mint, held, net + 1), FumpadError::SlippageExceeded);
    assert_fumpad_err(sell(&mut env, &u, &mint, 0, 0), FumpadError::ZeroAmount);
    // Dust sell that pays zero lamports.
    assert_fumpad_err(sell(&mut env, &u, &mint, 1, 0), FumpadError::ZeroAmount);
    // More than the wallet holds: the token program refuses (and nothing moves).
    assert!(sell(&mut env, &u, &mint, held + 1, 0).is_err());
    // More than the curve can pay out: tokens that never came from the curve.
    // (Simulated by asking the math directly; on-chain the wallet cap hits first.)
    assert!(quote_sell(&reserves(&c), c.virtual_token_reserves).is_none());

    // Pause.
    set_pause(&mut env, PAUSE_TRADE);
    assert_fumpad_err(buy(&mut env, &u, &mint, SOL, 1), FumpadError::Paused);
    assert_fumpad_err(sell(&mut env, &u, &mint, held / 2, 0), FumpadError::Paused);
    set_pause(&mut env, PAUSE_LAUNCH | PAUSE_CLAIMS);
    ok(sell(&mut env, &u, &mint, held, net));
    assert_lamport_invariant(&env, &mint);
}

#[test]
fn trade_rejects_bad_accounts() {
    let mut env = env();
    let creator = env.new_user(10);
    let mint = create_coin(&mut env, &creator);
    let other = create_coin(&mut env, &creator);
    let u = env.new_user(100);
    let uk = kp_pk(&u);
    ok(buy(&mut env, &u, &mint, SOL, 1));
    ok(buy(&mut env, &u, &other, SOL, 1));

    let send_buy = |env: &mut Env, a: fumpad::accounts::Buy| {
        let i = ix(a, fumpad::instruction::Buy { sol_in: SOL, min_tokens_out: 1 });
        env.send(&[i], &[&u])
    };
    // Another coin's vault / coin account / reward vault.
    let mut a = buy_accounts(&env, &uk, &mint);
    a.curve_vault = curve_vault(&other);
    assert_custom(send_buy(&mut env, a), anchor_lang::error::ErrorCode::ConstraintSeeds as u32);
    let mut a = buy_accounts(&env, &uk, &mint);
    a.reward_vault = reward_vault(&other);
    assert_custom(send_buy(&mut env, a), anchor_lang::error::ErrorCode::ConstraintSeeds as u32);
    let mut a = buy_accounts(&env, &uk, &mint);
    a.coin = coin_pda(&other);
    assert_custom(send_buy(&mut env, a), anchor_lang::error::ErrorCode::ConstraintSeeds as u32);
    // Tokens to someone else's account.
    let mut a = buy_accounts(&env, &uk, &mint);
    a.user_token_account = ata(&kp_pk(&creator), &mint, &TOKEN_2022);
    assert!(send_buy(&mut env, a).is_err());
    // Fake pool authority.
    let mut a = buy_accounts(&env, &uk, &mint);
    a.pool_authority = Pubkey::new_unique();
    assert_custom(send_buy(&mut env, a), anchor_lang::error::ErrorCode::ConstraintSeeds as u32);

    // Sell with a ticket PDA that isn't the position's next one.
    let mut s = sell_accounts(&env, &uk, &mint);
    s.ticket = pda(&[fumpad::TICKET_SEED, mint.as_ref(), uk.as_ref(), &99u64.to_le_bytes()]);
    let i = ix(s, fumpad::instruction::Sell { tokens_in: 1_000_000, min_sol_out: 0 });
    assert_custom(env.send(&[i], &[&u]), anchor_lang::error::ErrorCode::ConstraintSeeds as u32);
    // Sell into the other coin's curve vault.
    let mut s = sell_accounts(&env, &uk, &mint);
    s.curve_vault = curve_vault(&other);
    let i = ix(s, fumpad::instruction::Sell { tokens_in: 1_000_000, min_sol_out: 0 });
    assert_custom(env.send(&[i], &[&u]), anchor_lang::error::ErrorCode::ConstraintSeeds as u32);
    assert_lamport_invariant(&env, &mint);
    assert_lamport_invariant(&env, &other);
}

/// Buys must pass the position's open tickets in remaining_accounts. The ticket is a
/// real one, created by a qualifying curve sell (matured tokens, ≥ $50, fresh Pyth).
#[test]
fn buy_requires_open_tickets() {
    let mut env = env();
    let creator = env.new_user(10);
    let mint = create_coin(&mut env, &creator);
    let u = env.new_user(100);
    let uk = kp_pk(&u);
    ok(buy(&mut env, &u, &mint, SOL, 1));
    env.warp(600);
    let held = token_amount(&env, &ata(&uk, &mint, &TOKEN_2022));
    let ticket = sell_accounts(&env, &uk, &mint).ticket;
    let m = ok(sell_priced(&mut env, &u, &mint, held / 2));
    assert_eq!(events::<fumpad::events::TicketCreated>(&m).len(), 1);
    let p: Position = env.fetch(&position_pda(&mint, &uk));
    assert_eq!((p.open_count, p.open_tickets[0]), (1, ticket));
    assert_eq!(env.fetch::<Coin>(&coin_pda(&mint)).tickets_created, 1);

    // Missing the open ticket.
    assert_fumpad_err(buy(&mut env, &u, &mint, SOL, 1), FumpadError::OpenTicketsMismatch);
    // Passing some other account in its place.
    let i = ix_with_remaining(
        buy_accounts(&env, &uk, &mint),
        fumpad::instruction::Buy { sol_in: SOL, min_tokens_out: 1 },
        &[anchor_lang::prelude::AccountMeta::new(Pubkey::new_unique(), false)],
    );
    assert_fumpad_err(env.send(&[i], &[&u]), FumpadError::OpenTicketsMismatch);
    // Passing it: the buy goes through and the rebuy rule debits the ticket.
    let before: fumpad::state::Ticket = env.fetch(&ticket);
    let i = ix_with_remaining(
        buy_accounts(&env, &uk, &mint),
        fumpad::instruction::Buy { sol_in: SOL / 1_000, min_tokens_out: 1 },
        &[anchor_lang::prelude::AccountMeta::new(ticket, false)],
    );
    let m = ok(env.send(&[i], &[&u]));
    let bought = events::<Trade>(&m)[0].token_amount;
    let after: fumpad::state::Ticket = env.fetch(&ticket);
    assert_eq!(after.tokens, before.tokens - bought.min(before.tokens));
    assert_lamport_invariant(&env, &mint);
}

// ═════════════════════════════════════════════════════════════════════════════
// graduate
// ═════════════════════════════════════════════════════════════════════════════

struct PoolInfo {
    creator: Pubkey,
    base_mint: Pubkey,
    quote_mint: Pubkey,
    lp_mint: Pubkey,
    base_vault: Pubkey,
    quote_vault: Pubkey,
    coin_creator: Pubkey,
}

fn read_pool(env: &Env, pool: &Pubkey) -> PoolInfo {
    let a = env.account(pool).expect("pool");
    assert_eq!(pk(&a.owner), fumpad::PUMPSWAP_PROGRAM_ID);
    let k = |o: usize| Pubkey::new_from_array(a.data[o..o + 32].try_into().unwrap());
    // 8 disc | bump u8 | index u16 | creator | base | quote | lp | base vault | quote vault | lp_supply u64 | coin_creator
    PoolInfo {
        creator: k(11),
        base_mint: k(43),
        quote_mint: k(75),
        lp_mint: k(107),
        base_vault: k(139),
        quote_vault: k(171),
        coin_creator: k(211),
    }
}

fn graduate_flow(params: Params) {
    let mut env = env_with(params);
    let p = params;
    let creator = env.new_user(10);
    let mint = create_coin(&mut env, &creator);
    let whale = env.new_user(1_000);
    ok(buy(&mut env, &whale, &mint, 30 * SOL, 1));
    let held = token_amount(&env, &ata(&kp_pk(&whale), &mint, &TOKEN_2022));
    ok(sell(&mut env, &whale, &mint, held / 4, 0));
    complete_curve(&mut env, &mint, &whale);

    let c: Coin = env.fetch(&coin_pda(&mint));
    assert_eq!(c.status, CoinStatus::Complete);
    let curve_price = price_q64(c.virtual_sol_reserves, c.virtual_token_reserves).unwrap();
    let payer = kp_pk(&env.payer);
    let payer_before = env.lamports(&payer);

    let meta = ok(graduate(&mut env, &mint));
    println!("graduate CU: {}", meta.compute_units_consumed);

    let pa = pool_authority();
    let pool = pool_pda(0, &pa, &mint, &WSOL_MINT);
    let info = read_pool(&env, &pool);
    assert_eq!((info.creator, info.base_mint, info.quote_mint), (pa, mint, WSOL_MINT));
    assert_eq!(info.coin_creator, Pubkey::default());
    let sol_deposited = c.real_sol_reserves - p.graduation_fee_lamports;
    assert_eq!(token_amount(&env, &info.base_vault), p.lp_supply);
    assert_eq!(token_amount(&env, &info.quote_vault), sol_deposited);

    // D11: every LP token sits in the locker's vault (nothing burned, nothing elsewhere);
    // our temporary accounts are closed; the rent loan was returned.
    let (lock_key, locker_auth, lp_vault) = crate::flow::locker_accounts(&pool);
    let lp_locked = token_amount(&env, &lp_vault);
    assert!(lp_locked > 0);
    assert_eq!(mint_supply(&env, &info.lp_mint), lp_locked, "LP mint supply == locker balance");
    let vault = env.account(&lp_vault).unwrap();
    assert_eq!(Pubkey::new_from_array(vault.data[32..64].try_into().unwrap()), locker_auth);
    let lock: fumpad_lp_locker::Lock = env.fetch(&lock_key);
    assert_eq!((lock.pool, lock.mint, lock.lp_mint, lock.lp_vault), (pool, mint, info.lp_mint, lp_vault));
    assert_eq!(lock.lp_locked, lp_locked);
    let reward_vault = Pubkey::find_program_address(&[fumpad::REWARD_VAULT_SEED, mint.as_ref()], &fumpad::ID).0;
    assert_eq!(lock.base_dest, reward_vault);
    assert_eq!(lock.quote_dest, ata(&coin_pda(&mint), &WSOL_MINT, &SPL_TOKEN));
    // PumpSwap's lp_supply counts every minted LP; the creator (→ locker) got all but the
    // pool's permanently locked minimum.
    let lp_supply = u64::from_le_bytes(env.account(&pool).unwrap().data[203..211].try_into().unwrap());
    assert_eq!(lock.lp_supply_at_lock, lp_supply);
    assert!(lp_locked <= lp_supply && lp_supply - lp_locked < 1_000_000, "locked {lp_locked} of {lp_supply}");
    assert!(!exists(&env, &ata(&pa, &info.lp_mint, &TOKEN_2022)));
    assert!(!exists(&env, &ata(&pa, &WSOL_MINT, &SPL_TOKEN)));
    assert_eq!(env.lamports(&pa), 0);
    let ev = events::<Graduated>(&meta);
    assert_eq!(ev.len(), 1);
    let ev = &ev[0];
    assert_eq!((ev.mint, ev.pool), (mint, pool));
    assert_eq!((ev.sol_deposited, ev.tokens_deposited), (sol_deposited, p.lp_supply));
    assert_eq!(ev.lp_locked, lp_locked);
    // D20: the fee is split exactly into caller refund + PDA pre-funding + platform remainder.
    assert_eq!(ev.caller_refund + ev.setup_prefunded + ev.platform_fee, p.graduation_fee_lamports);
    let rent = |len: usize| env.svm.minimum_balance_for_rent_exemption(len);
    let obs_key = pda(&[fumpad::OBSERVATIONS_SEED, mint.as_ref()]);
    let queue_key = pda(&[fumpad::CLAIM_QUEUE_SEED, mint.as_ref()]);
    let (obs_rent, queue_rent) = (rent(fumpad::OBSERVATIONS_SPACE), rent(fumpad::CLAIM_QUEUE_SPACE));
    assert_eq!(env.lamports(&obs_key) + env.lamports(&queue_key), ev.setup_prefunded);
    let caller_net = payer_before - env.lamports(&payer); // incl. the 5000-lamport tx fee
    let gross_rent = caller_net - 5_000 + ev.caller_refund;
    assert!(gross_rent < GRADUATION_RENT_BUDGET / 2, "graduate rent {gross_rent}");
    println!(
        "graduate: caller rent {gross_rent}, refunded {}, prefunded obs {} + queue {}, platform {}",
        ev.caller_refund,
        env.lamports(&obs_key),
        env.lamports(&queue_key),
        ev.platform_fee
    );
    let full_setup = gross_rent + obs_rent + queue_rent;
    if p.graduation_fee_lamports >= full_setup {
        // Self-funding: caller net = tx fee only; both PDAs hold their full rent.
        assert_eq!(caller_net, 5_000, "graduate costs the caller nothing but the tx fee");
        assert_eq!((env.lamports(&obs_key), env.lamports(&queue_key)), (obs_rent, queue_rent));
        assert_eq!(ev.platform_fee, p.graduation_fee_lamports - full_setup);
    } else {
        // Priority: caller, observations, queue; nothing left for the platform.
        assert_eq!(ev.platform_fee, 0);
        assert_eq!(ev.caller_refund, gross_rent.min(p.graduation_fee_lamports));
    }

    // Price continuity: PumpSwap opens at the curve's final price — for every fee, since
    // `is_valid` requires curve constants derived with it (D20, SPEC §3; L-2 v0.6).
    let pool_price = price_q64(sol_deposited, p.lp_supply).unwrap();
    let diff = pool_price.abs_diff(curve_price);
    assert!(diff * 1_000_000 <= curve_price, "curve {curve_price} vs pool {pool_price}");

    let g: Coin = env.fetch(&coin_pda(&mint));
    assert_eq!(g.status, CoinStatus::Graduated);
    assert_eq!(g.amm_pool, pool);
    assert_eq!(g.graduated_at, env.now());
    assert_eq!(g.real_sol_reserves, 0);
    assert_eq!(g.platform_fees_unclaimed, c.platform_fees_unclaimed + ev.platform_fee);
    assert_eq!(g.buyback_lamports, c.buyback_lamports);
    assert_eq!(token_amount(&env, &curve_vault(&mint)), 0);
    assert_lamport_invariant(&env, &mint);

    // D20: the keeper's init_observations + 9× init_claim_queue then cost it only the tx
    // fees (or exactly the shortfall when the fee didn't cover everything).
    let keeper = env.new_user(10);
    let kp = kp_pk(&keeper);
    let k_before = env.lamports(&kp);
    let obs_ix = ix(
        fumpad::accounts::InitObservations { payer: kp, coin: coin_pda(&mint), observations: obs_key, system_program: SYSTEM },
        fumpad::instruction::InitObservations {},
    );
    ok(env.send_as(&keeper, &[obs_ix], &[&keeper]));
    let q_ix = ix(
        fumpad::accounts::InitClaimQueue { payer: kp, coin: coin_pda(&mint), claim_queue: queue_key, system_program: SYSTEM },
        fumpad::instruction::InitClaimQueue {},
    );
    ok(env.send_as(&keeper, &vec![q_ix; fumpad::CLAIM_QUEUE_INIT_CALLS], &[&keeper]));
    let keeper_paid = k_before - env.lamports(&kp) - 2 * 5_000;
    assert_eq!(keeper_paid, (obs_rent + queue_rent) - ev.setup_prefunded, "keeper pays only the shortfall");
    assert_eq!((env.lamports(&obs_key), env.lamports(&queue_key)), (obs_rent, queue_rent));
    assert_eq!(env.account(&queue_key).unwrap().data.len(), fumpad::CLAIM_QUEUE_SPACE);

    // Terminal: no second graduation, no curve trading.
    assert_fumpad_err(graduate(&mut env, &mint), FumpadError::WrongCoinStatus);
    assert_fumpad_err(buy(&mut env, &whale, &mint, SOL, 1), FumpadError::WrongCoinStatus);
    assert_fumpad_err(sell(&mut env, &whale, &mint, 1_000_000, 0), FumpadError::WrongCoinStatus);
}

#[test]
fn graduate_creates_pumpswap_pool_and_locks_lp() {
    graduate_flow(Params::default());
}

/// D20: a fee below the setup cost funds the caller, then the ring, then part of the queue;
/// the keeper tops up the rest and the platform gets nothing.
#[test]
fn graduate_with_partial_fee_funds_setup_in_order() {
    graduate_flow(params_for_graduation_fee(SOL / 4));
}

/// Fee 0 (pre-D20 behaviour): the caller pays its rent, the keeper the whole setup.
#[test]
fn graduate_with_zero_fee_leaves_setup_to_callers() {
    graduate_flow(params_for_graduation_fee(0));
}

/// A fee too small to make a fresh PDA rent-exempt is not split into dust: it refunds the
/// caller as far as it goes.
#[test]
fn graduate_with_tiny_fee_refunds_caller_only() {
    graduate_flow(params_for_graduation_fee(1_000));
}

#[test]
fn graduate_rejections() {
    let mut env = env();
    let creator = env.new_user(10);
    let mint = create_coin(&mut env, &creator);
    let whale = env.new_user(1_000);
    ok(buy(&mut env, &whale, &mint, SOL, 1));
    // Not complete yet.
    assert_fumpad_err(graduate(&mut env, &mint), FumpadError::WrongCoinStatus);
    complete_curve(&mut env, &mint, &whale);

    let payer = kp_pk(&env.payer);
    let send = |env: &mut Env, a: fumpad::accounts::Graduate| {
        let i = ix(a, fumpad::instruction::Graduate {});
        env.send(&[cu_limit(GRADUATE_CU), i], &[])
    };
    // Wrong pool (index 1) / wrong LP mint / wrong LP account / fake AMM program / config.
    let mut a = graduate_accounts(&env, &payer, &mint);
    a.amm_pool = pool_pda(1, &pool_authority(), &mint, &WSOL_MINT);
    assert_fumpad_err(send(&mut env, a), FumpadError::WrongVenue);
    let mut a = graduate_accounts(&env, &payer, &mint);
    a.lp_mint = Pubkey::new_unique();
    assert_fumpad_err(send(&mut env, a), FumpadError::WrongVenue);
    let mut a = graduate_accounts(&env, &payer, &mint);
    a.pool_authority_lp = ata(&payer, &a.lp_mint, &TOKEN_2022);
    assert_fumpad_err(send(&mut env, a), FumpadError::InvalidAccount);
    let mut a = graduate_accounts(&env, &payer, &mint);
    a.amm_program = Pubkey::new_unique();
    assert_fumpad_err(send(&mut env, a), FumpadError::WrongVenue);
    let mut a = graduate_accounts(&env, &payer, &mint);
    a.amm_global_config = Pubkey::new_unique();
    assert_custom(send(&mut env, a), anchor_lang::error::ErrorCode::ConstraintAddress as u32);
    // Wrong WSOL mint.
    let mut a = graduate_accounts(&env, &payer, &mint);
    a.wsol_mint = mint;
    assert!(send(&mut env, a).is_err());
    // Another coin's vault.
    let other = create_coin(&mut env, &creator);
    let mut a = graduate_accounts(&env, &payer, &mint);
    a.curve_vault = curve_vault(&other);
    assert_custom(send(&mut env, a), anchor_lang::error::ErrorCode::ConstraintSeeds as u32);
    // Graduate the uncompleted other coin.
    assert_fumpad_err(graduate(&mut env, &other), FumpadError::WrongCoinStatus);
    // D11 locker: fake locker program / wrong Lock PDA / LP vault not the locker's ATA.
    let mut a = graduate_accounts(&env, &payer, &mint);
    a.lp_locker_program = Pubkey::new_unique();
    assert!(send(&mut env, a).is_err());
    let mut a = graduate_accounts(&env, &payer, &mint);
    a.lp_lock = crate::flow::locker_accounts(&Pubkey::new_unique()).0;
    assert_custom(send(&mut env, a), anchor_lang::error::ErrorCode::ConstraintSeeds as u32);
    let mut a = graduate_accounts(&env, &payer, &mint);
    a.lp_vault = ata(&payer, &a.lp_mint, &TOKEN_2022);
    assert!(send(&mut env, a).is_err());
    let mut a = graduate_accounts(&env, &payer, &mint);
    a.lp_locker_authority = payer;
    assert!(send(&mut env, a).is_err());

    // Nothing above changed state; the real call still works.
    assert_lamport_invariant(&env, &mint);
    ok(graduate(&mut env, &mint));
}

/// Pause flags don't block graduation (liquidity must be able to leave the curve).
#[test]
fn graduate_is_permissionless_and_not_paused() {
    let mut env = env();
    let creator = env.new_user(10);
    let mint = create_coin(&mut env, &creator);
    let whale = env.new_user(1_000);
    complete_curve(&mut env, &mint, &whale);
    set_pause(&mut env, PAUSE_LAUNCH | PAUSE_TRADE | PAUSE_CLAIMS);
    // A random wallet pays and signs.
    let rando = env.new_user(1);
    let i = ix(graduate_accounts(&env, &kp_pk(&rando), &mint), fumpad::instruction::Graduate {});
    ok(env.send_as(&rando, &[cu_limit(GRADUATE_CU), i], &[&rando]));
    assert_eq!(env.fetch::<Coin>(&coin_pda(&mint)).status, CoinStatus::Graduated);
}

/// Griefing check: anyone can pre-create the pool's ATAs (their addresses are
/// predictable). Graduation must still go through.
#[test]
fn graduate_survives_precreated_pool_token_accounts() {
    let mut env = env();
    let creator = env.new_user(10);
    let mint = create_coin(&mut env, &creator);
    let whale = env.new_user(1_000);
    complete_curve(&mut env, &mint, &whale);

    let pa = pool_authority();
    let pool = pool_pda(0, &pa, &mint, &WSOL_MINT);
    let attacker = env.new_user(1);
    let ak = kp_pk(&attacker);
    let create_ata = |owner: &Pubkey, m: &Pubkey, tp: &Pubkey| solana_instruction::Instruction {
        program_id: addr(&ATA_PROGRAM),
        accounts: vec![
            solana_instruction::AccountMeta::new(addr(&ak), true),
            solana_instruction::AccountMeta::new(addr(&ata(owner, m, tp)), false),
            solana_instruction::AccountMeta::new_readonly(addr(owner), false),
            solana_instruction::AccountMeta::new_readonly(addr(m), false),
            solana_instruction::AccountMeta::new_readonly(addr(&SYSTEM), false),
            solana_instruction::AccountMeta::new_readonly(addr(tp), false),
        ],
        data: vec![1], // CreateIdempotent
    };
    ok(env.send_as(
        &attacker,
        &[
            create_ata(&pool, &mint, &TOKEN_2022),
            create_ata(&pool, &WSOL_MINT, &SPL_TOKEN),
            create_ata(&pa, &WSOL_MINT, &SPL_TOKEN),
        ],
        &[&attacker],
    ));
    ok(graduate(&mut env, &mint));
    assert_eq!(env.fetch::<Coin>(&coin_pda(&mint)).status, CoinStatus::Graduated);
}

/// With a curve priced above 1 lamport per base unit, a 1-lamport buy rounds to zero
/// tokens and must be rejected rather than silently taking the lamport.
#[test]
fn dust_buy_rounding_to_zero_is_rejected() {
    let v0 = 10 * fumpad::DEFAULT_INITIAL_VIRTUAL_TOKEN;
    let params = curve_params(v0, v0 / 30 * 85, fumpad::DEFAULT_GRADUATION_FEE_LAMPORTS);
    let mut env = env_with(params);
    let creator = env.new_user(10);
    let mint = create_coin(&mut env, &creator);
    let u = env.new_user(10);
    assert_fumpad_err(buy(&mut env, &u, &mint, 1, 0), FumpadError::ZeroAmount);
    ok(buy(&mut env, &u, &mint, 1_000, 1));
    assert_lamport_invariant(&env, &mint);
}

/// D14: a coin graduates with the fee snapshotted at `create_coin`; a (timelocked) change
/// of the global fee afterwards applies only to coins created later, and is capped at 1 SOL.
#[test]
fn graduate_uses_fee_snapshotted_at_create() {
    let mut env = env();
    let creator = env.new_user(10);
    let mint = create_coin(&mut env, &creator);
    assert_eq!(env.fetch::<Coin>(&coin_pda(&mint)).fees, Params::default().coin_fees());
    let whale = env.new_user(1_000);
    complete_curve(&mut env, &mint, &whale);
    let raised = env.fetch::<Coin>(&coin_pda(&mint)).real_sol_reserves;
    // Above the 1 SOL hard cap: refused at queue time.
    let too_big = Params { graduation_fee_lamports: raised, graduation_lamports: 200 * SOL, ..Params::default() };
    assert_fumpad_err(env.queue_params(too_big), FumpadError::InvalidParams);
    // At the cap: accepted after 48h, but not for this (already created) coin.
    env.set_params_timelocked(params_for_graduation_fee(SOL));
    let before = env.fetch::<Coin>(&coin_pda(&mint));
    let meta = ok(graduate(&mut env, &mint));
    let c = env.fetch::<Coin>(&coin_pda(&mint));
    assert_eq!(c.status, CoinStatus::Graduated);
    let ev = &events::<Graduated>(&meta)[0];
    assert_eq!(
        ev.caller_refund + ev.setup_prefunded + ev.platform_fee,
        fumpad::DEFAULT_GRADUATION_FEE_LAMPORTS,
        "snapshotted fee (0.65 SOL) charged, not the new 1 SOL"
    );
    assert_eq!(ev.sol_deposited, before.real_sol_reserves - fumpad::DEFAULT_GRADUATION_FEE_LAMPORTS);
    assert_eq!(c.platform_fees_unclaimed, before.platform_fees_unclaimed + ev.platform_fee);
    assert_lamport_invariant(&env, &mint);
    // A coin created after the change snapshots the new fee.
    let mint2 = create_coin(&mut env, &creator);
    assert_eq!(env.fetch::<Coin>(&coin_pda(&mint2)).fees.graduation_fee_lamports, SOL);
}

// ═════════════════════════════════════════════════════════════════════════════
// D19 snipe protection
// ═════════════════════════════════════════════════════════════════════════════

fn slot(env: &Env) -> u64 {
    env.svm.get_sysvar::<litesvm_clock::Clock>().slot
}

fn set_slot(env: &mut Env, s: u64) {
    let mut c = env.svm.get_sysvar::<litesvm_clock::Clock>();
    c.slot = s;
    env.svm.set_sysvar(&c);
}

/// Create a coin and stay in its launch slot (no `skip_snipe_window`).
fn launch(env: &mut Env, creator: &Keypair) -> Pubkey {
    let (mint, res) = create_coin_with(env, creator, "Snipe", "SNP", "");
    ok(res);
    kp_pk(&mint)
}

fn buy_ix(env: &Env, user: &Pubkey, mint: &Pubkey, sol_in: u64, min_out: u64) -> solana_instruction::Instruction {
    ix(buy_accounts(env, user, mint), fumpad::instruction::Buy { sol_in, min_tokens_out: min_out })
}

/// What a curve buy of `sol_in` at snipe rate `bps` does to `before` (mirror of `buy`).
struct SnipeExpect {
    q: BuyQuote,
    fee: fumpad::math::fees::FeeSplit,
    tax: u64,
    pool_tokens: u64,
}

fn expect_buy(before: &Coin, sol_in: u64, bps: u16) -> SnipeExpect {
    let offer = snipe_curve_offer(sol_in, bps).unwrap();
    let r = reserves(before);
    let q = quote_buy(&r, offer).unwrap();
    let fee = compute_fee(q.sol_used, &before.fees).unwrap();
    let tax = snipe_tax(q.sol_used, bps).unwrap();
    let mut after = r;
    after.apply_buy(&q).unwrap();
    let bb = quote_buy(&after, fee.pool + tax).unwrap();
    SnipeExpect { q, fee, tax, pool_tokens: bb.tokens_out }
}

/// Buyer's lamports spent on the trade itself (excludes the ATA + position rent it paid).
fn trade_cost(env: &Env, user: &Pubkey, mint: &Pubkey, lamports_before: u64) -> u64 {
    let rents = env.lamports(&ata(user, mint, &TOKEN_2022)) + env.lamports(&position_pda(mint, user));
    lamports_before - env.lamports(user) - rents
}

/// Buys at slot offsets 0..=W+1 pay 99 / 75 / 50 / 25 % then the normal fee only. The tax
/// is carved out of `sol_in` (curve gets the rest, normal fee on top of that), lands in
/// the reward pool via the inline buyback, and the lamport invariant holds.
#[test]
fn snipe_tax_follows_schedule_by_slot_offset() {
    let mut env = env();
    let p = Params::default();
    let creator = env.new_user(10);
    let schedule = [9_900u16, 7_500, 5_000, 2_500, 0, 0];
    assert_eq!(schedule.len(), p.snipe_window_slots as usize + 2);
    for (d, &bps) in schedule.iter().enumerate() {
        let mint = launch(&mut env, &creator);
        let launch_slot = slot(&env);
        env.advance_slots(d as u64);
        let buyer = env.new_user(100);
        let bk = kp_pk(&buyer);
        let before: Coin = env.fetch(&coin_pda(&mint));
        assert_eq!(before.snipe.launch_slot, launch_slot);
        let sol_in = SOL;
        let e = expect_buy(&before, sol_in, bps);
        let (lamports, pool_tokens) = (env.lamports(&bk), token_amount(&env, &reward_vault(&mint)));

        let meta = ok(buy(&mut env, &buyer, &mint, sol_in, e.q.tokens_out));
        let t = &events::<Trade>(&meta)[0];
        assert_eq!((t.snipe_tax_bps, t.snipe_tax), (bps, e.tax), "offset {d}");
        assert_eq!((t.sol_amount, t.token_amount), (e.q.sol_used, e.q.tokens_out));
        assert_eq!((t.fee_pool, t.fee_platform, t.fee_creator), (e.fee.pool, e.fee.platform, e.fee.creator));
        assert_eq!(t.pool_tokens_bought, e.pool_tokens);
        assert_eq!(token_amount(&env, &reward_vault(&mint)) - pool_tokens, e.pool_tokens, "tax bought into the pool");
        assert_eq!(token_amount(&env, &ata(&bk, &mint, &TOKEN_2022)), e.q.tokens_out);
        // Charged exactly curve + normal fee + tax, never more than outside the window.
        let cost = trade_cost(&env, &bk, &mint, lamports);
        assert_eq!(cost, e.q.sol_used + e.fee.total + e.tax);
        assert!(e.q.sol_used + e.tax <= sol_in && cost <= sol_in + compute_fee(sol_in, &before.fees).unwrap().total);
        if bps == 0 {
            assert_eq!(e.q.sol_used, sol_in);
        } else {
            // tax ≈ bps of (curve + tax), rounded up for the pool.
            let share = e.tax as u128 * 10_000 / (e.tax + e.q.sol_used) as u128;
            assert!(share.abs_diff(bps as u128) <= 1, "offset {d}: share {share}");
        }
        let c: Coin = env.fetch(&coin_pda(&mint));
        assert_eq!(c.platform_fees_unclaimed, e.fee.platform, "platform gets only the normal share");
        assert_eq!(c.creator_fees_unclaimed, e.fee.creator, "creator gets only the normal share");
        assert_lamport_invariant(&env, &mint);
        assert_vault_invariant(&env, &mint, &p);
    }
}

/// The creator's buy inside the `create_coin` transaction is exempt; a second creator buy
/// in that same transaction is not (it is no longer the coin's first trade).
#[test]
fn snipe_creator_buy_bundled_with_create_is_exempt() {
    let mut env = env();
    let creator = env.new_user(100);
    let ck = kp_pk(&creator);
    let mint_kp = Keypair::new();
    let mint = kp_pk(&mint_kp);
    let create = create_coin_ix(&ck, &mint, "Snipe", "SNP", "", &env);
    let first = buy_ix(&env, &ck, &mint, 2 * SOL, 1);
    let second = buy_ix(&env, &ck, &mint, SOL, 1);
    let meta = ok(env.send(&[create, first, second], &[&creator, &mint_kp]));
    let t = events::<Trade>(&meta);
    assert_eq!(t.len(), 2);
    assert_eq!((t[0].snipe_tax_bps, t[0].snipe_tax, t[0].sol_amount), (0, 0, 2 * SOL), "launch buy exempt");
    assert_eq!(t[1].snipe_tax_bps, 9_900, "second creator buy in the launch tx is taxed");
    assert_eq!(t[1].sol_amount, SOL / 100);
    assert_eq!(t[1].snipe_tax, 99 * SOL / 100);
    assert_lamport_invariant(&env, &mint);
}

/// Dev alt wallets in the launch slot — bundled into the launch transaction or not — pay
/// the tax; so does the creator once another trade happened, or in a later slot.
#[test]
fn snipe_alts_and_later_creator_buys_pay_the_tax() {
    let mut env = env();
    let creator = env.new_user(100);
    let alt = env.new_user(100);
    let (ck, ak) = (kp_pk(&creator), kp_pk(&alt));

    // a) alt wallet's buy bundled into the launch transaction (creator co-signs).
    let mint_kp = Keypair::new();
    let mint = kp_pk(&mint_kp);
    let create = create_coin_ix(&ck, &mint, "Snipe", "SNP", "", &env);
    let alt_buy = buy_ix(&env, &ak, &mint, SOL, 1);
    let meta = ok(env.send(&[create, alt_buy], &[&creator, &mint_kp, &alt]));
    assert_eq!(events::<Trade>(&meta)[0].snipe_tax_bps, 9_900);
    // b) another alt in the launch slot, separate transaction.
    let alt2 = env.new_user(100);
    let meta = ok(buy(&mut env, &alt2, &mint, SOL, 1));
    assert_eq!(events::<Trade>(&meta)[0].snipe_tax_bps, 9_900);
    // c) the creator in the launch slot, but after other trades.
    let meta = ok(buy(&mut env, &creator, &mint, SOL, 1));
    assert_eq!(events::<Trade>(&meta)[0].snipe_tax_bps, 9_900);
    assert_lamport_invariant(&env, &mint);

    // d) the creator's first buy one slot after launch.
    let mint2 = launch(&mut env, &creator);
    env.advance_slots(1);
    let meta = ok(buy(&mut env, &creator, &mint2, SOL, 1));
    assert_eq!(events::<Trade>(&meta)[0].snipe_tax_bps, 7_500);

    // e) the creator's own separate transaction in the launch slot that is still the coin's
    //    first trade is exempt too — equivalent to bundling it (nothing traded in between).
    let mint3 = launch(&mut env, &creator);
    let meta = ok(buy(&mut env, &creator, &mint3, SOL, 1));
    assert_eq!(events::<Trade>(&meta)[0].snipe_tax, 0);
}

/// Sells in the window pay the normal fee only.
#[test]
fn snipe_tax_does_not_apply_to_sells() {
    let mut env = env();
    let creator = env.new_user(100);
    let ck = kp_pk(&creator);
    let mint_kp = Keypair::new();
    let mint = kp_pk(&mint_kp);
    let create = create_coin_ix(&ck, &mint, "Snipe", "SNP", "", &env);
    let b = buy_ix(&env, &ck, &mint, 5 * SOL, 1);
    ok(env.send(&[create, b], &[&creator, &mint_kp]));
    let held = token_amount(&env, &ata(&ck, &mint, &TOKEN_2022));
    let before: Coin = env.fetch(&coin_pda(&mint));
    let gross = quote_sell(&reserves(&before), held / 2).unwrap();
    let fee = compute_fee(gross, &before.fees).unwrap();
    let lamports = env.lamports(&ck);
    let meta = ok(sell(&mut env, &creator, &mint, held / 2, 0)); // slot offset 0
    let t = &events::<Trade>(&meta)[0];
    assert!(!t.is_buy);
    assert_eq!((t.snipe_tax, t.snipe_tax_bps), (0, 0));
    assert_eq!((t.sol_amount, t.fee_pool + t.fee_platform + t.fee_creator), (gross, fee.total));
    assert_eq!(env.lamports(&ck) - lamports, gross - fee.total);
    assert_lamport_invariant(&env, &mint);
}

/// A buy that completes the curve inside the window pays the tax on the SOL the curve
/// actually took; the tax (curve now empty) waits in `buyback_lamports`.
#[test]
fn snipe_tax_on_completing_buy_follows_sol_used() {
    let mut env = env();
    let p = Params::default();
    let creator = env.new_user(10);
    let mint = launch(&mut env, &creator);
    env.advance_slots(3); // 25%
    let whale = env.new_user(1_000);
    let wk = kp_pk(&whale);
    let before: Coin = env.fetch(&coin_pda(&mint));
    let sol_in = 400 * SOL;
    let e = expect_buy(&before, sol_in, 2_500);
    assert!(e.q.completes && e.q.sol_used < snipe_curve_offer(sol_in, 2_500).unwrap());
    assert_eq!(e.tax, (e.q.sol_used as u128 * 2_500).div_ceil(7_500) as u64);
    let lamports = env.lamports(&wk);
    let meta = ok(buy(&mut env, &whale, &mint, sol_in, 1));
    let t = &events::<Trade>(&meta)[0];
    assert_eq!((t.snipe_tax, t.pool_tokens_bought), (e.tax, 0));
    assert_eq!(trade_cost(&env, &wk, &mint, lamports), e.q.sol_used + e.fee.total + e.tax);
    let c: Coin = env.fetch(&coin_pda(&mint));
    assert_eq!(c.status, CoinStatus::Complete);
    assert_eq!(c.buyback_lamports, e.fee.pool + e.tax);
    assert_lamport_invariant(&env, &mint);
    assert_vault_invariant(&env, &mint, &p);
}

/// The schedule is fixed per coin at `create_coin`: a later (timelocked) change applies only
/// to coins launched after it.
#[test]
fn snipe_schedule_is_snapshotted_at_create() {
    let mut env = env();
    let creator = env.new_user(100);
    let mint_a = launch(&mut env, &creator);
    let launch_a = slot(&env);
    env.set_params_timelocked(Params { snipe_window_slots: 0, ..Params::default() });
    set_slot(&mut env, launch_a + 1); // back inside A's window (the 48h warp moved slots)
    let buyer = env.new_user(100);
    let meta = ok(buy(&mut env, &buyer, &mint_a, SOL, 1));
    assert_eq!(events::<Trade>(&meta)[0].snipe_tax_bps, 7_500, "A keeps its launch schedule");

    let mint_b = launch(&mut env, &creator);
    let b: Coin = env.fetch(&coin_pda(&mint_b));
    assert_eq!(b.snipe, SnipeConfig { launch_slot: launch_a + 1, window_slots: 0, start_bps: 9_900 });
    let meta = ok(buy(&mut env, &buyer, &mint_b, SOL, 1));
    assert_eq!(events::<Trade>(&meta)[0].snipe_tax, 0, "B launched with protection off");
}

/// `Params::is_valid` caps: start ≤ 99%, window ≤ 50 slots.
#[test]
fn snipe_params_are_capped() {
    let mut env = env();
    let d = Params::default();
    assert_fumpad_err(env.queue_params(Params { snipe_start_bps: 9_901, ..d }), FumpadError::InvalidParams);
    assert_fumpad_err(env.queue_params(Params { snipe_window_slots: 51, ..d }), FumpadError::InvalidParams);
    ok(env.queue_params(Params { snipe_start_bps: 9_900, snipe_window_slots: 50, ..d }));
    ok(env.queue_params(Params { snipe_start_bps: 0, snipe_window_slots: 0, ..d }));
}

/// A buyer quoting without the tax is protected by `min_tokens_out`.
#[test]
fn snipe_tax_respects_slippage_guard() {
    let mut env = env();
    let creator = env.new_user(10);
    let mint = launch(&mut env, &creator);
    let bot = env.new_user(100);
    let untaxed = quote_buy(&reserves(&env.fetch::<Coin>(&coin_pda(&mint))), SOL).unwrap().tokens_out;
    assert_fumpad_err(buy(&mut env, &bot, &mint, SOL, untaxed), FumpadError::SlippageExceeded);
}

/// CU of a curve buy inside vs outside the window (same wallet and coin, so PDA bump
/// searches cost the same; the wallet's ATA + position already exist).
#[test]
fn snipe_tax_compute_units() {
    let mut env = env();
    let creator = env.new_user(10);
    let mint = launch(&mut env, &creator);
    let a = env.new_user(100);
    let first = ok(buy(&mut env, &a, &mint, SOL, 1)).compute_units_consumed;
    env.advance_slots(1);
    let taxed = ok(buy(&mut env, &a, &mint, SOL, 1)).compute_units_consumed;
    env.skip_snipe_window();
    let normal = ok(buy(&mut env, &a, &mint, SOL, 1)).compute_units_consumed;
    println!("buy CU: first (taxed, creates ATA + position) {first}, taxed {taxed}, normal {normal}");
    assert!(taxed < normal + 2_000, "taxed {taxed} vs normal {normal}");
}
