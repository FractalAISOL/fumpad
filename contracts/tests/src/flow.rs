//! Full-stack test helpers: a REAL coin from `create_coin`, curve trading, `graduate`
//! into the real PumpSwap program, then router / oracle / rewards on that pool. Used by
//! the D10 tests and the end-to-end test (nothing is fabricated except Pyth bytes).

use anchor_lang::{
    prelude::{AccountMeta as Meta, Pubkey},
    pubkey, AnchorDeserialize, Discriminator, InstructionData, ToAccountMetas,
};
use fumpad::{
    error::FumpadError,
    external::pumpswap::{event_authority_pda, lp_mint_pda, pool_pda, IX_BUY_EXACT_QUOTE_IN_V2, IX_SELL_V2, WSOL_MINT},
    state::*,
    PUMPSWAP_GLOBAL_CONFIG, PUMPSWAP_PROGRAM_ID,
};
use litesvm::types::{TransactionMetadata, TransactionResult};
use solana_account::Account;
use solana_instruction::{AccountMeta as Meta4, Instruction};
use solana_keypair::Keypair;

use crate::*;

pub const T22: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const TOKEN: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const ATA_PROGRAM: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const SYSTEM: Pubkey = anchor_lang::system_program::ID;
pub const IX_SYSVAR: Pubkey = pubkey!("Sysvar1nstructions1111111111111111111111111");
pub const COMPUTE_BUDGET: Pubkey = pubkey!("ComputeBudget111111111111111111111111111111");
pub const FEE_CONFIG: Pubkey = pubkey!("5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx");
pub const T0: i64 = 1_800_000_000;
/// SOL/USD used for every priced sell.
pub const SOL_USD: u64 = 150;

// ── generic helpers ──────────────────────────────────────────────────────────

pub fn pda(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}
pub fn fpda(seeds: &[&[u8]]) -> Pubkey {
    pda(seeds, &fumpad::ID)
}
pub fn ata(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    pda(&[owner.as_ref(), token_program.as_ref(), mint.as_ref()], &ATA_PROGRAM)
}
pub fn event_authority() -> Pubkey {
    fpda(&[b"__event_authority"])
}
pub fn pool_authority() -> Pubkey {
    fpda(&[fumpad::POOL_AUTHORITY_SEED])
}
/// D11 locker accounts of a pool: (Lock PDA, locker authority PDA, LP vault ATA).
pub fn locker_accounts(pool: &Pubkey) -> (Pubkey, Pubkey, Pubkey) {
    let lock = pda(&[fumpad_lp_locker::LOCK_SEED, pool.as_ref()], &fumpad_lp_locker::ID);
    let authority = pda(&[fumpad_lp_locker::AUTHORITY_SEED], &fumpad_lp_locker::ID);
    (lock, authority, ata(&authority, &lp_mint_pda(pool), &T22))
}
pub fn uva(user: &Pubkey) -> Pubkey {
    pda(&[b"user_volume_accumulator", user.as_ref()], &PUMPSWAP_PROGRAM_ID)
}
pub fn w(k: Pubkey) -> Meta {
    Meta::new(k, false)
}
pub fn r(k: Pubkey) -> Meta {
    Meta::new_readonly(k, false)
}

pub fn raw_ix(program: Pubkey, metas: Vec<Meta>, data: Vec<u8>) -> Instruction {
    Instruction {
        program_id: addr(&program),
        accounts: metas
            .into_iter()
            .map(|m| Meta4 { pubkey: addr(&m.pubkey), is_signer: m.is_signer, is_writable: m.is_writable })
            .collect(),
        data,
    }
}

pub fn cu_limit(units: u32) -> Instruction {
    let mut d = vec![2u8];
    d.extend_from_slice(&units.to_le_bytes());
    raw_ix(COMPUTE_BUDGET, vec![], d)
}

pub fn code_of(e: FumpadError) -> u32 {
    anchor_lang::error::ERROR_CODE_OFFSET + e as u32
}

#[track_caller]
pub fn expect_err(res: TransactionResult, e: FumpadError) {
    let c = code_of(e);
    match res {
        Ok(_) => panic!("expected {e:?} ({c}), but the transaction succeeded"),
        Err(f) => {
            let s = format!("{:?}", f.err);
            assert!(s.contains(&format!("Custom({c})")), "expected {e:?} ({c}), got {s}\nlogs: {:#?}", f.meta.logs);
        }
    }
}

#[track_caller]
pub fn ok(res: TransactionResult) -> TransactionMetadata {
    match res {
        Ok(m) => m,
        Err(f) => panic!("tx failed: {:?}\nlogs: {:#?}", f.err, f.meta.logs),
    }
}

/// Decode every `emit_cpi!` event of type T from a transaction's inner instructions.
pub fn events<T: anchor_lang::Event + AnchorDeserialize + Discriminator>(m: &TransactionMetadata) -> Vec<T> {
    let mut out = vec![];
    for ixs in &m.inner_instructions {
        for i in ixs {
            let d = &i.instruction.data;
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

pub fn token_balance(env: &Env, key: &Pubkey) -> u64 {
    match env.account(key) {
        Some(a) if a.data.len() >= 72 => u64::from_le_bytes(a.data[64..72].try_into().unwrap()),
        _ => 0,
    }
}

/// Plain token account (WSOL accounts are native: lamports = rent + amount).
pub fn put_token_account(env: &mut Env, key: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64, program: Pubkey) {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1;
    let rent = env.svm.minimum_balance_for_rent_exemption(165);
    let mut lamports = rent;
    if mint == WSOL_MINT {
        d[109..113].copy_from_slice(&1u32.to_le_bytes());
        d[113..121].copy_from_slice(&rent.to_le_bytes());
        lamports += amount;
    }
    env.svm
        .set_account(addr(&key), Account { lamports, data: d, owner: addr(&program), executable: false, rent_epoch: 0 })
        .unwrap();
}

// ── the world ────────────────────────────────────────────────────────────────

pub struct Flow {
    pub env: Env,
    pub creator: Keypair,
    pub mint: Pubkey,
    pub coin: Pubkey,
    pub pool: Pubkey,
    pub pool_base: Pubkey,
    pub pool_quote: Pubkey,
    pub reward_vault: Pubkey,
    pub curve_vault: Pubkey,
    pub observations: Pubkey,
    pub queue: Pubkey,
    pub buyback_fee_recipient_ata: Pubkey,
}

impl Flow {
    /// Env with every fixture the full lifecycle needs, clock at T0, and a coin created
    /// by `creator` with default params.
    pub fn new() -> Self {
        Self::with_params(Params::default())
    }

    pub fn with_params(params: Params) -> Self {
        let mut env = Env::with_params(params);
        let mut c = env.svm.get_sysvar::<litesvm_clock::Clock>();
        c.unix_timestamp = T0;
        env.svm.set_sysvar(&c);
        load_account_fixture(&mut env.svm, "wsol_mint.json");
        load_account_fixture(&mut env.svm, "pump_fees_fee_config_amm.json");
        // PumpSwap's buyback fee recipient WSOL ATA exists on mainnet/devnet.
        let gc = env.account(&PUMPSWAP_GLOBAL_CONFIG).unwrap();
        let bfr = Pubkey::new_from_array(gc.data[643..675].try_into().unwrap());
        let bfr_ata = ata(&bfr, &WSOL_MINT, &TOKEN);
        put_token_account(&mut env, bfr_ata, WSOL_MINT, bfr, 0, TOKEN);

        let creator = env.new_user(10);
        let mint_kp = Keypair::new();
        let mint = kp_pk(&mint_kp);
        let pa = pool_authority();
        let pool = pool_pda(0, &pa, &mint, &WSOL_MINT);
        let mut f = Flow {
            coin: fpda(&[fumpad::COIN_SEED, mint.as_ref()]),
            reward_vault: fpda(&[fumpad::REWARD_VAULT_SEED, mint.as_ref()]),
            curve_vault: fpda(&[fumpad::CURVE_VAULT_SEED, mint.as_ref()]),
            observations: fpda(&[fumpad::OBSERVATIONS_SEED, mint.as_ref()]),
            queue: fpda(&[fumpad::CLAIM_QUEUE_SEED, mint.as_ref()]),
            pool_base: ata(&pool, &mint, &T22),
            pool_quote: ata(&pool, &WSOL_MINT, &TOKEN),
            pool,
            mint,
            buyback_fee_recipient_ata: bfr_ata,
            creator,
            env,
        };
        let i = ix(
            fumpad::accounts::CreateCoin {
                creator: kp_pk(&f.creator),
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
            fumpad::instruction::CreateCoin { name: "Fumble".into(), symbol: "FUMB".into(), uri: "https://fumpad.fun/x".into() },
        );
        let creator = f.creator.insecure_clone();
        ok(f.env.send(&[i], &[&creator, &mint_kp]));
        f
    }

    pub fn now(&self) -> i64 {
        self.env.now()
    }
    pub fn coin_state(&self) -> Coin {
        self.env.fetch(&self.coin)
    }
    pub fn tokens(&self, user: &Pubkey) -> u64 {
        token_balance(&self.env, &ata(user, &self.mint, &T22))
    }
    pub fn pool_tokens(&self) -> u64 {
        token_balance(&self.env, &self.reward_vault)
    }
    pub fn position_key(&self, user: &Pubkey) -> Pubkey {
        fpda(&[fumpad::POSITION_SEED, self.mint.as_ref(), user.as_ref()])
    }
    pub fn position(&self, user: &Pubkey) -> Option<Position> {
        self.env.account(&self.position_key(user)).filter(|a| a.lamports > 0).map(|_| self.env.fetch(&self.position_key(user)))
    }
    pub fn open_tickets(&self, user: &Pubkey) -> Vec<Pubkey> {
        self.position(user)
            .map(|p| p.open_tickets.iter().copied().filter(|k| *k != Pubkey::default()).collect())
            .unwrap_or_default()
    }
    /// Rebuy-rule accounts for a buy / register_holdings: the open tickets (writable), then
    /// the claim queue iff one of them is Queued (R-L1).
    pub fn rebuy_metas(&self, user: &Pubkey) -> Vec<Meta> {
        let open = self.open_tickets(user);
        let queued = open.iter().any(|k| self.ticket(k).status == TicketStatus::Queued);
        let mut v: Vec<Meta> = open.into_iter().map(w).collect();
        if queued {
            v.push(w(self.queue));
        }
        v
    }

    pub fn next_ticket(&self, user: &Pubkey) -> Pubkey {
        let seq = self.position(user).map_or(0, |p| p.next_ticket_seq);
        fpda(&[fumpad::TICKET_SEED, self.mint.as_ref(), user.as_ref(), &seq.to_le_bytes()])
    }
    pub fn ticket(&self, key: &Pubkey) -> Ticket {
        self.env.fetch(key)
    }

    /// Coin lamports == rent + real_sol + creator fees + platform fees + buyback lamports.
    #[track_caller]
    pub fn assert_invariant(&self) {
        let acc = self.env.account(&self.coin).unwrap();
        let c = self.coin_state();
        let rent = self.env.svm.minimum_balance_for_rent_exemption(acc.data.len());
        assert_eq!(
            acc.lamports,
            rent + c.real_sol_reserves + c.creator_fees_unclaimed + c.platform_fees_unclaimed + c.buyback_lamports,
            "coin lamport invariant broken"
        );
    }

    /// Current spot, Q64: curve virtual reserves before graduation, PumpSwap after.
    pub fn spot_q64(&self) -> u128 {
        let c = self.coin_state();
        if c.status != CoinStatus::Graduated {
            return ((c.virtual_sol_reserves as u128) << 64) / c.virtual_token_reserves as u128;
        }
        let p = self.env.account(&self.pool).unwrap();
        let vqr = if p.data.len() >= 261 { i128::from_le_bytes(p.data[245..261].try_into().unwrap()) } else { 0 };
        let quote = (token_balance(&self.env, &self.pool_quote) as i128 + vqr) as u128;
        (quote << 64) / token_balance(&self.env, &self.pool_base) as u128
    }

    // ── curve ───────────────────────────────────────────────────────────────

    pub fn buy_ix(&self, user: &Pubkey, sol_in: u64) -> Instruction {
        let open = self.rebuy_metas(user);
        ix_with_remaining(
            fumpad::accounts::Buy {
                user: *user,
                global: self.env.global_pda(),
                coin: self.coin,
                mint: self.mint,
                pool_authority: pool_authority(),
                curve_vault: self.curve_vault,
                reward_vault: self.reward_vault,
                user_token_account: ata(user, &self.mint, &T22),
                position: self.position_key(user),
                token_program: T22,
                associated_token_program: ATA_PROGRAM,
                system_program: SYSTEM,
                event_authority: event_authority(),
                program: fumpad::ID,
            },
            fumpad::instruction::Buy { sol_in, min_tokens_out: 1 },
            &open,
        )
    }

    pub fn buy(&mut self, user: &Keypair, sol_in: u64) -> TransactionResult {
        let i = self.buy_ix(&kp_pk(user), sol_in);
        self.env.send_as(user, &[i], &[user])
    }

    /// Curve sell with a fresh Pyth price (refreshed when the tx is built).
    pub fn sell_ix(&mut self, user: &Pubkey, tokens_in: u64) -> Instruction {
        self.env.set_sol_usd(SOL_USD);
        ix(
            fumpad::accounts::Sell {
                user: *user,
                global: self.env.global_pda(),
                coin: self.coin,
                mint: self.mint,
                pool_authority: pool_authority(),
                curve_vault: self.curve_vault,
                reward_vault: self.reward_vault,
                user_token_account: ata(user, &self.mint, &T22),
                position: self.position_key(user),
                ticket: self.next_ticket(user),
                sol_usd_price: PYTH_SOL_USD,
                token_program: T22,
                system_program: SYSTEM,
                event_authority: event_authority(),
                program: fumpad::ID,
            },
            fumpad::instruction::Sell { tokens_in, min_sol_out: 0 },
        )
    }

    pub fn sell(&mut self, user: &Keypair, tokens_in: u64) -> TransactionResult {
        let i = self.sell_ix(&kp_pk(user), tokens_in);
        self.env.send_as(user, &[i], &[user])
    }

    pub fn graduate(&mut self) -> TransactionResult {
        let pa = pool_authority();
        let lp_mint = lp_mint_pda(&self.pool);
        let i = ix(
            fumpad::accounts::Graduate {
                payer: kp_pk(&self.env.payer),
                global: self.env.global_pda(),
                coin: self.coin,
                mint: self.mint,
                pool_authority: pa,
                curve_vault: self.curve_vault,
                wsol_mint: WSOL_MINT,
                graduation_wsol: fpda(&[fumpad::GRADUATION_WSOL_SEED, self.mint.as_ref()]),
                amm_pool: self.pool,
                amm_global_config: PUMPSWAP_GLOBAL_CONFIG,
                lp_mint,
                pool_authority_lp: ata(&pa, &lp_mint, &T22),
                pool_base_vault: self.pool_base,
                pool_quote_vault: self.pool_quote,
                amm_event_authority: event_authority_pda(),
                amm_program: PUMPSWAP_PROGRAM_ID,
                lp_lock: locker_accounts(&self.pool).0,
                lp_locker_authority: locker_accounts(&self.pool).1,
                lp_vault: locker_accounts(&self.pool).2,
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
        self.env.send(&[cu_limit(400_000), i], &[])
    }

    /// init_observations + `CLAIM_QUEUE_INIT_CALLS` (9) × init_claim_queue + PumpSwap volume accumulator for the
    /// pool authority (one-time buyback setup).
    pub fn post_graduation_setup(&mut self) {
        let payer = kp_pk(&self.env.payer);
        let obs = ix(
            fumpad::accounts::InitObservations {
                payer,
                coin: self.coin,
                observations: self.observations,
                system_program: SYSTEM,
            },
            fumpad::instruction::InitObservations {},
        );
        ok(self.env.send(&[obs], &[]));
        let q = ix(
            fumpad::accounts::InitClaimQueue { payer, coin: self.coin, claim_queue: self.queue, system_program: SYSTEM },
            fumpad::instruction::InitClaimQueue {},
        );
        ok(self.env.send(&vec![q; fumpad::CLAIM_QUEUE_INIT_CALLS], &[]));
        let pa = pool_authority();
        let init_uva = raw_ix(
            PUMPSWAP_PROGRAM_ID,
            vec![
                Meta::new(payer, true),
                r(pa),
                w(uva(&pa)),
                r(SYSTEM),
                r(event_authority_pda()),
                r(PUMPSWAP_PROGRAM_ID),
            ],
            vec![94, 6, 202, 115, 255, 96, 232, 183],
        );
        ok(self.env.send(&[init_uva], &[]));
    }

    // ── router ──────────────────────────────────────────────────────────────

    /// PumpSwap buy/sell v2 account list (17).
    pub fn venue(&self, user: Pubkey, user_base: Pubkey, user_quote: Pubkey) -> Vec<Meta> {
        vec![
            w(self.pool),
            w(user),
            r(PUMPSWAP_GLOBAL_CONFIG),
            r(self.mint),
            r(WSOL_MINT),
            w(user_base),
            w(user_quote),
            w(self.pool_base),
            w(self.pool_quote),
            r(T22),
            r(TOKEN),
            r(SYSTEM),
            w(uva(&user)),
            r(FEE_CONFIG),
            w(self.buyback_fee_recipient_ata),
            r(event_authority_pda()),
            r(PUMPSWAP_PROGRAM_ID),
        ]
    }

    fn user_venue(&self, u: &Pubkey) -> Vec<Meta> {
        self.venue(*u, ata(u, &self.mint, &T22), ata(u, &WSOL_MINT, &TOKEN))
    }

    pub fn swap_buy_ix(&self, u: &Pubkey, sol_in: u64) -> Instruction {
        let mut rem = self.rebuy_metas(u);
        rem.extend(self.user_venue(u));
        ix_with_remaining(
            fumpad::accounts::SwapBuy {
                user: *u,
                global: self.env.global_pda(),
                coin: self.coin,
                mint: self.mint,
                position: self.position_key(u),
                user_token_account: ata(u, &self.mint, &T22),
                user_wsol: ata(u, &WSOL_MINT, &TOKEN),
                wsol_mint: WSOL_MINT,
                pumpswap_program: PUMPSWAP_PROGRAM_ID,
                token_program: TOKEN,
                token_2022_program: T22,
                associated_token_program: ATA_PROGRAM,
                system_program: SYSTEM,
                event_authority: event_authority(),
                program: fumpad::ID,
            },
            fumpad::instruction::SwapBuy { sol_in, min_tokens_out: 1 },
            &rem,
        )
    }

    pub fn swap_buy(&mut self, user: &Keypair, sol_in: u64) -> TransactionResult {
        let i = self.swap_buy_ix(&kp_pk(user), sol_in);
        self.env.send_as(user, &[cu_limit(1_400_000), i], &[user])
    }

    /// Router sell with a fresh Pyth price (refreshed when the tx is built).
    pub fn swap_sell_ix(&mut self, u: &Pubkey, tokens_in: u64) -> Instruction {
        self.env.set_sol_usd(SOL_USD);
        ix_with_remaining(
            fumpad::accounts::SwapSell {
                user: *u,
                global: self.env.global_pda(),
                coin: self.coin,
                mint: self.mint,
                position: self.position_key(u),
                ticket: self.next_ticket(u),
                sol_usd_price: PYTH_SOL_USD,
                user_token_account: ata(u, &self.mint, &T22),
                user_wsol: ata(u, &WSOL_MINT, &TOKEN),
                wsol_mint: WSOL_MINT,
                pumpswap_program: PUMPSWAP_PROGRAM_ID,
                token_program: TOKEN,
                token_2022_program: T22,
                associated_token_program: ATA_PROGRAM,
                system_program: SYSTEM,
                event_authority: event_authority(),
                program: fumpad::ID,
            },
            fumpad::instruction::SwapSell { tokens_in, min_sol_out: 0 },
            &self.user_venue(u),
        )
    }

    pub fn swap_sell(&mut self, user: &Keypair, tokens_in: u64) -> TransactionResult {
        let i = self.swap_sell_ix(&kp_pk(user), tokens_in);
        self.env.send_as(user, &[cu_limit(1_400_000), i], &[user])
    }

    /// Direct PumpSwap sell (outside FUMPAD). Ensures the trader's WSOL ATA exists.
    pub fn direct_sell_ix(&mut self, trader: &Pubkey, base_in: u64) -> Instruction {
        let quote = ata(trader, &WSOL_MINT, &TOKEN);
        if self.env.account(&quote).map_or(true, |a| a.lamports == 0) {
            put_token_account(&mut self.env, quote, WSOL_MINT, *trader, 0, TOKEN);
        }
        let mut data = IX_SELL_V2.to_vec();
        data.extend_from_slice(&base_in.to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes());
        let mut metas = self.user_venue(trader);
        metas[1] = Meta::new(*trader, true);
        raw_ix(PUMPSWAP_PROGRAM_ID, metas, data)
    }

    /// Direct PumpSwap buy (outside FUMPAD) spending `quote_in` WSOL, which is credited to
    /// the trader's WSOL ATA up front (as if the trader had wrapped it).
    pub fn direct_buy_ix(&mut self, trader: &Pubkey, quote_in: u64, top_up: bool) -> Instruction {
        let quote = ata(trader, &WSOL_MINT, &TOKEN);
        let have = token_balance(&self.env, &quote);
        if top_up || self.env.account(&quote).map_or(true, |a| a.lamports == 0) {
            put_token_account(&mut self.env, quote, WSOL_MINT, *trader, have + quote_in, TOKEN);
        }
        let mut data = IX_BUY_EXACT_QUOTE_IN_V2.to_vec();
        data.extend_from_slice(&quote_in.to_le_bytes());
        data.extend_from_slice(&1u64.to_le_bytes());
        let mut metas = self.user_venue(trader);
        metas[1] = Meta::new(*trader, true);
        raw_ix(PUMPSWAP_PROGRAM_ID, metas, data)
    }

    // ── oracle ──────────────────────────────────────────────────────────────

    pub fn sample_ix(&self, sampler: &Pubkey) -> Instruction {
        ix_with_remaining(
            fumpad::accounts::RecordSamples {
                sampler: *sampler,
                global: self.env.global_pda(),
                instructions: IX_SYSVAR,
                event_authority: event_authority(),
                program: fumpad::ID,
            },
            fumpad::instruction::RecordSamples {},
            &[w(self.coin), w(self.observations), r(self.pool), r(self.pool_base), r(self.pool_quote)],
        )
    }

    pub fn keeper_sample(&mut self) -> TransactionResult {
        let k = self.env.keeper.insecure_clone();
        let i = self.sample_ix(&kp_pk(&k));
        self.env.send_as(&k, &[i], &[&k])
    }

    /// `n` keeper samples, `spacing` seconds apart (warps before each).
    pub fn keeper_samples(&mut self, n: usize, spacing: i64) {
        for _ in 0..n {
            self.env.warp(spacing);
            ok(self.keeper_sample());
        }
    }

    pub fn median(&self) -> Option<u128> {
        let p = Params::default();
        let o: Observations = self.env.fetch_zc(&self.observations);
        o.median_price_q64(self.now(), p.oracle_window_secs, p.oracle_min_samples)
    }

    pub fn execute_buyback(&mut self, max_lamports: u64) -> TransactionResult {
        let pa = pool_authority();
        let cranker = self.env.new_user(1);
        let i = ix_with_remaining(
            fumpad::accounts::ExecuteBuyback {
                cranker: kp_pk(&cranker),
                global: self.env.global_pda(),
                coin: self.coin,
                mint: self.mint,
                observations: self.observations,
                reward_vault: self.reward_vault,
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
            fumpad::instruction::ExecuteBuyback { max_lamports },
            &self.venue(pa, self.reward_vault, ata(&pa, &WSOL_MINT, &TOKEN)),
        );
        self.env.send_as(&cranker, &[cu_limit(1_400_000), i], &[&cranker])
    }

    // ── rewards ─────────────────────────────────────────────────────────────

    pub fn claim(&mut self, owner: &Keypair, ticket: Pubkey) -> TransactionResult {
        let o = kp_pk(owner);
        let i = ix(
            fumpad::accounts::Claim {
                owner: o,
                global: self.env.global_pda(),
                coin: self.coin,
                mint: self.mint,
                ticket,
                position: self.position_key(&o),
                claim_queue: self.queue,
                observations: self.observations,
                pool_authority: pool_authority(),
                reward_vault: self.reward_vault,
                owner_token_account: ata(&o, &self.mint, &T22),
                token_program: T22,
                event_authority: event_authority(),
                program: fumpad::ID,
            },
            fumpad::instruction::Claim {},
        );
        self.env.send_as(owner, &[i], &[owner])
    }

    pub fn queue_state(&self) -> Box<ClaimQueue> {
        let acc = self.env.account(&self.queue).expect("queue");
        let n = std::mem::size_of::<ClaimQueue>();
        let mut q: Box<ClaimQueue> = Box::new(unsafe { std::mem::zeroed() });
        unsafe { std::ptr::copy_nonoverlapping(acc.data[8..8 + n].as_ptr(), &mut *q as *mut ClaimQueue as *mut u8, n) };
        q
    }

    /// process_queue with quadruples for `entries` = (ticket, owner), in queue order.
    pub fn process_queue(&mut self, max_entries: u8, entries: &[(Pubkey, Pubkey)]) -> TransactionResult {
        let rem: Vec<Meta> = entries
            .iter()
            .flat_map(|(t, o)| {
                [w(*t), w(self.position_key(o)), w(ata(o, &self.mint, &T22)), w(fpda(&[fumpad::ESCROW_SEED, t.as_ref()]))]
            })
            .collect();
        let i = ix_with_remaining(
            fumpad::accounts::ProcessQueue {
                cranker: kp_pk(&self.env.payer),
                global: self.env.global_pda(),
                coin: self.coin,
                mint: self.mint,
                claim_queue: self.queue,
                pool_authority: pool_authority(),
                reward_vault: self.reward_vault,
                token_program: T22,
                system_program: SYSTEM,
                event_authority: event_authority(),
                program: fumpad::ID,
            },
            fumpad::instruction::ProcessQueue { max_entries },
            &rem,
        );
        self.env.send(&[cu_limit(1_400_000), i], &[])
    }

    pub fn close_ticket(&mut self, caller: &Keypair, ticket: Pubkey) -> TransactionResult {
        let t = self.ticket(&ticket);
        let i = ix(
            fumpad::accounts::CloseTicket {
                caller: kp_pk(caller),
                global: self.env.global_pda(),
                ticket,
                owner: t.owner,
                position: self.position_key(&t.owner),
                claim_queue: Some(self.queue).filter(|_| t.queued_at != 0),
                event_authority: event_authority(),
                program: fumpad::ID,
            },
            fumpad::instruction::CloseTicket {},
        );
        self.env.send_as(caller, &[i], &[caller])
    }

    pub fn withdraw_creator_fees(&mut self) -> TransactionResult {
        let c = self.creator.insecure_clone();
        let i = ix(
            fumpad::accounts::WithdrawCreatorFees {
                creator: kp_pk(&c),
                coin: self.coin,
                event_authority: event_authority(),
                program: fumpad::ID,
            },
            fumpad::instruction::WithdrawCreatorFees {},
        );
        self.env.send_as(&c, &[i], &[&c])
    }

    pub fn withdraw_platform_fees(&mut self) -> TransactionResult {
        let i = ix(
            fumpad::accounts::WithdrawPlatformFees {
                caller: kp_pk(&self.env.payer),
                global: self.env.global_pda(),
                coin: self.coin,
                platform_treasury: kp_pk(&self.env.treasury),
                event_authority: event_authority(),
                program: fumpad::ID,
            },
            fumpad::instruction::WithdrawPlatformFees {},
        );
        self.env.send(&[i], &[])
    }

    // ── D11 locker ──────────────────────────────────────────────────────────

    pub fn lp_mint(&self) -> Pubkey {
        lp_mint_pda(&self.pool)
    }
    /// The locker's fixed WSOL destination: ATA(coin PDA, WSOL).
    pub fn lp_fee_wsol(&self) -> Pubkey {
        ata(&self.coin, &WSOL_MINT, &TOKEN)
    }
    pub fn lock_state(&self) -> fumpad_lp_locker::Lock {
        self.env.fetch(&locker_accounts(&self.pool).0)
    }
    pub fn locked_lp(&self) -> u64 {
        token_balance(&self.env, &locker_accounts(&self.pool).2)
    }
    pub fn lp_supply(&self) -> u64 {
        u64::from_le_bytes(self.env.account(&self.pool).unwrap().data[203..211].try_into().unwrap())
    }
    /// (⌊√(base · quote_value)⌋, lp_supply) exactly as the locker measures them.
    pub fn sqrt_k(&self) -> (u128, u64) {
        let p = fumpad_lp_locker::parse_pool(&self.env.account(&self.pool).unwrap().data).unwrap();
        let base = token_balance(&self.env, &self.pool_base) as u128;
        let q = fumpad_lp_locker::quote_value(token_balance(&self.env, &self.pool_quote), p.virtual_quote, p.waiting_fees);
        (fumpad_lp_locker::isqrt(base * q as u128), p.lp_supply)
    }
    /// Principal in √k units fixed at lock time (f64).
    pub fn lp_principal(&self) -> f64 {
        let l = self.lock_state();
        l.principal_num as f64 / l.lp_supply_at_lock as f64
    }
    /// Value of the locked LP in √k units (f64, independent of the locker's own check).
    pub fn locked_value(&self) -> f64 {
        let (s, l) = self.sqrt_k();
        self.locked_lp() as f64 * s as f64 / l as f64
    }

    /// PumpSwap deposit/withdraw account list (15).
    pub fn liquidity_metas(&self, user: Pubkey, user_base: Pubkey, user_quote: Pubkey, user_lp: Pubkey) -> Vec<Meta> {
        vec![
            w(self.pool),
            r(PUMPSWAP_GLOBAL_CONFIG),
            r(user),
            r(self.mint),
            r(WSOL_MINT),
            w(self.lp_mint()),
            w(user_base),
            w(user_quote),
            w(user_lp),
            w(self.pool_base),
            w(self.pool_quote),
            r(TOKEN),
            r(T22),
            r(event_authority_pda()),
            r(PUMPSWAP_PROGRAM_ID),
        ]
    }

    /// [create ATA(coin, WSOL) idempotent (payer), locker `skim`].
    pub fn skim_ixs(&self, payer: &Pubkey) -> Vec<Instruction> {
        let (lock, authority, lp_vault) = locker_accounts(&self.pool);
        let venue = self.liquidity_metas(authority, self.reward_vault, self.lp_fee_wsol(), lp_vault);
        vec![create_ata_ix(payer, &self.coin, &WSOL_MINT, &TOKEN), locker_ix(
            fumpad_lp_locker::accounts::Skim { lock, authority, pumpswap_program: PUMPSWAP_PROGRAM_ID },
            fumpad_lp_locker::instruction::Skim {},
            &venue,
        )]
    }

    pub fn skim(&mut self) -> TransactionResult {
        let mut ixs = vec![cu_limit(400_000)];
        ixs.extend(self.skim_ixs(&kp_pk(&self.env.payer)));
        self.env.send(&ixs, &[])
    }

    pub fn settle_ix(&self, cranker: &Pubkey) -> Instruction {
        ix(
            fumpad::accounts::SettleLpFees {
                cranker: *cranker,
                coin: self.coin,
                wsol_mint: WSOL_MINT,
                lp_fee_wsol: self.lp_fee_wsol(),
                token_program: TOKEN,
                system_program: SYSTEM,
                event_authority: event_authority(),
                program: fumpad::ID,
            },
            fumpad::instruction::SettleLpFees {},
        )
    }

    pub fn settle_lp_fees(&mut self) -> TransactionResult {
        let i = self.settle_ix(&kp_pk(&self.env.payer));
        self.env.send(&[i], &[])
    }
}

/// Instruction for the locker program from Anchor's generated types.
pub fn locker_ix(accounts: impl ToAccountMetas, data: impl InstructionData, remaining: &[Meta]) -> Instruction {
    let mut i = ix_with_remaining(accounts, data, remaining);
    i.program_id = addr(&fumpad_lp_locker::ID);
    i
}

/// Associated Token Account `create_idempotent`.
pub fn create_ata_ix(payer: &Pubkey, owner: &Pubkey, mint: &Pubkey, program: &Pubkey) -> Instruction {
    raw_ix(
        ATA_PROGRAM,
        vec![Meta::new(*payer, true), w(ata(owner, mint, program)), r(*owner), r(*mint), r(SYSTEM), r(*program)],
        vec![1],
    )
}

/// Locker `emit!` events (logged as "Program data: <base64>").
pub fn locker_events<T: AnchorDeserialize + Discriminator>(m: &TransactionMetadata) -> Vec<T> {
    use base64::Engine;
    m.logs
        .iter()
        .filter_map(|l| l.strip_prefix("Program data: "))
        .filter_map(|b| base64::engine::general_purpose::STANDARD.decode(b).ok())
        .filter(|d| d.starts_with(T::DISCRIMINATOR))
        .map(|d| T::deserialize(&mut &d[T::DISCRIMINATOR.len()..]).unwrap())
        .collect()
}

/// Locker custom error code.
pub fn locker_code(e: fumpad_lp_locker::LockerError) -> u32 {
    anchor_lang::error::ERROR_CODE_OFFSET + e as u32
}

#[track_caller]
pub fn expect_custom(res: TransactionResult, code: u32) {
    match res {
        Ok(_) => panic!("expected Custom({code}), but the transaction succeeded"),
        Err(f) => {
            let s = format!("{:?}", f.err);
            assert!(s.contains(&format!("Custom({code})")), "expected Custom({code}), got {s}\nlogs: {:#?}", f.meta.logs);
        }
    }
}
