//! Venue/oracle integration tests: router (swap_buy / swap_sell), oracle sampler
//! (init_observations / record_samples) and buyback crank — against the REAL PumpSwap
//! program. Graduation isn't on this branch, so each test creates a PumpSwap pool itself
//! (from a Token-2022 mint) and fabricates a Graduated `Coin` pointing at it.

use anchor_lang::{
    prelude::{AccountMeta as Meta, Pubkey},
    pubkey, AccountSerialize, Space,
};
use fumpad::{
    error::FumpadError,
    math::reference::ReferencePrice,
    external::pumpswap::{SPL_TOKEN_2022_PROGRAM_ID as T22, SPL_TOKEN_PROGRAM_ID as TOKEN, WSOL_MINT},
    state::*,
    PUMPSWAP_GLOBAL_CONFIG, PUMPSWAP_PROGRAM_ID, PUMP_FEES_PROGRAM_ID,
};
use litesvm::types::TransactionResult;
use solana_account::Account;
use solana_instruction::{AccountMeta as Meta4, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;

use crate::*;

const ATA_PROGRAM: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM: Pubkey = anchor_lang::system_program::ID;
const IX_SYSVAR: Pubkey = pubkey!("Sysvar1nstructions1111111111111111111111111");
const COMPUTE_BUDGET: Pubkey = pubkey!("ComputeBudget111111111111111111111111111111");
const FEE_CONFIG: Pubkey = pubkey!("5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx");
const START_TS: i64 = 1_760_000_000;

const POOL_BASE_IN: u64 = 196_551_724_137_931; // DEFAULT_LP_SUPPLY
const POOL_QUOTE_IN: u64 = 85 * SOL;
const USER_TOKENS: u64 = 100_000_000_000_000; // tokens minted to the LP creator besides the pool

// ── low-level helpers ─────────────────────────────────────────────────────────

fn ata(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), token_program.as_ref(), mint.as_ref()], &ATA_PROGRAM).0
}

fn pda(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}

fn raw_ix(program: Pubkey, metas: Vec<Meta>, data: Vec<u8>) -> Instruction {
    Instruction {
        program_id: addr(&program),
        accounts: metas
            .into_iter()
            .map(|m| Meta4 { pubkey: addr(&m.pubkey), is_signer: m.is_signer, is_writable: m.is_writable })
            .collect(),
        data,
    }
}

fn cu_limit(units: u32) -> Instruction {
    let mut d = vec![2u8];
    d.extend_from_slice(&units.to_le_bytes());
    raw_ix(COMPUTE_BUDGET, vec![], d)
}

fn w(k: Pubkey) -> Meta {
    Meta::new(k, false)
}
fn r(k: Pubkey) -> Meta {
    Meta::new_readonly(k, false)
}
fn ws(k: Pubkey) -> Meta {
    Meta::new(k, true)
}

fn set(env: &mut Env, key: Pubkey, owner: Pubkey, data: Vec<u8>, lamports: Option<u64>) {
    let lamports = lamports.unwrap_or_else(|| env.svm.minimum_balance_for_rent_exemption(data.len()));
    env.svm
        .set_account(addr(&key), Account { lamports, data, owner: addr(&owner), executable: false, rent_epoch: 0 })
        .unwrap();
}

fn put_mint(env: &mut Env, key: Pubkey, supply: u64, decimals: u8, program: Pubkey) {
    let mut d = vec![0u8; 82];
    d[36..44].copy_from_slice(&supply.to_le_bytes());
    d[44] = decimals;
    d[45] = 1;
    set(env, key, program, d, None);
}

/// Plain (extension-less) SPL / Token-2022 account; WSOL accounts are native.
fn put_token_account(env: &mut Env, key: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64, program: Pubkey) {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1; // Initialized
    let rent = env.svm.minimum_balance_for_rent_exemption(165);
    let mut lamports = rent;
    if mint == WSOL_MINT {
        d[109..113].copy_from_slice(&1u32.to_le_bytes());
        d[113..121].copy_from_slice(&rent.to_le_bytes());
        lamports += amount;
    }
    set(env, key, program, d, Some(lamports));
}

fn token_balance(env: &Env, key: &Pubkey) -> u64 {
    let a = env.account(key).unwrap_or_else(|| panic!("token account {key} missing"));
    u64::from_le_bytes(a.data[64..72].try_into().unwrap())
}

fn code(e: FumpadError) -> (String, u32) {
    let name = format!("{e:?}");
    (name, anchor_lang::error::ERROR_CODE_OFFSET + e as u32)
}

#[track_caller]
fn expect_err(res: TransactionResult, e: FumpadError) {
    let (name, c) = code(e);
    match res {
        Ok(_) => panic!("expected {name} ({c}), but the transaction succeeded"),
        Err(f) => {
            let s = format!("{:?}", f.err);
            assert!(s.contains(&format!("Custom({c})")), "expected {name} ({c}), got {s}\nlogs: {:#?}", f.meta.logs);
        }
    }
}

#[track_caller]
fn expect_ok(res: TransactionResult) {
    if let Err(f) = res {
        panic!("tx failed: {:?}\nlogs: {:#?}", f.err, f.meta.logs);
    }
}

// ── fixture ──────────────────────────────────────────────────────────────────

struct Fx {
    env: Env,
    mint: Pubkey,
    pool: Pubkey,
    pool_base: Pubkey,
    pool_quote: Pubkey,
    coin: Pubkey,
    observations: Pubkey,
    reward_vault: Pubkey,
    buyback_fee_recipient_ata: Pubkey,
    lp: Keypair,
}

fn pool_authority() -> Pubkey {
    pda(&[fumpad::POOL_AUTHORITY_SEED], &fumpad::ID)
}

fn event_authority() -> Pubkey {
    pda(&[b"__event_authority"], &fumpad::ID)
}

fn pumpswap_event_authority() -> Pubkey {
    pda(&[b"__event_authority"], &PUMPSWAP_PROGRAM_ID)
}

fn user_volume_accumulator(user: &Pubkey) -> Pubkey {
    pda(&[b"user_volume_accumulator", user.as_ref()], &PUMPSWAP_PROGRAM_ID)
}

/// First buyback fee recipient from the dumped GlobalConfig (offset per IDL layout).
fn buyback_fee_recipient(env: &Env) -> Pubkey {
    let gc = env.account(&PUMPSWAP_GLOBAL_CONFIG).unwrap();
    Pubkey::new_from_array(gc.data[643..675].try_into().unwrap())
}

fn create_pool(env: &mut Env, creator: &Keypair, mint: Pubkey, index: u16, base_in: u64, quote_in: u64) -> Pubkey {
    let c = kp_pk(creator);
    let pool = pda(&[b"pool", &index.to_le_bytes(), c.as_ref(), mint.as_ref(), WSOL_MINT.as_ref()], &PUMPSWAP_PROGRAM_ID);
    let lp_mint = pda(&[b"pool_lp_mint", pool.as_ref()], &PUMPSWAP_PROGRAM_ID);
    let mut data = vec![233, 146, 209, 142, 207, 104, 64, 188];
    data.extend_from_slice(&index.to_le_bytes());
    data.extend_from_slice(&base_in.to_le_bytes());
    data.extend_from_slice(&quote_in.to_le_bytes());
    data.extend_from_slice(Pubkey::default().as_ref()); // coin_creator
    data.push(0); // is_mayhem_mode
    data.push(0); // is_cashback_coin
    data.extend_from_slice(&0u64.to_le_bytes()); // creator_fee_bps
    data.push(0); // can_edit_creator_fee
    data.push(0); // is_holder_reward
    let metas = vec![
        w(pool),
        r(PUMPSWAP_GLOBAL_CONFIG),
        ws(c),
        r(mint),
        r(WSOL_MINT),
        w(lp_mint),
        w(ata(&c, &mint, &T22)),
        w(ata(&c, &WSOL_MINT, &TOKEN)),
        w(ata(&c, &lp_mint, &T22)),
        w(ata(&pool, &mint, &T22)),
        w(ata(&pool, &WSOL_MINT, &TOKEN)),
        r(SYSTEM),
        r(T22),
        r(T22),
        r(TOKEN),
        r(ATA_PROGRAM),
        r(pumpswap_event_authority()),
        r(PUMPSWAP_PROGRAM_ID),
    ];
    let ix = raw_ix(PUMPSWAP_PROGRAM_ID, metas, data);
    expect_ok(env.send_as(creator, &[cu_limit(1_000_000), ix], &[creator]));
    pool
}

fn coin_pda(mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[fumpad::COIN_SEED, mint.as_ref()], &fumpad::ID)
}

fn coin_len() -> usize {
    8 + Coin::INIT_SPACE
}

/// Fabricate a Coin account (lamports = rent + accounted balances, i.e. invariant holds).
fn put_coin(env: &mut Env, mint: Pubkey, pool: Pubkey, status: CoinStatus, buyback_lamports: u64) -> Pubkey {
    let (key, bump) = coin_pda(&mint);
    let coin = Coin {
        bump,
        mint,
        creator: Pubkey::new_unique(),
        status,
        created_at: START_TS - 3_600,
        virtual_sol_reserves: 0,
        virtual_token_reserves: 0,
        real_sol_reserves: 0,
        real_token_reserves: 0,
        completed_at: START_TS - 60,
        graduated_at: START_TS - 30,
        amm_pool: pool,
        creator_fees_unclaimed: 0,
        platform_fees_unclaimed: 0,
        buyback_lamports,
        volume_lamports: 0,
        trade_count: 0,
        tickets_created: 0,
        tokens_paid_out: 0,
        // D10 reference initialized at the pool's opening spot (as graduation carries it).
        reference: ReferencePrice::new(pool_spot_q64(env, &pool), START_TS - 30),
        fees: env.fetch::<fumpad::state::Global>(&env.global_pda()).params.coin_fees(),
        reserved: [0; 72],
    };
    let mut data = Vec::new();
    coin.try_serialize(&mut data).unwrap();
    data.resize(coin_len(), 0);
    let rent = env.svm.minimum_balance_for_rent_exemption(data.len());
    set(env, key, fumpad::ID, data, Some(rent + buyback_lamports));
    key
}

/// PumpSwap spot (quote vault + virtual quote reserves) / base vault, Q64. 0 if no pool.
pub(crate) fn pool_spot_q64(env: &Env, pool: &Pubkey) -> u128 {
    let Some(p) = env.account(pool).filter(|a| a.owner == addr(&PUMPSWAP_PROGRAM_ID)) else { return 0 };
    let key = |o: usize| Pubkey::new_from_array(p.data[o..o + 32].try_into().unwrap());
    let vqr = if p.data.len() >= 261 { i128::from_le_bytes(p.data[245..261].try_into().unwrap()) } else { 0 };
    let base = token_balance(env, &key(139)) as u128;
    let quote = (token_balance(env, &key(171)) as i128 + vqr) as u128;
    if base == 0 { 0 } else { (quote << 64) / base }
}

fn fetch_coin(env: &Env, key: &Pubkey) -> Coin {
    env.fetch(key)
}

#[track_caller]
fn assert_coin_invariant(env: &Env, key: &Pubkey) {
    let c = fetch_coin(env, key);
    let rent = env.svm.minimum_balance_for_rent_exemption(coin_len());
    assert_eq!(
        env.lamports(key),
        rent + c.real_sol_reserves + c.creator_fees_unclaimed + c.platform_fees_unclaimed + c.buyback_lamports,
        "Coin lamport invariant broken"
    );
}

fn setup() -> Fx {
    setup_with(Params::default())
}

fn setup_with(params: Params) -> Fx {
    let mut env = Env::with_params(params);
    let mut clock = env.svm.get_sysvar::<litesvm_clock::Clock>();
    clock.unix_timestamp = START_TS;
    env.svm.set_sysvar(&clock);
    load_account_fixture(&mut env.svm, "pump_fees_fee_config_amm.json");
    assert_eq!(pda(&[b"fee_config", PUMPSWAP_PROGRAM_ID.as_ref()], &PUMP_FEES_PROGRAM_ID), FEE_CONFIG);
    if env.account(&WSOL_MINT).is_none() {
        put_mint(&mut env, WSOL_MINT, 0, 9, TOKEN);
    }
    // Buyback fee recipient's WSOL ATA (exists on mainnet/devnet; PumpSwap never creates it).
    let bfr = buyback_fee_recipient(&env);
    let buyback_fee_recipient_ata = ata(&bfr, &WSOL_MINT, &TOKEN);
    put_token_account(&mut env, buyback_fee_recipient_ata, WSOL_MINT, bfr, 0, TOKEN);

    // Token-2022 mint + an LP creator holding tokens and WSOL.
    let mint = Pubkey::new_unique();
    put_mint(&mut env, mint, POOL_BASE_IN + 2 * USER_TOKENS, 6, T22);
    let lp = env.new_user(1_000);
    let lpk = kp_pk(&lp);
    put_token_account(&mut env, ata(&lpk, &mint, &T22), mint, lpk, POOL_BASE_IN + 2 * USER_TOKENS, T22);
    put_token_account(&mut env, ata(&lpk, &WSOL_MINT, &TOKEN), WSOL_MINT, lpk, 2 * POOL_QUOTE_IN, TOKEN);
    let pool = create_pool(&mut env, &lp, mint, 0, POOL_BASE_IN, POOL_QUOTE_IN);

    let coin = put_coin(&mut env, mint, pool, CoinStatus::Graduated, 0);
    let reward_vault = pda(&[fumpad::REWARD_VAULT_SEED, mint.as_ref()], &fumpad::ID);
    put_token_account(&mut env, reward_vault, mint, pool_authority(), 0, T22);

    // One-time buyback setup: PumpSwap volume accumulator for pool_authority.
    let pa = pool_authority();
    let init_uva = raw_ix(
        PUMPSWAP_PROGRAM_ID,
        vec![
            ws(kp_pk(&env.payer)),
            r(pa),
            w(user_volume_accumulator(&pa)),
            r(SYSTEM),
            r(pumpswap_event_authority()),
            r(PUMPSWAP_PROGRAM_ID),
        ],
        vec![94, 6, 202, 115, 255, 96, 232, 183],
    );
    expect_ok(env.send(&[init_uva], &[]));

    Fx {
        observations: pda(&[fumpad::OBSERVATIONS_SEED, mint.as_ref()], &fumpad::ID),
        pool_base: ata(&pool, &mint, &T22),
        pool_quote: ata(&pool, &WSOL_MINT, &TOKEN),
        env,
        mint,
        pool,
        coin,
        reward_vault,
        buyback_fee_recipient_ata,
        lp,
    }
}

impl Fx {
    /// PumpSwap buy/sell v2 account list (17) for `user`.
    fn venue(&self, user: Pubkey, user_base: Pubkey, user_quote: Pubkey) -> Vec<Meta> {
        self.venue_for_pool(self.pool, self.pool_base, self.pool_quote, user, user_base, user_quote)
    }

    fn venue_for_pool(
        &self,
        pool: Pubkey,
        pool_base: Pubkey,
        pool_quote: Pubkey,
        user: Pubkey,
        user_base: Pubkey,
        user_quote: Pubkey,
    ) -> Vec<Meta> {
        vec![
            w(pool),
            w(user),
            r(PUMPSWAP_GLOBAL_CONFIG),
            r(self.mint),
            r(WSOL_MINT),
            w(user_base),
            w(user_quote),
            w(pool_base),
            w(pool_quote),
            r(T22),
            r(TOKEN),
            r(SYSTEM),
            w(user_volume_accumulator(&user)),
            r(FEE_CONFIG),
            w(self.buyback_fee_recipient_ata),
            r(pumpswap_event_authority()),
            r(PUMPSWAP_PROGRAM_ID),
        ]
    }

    fn position(&self, user: &Pubkey) -> Pubkey {
        pda(&[fumpad::POSITION_SEED, self.mint.as_ref(), user.as_ref()], &fumpad::ID)
    }

    fn next_seq(&self, user: &Pubkey) -> u64 {
        match self.env.account(&self.position(user)) {
            Some(a) if a.lamports > 0 => self.env.fetch::<Position>(&self.position(user)).next_ticket_seq,
            _ => 0,
        }
    }

    fn buy_accounts(&self, user: Pubkey) -> fumpad::accounts::SwapBuy {
        fumpad::accounts::SwapBuy {
            user,
            global: self.env.global_pda(),
            coin: self.coin,
            mint: self.mint,
            position: self.position(&user),
            user_token_account: ata(&user, &self.mint, &T22),
            user_wsol: ata(&user, &WSOL_MINT, &TOKEN),
            wsol_mint: WSOL_MINT,
            pumpswap_program: PUMPSWAP_PROGRAM_ID,
            token_program: TOKEN,
            token_2022_program: T22,
            associated_token_program: ATA_PROGRAM,
            system_program: SYSTEM,
            event_authority: event_authority(),
            program: fumpad::ID,
        }
    }

    fn buy_ix_with(&self, accts: fumpad::accounts::SwapBuy, venue: Vec<Meta>, sol_in: u64, min_out: u64) -> Instruction {
        ix_with_remaining(accts, fumpad::instruction::SwapBuy { sol_in, min_tokens_out: min_out }, &venue)
    }

    fn buy_ix(&self, user: Pubkey, sol_in: u64, min_out: u64) -> Instruction {
        let venue = self.venue(user, ata(&user, &self.mint, &T22), ata(&user, &WSOL_MINT, &TOKEN));
        self.buy_ix_with(self.buy_accounts(user), venue, sol_in, min_out)
    }

    fn sell_accounts(&self, user: Pubkey) -> fumpad::accounts::SwapSell {
        fumpad::accounts::SwapSell {
            user,
            global: self.env.global_pda(),
            coin: self.coin,
            mint: self.mint,
            position: self.position(&user),
            ticket: pda(&[fumpad::TICKET_SEED, self.mint.as_ref(), user.as_ref(), &self.next_seq(&user).to_le_bytes()], &fumpad::ID),
            sol_usd_price: Pubkey::new_from_array([7; 32]),
            user_token_account: ata(&user, &self.mint, &T22),
            user_wsol: ata(&user, &WSOL_MINT, &TOKEN),
            wsol_mint: WSOL_MINT,
            pumpswap_program: PUMPSWAP_PROGRAM_ID,
            token_program: TOKEN,
            token_2022_program: T22,
            associated_token_program: ATA_PROGRAM,
            system_program: SYSTEM,
            event_authority: event_authority(),
            program: fumpad::ID,
        }
    }

    fn sell_ix(&self, user: Pubkey, tokens_in: u64, min_out: u64) -> Instruction {
        let venue = self.venue(user, ata(&user, &self.mint, &T22), ata(&user, &WSOL_MINT, &TOKEN));
        ix_with_remaining(
            self.sell_accounts(user),
            fumpad::instruction::SwapSell { tokens_in, min_sol_out: min_out },
            &venue,
        )
    }

    /// Router sell with a fresh Pyth price ($150) and the position's next ticket PDA.
    fn sell_priced(&mut self, user: &Keypair, tokens_in: u64, min_out: u64) -> TransactionResult {
        self.env.set_sol_usd(150);
        let u = kp_pk(user);
        let mut accts = self.sell_accounts(u);
        accts.sol_usd_price = PYTH_SOL_USD;
        let venue = self.venue(u, ata(&u, &self.mint, &T22), ata(&u, &WSOL_MINT, &TOKEN));
        let ix = ix_with_remaining(accts, fumpad::instruction::SwapSell { tokens_in, min_sol_out: min_out }, &venue);
        self.env.send_as(user, &[cu_limit(1_400_000), ix], &[user])
    }

    fn buy(&mut self, user: &Keypair, sol_in: u64, min_out: u64) -> TransactionResult {
        let ix = self.buy_ix(kp_pk(user), sol_in, min_out);
        self.env.send_as(user, &[cu_limit(1_400_000), ix], &[user])
    }

    fn sell(&mut self, user: &Keypair, tokens_in: u64, min_out: u64) -> TransactionResult {
        let ix = self.sell_ix(kp_pk(user), tokens_in, min_out);
        self.env.send_as(user, &[cu_limit(1_400_000), ix], &[user])
    }

    fn init_obs(&mut self) {
        let ix = ix(
            fumpad::accounts::InitObservations {
                payer: kp_pk(&self.env.payer),
                coin: self.coin,
                observations: self.observations,
                system_program: SYSTEM,
            },
            fumpad::instruction::InitObservations {},
        );
        expect_ok(self.env.send(&[ix], &[]));
    }

    fn group(&self) -> Vec<Meta> {
        vec![w(self.coin), w(self.observations), r(self.pool), r(self.pool_base), r(self.pool_quote)]
    }

    fn sample_ix(&self, sampler: Pubkey, groups: &[Meta]) -> Instruction {
        ix_with_remaining(
            fumpad::accounts::RecordSamples {
                sampler,
                global: self.env.global_pda(),
                instructions: IX_SYSVAR,
                event_authority: event_authority(),
                program: fumpad::ID,
            },
            fumpad::instruction::RecordSamples {},
            groups,
        )
    }

    fn keeper_sample(&mut self) -> TransactionResult {
        let k = self.env.keeper.insecure_clone();
        let ix = self.sample_ix(kp_pk(&k), &self.group());
        self.env.send_as(&k, &[ix], &[&k])
    }

    fn sample_as(&mut self, who: &Keypair) -> TransactionResult {
        let ix = self.sample_ix(kp_pk(who), &self.group());
        self.env.send_as(who, &[ix], &[who])
    }

    /// `n` keeper samples, `spacing` seconds apart (warps before each).
    fn keeper_samples(&mut self, n: usize, spacing: i64) {
        for _ in 0..n {
            self.env.warp(spacing);
            expect_ok(self.keeper_sample());
        }
    }

    fn obs(&self) -> Observations {
        self.env.fetch_zc(&self.observations)
    }

    fn buyback_accounts(&self, cranker: Pubkey) -> fumpad::accounts::ExecuteBuyback {
        fumpad::accounts::ExecuteBuyback {
            cranker,
            global: self.env.global_pda(),
            coin: self.coin,
            mint: self.mint,
            observations: self.observations,
            reward_vault: self.reward_vault,
            pool_authority: pool_authority(),
            buyback_wsol: ata(&pool_authority(), &WSOL_MINT, &TOKEN),
            wsol_mint: WSOL_MINT,
            pumpswap_program: PUMPSWAP_PROGRAM_ID,
            token_program: TOKEN,
            token_2022_program: T22,
            associated_token_program: ATA_PROGRAM,
            system_program: SYSTEM,
            event_authority: event_authority(),
            program: fumpad::ID,
        }
    }

    fn buyback_venue(&self) -> Vec<Meta> {
        self.venue(pool_authority(), self.reward_vault, ata(&pool_authority(), &WSOL_MINT, &TOKEN))
    }

    fn buyback(&mut self, max_lamports: u64) -> TransactionResult {
        let cranker = self.env.new_user(1);
        let ix = ix_with_remaining(
            self.buyback_accounts(kp_pk(&cranker)),
            fumpad::instruction::ExecuteBuyback { max_lamports },
            &self.buyback_venue(),
        );
        self.env.send_as(&cranker, &[cu_limit(1_400_000), ix], &[&cranker])
    }

    /// Direct PumpSwap buy (not via the router) by a wallet with fabricated WSOL.
    fn direct_pumpswap_buy_ix(&mut self, trader: &Keypair, quote_in: u64) -> Instruction {
        let t = kp_pk(trader);
        let base = ata(&t, &self.mint, &T22);
        let quote = ata(&t, &WSOL_MINT, &TOKEN);
        if self.env.account(&base).is_none() {
            put_token_account(&mut self.env, base, self.mint, t, 0, T22);
        }
        put_token_account(&mut self.env, quote, WSOL_MINT, t, quote_in, TOKEN);
        let mut data = vec![194, 171, 28, 70, 104, 77, 91, 47];
        data.extend_from_slice(&quote_in.to_le_bytes());
        data.extend_from_slice(&1u64.to_le_bytes());
        let mut metas = self.venue(t, base, quote);
        metas[1] = ws(t);
        raw_ix(PUMPSWAP_PROGRAM_ID, metas, data)
    }

    fn virtual_quote_reserves(&self) -> i128 {
        let pool = self.env.account(&self.pool).unwrap();
        if pool.data.len() >= 261 { i128::from_le_bytes(pool.data[245..261].try_into().unwrap()) } else { 0 }
    }

    /// Quote vault + Pool.virtual_quote_reserves (signed).
    fn effective_quote(&self) -> u64 {
        (token_balance(&self.env, &self.pool_quote) as i128 + self.virtual_quote_reserves()) as u64
    }

    fn spot_q64(&self) -> u128 {
        let base = token_balance(&self.env, &self.pool_base) as u128;
        ((self.effective_quote() as u128) << 64) / base
    }

    fn set_pause(&mut self, flags: u8) {
        let admin = self.env.admin.insecure_clone();
        let ix = ix(
            fumpad::accounts::AdminOnly { admin: kp_pk(&admin), global: self.env.global_pda() },
            fumpad::instruction::SetPause { paused: flags },
        );
        expect_ok(self.env.send(&[ix], &[&admin]));
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// Router
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn swap_buy_happy_path_fee_accounting_and_invariant() {
    let mut fx = setup();
    let user = fx.env.new_user(10);
    let u = kp_pk(&user);
    let sol_before = fx.env.lamports(&u);
    let coin_lamports_before = fx.env.lamports(&fx.coin);
    let pool_quote_before = token_balance(&fx.env, &fx.pool_quote);

    expect_ok(fx.buy(&user, SOL, 1));

    let tokens = token_balance(&fx.env, &ata(&u, &fx.mint, &T22));
    assert!(tokens > 0);
    // PumpSwap took exactly sol_in from the wrapped SOL (buy_exact_quote_in spends it all).
    let pool_in = token_balance(&fx.env, &fx.pool_quote) - pool_quote_before;
    assert!(pool_in <= SOL && pool_in > SOL * 99 / 100, "pool received {pool_in}");

    // FUMPAD fee: 1% of SOL spent, on top; 50/30/20.
    let c = fetch_coin(&fx.env, &fx.coin);
    let fee = fx.env.lamports(&fx.coin) - coin_lamports_before;
    assert_eq!(fee, SOL / 100);
    assert_eq!(c.buyback_lamports, fee / 2);
    assert_eq!(c.platform_fees_unclaimed, fee * 3 / 10);
    assert_eq!(c.creator_fees_unclaimed, fee - fee / 2 - fee * 3 / 10);
    assert_eq!((c.volume_lamports, c.trade_count), (SOL, 1));
    assert_coin_invariant(&fx.env, &fx.coin);

    // WSOL ATA closed (unwrapped); position created and initialized.
    assert!(fx.env.account(&ata(&u, &WSOL_MINT, &TOKEN)).map_or(true, |a| a.lamports == 0));
    let pos: Position = fx.env.fetch(&fx.position(&u));
    assert_eq!((pos.wallet, pos.mint), (u, fx.mint));

    // User paid sol_in + fee + rents (position, token ATA, PumpSwap volume accumulator) + tx fee.
    let rents = fx.env.lamports(&fx.position(&u))
        + fx.env.lamports(&ata(&u, &fx.mint, &T22))
        + fx.env.lamports(&user_volume_accumulator(&u));
    let paid = sol_before - fx.env.lamports(&u);
    assert!(paid >= SOL + fee + rents && paid <= SOL + fee + rents + 20_000, "paid {paid}");

    // A second buy reuses the accounts (init_if_needed path).
    expect_ok(fx.buy(&user, SOL / 2, 1));
    assert_coin_invariant(&fx.env, &fx.coin);
}

#[test]
fn swap_sell_happy_path_fee_from_proceeds() {
    let mut fx = setup();
    let user = fx.env.new_user(10);
    let u = kp_pk(&user);
    expect_ok(fx.buy(&user, 2 * SOL, 1));
    let tokens = token_balance(&fx.env, &ata(&u, &fx.mint, &T22));
    let c0 = fetch_coin(&fx.env, &fx.coin);
    let coin_lamports0 = fx.env.lamports(&fx.coin);
    let sol0 = fx.env.lamports(&u);
    let pool_quote0 = token_balance(&fx.env, &fx.pool_quote);

    expect_ok(fx.sell(&user, tokens / 2, 1));

    assert_eq!(token_balance(&fx.env, &ata(&u, &fx.mint, &T22)), tokens - tokens / 2);
    let gross = pool_quote0 - token_balance(&fx.env, &fx.pool_quote); // pool pays gross (+ its own fees stay)
    let fee = fx.env.lamports(&fx.coin) - coin_lamports0;
    let c = fetch_coin(&fx.env, &fx.coin);
    assert!(fee > 0 && c.trade_count == 2);
    // fee = ceil(1% of what the user received from PumpSwap)
    let received = c.volume_lamports - c0.volume_lamports;
    assert_eq!(fee, (received + 99) / 100);
    assert!(received <= gross);
    assert_eq!(c.buyback_lamports - c0.buyback_lamports, fee / 2);
    assert_coin_invariant(&fx.env, &fx.coin);
    // User nets proceeds − fee (minus tx fee); WSOL ATA closed.
    let gained = fx.env.lamports(&u) - sol0;
    assert!(gained + 20_000 >= received - fee && gained <= received - fee, "gained {gained}");
    assert!(fx.env.account(&ata(&u, &WSOL_MINT, &TOKEN)).map_or(true, |a| a.lamports == 0));
}

#[test]
fn swap_slippage_is_enforced() {
    let mut fx = setup();
    let user = fx.env.new_user(10);
    let u = kp_pk(&user);
    // Buy: absurd min_out fails (PumpSwap rejects first; our delta check is the backstop).
    assert!(fx.buy(&user, SOL, u64::MAX / 2).is_err());
    expect_ok(fx.buy(&user, SOL, 1));
    let tokens = token_balance(&fx.env, &ata(&u, &fx.mint, &T22));
    // Sell: min_sol_out between net and gross passes PumpSwap's gross check but fails ours.
    let gross_est = 990_000_000u64; // ~1 SOL back minus pool fees and impact
    let res = fx.sell(&user, tokens, gross_est - 5_000_000);
    expect_err(res, FumpadError::SlippageExceeded);
    expect_ok(fx.sell(&user, tokens, 900_000_000));
}

#[test]
fn swap_rejects_wrong_pool_program_and_spoofed_accounts() {
    let mut fx = setup();
    let user = fx.env.new_user(20);
    let u = kp_pk(&user);
    let (ub, uq) = (ata(&u, &fx.mint, &T22), ata(&u, &WSOL_MINT, &TOKEN));

    // A second, attacker-owned pool for the same mint (index 1) — not coin.amm_pool.
    let lp = fx.lp.insecure_clone();
    let other = create_pool(&mut fx.env, &lp, fx.mint, 1, POOL_BASE_IN / 100, SOL);
    let venue = fx.venue_for_pool(other, ata(&other, &fx.mint, &T22), ata(&other, &WSOL_MINT, &TOKEN), u, ub, uq);
    let ix = fx.buy_ix_with(fx.buy_accounts(u), venue, SOL, 1);
    expect_err(fx.env.send_as(&user, &[cu_limit(1_400_000), ix], &[&user]), FumpadError::WrongVenue);

    // Wrong program in the named slot.
    let mut accts = fx.buy_accounts(u);
    accts.pumpswap_program = TOKEN;
    let ix = fx.buy_ix_with(accts, fx.venue(u, ub, uq), SOL, 1);
    expect_err(fx.env.send_as(&user, &[cu_limit(1_400_000), ix], &[&user]), FumpadError::WrongVenue);

    // Tokens routed to someone else's account.
    let thief = Pubkey::new_unique();
    let thief_ata = ata(&thief, &fx.mint, &T22);
    put_token_account(&mut fx.env, thief_ata, fx.mint, thief, 0, T22);
    let ix = fx.buy_ix_with(fx.buy_accounts(u), fx.venue(u, thief_ata, uq), SOL, 1);
    expect_err(fx.env.send_as(&user, &[cu_limit(1_400_000), ix], &[&user]), FumpadError::WrongVenue);

    // Spoofed pool vault (a token account of the right mint that isn't the pool's vault).
    let fake_vault = Pubkey::new_unique();
    put_token_account(&mut fx.env, fake_vault, fx.mint, Pubkey::new_unique(), 1, T22);
    let venue = fx.venue_for_pool(fx.pool, fake_vault, fx.pool_quote, u, ub, uq);
    let ix = fx.buy_ix_with(fx.buy_accounts(u), venue, SOL, 1);
    expect_err(fx.env.send_as(&user, &[cu_limit(1_400_000), ix], &[&user]), FumpadError::WrongVenue);

    // Wrong user in the venue slice (someone else's wallet as PumpSwap `user`).
    let mut venue = fx.venue(u, ub, uq);
    venue[1] = w(fx.env.keeper.pubkey().to_bytes().into());
    let ix = fx.buy_ix_with(fx.buy_accounts(u), venue, SOL, 1);
    expect_err(fx.env.send_as(&user, &[cu_limit(1_400_000), ix], &[&user]), FumpadError::WrongVenue);

    // Truncated venue slice.
    let venue = fx.venue(u, ub, uq)[..8].to_vec();
    let ix = fx.buy_ix_with(fx.buy_accounts(u), venue, SOL, 1);
    expect_err(fx.env.send_as(&user, &[cu_limit(1_400_000), ix], &[&user]), FumpadError::WrongVenue);

    // A coin whose amm_pool is a look-alike Pool account NOT owned by PumpSwap.
    let fake_pool = Pubkey::new_unique();
    let real = fx.env.account(&fx.pool).unwrap();
    set(&mut fx.env, fake_pool, SYSTEM, real.data.clone(), None);
    put_coin(&mut fx.env, fx.mint, fake_pool, CoinStatus::Graduated, 0);
    let venue = fx.venue_for_pool(fake_pool, fx.pool_base, fx.pool_quote, u, ub, uq);
    let ix = fx.buy_ix_with(fx.buy_accounts(u), venue, SOL, 1);
    expect_err(fx.env.send_as(&user, &[cu_limit(1_400_000), ix], &[&user]), FumpadError::WrongVenue);
    put_coin(&mut fx.env, fx.mint, fx.pool, CoinStatus::Graduated, 0);

    // Nothing above moved funds; the honest route still works.
    assert_eq!(token_balance(&fx.env, &thief_ata), 0);
    expect_ok(fx.buy(&user, SOL, 1));
}

#[test]
fn swap_requires_graduated_and_unpaused() {
    let mut fx = setup();
    let user = fx.env.new_user(10);
    expect_ok(fx.buy(&user, SOL, 1));
    let tokens = token_balance(&fx.env, &ata(&kp_pk(&user), &fx.mint, &T22));

    fx.set_pause(PAUSE_TRADE);
    expect_err(fx.buy(&user, SOL, 1), FumpadError::Paused);
    expect_err(fx.sell(&user, tokens, 1), FumpadError::Paused);
    fx.set_pause(PAUSE_LAUNCH | PAUSE_CLAIMS); // other flags don't block trading
    expect_ok(fx.sell(&user, tokens / 2, 1));
    fx.set_pause(0);

    put_coin(&mut fx.env, fx.mint, fx.pool, CoinStatus::Complete, 0);
    expect_err(fx.buy(&user, SOL, 1), FumpadError::WrongCoinStatus);
    expect_err(fx.sell(&user, tokens / 4, 1), FumpadError::WrongCoinStatus);

    put_coin(&mut fx.env, fx.mint, fx.pool, CoinStatus::Graduated, 0);
    expect_err(fx.buy(&user, 0, 1), FumpadError::ZeroAmount);
    expect_err(fx.sell(&user, 0, 1), FumpadError::ZeroAmount);
}

// ═════════════════════════════════════════════════════════════════════════════
// Oracle sampling
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn init_observations_requires_graduated_and_is_unique() {
    let mut fx = setup();
    put_coin(&mut fx.env, fx.mint, fx.pool, CoinStatus::Complete, 0);
    let mk = |fx: &Fx| {
        ix(
            fumpad::accounts::InitObservations {
                payer: kp_pk(&fx.env.payer),
                coin: fx.coin,
                observations: fx.observations,
                system_program: SYSTEM,
            },
            fumpad::instruction::InitObservations {},
        )
    };
    let i = mk(&fx);
    expect_err(fx.env.send(&[i], &[]), FumpadError::WrongCoinStatus);
    put_coin(&mut fx.env, fx.mint, fx.pool, CoinStatus::Graduated, 0);
    fx.init_obs();
    let o = fx.obs();
    assert_eq!((o.mint, o.pool, o.len, o.head), (fx.mint, fx.pool, 0, 0));
    assert_eq!(o.last_keeper_sample_ts, START_TS);
    let i = mk(&fx);
    assert!(fx.env.send(&[i], &[]).is_err(), "second init must fail");
}

#[test]
fn record_samples_keeper_only_and_price_matches_pool() {
    let mut fx = setup();
    fx.init_obs();
    let rando = fx.env.new_user(1);
    expect_err(fx.sample_as(&rando), FumpadError::Unauthorized);

    expect_ok(fx.keeper_sample());
    let o = fx.obs();
    assert_eq!(o.len, 1);
    assert_eq!(o.samples[0].ts, START_TS);
    assert_eq!(o.samples[0].fallback, 0);
    assert_eq!(o.samples[0].price_q64, fx.spot_q64());
    assert_eq!(o.samples[0].price_q64, ((POOL_QUOTE_IN as u128) << 64) / POOL_BASE_IN as u128);
    assert_eq!(o.last_keeper_sample_ts, START_TS);
}

#[test]
fn record_samples_spacing() {
    let mut fx = setup();
    fx.init_obs();
    expect_ok(fx.keeper_sample());
    expect_err(fx.keeper_sample(), FumpadError::SampleTooSoon);
    fx.env.warp(9);
    expect_err(fx.keeper_sample(), FumpadError::SampleTooSoon);
    fx.env.warp(1);
    expect_ok(fx.keeper_sample());
    assert_eq!(fx.obs().len, 2);

    // Same coin twice in one batch → the second group is too soon.
    fx.env.warp(10);
    let k = fx.env.keeper.insecure_clone();
    let mut groups = fx.group();
    groups.extend(fx.group());
    let ix = fx.sample_ix(kp_pk(&k), &groups);
    expect_err(fx.env.send_as(&k, &[ix], &[&k]), FumpadError::SampleTooSoon);
}

#[test]
fn record_samples_transaction_isolation() {
    let mut fx = setup();
    fx.init_obs();
    let k = fx.env.keeper.insecure_clone();
    let kk = kp_pk(&k);

    // Extra non-compute-budget instruction after the sample.
    let transfer = anchor_lang::solana_program::system_instruction::transfer(&kk, &Pubkey::new_unique(), 1);
    let transfer = raw_ix(SYSTEM, transfer.accounts, transfer.data);
    let s = fx.sample_ix(kk, &fx.group());
    expect_err(fx.env.send_as(&k, &[s.clone(), transfer.clone()], &[&k]), FumpadError::SampleTxNotIsolated);
    // ... and before it.
    expect_err(fx.env.send_as(&k, &[transfer, s.clone()], &[&k]), FumpadError::SampleTxNotIsolated);
    // Two sampling instructions in one transaction are not allowed either.
    let s2 = fx.sample_ix(kk, &fx.group());
    expect_err(fx.env.send_as(&k, &[s.clone(), s2], &[&k]), FumpadError::SampleTxNotIsolated);
    // Compute-budget instructions are fine.
    let mut price = vec![3u8];
    price.extend_from_slice(&1_000u64.to_le_bytes());
    let cu_price = raw_ix(COMPUTE_BUDGET, vec![], price);
    expect_ok(fx.env.send_as(&k, &[cu_limit(400_000), cu_price, s], &[&k]));
    assert_eq!(fx.obs().len, 1);
}

#[test]
fn record_samples_stale_keeper_fallback() {
    let mut fx = setup();
    fx.init_obs();
    let rando = fx.env.new_user(1);
    // Fresh ring: the keeper has a full stale period of grace.
    fx.env.warp(600);
    expect_err(fx.sample_as(&rando), FumpadError::Unauthorized);
    fx.env.warp(1);
    expect_ok(fx.sample_as(&rando));
    let o = fx.obs();
    assert_eq!((o.len, o.samples[0].fallback), (1, 1));
    assert_eq!(o.last_keeper_sample_ts, START_TS, "fallback samples don't refresh the keeper clock");
    // Fallback samples obey spacing too.
    let rando2 = fx.env.new_user(1);
    expect_err(fx.sample_as(&rando2), FumpadError::SampleTooSoon);

    // A keeper sample closes the fallback window again.
    fx.env.warp(10);
    expect_ok(fx.keeper_sample());
    fx.env.warp(10);
    expect_err(fx.sample_as(&rando), FumpadError::Unauthorized);
    let o = fx.obs();
    assert_eq!(o.samples[1].fallback, 0);
    assert_eq!(o.last_keeper_sample_ts, fx.env.now() - 10);
}

#[test]
fn record_samples_ring_wraps() {
    let mut fx = setup();
    fx.init_obs();
    expect_ok(fx.keeper_sample());
    fx.keeper_samples(299, 10);
    let o = fx.obs();
    assert_eq!(o.len as usize, fumpad::OBSERVATION_CAPACITY);
    assert_eq!(o.head as usize, 300 % fumpad::OBSERVATION_CAPACITY);
    assert_eq!(o.last_ts(), Some(fx.env.now()));
    // Oldest surviving sample is #44 (0-based).
    assert_eq!(o.samples[o.head as usize].ts, START_TS + 44 * 10);
    let p = Params::default();
    assert_eq!(o.median_price_q64(fx.env.now(), p.oracle_window_secs, p.oracle_min_samples), Some(fx.spot_q64()));
}

#[test]
fn record_samples_batches_several_coins_and_validates_groups() {
    let mut fx = setup();
    fx.init_obs();
    // Second coin with its own pool.
    let mint2 = Pubkey::new_unique();
    put_mint(&mut fx.env, mint2, POOL_BASE_IN, 6, T22);
    let lp = fx.lp.insecure_clone();
    let lpk = kp_pk(&lp);
    put_token_account(&mut fx.env, ata(&lpk, &mint2, &T22), mint2, lpk, POOL_BASE_IN, T22);
    let pool2 = create_pool(&mut fx.env, &lp, mint2, 0, POOL_BASE_IN, 40 * SOL);
    let coin2 = put_coin(&mut fx.env, mint2, pool2, CoinStatus::Graduated, 0);
    let obs2 = pda(&[fumpad::OBSERVATIONS_SEED, mint2.as_ref()], &fumpad::ID);
    let i = ix(
        fumpad::accounts::InitObservations { payer: kp_pk(&fx.env.payer), coin: coin2, observations: obs2, system_program: SYSTEM },
        fumpad::instruction::InitObservations {},
    );
    expect_ok(fx.env.send(&[i], &[]));
    let g2 = vec![w(coin2), w(obs2), r(pool2), r(ata(&pool2, &mint2, &T22)), r(ata(&pool2, &WSOL_MINT, &TOKEN))];
    let k = fx.env.keeper.insecure_clone();

    // Mismatched groups: coin 1 with coin 2's observations / pool / vaults.
    for bad in [
        vec![w(fx.coin), w(obs2), r(fx.pool), r(fx.pool_base), r(fx.pool_quote)],
        vec![w(fx.coin), w(fx.observations), r(pool2), r(fx.pool_base), r(fx.pool_quote)],
        vec![w(fx.coin), w(fx.observations), r(fx.pool), r(g2[3].pubkey), r(fx.pool_quote)],
    ] {
        let ix = fx.sample_ix(kp_pk(&k), &bad);
        assert!(fx.env.send_as(&k, &[ix], &[&k]).is_err());
    }
    // Read-only observations account.
    let mut ro = fx.group();
    ro[1] = r(fx.observations);
    let ix = fx.sample_ix(kp_pk(&k), &ro);
    expect_err(fx.env.send_as(&k, &[ix], &[&k]), FumpadError::InvalidAccount);
    // Read-only coin (the sample is a D10 reference touch point).
    let mut ro = fx.group();
    ro[0] = r(fx.coin);
    let ix = fx.sample_ix(kp_pk(&k), &ro);
    expect_err(fx.env.send_as(&k, &[ix], &[&k]), FumpadError::InvalidAccount);
    // Ragged group list.
    let ix = fx.sample_ix(kp_pk(&k), &fx.group()[..4]);
    expect_err(fx.env.send_as(&k, &[ix], &[&k]), FumpadError::InvalidAccount);

    let mut groups = fx.group();
    groups.extend(g2);
    let ix = fx.sample_ix(kp_pk(&k), &groups);
    expect_ok(fx.env.send_as(&k, &[ix], &[&k]));
    assert_eq!(fx.obs().len, 1);
    let o2: Observations = fx.env.fetch_zc(&obs2);
    assert_eq!(o2.len, 1);
    assert_eq!(o2.samples[0].price_q64, ((40 * SOL as u128) << 64) / POOL_BASE_IN as u128);
    // Each sample is a D10 touch point: recorded as the coin's last spot.
    let c2 = fetch_coin(&fx.env, &coin2);
    assert_eq!(c2.reference.last_spot_q64, o2.samples[0].price_q64);
    assert_eq!(c2.reference.updated_at, fx.env.now());

    // Not graduated → rejected.
    fx.env.warp(10);
    put_coin(&mut fx.env, fx.mint, fx.pool, CoinStatus::Complete, 0);
    expect_err(fx.keeper_sample(), FumpadError::WrongCoinStatus);
}

// ═════════════════════════════════════════════════════════════════════════════
// Buyback
// ═════════════════════════════════════════════════════════════════════════════

/// Fund the coin's buyback balance directly (as if fees had accrued), keeping the invariant.
fn fund_buyback(fx: &mut Fx, lamports: u64) {
    put_coin(&mut fx.env, fx.mint, fx.pool, CoinStatus::Graduated, lamports);
}

#[test]
fn buyback_needs_samples_and_balance() {
    let mut fx = setup();
    fx.init_obs();
    fund_buyback(&mut fx, SOL / 10);
    // Fewer than oracle_min_samples (84) in the window.
    fx.keeper_samples(83, 20);
    expect_err(fx.buyback(u64::MAX), FumpadError::InsufficientSamples);
    fx.keeper_samples(1, 20);
    // Zero balance → nothing to do.
    fund_buyback(&mut fx, 0);
    expect_err(fx.buyback(u64::MAX), FumpadError::NothingToBuyBack);
    fund_buyback(&mut fx, SOL / 10);
    expect_err(fx.buyback(0), FumpadError::NothingToBuyBack);
    // Samples age out of the 30-min window.
    fx.env.warp(1_800);
    expect_err(fx.buyback(u64::MAX), FumpadError::InsufficientSamples);
}

#[test]
fn buyback_happy_path_from_router_fees() {
    let mut fx = setup();
    fx.init_obs();
    // Real fees from router trades.
    let user = fx.env.new_user(50);
    expect_ok(fx.buy(&user, 20 * SOL, 1));
    let accrued = fetch_coin(&fx.env, &fx.coin).buyback_lamports;
    assert_eq!(accrued, 20 * SOL / 100 / 2);
    fx.keeper_samples(90, 20);

    let vault0 = token_balance(&fx.env, &fx.reward_vault);
    let lamports0 = fx.env.lamports(&fx.coin);
    let spot0 = fx.spot_q64();
    expect_ok(fx.buyback(u64::MAX));
    let c = fetch_coin(&fx.env, &fx.coin);
    let bought = token_balance(&fx.env, &fx.reward_vault) - vault0;
    // 0.1 SOL < 0.5% of ~105 SOL depth → whole balance spent.
    assert_eq!(c.buyback_lamports, 0);
    assert_eq!(lamports0 - fx.env.lamports(&fx.coin), accrued);
    let fair = ((accrued as u128) << 64) / spot0;
    assert!(bought as u128 > fair * 99 / 100 && (bought as u128) < fair, "bought {bought}, fair {fair}");
    assert_coin_invariant(&fx.env, &fx.coin);
}

#[test]
fn buyback_slice_is_capped_by_pool_depth_and_max() {
    let mut fx = setup();
    fx.init_obs();
    fx.keeper_samples(90, 20);
    fund_buyback(&mut fx, 10 * SOL);
    assert_eq!(fx.virtual_quote_reserves(), 0); // fresh pool
    let cap = fx.effective_quote() * 50 / 10_000;

    // max_lamports below the cap wins.
    expect_ok(fx.buyback(SOL / 100));
    assert_eq!(fetch_coin(&fx.env, &fx.coin).buyback_lamports, 10 * SOL - SOL / 100);
    // v2 trades keep PumpSwap's protocol fee in the vault and offset it in the (now
    // negative) virtual reserves; the cap must use the EFFECTIVE quote, not the raw vault.
    assert!(fx.virtual_quote_reserves() < 0);
    let cap2 = fx.effective_quote() * 50 / 10_000;
    assert!(cap2 < token_balance(&fx.env, &fx.pool_quote) * 50 / 10_000 + 1);
    assert!(cap2 >= cap);
    expect_ok(fx.buyback(u64::MAX));
    assert_eq!(fetch_coin(&fx.env, &fx.coin).buyback_lamports, 10 * SOL - SOL / 100 - cap2);
    assert_coin_invariant(&fx.env, &fx.coin);
}

#[test]
fn buyback_rejects_wrong_destination_and_pause() {
    let mut fx = setup();
    fx.init_obs();
    fx.keeper_samples(90, 20);
    fund_buyback(&mut fx, SOL);

    // Tokens to an attacker account instead of the reward vault.
    let thief = Pubkey::new_unique();
    let thief_ata = ata(&thief, &fx.mint, &T22);
    put_token_account(&mut fx.env, thief_ata, fx.mint, pool_authority(), 0, T22);
    let mut venue = fx.buyback_venue();
    venue[5] = w(thief_ata);
    let cranker = fx.env.new_user(1);
    let ix = ix_with_remaining(
        fx.buyback_accounts(kp_pk(&cranker)),
        fumpad::instruction::ExecuteBuyback { max_lamports: u64::MAX },
        &venue,
    );
    expect_err(fx.env.send_as(&cranker, &[cu_limit(1_400_000), ix], &[&cranker]), FumpadError::WrongVenue);

    fx.set_pause(PAUSE_TRADE);
    expect_err(fx.buyback(u64::MAX), FumpadError::Paused);
    fx.set_pause(0);
    expect_ok(fx.buyback(u64::MAX));
}

#[test]
fn buyback_deviation_guard_blocks_pumped_spot() {
    let mut fx = setup();
    fx.init_obs();
    fx.keeper_samples(90, 20);
    fund_buyback(&mut fx, SOL);
    let median_spot = fx.spot_q64();

    // Attacker pumps the pool ~+5% (direct PumpSwap buy, no FUMPAD fee) and cranks.
    let attacker = fx.env.new_user(10);
    let pump = fx.direct_pumpswap_buy_ix(&attacker, 2 * SOL);
    expect_ok(fx.env.send_as(&attacker, &[cu_limit(400_000), pump], &[&attacker]));
    assert!(fx.spot_q64() > median_spot * 1035 / 1000);
    expect_err(fx.buyback(u64::MAX), FumpadError::PriceDeviation);

    // Same thing inside ONE transaction (pump + crank) — still blocked.
    let attacker2 = fx.env.new_user(10);
    let pump2 = fx.direct_pumpswap_buy_ix(&attacker2, SOL / 10);
    let crank = ix_with_remaining(
        fx.buyback_accounts(kp_pk(&attacker2)),
        fumpad::instruction::ExecuteBuyback { max_lamports: u64::MAX },
        &fx.buyback_venue(),
    );
    expect_err(
        fx.env.send_as(&attacker2, &[cu_limit(1_400_000), pump2, crank], &[&attacker2]),
        FumpadError::PriceDeviation,
    );
    assert_eq!(fetch_coin(&fx.env, &fx.coin).buyback_lamports, SOL);
}

// ═════════════════════════════════════════════════════════════════════════════
// Manipulation scenario
// ═════════════════════════════════════════════════════════════════════════════

/// An attacker wants a high median (to trigger 10x claims). They can move the pool at
/// will, but: (1) they can't sample while the keeper is live; (2) they can't pump and
/// sample in one transaction even in fallback mode; (3) samples they do land in fallback
/// mode (a multi-tx bundle) are flagged and still need to dominate a 30-min median.
#[test]
fn manipulation_pump_and_sample_in_same_tx_or_bundle() {
    let mut fx = setup();
    fx.init_obs();
    fx.keeper_samples(100, 15);
    let fair = fx.spot_q64();
    let p = Params::default();
    let median0 = fx.obs().median_price_q64(fx.env.now(), p.oracle_window_secs, p.oracle_min_samples).unwrap();
    assert_eq!(median0, fair);

    let attacker = fx.env.new_user(100);
    // (1) Keeper live: pump in one tx, sample in the next → not a keeper.
    fx.env.warp(15);
    let pump = fx.direct_pumpswap_buy_ix(&attacker, 50 * SOL);
    expect_ok(fx.env.send_as(&attacker, &[cu_limit(400_000), pump], &[&attacker]));
    assert!(fx.spot_q64() > 2 * fair);
    expect_err(fx.sample_as(&attacker), FumpadError::Unauthorized);

    // (2) Keeper offline > 10 min → fallback open. Pump + sample atomically: rejected.
    fx.env.warp(700);
    let pump = fx.direct_pumpswap_buy_ix(&attacker, 10 * SOL);
    let sample = fx.sample_ix(kp_pk(&attacker), &fx.group());
    expect_err(
        fx.env.send_as(&attacker, &[cu_limit(1_400_000), pump, sample], &[&attacker]),
        FumpadError::SampleTxNotIsolated,
    );
    // Same via the router's own swap (a FUMPAD instruction that isn't the sampler).
    let buy = fx.buy_ix(kp_pk(&attacker), SOL, 1);
    let sample = fx.sample_ix(kp_pk(&attacker), &fx.group());
    expect_err(
        fx.env.send_as(&attacker, &[cu_limit(1_400_000), buy, sample], &[&attacker]),
        FumpadError::SampleTxNotIsolated,
    );

    // (3) Bundle-style: pumped pool, isolated sample tx → lands, but flagged as fallback,
    // and fallback samples are excluded from the median and its coverage (V-M1).
    for _ in 0..5 {
        expect_ok(fx.sample_as(&attacker));
        fx.env.warp(10);
    }
    let o = fx.obs();
    let n = o.len as usize;
    for i in 0..5 {
        let s = o.samples[(o.head as usize + fumpad::OBSERVATION_CAPACITY - 1 - i) % fumpad::OBSERVATION_CAPACITY];
        assert_eq!(s.fallback, 1);
        assert!(s.price_q64 > 2 * fair);
    }
    assert_eq!(n, 105);
    // Window is now mostly honest samples + 5 pumped ones. Median at the end of the
    // honest run (before the 715s gap) stays fair; the coverage rule forces an attacker
    // to own most of a 30-min window of ≥84 samples to move it.
    let honest_end = fx.env.now() - 50 - 700 - 15;
    assert_eq!(o.median_price_q64(honest_end, p.oracle_window_secs, p.oracle_min_samples), Some(fair));
    // Right now the window holds ~69 honest keeper samples (+ 5 ignored fallback ones) < 84
    // → no median at all: a keeper outage pauses claims rather than letting fallback
    // samples decide.
    assert_eq!(o.median_price_q64(fx.env.now(), p.oracle_window_secs, p.oracle_min_samples), None);
    // V-M1: fallback samples never count, not even with the count requirement relaxed: the
    // keeper samples left in the window are bunched in its oldest half (time spread fails).
    assert_eq!(o.median_price_q64(fx.env.now(), p.oracle_window_secs, 1), None);
}

// ═════════════════════════════════════════════════════════════════════════════
// Account-list plumbing and budgets
// ═════════════════════════════════════════════════════════════════════════════

/// Buys must put exactly `position.open_count` open tickets in front of the venue slice.
/// The ticket is a real one, created by a qualifying router sell.
#[test]
fn swap_buy_open_tickets_precede_venue_slice() {
    let mut fx = setup();
    let user = fx.env.new_user(10);
    let u = kp_pk(&user);
    expect_ok(fx.buy(&user, SOL, 1));
    fx.env.warp(600);
    let held = token_balance(&fx.env, &ata(&u, &fx.mint, &T22));
    let ticket = fx.sell_accounts(u).ticket;
    expect_ok(fx.sell_priced(&user, held / 2, 1));
    let pos: Position = fx.env.fetch(&fx.position(&u));
    assert_eq!((pos.open_count, pos.open_tickets[0]), (1, ticket));
    assert_eq!(fetch_coin(&fx.env, &fx.coin).tickets_created, 1);

    // Without the ticket the venue slice is shifted by one → rejected.
    expect_err(fx.buy(&user, SOL, 1), FumpadError::WrongVenue);
    // With it, the buy goes through (and the rebuy rule debits the ticket).
    let before: Ticket = fx.env.fetch(&ticket);
    let mut remaining = vec![w(ticket)];
    remaining.extend(fx.venue(u, ata(&u, &fx.mint, &T22), ata(&u, &WSOL_MINT, &TOKEN)));
    let ix = fx.buy_ix_with(fx.buy_accounts(u), remaining, SOL / 1_000, 1);
    expect_ok(fx.env.send_as(&user, &[cu_limit(1_400_000), ix], &[&user]));
    assert!(fx.env.fetch::<Ticket>(&ticket).tokens < before.tokens);
}

#[test]
fn swap_sell_rejects_spoofed_accounts() {
    let mut fx = setup();
    let user = fx.env.new_user(10);
    let u = kp_pk(&user);
    expect_ok(fx.buy(&user, SOL, 1));
    let tokens = token_balance(&fx.env, &ata(&u, &fx.mint, &T22));
    // Proceeds routed to another WSOL account.
    let other = Pubkey::new_unique();
    let other_wsol = ata(&other, &WSOL_MINT, &TOKEN);
    put_token_account(&mut fx.env, other_wsol, WSOL_MINT, other, 0, TOKEN);
    let venue = fx.venue(u, ata(&u, &fx.mint, &T22), other_wsol);
    let ix = ix_with_remaining(
        fx.sell_accounts(u),
        fumpad::instruction::SwapSell { tokens_in: tokens, min_sol_out: 1 },
        &venue,
    );
    expect_err(fx.env.send_as(&user, &[cu_limit(1_400_000), ix], &[&user]), FumpadError::WrongVenue);
    // Selling from a token account the user doesn't own.
    let victim = Pubkey::new_unique();
    let victim_ata = ata(&victim, &fx.mint, &T22);
    put_token_account(&mut fx.env, victim_ata, fx.mint, victim, tokens, T22);
    let mut accts = fx.sell_accounts(u);
    accts.user_token_account = victim_ata;
    let venue = fx.venue(u, victim_ata, ata(&u, &WSOL_MINT, &TOKEN));
    let ix = ix_with_remaining(accts, fumpad::instruction::SwapSell { tokens_in: tokens, min_sol_out: 1 }, &venue);
    assert!(fx.env.send_as(&user, &[cu_limit(1_400_000), ix], &[&user]).is_err());
    assert_eq!(token_balance(&fx.env, &victim_ata), tokens);
    expect_ok(fx.sell(&user, tokens, 1));
}

/// CU of each venue instruction, and a 5-coin sampling batch (the most that fits a
/// legacy transaction; 8–10 coins need a v0 transaction with an address lookup table).
#[test]
fn compute_units_and_batch_size() {
    let mut fx = setup();
    let user = fx.env.new_user(10);
    let cu = |r: &TransactionResult| match r {
        Ok(m) => m.compute_units_consumed,
        Err(f) => panic!("tx failed: {:?}\n{:#?}", f.err, f.meta.logs),
    };
    let buy = cu(&fx.buy(&user, SOL, 1));
    let tokens = token_balance(&fx.env, &ata(&kp_pk(&user), &fx.mint, &T22));
    let sell = cu(&fx.sell(&user, tokens / 2, 1));

    fx.init_obs();
    let k = fx.env.keeper.insecure_clone();
    let mut groups = fx.group();
    let lp = fx.lp.insecure_clone();
    let lpk = kp_pk(&lp);
    for _ in 0..4 {
        let m = Pubkey::new_unique();
        put_mint(&mut fx.env, m, POOL_BASE_IN, 6, T22);
        put_token_account(&mut fx.env, ata(&lpk, &m, &T22), m, lpk, POOL_BASE_IN, T22);
        let p = create_pool(&mut fx.env, &lp, m, 0, POOL_BASE_IN, 10 * SOL);
        let c = put_coin(&mut fx.env, m, p, CoinStatus::Graduated, 0);
        let o = pda(&[fumpad::OBSERVATIONS_SEED, m.as_ref()], &fumpad::ID);
        let i = ix(
            fumpad::accounts::InitObservations {
                payer: kp_pk(&fx.env.payer),
                coin: c,
                observations: o,
                system_program: SYSTEM,
            },
            fumpad::instruction::InitObservations {},
        );
        expect_ok(fx.env.send(&[i], &[]));
        groups.extend([w(c), w(o), r(p), r(ata(&p, &m, &T22)), r(ata(&p, &WSOL_MINT, &TOKEN))]);
    }
    let one = fx.sample_ix(kp_pk(&k), &fx.group());
    let single = cu(&fx.env.send_as(&k, &[one], &[&k]));
    fx.env.warp(10);
    let batch = fx.sample_ix(kp_pk(&k), &groups);
    let five = cu(&fx.env.send_as(&k, &[batch], &[&k]));

    fx.keeper_samples(90, 20);
    fund_buyback(&mut fx, SOL);
    let bb = cu(&fx.buyback(u64::MAX));
    println!(
        "CU: swap_buy {buy}, swap_sell {sell}, record_samples 1 coin {single}, 5 coins {five}, execute_buyback {bb}"
    );
    assert!(buy < 200_000 && sell < 200_000 && bb < 200_000);
    assert!(five < 200_000, "5-coin batch must fit the default 200k budget");
}
