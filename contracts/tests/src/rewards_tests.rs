//! Rewards module integration tests (LiteSVM).
//!
//! The curve / router aren't in this branch, so the world is FABRICATED with
//! `svm.set_account`: a graduated Coin, a Token-2022 mint, the reward vault, Positions,
//! Tickets, Observations samples and Pyth bytes. Sell-side ticket creation (`on_sell`)
//! is covered by pure unit tests in the program crate (`hooks::tests`, `logic::tests`);
//! the rebuy rule is exercised end-to-end through `register_holdings`, which shares
//! `hooks::apply_rebuy` with `on_buy`.

use anchor_lang::{
    prelude::{AccountMeta, Pubkey},
    AccountSerialize, Discriminator, Space,
};
use fumpad::{
    error::FumpadError,
    math::price::price_q64,
    state::{
        ClaimQueue, Coin, CoinStatus, Observations, Position, QueueEntry, Ticket, TicketStatus, PAUSE_CLAIMS,
    },
};
use litesvm::types::TransactionResult;
use solana_account::Account;
use solana_instruction::Instruction;
use solana_keypair::Keypair;

use crate::*;

const TOKEN_2022: Pubkey = anchor_lang::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROGRAM: Pubkey = anchor_lang::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const T0: i64 = 1_800_000_000;
const DAY: i64 = 86_400;
const M: u64 = 1_000_000; // 1 token (6 decimals)
const POOL: u64 = 50_000_000 * M;

// ── generic helpers ─────────────────────────────────────────────────────────

fn code(e: FumpadError) -> u32 {
    6000 + e as u32
}

#[track_caller]
fn assert_err_code(res: TransactionResult, c: u32) {
    match res {
        Ok(_) => panic!("expected custom error {c}, tx succeeded"),
        Err(e) => {
            let s = format!("{:?}", e.err);
            assert!(s.contains(&format!("Custom({c})")), "expected Custom({c}), got {s}\n{:#?}", e.meta.logs);
        }
    }
}

#[track_caller]
fn assert_fumpad_err(res: TransactionResult, e: FumpadError) {
    assert_err_code(res, code(e));
}

#[track_caller]
fn ok(res: TransactionResult) -> litesvm::types::TransactionMetadata {
    match res {
        Ok(m) => m,
        Err(e) => panic!("tx failed: {:?}\n{:#?}", e.err, e.meta.logs),
    }
}

fn anchor_bytes<T: AccountSerialize>(v: &T) -> Vec<u8> {
    let mut d = Vec::new();
    v.try_serialize(&mut d).unwrap();
    d
}

fn pod_bytes<T: Copy>(v: &T) -> Vec<u8> {
    unsafe { std::slice::from_raw_parts(v as *const T as *const u8, std::mem::size_of::<T>()) }.to_vec()
}

fn zeroed_box<T: Copy>() -> Box<T> {
    // All zero-copy account types are Pod.
    unsafe { Box::new_zeroed().assume_init() }
}

pub fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), TOKEN_2022.as_ref(), mint.as_ref()], &ATA_PROGRAM).0
}

fn mint_bytes(supply: u64) -> Vec<u8> {
    let mut d = vec![0u8; 82];
    d[36..44].copy_from_slice(&supply.to_le_bytes());
    d[44] = 6; // decimals
    d[45] = 1; // initialized
    d
}

/// Token-2022 account. `exts`: append ImmutableOwner (+ MemoTransfer(required) if `memo`).
fn token_account_bytes(mint: &Pubkey, owner: &Pubkey, amount: u64, exts: bool, memo: bool) -> Vec<u8> {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1; // Initialized
    if exts {
        d.push(2); // AccountType::Account
        d.extend_from_slice(&[7, 0, 0, 0]); // ImmutableOwner, len 0
        if memo {
            d.extend_from_slice(&[8, 0, 1, 0, 1]); // MemoTransfer { require_incoming: true }
        }
    }
    d
}

fn token_amount(env: &Env, key: &Pubkey) -> u64 {
    let d = env.account(key).map(|a| a.data).unwrap_or_default();
    if d.len() < 72 {
        return 0;
    }
    u64::from_le_bytes(d[64..72].try_into().unwrap())
}

fn sell_price(lamports: u64, tokens: u64) -> u128 {
    price_q64(lamports, tokens).unwrap()
}

// ── the fabricated world ────────────────────────────────────────────────────

pub struct World {
    pub env: Env,
    pub mint: Pubkey,
    pub creator: Keypair,
    pub coin: Pubkey,
    pub pool_auth: Pubkey,
    pub vault: Pubkey,
    pub obs: Pubkey,
    pub queue: Pubkey,
}

pub struct User {
    pub kp: Keypair,
    pub key: Pubkey,
    pub ata: Pubkey,
}

impl World {
    /// Graduated coin, 50M-token pool, observations at 10x of `base_price()`, queue initialized.
    pub fn new() -> Self {
        let mut w = Self::bare(CoinStatus::Graduated);
        w.set_samples(120, sell_price(10_000, M)); // 10x of base_price
        ok(w.init_queue());
        w
    }

    pub fn bare(status: CoinStatus) -> Self {
        let mut env = Env::new();
        let mut c = env.svm.get_sysvar::<litesvm_clock::Clock>();
        c.unix_timestamp = T0;
        env.svm.set_sysvar(&c);
        let creator = env.new_user(10);
        let mint = Pubkey::new_unique();
        let p = |seeds: &[&[u8]]| Pubkey::find_program_address(seeds, &fumpad::ID).0;
        let coin = p(&[fumpad::COIN_SEED, mint.as_ref()]);
        let pool_auth = p(&[fumpad::POOL_AUTHORITY_SEED]);
        let vault = p(&[fumpad::REWARD_VAULT_SEED, mint.as_ref()]);
        let obs = p(&[fumpad::OBSERVATIONS_SEED, mint.as_ref()]);
        let queue = p(&[fumpad::CLAIM_QUEUE_SEED, mint.as_ref()]);
        let mut w = World { env, mint, creator, coin, pool_auth, vault, obs, queue };
        w.raw_set(&mint, mint_bytes(1_000_000_000 * M), TOKEN_2022);
        w.set_pool(POOL);
        let coin_bump = Pubkey::find_program_address(&[fumpad::COIN_SEED, mint.as_ref()], &fumpad::ID).1;
        let c = Coin {
            bump: coin_bump,
            mint,
            creator: kp_pk(&w.creator),
            status,
            created_at: T0 - 10 * DAY,
            virtual_sol_reserves: 0,
            virtual_token_reserves: 0,
            real_sol_reserves: 0,
            real_token_reserves: 0,
            completed_at: T0 - 9 * DAY,
            graduated_at: T0 - 9 * DAY,
            amm_pool: Pubkey::new_unique(),
            creator_fees_unclaimed: 0,
            platform_fees_unclaimed: 0,
            buyback_lamports: 0,
            volume_lamports: 0,
            trade_count: 0,
            tickets_created: 0,
            tokens_paid_out: 0,
            reference: Default::default(),
            fees: fumpad::state::Params::default().coin_fees(),
            snipe: Default::default(),
            reserved: [0; 60],
        };
        w.write_coin(&c);
        w
    }

    fn raw_set(&mut self, key: &Pubkey, data: Vec<u8>, owner: Pubkey) {
        let lamports = self.env.svm.minimum_balance_for_rent_exemption(data.len());
        self.env
            .svm
            .set_account(addr(key), Account { lamports, data, owner: addr(&owner), executable: false, rent_epoch: 0 })
            .unwrap();
    }

    pub fn now(&self) -> i64 {
        self.env.now()
    }

    pub fn coin_state(&self) -> Coin {
        self.env.fetch(&self.coin)
    }

    /// Writes the coin with lamports = rent + every tracked lamport (the invariant).
    pub fn write_coin(&mut self, c: &Coin) {
        let data = anchor_bytes(c);
        assert_eq!(data.len(), 8 + Coin::INIT_SPACE);
        let lamports = self.env.svm.minimum_balance_for_rent_exemption(data.len())
            + c.real_sol_reserves
            + c.creator_fees_unclaimed
            + c.platform_fees_unclaimed
            + c.buyback_lamports;
        self.env
            .svm
            .set_account(
                addr(&self.coin),
                Account { lamports, data, owner: addr(&fumpad::ID), executable: false, rent_epoch: 0 },
            )
            .unwrap();
    }

    pub fn coin_invariant_holds(&self) -> bool {
        let c = self.coin_state();
        let rent = self.env.svm.minimum_balance_for_rent_exemption(8 + Coin::INIT_SPACE);
        self.env.lamports(&self.coin)
            == rent + c.real_sol_reserves + c.creator_fees_unclaimed + c.platform_fees_unclaimed + c.buyback_lamports
    }

    pub fn set_pool(&mut self, amount: u64) {
        let (vault, mint, pa) = (self.vault, self.mint, self.pool_auth);
        self.raw_set(&vault, token_account_bytes(&mint, &pa, amount, false, false), TOKEN_2022);
    }

    pub fn pool(&self) -> u64 {
        token_amount(&self.env, &self.vault)
    }

    /// `n` samples, 15 s apart, ending now, all at `price`.
    pub fn set_samples(&mut self, n: usize, price: u128) {
        let now = self.now();
        let mut o: Box<Observations> = zeroed_box();
        o.mint = self.mint;
        o.bump = Pubkey::find_program_address(&[fumpad::OBSERVATIONS_SEED, self.mint.as_ref()], &fumpad::ID).1;
        for i in (0..n as i64).rev() {
            o.push(now - i * 15, price, false);
        }
        let mut data = Observations::DISCRIMINATOR.to_vec();
        data.extend(pod_bytes(&*o));
        let obs = self.obs;
        self.raw_set(&obs, data, fumpad::ID);
    }

    pub fn init_queue_ix(&self, payer: &Pubkey) -> Instruction {
        ix(
            fumpad::accounts::InitClaimQueue {
                payer: *payer,
                coin: self.coin,
                claim_queue: self.queue,
                system_program: anchor_lang::system_program::ID,
            },
            fumpad::instruction::InitClaimQueue {},
        )
    }

    /// Three growth steps in one transaction.
    pub fn init_queue(&mut self) -> TransactionResult {
        let payer = kp_pk(&self.env.payer);
        let i = self.init_queue_ix(&payer);
        self.env.send(&vec![i; fumpad::CLAIM_QUEUE_INIT_CALLS], &[])
    }

    pub fn queue_state(&self) -> Box<ClaimQueue> {
        let acc = self.env.account(&self.queue).expect("queue");
        let mut q: Box<ClaimQueue> = zeroed_box();
        let n = std::mem::size_of::<ClaimQueue>();
        unsafe { std::ptr::copy_nonoverlapping(acc.data[8..8 + n].as_ptr(), &mut *q as *mut ClaimQueue as *mut u8, n) };
        q
    }

    pub fn write_queue(&mut self, q: &ClaimQueue) {
        let mut acc = self.env.account(&self.queue).expect("queue");
        let n = std::mem::size_of::<ClaimQueue>();
        acc.data[8..8 + n].copy_from_slice(&pod_bytes(q));
        self.env.svm.set_account(addr(&self.queue), acc).unwrap();
    }

    pub fn user(&mut self, balance: u64) -> User {
        let kp = self.env.new_user(10);
        let key = kp_pk(&kp);
        let a = ata(&key, &self.mint);
        let mint = self.mint;
        self.raw_set(&a, token_account_bytes(&mint, &key, balance, true, false), TOKEN_2022);
        User { kp, key, ata: a }
    }

    pub fn set_balance(&mut self, u: &User, balance: u64, memo: bool) {
        let mint = self.mint;
        self.raw_set(&u.ata, token_account_bytes(&mint, &u.key, balance, true, memo), TOKEN_2022);
    }

    pub fn position_key(&self, owner: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[fumpad::POSITION_SEED, self.mint.as_ref(), owner.as_ref()], &fumpad::ID).0
    }

    pub fn position(&self, owner: &Pubkey) -> Position {
        self.env.fetch(&self.position_key(owner))
    }

    pub fn write_position(&mut self, p: &Position) {
        let key = self.position_key(&p.wallet);
        self.raw_set(&key, anchor_bytes(p), fumpad::ID);
    }

    fn position_or_new(&self, owner: &Pubkey) -> Position {
        match self.env.account(&self.position_key(owner)) {
            Some(_) => self.position(owner),
            None => Position {
                bump: Pubkey::find_program_address(
                    &[fumpad::POSITION_SEED, self.mint.as_ref(), owner.as_ref()],
                    &fumpad::ID,
                )
                .1,
                wallet: *owner,
                mint: self.mint,
                matured: 0,
                pending: 0,
                pending_since: 0,
                next_ticket_seq: 0,
                open_tickets: [Pubkey::default(); fumpad::MAX_OPEN_TICKETS],
                open_count: 0,
                last_balance: 0,
                auto_claim_opt_out: 0,
                reserved: [0; 55],
            },
        }
    }

    pub fn ticket_key(&self, owner: &Pubkey, seq: u64) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[fumpad::TICKET_SEED, self.mint.as_ref(), owner.as_ref(), &seq.to_le_bytes()],
            &fumpad::ID,
        )
    }

    /// Fabricate a ticket exactly as `on_sell` would (and register it in the position).
    pub fn add_ticket(&mut self, owner: &Pubkey, tokens: u64, price_q64: u128, sell_ts: i64) -> Pubkey {
        let mut pos = self.position_or_new(owner);
        let seq = pos.next_ticket_seq;
        let (key, bump) = self.ticket_key(owner, seq);
        let t = Ticket {
            bump,
            owner: *owner,
            mint: self.mint,
            seq,
            tokens,
            original_tokens: tokens,
            sell_price_q64: price_q64,
            sell_usd_cents: 10_000,
            sell_ts,
            status: TicketStatus::Open,
            queued_at: 0,
            claim_amount: 0,
            claimed_at: 0,
            escrow_payer: Pubkey::default(),
        };
        assert_eq!(anchor_bytes(&t).len(), 8 + Ticket::INIT_SPACE);
        self.raw_set(&key, anchor_bytes(&t), fumpad::ID);
        pos.next_ticket_seq += 1;
        let slot = pos.open_tickets.iter().position(|k| *k == Pubkey::default()).expect("free slot");
        pos.open_tickets[slot] = key;
        pos.open_count += 1;
        self.write_position(&pos);
        key
    }

    pub fn ticket(&self, key: &Pubkey) -> Ticket {
        self.env.fetch(key)
    }

    pub fn write_ticket(&mut self, key: &Pubkey, t: &Ticket) {
        self.raw_set(key, anchor_bytes(t), fumpad::ID);
    }

    // ── instruction builders ────────────────────────────────────────────────

    pub fn claim_ix(&self, owner: &Pubkey, ticket: Pubkey, dest: Pubkey) -> Instruction {
        ix(
            fumpad::accounts::Claim {
                owner: *owner,
                global: self.env.global_pda(),
                coin: self.coin,
                mint: self.mint,
                ticket,
                position: self.position_key(owner),
                claim_queue: self.queue,
                observations: self.obs,
                pool_authority: self.pool_auth,
                reward_vault: self.vault,
                owner_token_account: dest,
                token_program: TOKEN_2022,
                event_authority: fumpad::EVENT_AUTHORITY_AND_BUMP.0,
                program: fumpad::ID,
            },
            fumpad::instruction::Claim {},
        )
    }

    pub fn claim(&mut self, u: &User, ticket: Pubkey) -> TransactionResult {
        let i = self.claim_ix(&u.key, ticket, u.ata);
        self.env.send(&[i], &[&u.kp])
    }

    /// `entries`: (ticket, owner) in the order the triples are passed.
    pub fn process_ix(&self, max_entries: u8, entries: &[(Pubkey, Pubkey)]) -> Instruction {
        let rem: Vec<AccountMeta> = entries
            .iter()
            .flat_map(|(t, o)| {
                [
                    AccountMeta::new(*t, false),
                    AccountMeta::new(self.position_key(o), false),
                    AccountMeta::new(ata(o, &self.mint), false),
                    AccountMeta::new(self.escrow_key(t), false),
                ]
            })
            .collect();
        self.process_ix_raw(max_entries, rem)
    }

    pub fn process_ix_raw(&self, max_entries: u8, rem: Vec<AccountMeta>) -> Instruction {
        ix_with_remaining(
            fumpad::accounts::ProcessQueue {
                cranker: kp_pk(&self.env.payer),
                global: self.env.global_pda(),
                coin: self.coin,
                mint: self.mint,
                claim_queue: self.queue,
                pool_authority: self.pool_auth,
                reward_vault: self.vault,
                token_program: TOKEN_2022,
                system_program: anchor_lang::system_program::ID,
                event_authority: fumpad::EVENT_AUTHORITY_AND_BUMP.0,
                program: fumpad::ID,
            },
            fumpad::instruction::ProcessQueue { max_entries },
            &rem,
        )
    }

    pub fn process(&mut self, max_entries: u8, entries: &[(Pubkey, Pubkey)]) -> TransactionResult {
        let i = self.process_ix(max_entries, entries);
        self.env.send(&[i], &[])
    }

    /// D16 escrow token account of a ticket.
    pub fn escrow_key(&self, ticket: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[fumpad::ESCROW_SEED, ticket.as_ref()], &fumpad::ID).0
    }

    /// D16 `withdraw_escrow` by `u` into `dest` (any token account of u for this mint).
    pub fn withdraw_escrow_ix(&self, owner: &Pubkey, ticket: Pubkey, dest: Pubkey) -> Instruction {
        let t = self.ticket(&ticket);
        ix(
            fumpad::accounts::WithdrawEscrow {
                owner: *owner,
                global: self.env.global_pda(),
                mint: self.mint,
                ticket,
                escrow: self.escrow_key(&ticket),
                pool_authority: self.pool_auth,
                destination: dest,
                escrow_payer: t.escrow_payer,
                token_program: TOKEN_2022,
                event_authority: fumpad::EVENT_AUTHORITY_AND_BUMP.0,
                program: fumpad::ID,
            },
            fumpad::instruction::WithdrawEscrow {},
        )
    }

    pub fn withdraw_escrow(&mut self, u: &User, ticket: Pubkey, dest: Pubkey) -> TransactionResult {
        let i = self.withdraw_escrow_ix(&u.key, ticket, dest);
        let kp = u.kp.insecure_clone();
        self.env.send_as(&kp, &[i], &[&kp])
    }

    /// A second (non-ATA) Token-2022 account of `u`, without extensions.
    pub fn side_account(&mut self, u: &User) -> Pubkey {
        let k = Pubkey::new_unique();
        let mint = self.mint;
        self.raw_set(&k, token_account_bytes(&mint, &u.key, 0, false, false), TOKEN_2022);
        k
    }

    /// `open` tickets (writable), then the claim queue iff one of them is Queued (R-L1).
    pub fn register_ix(&self, u: &User, open: &[Pubkey]) -> Instruction {
        let mut rem: Vec<AccountMeta> = open.iter().map(|k| AccountMeta::new(*k, false)).collect();
        if open.iter().any(|k| self.env.account(k).is_some_and(|a| a.lamports > 0) && self.ticket(k).status == TicketStatus::Queued) {
            rem.push(AccountMeta::new(self.queue, false));
        }
        ix_with_remaining(
            fumpad::accounts::RegisterHoldings {
                user: u.key,
                global: self.env.global_pda(),
                coin: self.coin,
                mint: self.mint,
                position: self.position_key(&u.key),
                user_token_account: u.ata,
                token_program: TOKEN_2022,
                system_program: anchor_lang::system_program::ID,
                event_authority: fumpad::EVENT_AUTHORITY_AND_BUMP.0,
                program: fumpad::ID,
            },
            fumpad::instruction::RegisterHoldings {},
            &rem,
        )
    }

    pub fn register(&mut self, u: &User, open: &[Pubkey]) -> TransactionResult {
        let i = self.register_ix(u, open);
        let kp = u.kp.insecure_clone();
        self.env.send_as(&kp, &[i], &[&kp])
    }

    pub fn close_ix(&self, caller: &Pubkey, ticket: Pubkey, with_queue: bool) -> Instruction {
        let t = self.ticket(&ticket);
        ix(
            fumpad::accounts::CloseTicket {
                caller: *caller,
                global: self.env.global_pda(),
                ticket,
                owner: t.owner,
                position: self.position_key(&t.owner),
                claim_queue: with_queue.then_some(self.queue),
                event_authority: fumpad::EVENT_AUTHORITY_AND_BUMP.0,
                program: fumpad::ID,
            },
            fumpad::instruction::CloseTicket {},
        )
    }

    pub fn close(&mut self, caller: &Keypair, ticket: Pubkey, with_queue: bool) -> TransactionResult {
        let i = self.close_ix(&kp_pk(caller), ticket, with_queue);
        self.env.send(&[i], &[caller])
    }

    // ── D17 auto-claim ──────────────────────────────────────────────────────

    /// `claim_for` signed by `keeper`, paying to `owner_ata` / `escrow` as passed.
    pub fn claim_for_ix_raw(&self, keeper: &Pubkey, ticket: Pubkey, owner_ata: Pubkey, escrow: Pubkey) -> Instruction {
        let owner = self.ticket(&ticket).owner;
        ix(
            fumpad::accounts::ClaimFor {
                keeper: *keeper,
                global: self.env.global_pda(),
                coin: self.coin,
                mint: self.mint,
                ticket,
                position: self.position_key(&owner),
                claim_queue: self.queue,
                observations: self.obs,
                pool_authority: self.pool_auth,
                reward_vault: self.vault,
                owner_ata,
                escrow,
                token_program: TOKEN_2022,
                system_program: anchor_lang::system_program::ID,
                event_authority: fumpad::EVENT_AUTHORITY_AND_BUMP.0,
                program: fumpad::ID,
            },
            fumpad::instruction::ClaimFor {},
        )
    }

    /// The canonical `claim_for` (owner's ATA + the ticket's escrow PDA).
    pub fn claim_for_ix(&self, keeper: &Pubkey, ticket: Pubkey) -> Instruction {
        let owner = self.ticket(&ticket).owner;
        self.claim_for_ix_raw(keeper, ticket, ata(&owner, &self.mint), self.escrow_key(&ticket))
    }

    /// `claim_for` by the registered keeper (fee payer = env payer, so the keeper's
    /// lamports move only for rent it pays).
    pub fn claim_for(&mut self, ticket: Pubkey) -> TransactionResult {
        let k = self.env.keeper.insecure_clone();
        let i = self.claim_for_ix(&kp_pk(&k), ticket);
        self.env.send(&[i], &[&k])
    }

    pub fn set_auto_claim_ix(&self, wallet: &Pubkey, position: Pubkey, enabled: bool) -> Instruction {
        ix(
            fumpad::accounts::SetAutoClaim {
                wallet: *wallet,
                position,
                event_authority: fumpad::EVENT_AUTHORITY_AND_BUMP.0,
                program: fumpad::ID,
            },
            fumpad::instruction::SetAutoClaim { enabled },
        )
    }

    pub fn set_auto_claim(&mut self, u: &User, enabled: bool) -> TransactionResult {
        let i = self.set_auto_claim_ix(&u.key, self.position_key(&u.key), enabled);
        let kp = u.kp.insecure_clone();
        self.env.send(&[i], &[&kp])
    }
}

/// Sell price used by most tests: 0.001 lamports per base unit (1_000 lamports / token).
fn base_price() -> u128 {
    sell_price(1_000, M)
}

/// A user with one fresh ticket of `tokens` at `base_price()`, sold `age` seconds ago.
fn user_with_ticket(w: &mut World, tokens: u64, age: i64) -> (User, Pubkey) {
    let u = w.user(0);
    let now = w.now();
    let t = w.add_ticket(&u.key, tokens, base_price(), now - age);
    (u, t)
}

// ═══════════════════════════════════════════════════════════════════════════
// init_claim_queue
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn init_claim_queue_grows_then_initializes_once() {
    let mut w = World::bare(CoinStatus::Graduated);
    let payer = kp_pk(&w.env.payer);
    let i = w.init_queue_ix(&payer);
    ok(w.env.send(&[i.clone()], &[]));
    let acc = w.env.account(&w.queue).unwrap();
    assert_eq!(acc.data.len(), 10_240);
    assert_eq!(&acc.data[..8], &[0u8; 8], "not initialized until full size");
    // 7 more calls: one short of full size, still uninitialized.
    ok(w.env.send(&vec![i.clone(); fumpad::CLAIM_QUEUE_INIT_CALLS - 2], &[]));
    let acc = w.env.account(&w.queue).unwrap();
    assert_eq!(acc.data.len(), 10_240 * (fumpad::CLAIM_QUEUE_INIT_CALLS - 1));
    assert_eq!(&acc.data[..8], &[0u8; 8], "not initialized until full size");
    ok(w.env.send(&[i.clone()], &[]));
    let acc = w.env.account(&w.queue).unwrap();
    assert_eq!(fumpad::CLAIM_QUEUE_INIT_CALLS, 9);
    assert_eq!(acc.data.len(), 81_976);
    assert_eq!(acc.data.len(), 8 + std::mem::size_of::<ClaimQueue>());
    assert_eq!(&acc.data[..8], ClaimQueue::DISCRIMINATOR);
    assert_eq!(acc.lamports, w.env.svm.minimum_balance_for_rent_exemption(acc.data.len()));
    let q = w.queue_state();
    assert_eq!((q.mint, q.len, q.total_owed), (w.mint, 0, 0));
    // Re-init can't reset a live queue.
    assert_fumpad_err(w.env.send(&[i], &[]), FumpadError::InvalidAccount);
}

#[test]
fn init_claim_queue_requires_graduation() {
    for status in [CoinStatus::Curve, CoinStatus::Complete] {
        let mut w = World::bare(status);
        assert_fumpad_err(w.init_queue(), FumpadError::WrongCoinStatus);
    }
}

#[test]
fn init_claim_queue_survives_prefunded_pda() {
    let mut w = World::bare(CoinStatus::Graduated);
    // Griefer sends lamports to the predictable PDA first.
    w.env.svm.airdrop(&addr(&w.queue), 1_000_000).unwrap();
    ok(w.init_queue());
    assert_eq!(w.queue_state().mint, w.mint);
}

// ═══════════════════════════════════════════════════════════════════════════
// claim
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn claim_happy_path_pays_ten_percent_immediately() {
    let mut w = World::new();
    let (u, t) = user_with_ticket(&mut w, 1_000_000 * M, DAY);
    let res = ok(w.claim(&u, t));
    assert_eq!(token_amount(&w.env, &u.ata), 100_000 * M);
    assert_eq!(w.pool(), POOL - 100_000 * M);
    let tk = w.ticket(&t);
    assert_eq!(tk.status, TicketStatus::Claimed);
    assert_eq!(tk.claim_amount, 100_000 * M);
    assert_eq!(tk.claimed_at, w.now());
    let pos = w.position(&u.key);
    assert_eq!(pos.open_count, 0);
    assert!(!pos.open_tickets.contains(&t));
    assert_eq!(w.coin_state().tokens_paid_out, 100_000 * M);
    // ClaimPaid emitted via self-CPI.
    assert!(res.logs.iter().any(|l| l.contains(&fumpad::ID.to_string())));
    // Double claim.
    assert_fumpad_err(w.claim(&u, t), FumpadError::TicketNotOpen);
}

#[test]
fn claim_trigger_not_met_below_10x() {
    let mut w = World::new();
    w.set_samples(120, sell_price(9_999, M)); // 9.999x
    let (u, t) = user_with_ticket(&mut w, 1_000 * M, DAY);
    assert_fumpad_err(w.claim(&u, t), FumpadError::TriggerNotMet);
    // Exactly 10x passes.
    w.set_samples(120, sell_price(10_000, M));
    ok(w.claim(&u, t));
}

#[test]
fn claim_median_ignores_spikes() {
    let mut w = World::new();
    // 120 samples: 59 at 100x, 61 at 5x → median 5x.
    let now = w.now();
    let mut o: Box<Observations> = zeroed_box();
    o.mint = w.mint;
    for i in 0..120i64 {
        let p = if i % 2 == 0 && i < 118 { sell_price(100_000, M) } else { sell_price(5_000, M) };
        o.push(now - (119 - i) * 15, p, false);
    }
    let mut data = Observations::DISCRIMINATOR.to_vec();
    data.extend(pod_bytes(&*o));
    let obs = w.obs;
    w.raw_set(&obs, data, fumpad::ID);
    let (u, t) = user_with_ticket(&mut w, 1_000 * M, DAY);
    assert_fumpad_err(w.claim(&u, t), FumpadError::TriggerNotMet);
}

#[test]
fn claim_insufficient_samples() {
    let mut w = World::new();
    w.set_samples(83, sell_price(100_000, M));
    let (u, t) = user_with_ticket(&mut w, 1_000 * M, DAY);
    assert_fumpad_err(w.claim(&u, t), FumpadError::InsufficientSamples);
    // Samples older than the 30-min window don't count.
    w.set_samples(120, sell_price(100_000, M));
    w.env.warp(1_800);
    assert_fumpad_err(w.claim(&u, t), FumpadError::InsufficientSamples);
    w.set_samples(84, sell_price(100_000, M));
    ok(w.claim(&u, t));
}

#[test]
fn claim_expires_after_90_days() {
    let mut w = World::new();
    let (u, t) = user_with_ticket(&mut w, 1_000 * M, 90 * DAY + 1);
    assert_fumpad_err(w.claim(&u, t), FumpadError::TicketExpired);
    let (u2, t2) = user_with_ticket(&mut w, 1_000 * M, 90 * DAY); // last second
    ok(w.claim(&u2, t2));
}

#[test]
fn claim_rejections_auth_status_pause() {
    let mut w = World::new();
    let (u, t) = user_with_ticket(&mut w, 1_000 * M, DAY);
    let (thief, _) = user_with_ticket(&mut w, 1_000 * M, DAY); // has its own position
    // Thief signs, ticket belongs to u: seeds use the signer → seeds mismatch (2006).
    let i = w.claim_ix(&thief.key, t, thief.ata);
    assert_err_code(w.env.send(&[i], &[&thief.kp]), 2006);
    // u claims but routes the payout to the thief's account → token::authority (2015).
    let i = w.claim_ix(&u.key, t, thief.ata);
    assert_err_code(w.env.send(&[i], &[&u.kp]), 2015);
    // Paused.
    let admin = w.env.admin.insecure_clone();
    let pause = ix(
        fumpad::accounts::AdminOnly { admin: kp_pk(&admin), global: w.env.global_pda() },
        fumpad::instruction::SetPause { paused: PAUSE_CLAIMS },
    );
    ok(w.env.send(&[pause], &[&admin]));
    assert_fumpad_err(w.claim(&u, t), FumpadError::Paused);
}

#[test]
fn claim_requires_graduated_coin() {
    let mut w = World::new();
    let mut c = w.coin_state();
    c.status = CoinStatus::Complete;
    w.write_coin(&c);
    let (u, t) = user_with_ticket(&mut w, 1_000 * M, DAY);
    assert_fumpad_err(w.claim(&u, t), FumpadError::WrongCoinStatus);
}

#[test]
fn claim_rejects_foreign_observations_and_vault() {
    let mut w = World::new();
    let (u, t) = user_with_ticket(&mut w, 1_000 * M, DAY);
    // Observations PDA of another coin (fabricated at 1000x) can't be swapped in.
    let other_mint = Pubkey::new_unique();
    let other_obs = Pubkey::find_program_address(&[fumpad::OBSERVATIONS_SEED, other_mint.as_ref()], &fumpad::ID).0;
    let acc = w.env.account(&w.obs).unwrap();
    w.env.svm.set_account(addr(&other_obs), acc).unwrap();
    let mut i = w.claim_ix(&u.key, t, u.ata);
    i.accounts[7].pubkey = addr(&other_obs);
    assert_err_code(w.env.send(&[i], &[&u.kp]), 2006);
}

#[test]
fn claim_zero_amount_rejected() {
    let mut w = World::new();
    let (u, t) = user_with_ticket(&mut w, 9, DAY); // 10% of 9 rounds to 0
    assert_fumpad_err(w.claim(&u, t), FumpadError::ZeroAmount);
}

// ═══════════════════════════════════════════════════════════════════════════
// queue
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn claim_over_cap_queues_and_never_expires() {
    let mut w = World::new();
    w.set_pool(1_000 * M); // cap = 100 tokens
    let (u, t) = user_with_ticket(&mut w, 2_000 * M, DAY); // owed 200 tokens
    ok(w.claim(&u, t));
    let tk = w.ticket(&t);
    assert_eq!(tk.status, TicketStatus::Queued);
    assert_eq!(tk.claim_amount, 200 * M);
    assert_eq!(tk.queued_at, w.now());
    let q = w.queue_state();
    assert_eq!(q.len, 1);
    assert_eq!(q.total_owed, 200 * M);
    assert_eq!((q.entries[0].ticket, q.entries[0].owner, q.entries[0].amount), (t, u.key, 200 * M));
    // Queued tickets stay in the position's open list (rebuy rule still applies).
    assert!(w.position(&u.key).open_tickets.contains(&t));
    assert_fumpad_err(w.claim(&u, t), FumpadError::TicketNotOpen);
    // Can't be closed while queued, even long after the 90-day window (D5).
    w.env.warp(200 * DAY);
    let kp = u.kp.insecure_clone();
    assert_fumpad_err(w.close(&kp, t, true), FumpadError::TicketNotClosable);
    // Pool grows → crank pays it.
    w.set_pool(10_000 * M);
    ok(w.process(10, &[(t, u.key)]));
    assert_eq!(token_amount(&w.env, &u.ata), 200 * M);
    assert_eq!(w.ticket(&t).status, TicketStatus::Claimed);
    assert_eq!(w.queue_state().len, 0);
    assert_eq!(w.queue_state().total_owed, 0);
    assert!(!w.position(&u.key).open_tickets.contains(&t));
    assert_eq!(w.coin_state().tokens_paid_out, 200 * M);
}

#[test]
fn queue_is_sorted_by_sell_time_and_skip_ahead() {
    let mut w = World::new();
    w.set_pool(1_000 * M); // cap 100
    // Claim in reverse sell order; queue must sort by sell_ts.
    let (a, ta) = user_with_ticket(&mut w, 5_000 * M, 3 * DAY); // owes 500 — never fits here
    let (b, tb) = user_with_ticket(&mut w, 900 * M, 2 * DAY); // owes 90
    let (c, tc) = user_with_ticket(&mut w, 800 * M, DAY); // owes 80
    // Make b and c not fit at claim time (pool tiny), so all three queue.
    w.set_pool(100 * M);
    ok(w.claim(&c, tc));
    ok(w.claim(&b, tb));
    ok(w.claim(&a, ta));
    let q = w.queue_state();
    assert_eq!(q.len, 3);
    assert_eq!([q.entries[0].ticket, q.entries[1].ticket, q.entries[2].ticket], [ta, tb, tc]);
    assert_eq!(q.total_owed, 670 * M);

    // Pool 1_000: a (500) is skipped; b (90) pays → pool 910, cap 91; c (80) pays.
    w.set_pool(1_000 * M);
    ok(w.process(10, &[(tb, b.key), (tc, c.key)]));
    assert_eq!(token_amount(&w.env, &b.ata), 90 * M);
    assert_eq!(token_amount(&w.env, &c.ata), 80 * M);
    let q = w.queue_state();
    assert_eq!((q.len, q.entries[0].ticket, q.total_owed), (1, ta, 500 * M));
    assert_eq!(q.entries[1].ticket, Pubkey::default(), "compacted tail is zeroed");
    assert_eq!(w.pool(), 830 * M);
}

#[test]
fn process_queue_reevaluates_cap_against_shrinking_pool() {
    let mut w = World::new();
    let (a, ta) = user_with_ticket(&mut w, 1_000 * M, 2 * DAY); // owes 100
    let (b, tb) = user_with_ticket(&mut w, 1_000 * M, DAY); // owes 100
    w.set_pool(50 * M);
    ok(w.claim(&a, ta));
    ok(w.claim(&b, tb));
    // Pool 1_000: a pays (cap 100) → pool 900, cap 90 → b (100) no longer fits.
    w.set_pool(1_000 * M);
    ok(w.process(10, &[(ta, a.key), (tb, b.key)]));
    assert_eq!(w.ticket(&ta).status, TicketStatus::Claimed);
    assert_eq!(w.ticket(&tb).status, TicketStatus::Queued);
    assert_eq!(w.queue_state().len, 1);
}

#[test]
fn process_queue_respects_max_entries() {
    let mut w = World::new();
    let mut es = vec![];
    w.set_pool(1);
    for i in 0..3 {
        let (u, t) = user_with_ticket(&mut w, 100 * M, DAY + i);
        ok(w.claim(&u, t));
        es.push((t, u.key));
    }
    es.reverse(); // oldest first = queue order
    w.set_pool(1_000_000 * M);
    ok(w.process(2, &es));
    let q = w.queue_state();
    assert_eq!((q.len, q.entries[0].ticket), (1, es[2].0));
    ok(w.process(2, &es[2..]));
    assert_eq!(w.queue_state().len, 0);
}

#[test]
fn instant_claim_waits_behind_older_fitting_entry() {
    let mut w = World::new();
    let (a, ta) = user_with_ticket(&mut w, 1_000 * M, 2 * DAY); // older, owes 100
    w.set_pool(10 * M);
    ok(w.claim(&a, ta)); // queued
    w.set_pool(10_000 * M); // now a fits but nobody cranked yet
    let (b, tb) = user_with_ticket(&mut w, 1_000 * M, DAY); // newer, owes 100, fits
    ok(w.claim(&b, tb));
    assert_eq!(w.ticket(&tb).status, TicketStatus::Queued, "must not jump ahead of a");
    // An OLDER ticket than every queued entry is not blocked.
    let (c, tc) = user_with_ticket(&mut w, 1_000 * M, 3 * DAY);
    ok(w.claim(&c, tc));
    assert_eq!(w.ticket(&tc).status, TicketStatus::Claimed);
    // A newer claim behind a NON-fitting older entry pays instantly (skip-ahead).
    let mut w = World::new();
    let (a, ta) = user_with_ticket(&mut w, 1_000_000 * M, 2 * DAY);
    w.set_pool(10 * M);
    ok(w.claim(&a, ta));
    w.set_pool(10_000 * M);
    let (b, tb) = user_with_ticket(&mut w, 1_000 * M, DAY);
    ok(w.claim(&b, tb));
    assert_eq!(w.ticket(&tb).status, TicketStatus::Claimed);
}

#[test]
fn queue_full_reverts_and_ticket_stays_open() {
    let mut w = World::new();
    let mut q = w.queue_state();
    for i in 0..fumpad::CLAIM_QUEUE_CAPACITY {
        q.entries[i] = QueueEntry {
            ticket: Pubkey::new_unique(),
            owner: Pubkey::new_unique(),
            amount: u64::MAX / 2_048,
            sell_ts: i as i64,
        };
    }
    q.len = fumpad::CLAIM_QUEUE_CAPACITY as u16;
    q.total_owed = (u64::MAX / 2_048) * fumpad::CLAIM_QUEUE_CAPACITY as u64;
    w.write_queue(&q);
    w.set_pool(1);
    let (u, t) = user_with_ticket(&mut w, 1_000 * M, DAY);
    assert_fumpad_err(w.claim(&u, t), FumpadError::QueueFull);
    assert_eq!(w.ticket(&t).status, TicketStatus::Open);
    // When it fits and nothing older fits, a full queue doesn't block the instant path.
    w.set_pool(10_000 * M);
    ok(w.claim(&u, t));
    assert_eq!(w.ticket(&t).status, TicketStatus::Claimed);
}

/// Three queued entries a < b < c (sell order), all fitting.
fn three_queued(w: &mut World) -> Vec<(User, Pubkey)> {
    let mut v = vec![];
    w.set_pool(1);
    for age in [3 * DAY, 2 * DAY, DAY] {
        let (u, t) = user_with_ticket(w, 100 * M, age);
        ok(w.claim(&u, t));
        v.push((u, t));
    }
    w.set_pool(1_000_000 * M);
    v
}

#[test]
fn process_queue_rejects_spoofing() {
    let mut w = World::new();
    let v = three_queued(&mut w);
    let e = |i: usize| (v[i].1, v[i].0.key);

    // Out of order: c's triple before b's → b halts the walk, c's triple never matches.
    assert_fumpad_err(w.process(10, &[e(0), e(2), e(1)]), FumpadError::InvalidAccount);
    // Duplicate triple.
    assert_fumpad_err(w.process(10, &[e(0), e(0)]), FumpadError::InvalidAccount);
    // Unknown ticket.
    let (x, tx) = user_with_ticket(&mut w, 100 * M, DAY);
    assert_fumpad_err(w.process(10, &[(tx, x.key)]), FumpadError::InvalidAccount);
    // Triple count not a multiple of 3.
    let mut i = w.process_ix(10, &[e(0)]);
    i.accounts.pop();
    assert_fumpad_err(w.env.send(&[i], &[]), FumpadError::InvalidAccount);
    // Right ticket, attacker's ATA as destination.
    let mut rem = vec![
        AccountMeta::new(v[0].1, false),
        AccountMeta::new(w.position_key(&v[0].0.key), false),
        AccountMeta::new(x.ata, false),
    ];
    assert_fumpad_err(w.env.send(&[w.process_ix_raw(10, rem.clone())], &[]), FumpadError::InvalidAccount);
    // Right ticket + ATA, someone else's position.
    rem[1] = AccountMeta::new(w.position_key(&x.key), false);
    rem[2] = AccountMeta::new(v[0].0.ata, false);
    assert_fumpad_err(w.env.send(&[w.process_ix_raw(10, rem.clone())], &[]), FumpadError::InvalidAccount);
    // Non-canonical token account owned by the right wallet.
    let fake = Pubkey::new_unique();
    let mint = w.mint;
    w.raw_set(&fake, token_account_bytes(&mint, &v[0].0.key, 0, true, false), TOKEN_2022);
    rem[1] = AccountMeta::new(w.position_key(&v[0].0.key), false);
    rem[2] = AccountMeta::new(fake, false);
    assert_fumpad_err(w.env.send(&[w.process_ix_raw(10, rem)], &[]), FumpadError::InvalidAccount);

    // Nothing was paid by any failed attempt.
    assert_eq!(w.queue_state().len, 3);
    // Skipping a fitting entry halts: passing only c pays nobody (c can't jump a and b).
    let before = w.pool();
    ok(w.process(10, &[e(2)]));
    assert_eq!(w.pool(), before);
    assert_eq!(w.queue_state().len, 3);
    // Proper order pays all.
    ok(w.process(10, &[e(0), e(1), e(2)]));
    assert_eq!(w.queue_state().len, 0);
    for (u, t) in &v {
        assert_eq!(token_amount(&w.env, &u.ata), 10 * M);
        assert_eq!(w.ticket(t).status, TicketStatus::Claimed);
    }
    // Replaying a paid entry: no longer in the queue → unconsumed triple.
    assert_fumpad_err(w.process(10, &[e(0)]), FumpadError::InvalidAccount);
}

/// D16: a queue payout whose owner's ATA can't receive — closed/missing, or requiring
/// memos — goes into the ticket's escrow (cranker pays the rent); the entry leaves the
/// queue either way. The owner withdraws to any token account they own; the rent goes back
/// to the cranker.
#[test]
fn process_queue_escrows_payouts_to_refusing_or_missing_atas() {
    let mut w = World::new();
    let v = three_queued(&mut w);
    let e = |i: usize| (v[i].1, v[i].0.key);
    let cranker = kp_pk(&w.env.payer);
    // a's ATA closed, b requires memos, c is fine.
    w.env.svm.set_account(addr(&v[0].0.ata), Account::default()).unwrap();
    w.set_balance(&v[1].0, 0, true);
    let sol0 = w.env.lamports(&cranker);
    ok(w.process(10, &[e(0), e(1), e(2)]));
    let q = w.queue_state();
    assert_eq!((q.len, q.total_owed), (0, 0), "every entry left the queue");
    for i in [0, 1] {
        let t = w.ticket(&v[i].1);
        assert_eq!((t.status, t.escrow_payer, t.claim_amount), (TicketStatus::Escrowed, cranker, 10 * M));
        assert_eq!(token_amount(&w.env, &w.escrow_key(&v[i].1)), 10 * M);
        assert_eq!(w.position(&v[i].0.key).open_count, 0);
    }
    assert_eq!(w.ticket(&v[2].1).status, TicketStatus::Claimed);
    assert_eq!(token_amount(&w.env, &v[2].0.ata), 10 * M);
    let rent = w.env.lamports(&w.escrow_key(&v[0].1));
    assert!(rent > 0);
    assert!(sol0 - w.env.lamports(&cranker) >= 2 * rent, "cranker paid both escrows' rent");

    // Escrowed tickets can't be closed; only the owner withdraws, to an account they own.
    let (a, ta) = (&v[0].0, v[0].1);
    let ka = a.kp.insecure_clone();
    assert_fumpad_err(w.close(&ka, ta, false), FumpadError::TicketNotClosable);
    let side_b = w.side_account(&v[1].0);
    let stranger_dest = w.side_account(&v[1].0);
    let i = w.withdraw_escrow_ix(&a.key, ta, stranger_dest); // dest not a's
    assert!(w.env.send_as(&ka, &[i], &[&ka]).is_err());
    let i = w.withdraw_escrow_ix(&v[1].0.key, ta, side_b); // signer not the ticket owner
    let kb = v[1].0.kp.insecure_clone();
    assert!(w.env.send_as(&kb, &[i], &[&kb]).is_err());
    // a recreates its ATA and withdraws there; b withdraws to a memo-free side account.
    w.set_balance(a, 0, false);
    let c0 = w.env.lamports(&cranker);
    ok(w.withdraw_escrow(a, ta, a.ata));
    assert_eq!(token_amount(&w.env, &a.ata), 10 * M);
    assert_eq!(w.env.lamports(&cranker) - c0, rent, "escrow rent refunded to the cranker");
    assert!(w.env.account(&w.escrow_key(&ta)).map_or(true, |x| x.lamports == 0));
    assert_eq!(w.ticket(&ta).status, TicketStatus::Claimed);
    assert!(w.withdraw_escrow(a, ta, a.ata).is_err(), "nothing left to withdraw");
    ok(w.close(&ka, ta, false));
    let b = &v[1].0;
    ok(w.withdraw_escrow(b, v[1].1, side_b));
    assert_eq!(token_amount(&w.env, &side_b), 10 * M);
    assert_eq!(w.coin_state().tokens_paid_out, 30 * M);
}

// ═══════════════════════════════════════════════════════════════════════════
// register_holdings + rebuy rule (shared with on_buy)
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn register_holdings_adds_pending_and_restarts_hold_clock() {
    let mut w = World::new();
    let u = w.user(1_000 * M);
    ok(w.register(&u, &[]));
    let p = w.position(&u.key);
    assert_eq!((p.matured, p.pending, p.pending_since), (0, 1_000 * M, w.now()));
    // Nothing new to register.
    assert_fumpad_err(w.register(&u, &[]), FumpadError::ZeroAmount);
    // 10 minutes later more tokens arrive: the first batch matures, the new one is pending.
    w.env.warp(600);
    w.set_balance(&u, 1_500 * M, false);
    ok(w.register(&u, &[]));
    let p = w.position(&u.key);
    assert_eq!((p.matured, p.pending, p.pending_since), (1_000 * M, 500 * M, w.now()));
    // Tokens left the wallet elsewhere: tracked is capped (matured first) before adding.
    w.env.warp(60);
    w.set_balance(&u, 800 * M, false);
    assert_fumpad_err(w.register(&u, &[]), FumpadError::ZeroAmount);
}

#[test]
fn register_holdings_requires_canonical_ata() {
    let mut w = World::new();
    let u = w.user(1_000 * M);
    let fake = Pubkey::new_unique();
    let mint = w.mint;
    w.raw_set(&fake, token_account_bytes(&mint, &u.key, 5_000 * M, true, false), TOKEN_2022);
    let mut i = w.register_ix(&u, &[]);
    i.accounts[5].pubkey = addr(&fake);
    let kp = u.kp.insecure_clone();
    assert!(w.env.send_as(&kp, &[i], &[&kp]).is_err());
}

#[test]
fn rebuy_within_7_days_shrinks_newest_ticket_first() {
    let mut w = World::new();
    let u = w.user(0);
    let now = w.now();
    let old = w.add_ticket(&u.key, 1_000 * M, base_price(), now - 3 * DAY);
    let new = w.add_ticket(&u.key, 400 * M, base_price(), now - DAY);
    w.set_balance(&u, 600 * M, false); // "rebought" 600 elsewhere and registers them
    ok(w.register(&u, &[old, new]));
    let (o, n) = (w.ticket(&old), w.ticket(&new));
    assert_eq!((n.tokens, n.status), (0, TicketStatus::Voided));
    assert_eq!((o.tokens, o.status), (800 * M, TicketStatus::Open));
    assert_eq!(o.original_tokens, 1_000 * M);
    let p = w.position(&u.key);
    assert_eq!(p.open_count, 1);
    assert!(p.open_tickets.contains(&old) && !p.open_tickets.contains(&new));
    assert_eq!(p.pending, 600 * M);
    // Claim on the shrunk ticket pays 10% of what's left.
    ok(w.claim(&u, old));
    assert_eq!(token_amount(&w.env, &u.ata), 600 * M + 80 * M);
    // Voided ticket can't be claimed; owner closes it for the rent.
    assert_fumpad_err(w.claim(&u, new), FumpadError::TicketNotOpen);
    let before = w.env.lamports(&u.key);
    let rent = w.env.lamports(&new);
    let kp = u.kp.insecure_clone();
    ok(w.close(&kp, new, false));
    assert!(w.env.account(&new).map(|a| a.lamports == 0).unwrap_or(true));
    assert_eq!(w.env.lamports(&u.key), before + rent);
}

#[test]
fn rebuy_after_7_days_does_not_debit() {
    let mut w = World::new();
    let u = w.user(0);
    let now = w.now();
    let t = w.add_ticket(&u.key, 1_000 * M, base_price(), now - 7 * DAY - 1);
    w.set_balance(&u, 600 * M, false);
    ok(w.register(&u, &[t]));
    assert_eq!(w.ticket(&t).tokens, 1_000 * M);
}

#[test]
fn rebuy_voids_down_to_zero() {
    let mut w = World::new();
    let u = w.user(0);
    let now = w.now();
    let a = w.add_ticket(&u.key, 100 * M, base_price(), now - 2 * DAY);
    let b = w.add_ticket(&u.key, 100 * M, base_price(), now - DAY);
    w.set_balance(&u, 10_000 * M, false);
    ok(w.register(&u, &[b, a]));
    assert_eq!(w.ticket(&a).status, TicketStatus::Voided);
    assert_eq!(w.ticket(&b).status, TicketStatus::Voided);
    assert_eq!(w.position(&u.key).open_count, 0);
}

#[test]
fn rebuy_requires_exact_open_ticket_set() {
    let mut w = World::new();
    let u = w.user(0);
    let now = w.now();
    let a = w.add_ticket(&u.key, 100 * M, base_price(), now - DAY);
    let b = w.add_ticket(&u.key, 100 * M, base_price(), now - DAY);
    w.set_balance(&u, 50 * M, false);
    // Missing one (the attacker hides the ticket it wants to protect).
    assert_fumpad_err(w.register(&u, &[a]), FumpadError::OpenTicketsMismatch);
    // Duplicate instead of the hidden one.
    assert_fumpad_err(w.register(&u, &[a, a]), FumpadError::OpenTicketsMismatch);
    // Someone else's ticket substituted.
    let (_, other) = user_with_ticket(&mut w, 100 * M, DAY);
    assert_fumpad_err(w.register(&u, &[a, other]), FumpadError::OpenTicketsMismatch);
    // Extra.
    assert_fumpad_err(w.register(&u, &[a, b, other]), FumpadError::OpenTicketsMismatch);
    ok(w.register(&u, &[b, a]));
}

#[test]
fn rebuy_debits_queued_ticket_and_crank_resyncs() {
    let mut w = World::new();
    w.set_pool(1);
    let u = w.user(0);
    let now = w.now();
    let t = w.add_ticket(&u.key, 1_000 * M, base_price(), now - DAY);
    ok(w.claim(&u, t)); // queued, owes 100
    assert_eq!(w.queue_state().total_owed, 100 * M);
    w.set_balance(&u, 400 * M, false); // rebuy 400 while queued
    ok(w.register(&u, &[t]));
    let tk = w.ticket(&t);
    assert_eq!((tk.tokens, tk.claim_amount, tk.status), (600 * M, 60 * M, TicketStatus::Queued));
    // Crank (pool still tiny) re-syncs the stale entry without paying.
    ok(w.process(10, &[(t, u.key)]));
    let q = w.queue_state();
    assert_eq!((q.len, q.entries[0].amount, q.total_owed), (1, 60 * M, 60 * M));
    w.set_pool(1_000 * M);
    ok(w.process(10, &[(t, u.key)]));
    assert_eq!(token_amount(&w.env, &u.ata), 400 * M + 60 * M);
}

#[test]
fn rebuy_voids_queued_ticket_and_removes_its_entry() {
    // R-L1: the voiding rebuy removes the queue entry itself.
    let mut w = World::new();
    w.set_pool(1);
    let u = w.user(0);
    let now = w.now();
    let t = w.add_ticket(&u.key, 1_000 * M, base_price(), now - DAY);
    ok(w.claim(&u, t));
    assert_eq!(w.queue_state().len, 1);
    w.set_balance(&u, 5_000 * M, false);
    // Without the queue account the rebuy is refused (the ticket is Queued).
    let mut i = w.register_ix(&u, &[t]);
    i.accounts.pop();
    let kp = u.kp.insecure_clone();
    assert_fumpad_err(w.env.send_as(&kp, &[i], &[&kp]), FumpadError::QueueAccountRequired);
    ok(w.register(&u, &[t]));
    assert_eq!(w.ticket(&t).status, TicketStatus::Voided);
    assert_eq!(w.position(&u.key).open_count, 0);
    assert_eq!((w.queue_state().len, w.queue_state().total_owed), (0, 0));
    w.set_pool(1_000_000 * M);
    assert_eq!(token_amount(&w.env, &u.ata), 5_000 * M, "voided entry not paid");
    // The voided ticket closes without the queue; its stale key can't be used to pay.
    ok(w.close(&kp, t, false));
    assert_fumpad_err(w.process(10, &[(t, u.key)]), FumpadError::InvalidAccount);
}

// ═══════════════════════════════════════════════════════════════════════════
// close_ticket
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn close_ticket_paths() {
    let mut w = World::new();
    let (u, t) = user_with_ticket(&mut w, 1_000 * M, DAY);
    let stranger = w.env.new_user(1);
    let kp = u.kp.insecure_clone();
    // Open, within window: nobody can close.
    assert_fumpad_err(w.close(&kp, t, false), FumpadError::TicketNotClosable);
    assert_fumpad_err(w.close(&stranger, t, false), FumpadError::TicketNotClosable);
    // Claimed: owner only.
    ok(w.claim(&u, t));
    assert_fumpad_err(w.close(&stranger, t, false), FumpadError::Unauthorized);
    let before = w.env.lamports(&u.key);
    let rent = w.env.lamports(&t);
    ok(w.close(&kp, t, false));
    assert_eq!(w.env.lamports(&u.key), before + rent);

    // Expired: anyone may close; rent still goes to the owner; open slot freed.
    let (u2, t2) = user_with_ticket(&mut w, 1_000 * M, DAY);
    w.env.warp(89 * DAY);
    assert_fumpad_err(w.close(&stranger, t2, false), FumpadError::TicketNotClosable);
    w.env.warp(DAY + 1);
    let before = w.env.lamports(&u2.key);
    let rent = w.env.lamports(&t2);
    let res = ok(w.close(&stranger, t2, false));
    assert_eq!(w.env.lamports(&u2.key), before + rent);
    assert_eq!(w.position(&u2.key).open_count, 0);
    assert!(!res.logs.is_empty());
    // Rent can't be redirected: `owner` must be the ticket owner.
    let (_, t3) = user_with_ticket(&mut w, 1_000 * M, 91 * DAY);
    let mut i = w.close_ix(&kp_pk(&stranger), t3, false);
    i.accounts[3].pubkey = stranger.pubkey();
    assert_fumpad_err(w.env.send(&[i], &[&stranger]), FumpadError::InvalidAccount);
}

#[test]
fn five_open_tickets_then_close_frees_a_slot() {
    // The 5-open-ticket cap itself is enforced in on_sell (unit-tested in
    // logic::tests::creator_and_open_ticket_limit); here: the open list is maintained
    // correctly by claim/close so the cap frees up.
    let mut w = World::new();
    let u = w.user(0);
    let now = w.now();
    let ts: Vec<Pubkey> = (0..5).map(|i| w.add_ticket(&u.key, 1_000 * M, base_price(), now - DAY - i)).collect();
    assert_eq!(w.position(&u.key).open_count, 5);
    ok(w.claim(&u, ts[0]));
    assert_eq!(w.position(&u.key).open_count, 4);
    let p = w.position(&u.key);
    assert!(!p.open_tickets.contains(&ts[0]));
    // A rebuy must now pass exactly the 4 remaining.
    w.set_balance(&u, 100 * M + 1, false);
    let tok = token_amount(&w.env, &u.ata);
    assert!(tok > 0);
    assert_fumpad_err(w.register(&u, &ts), FumpadError::OpenTicketsMismatch);
    ok(w.register(&u, &ts[1..]));
}

// ═══════════════════════════════════════════════════════════════════════════
// fees
// ═══════════════════════════════════════════════════════════════════════════

fn withdraw_creator_ix(w: &World, signer: &Pubkey) -> Instruction {
    ix(
        fumpad::accounts::WithdrawCreatorFees {
            creator: *signer,
            coin: w.coin,
            event_authority: fumpad::EVENT_AUTHORITY_AND_BUMP.0,
            program: fumpad::ID,
        },
        fumpad::instruction::WithdrawCreatorFees {},
    )
}

fn withdraw_platform_ix(w: &World, treasury: Pubkey) -> Instruction {
    ix(
        fumpad::accounts::WithdrawPlatformFees {
            caller: kp_pk(&w.env.payer),
            global: w.env.global_pda(),
            coin: w.coin,
            platform_treasury: treasury,
            event_authority: fumpad::EVENT_AUTHORITY_AND_BUMP.0,
            program: fumpad::ID,
        },
        fumpad::instruction::WithdrawPlatformFees {},
    )
}

fn coin_with_fees(w: &mut World) {
    let mut c = w.coin_state();
    c.creator_fees_unclaimed = 2 * SOL;
    c.platform_fees_unclaimed = 3 * SOL;
    c.buyback_lamports = 5 * SOL;
    c.real_sol_reserves = 7 * SOL;
    w.write_coin(&c);
    assert!(w.coin_invariant_holds());
}

#[test]
fn creator_withdraws_fees_invariant_preserved() {
    let mut w = World::new();
    coin_with_fees(&mut w);
    let creator = w.creator.insecure_clone();
    let ck = kp_pk(&creator);
    // Not the creator.
    let rando = w.env.new_user(1);
    let i = withdraw_creator_ix(&w, &kp_pk(&rando));
    assert_fumpad_err(w.env.send(&[i], &[&rando]), FumpadError::Unauthorized);
    let before = w.env.lamports(&ck);
    ok(w.env.send(&[withdraw_creator_ix(&w, &ck)], &[&creator]));
    assert_eq!(w.env.lamports(&ck), before + 2 * SOL);
    let c = w.coin_state();
    assert_eq!((c.creator_fees_unclaimed, c.platform_fees_unclaimed, c.buyback_lamports), (0, 3 * SOL, 5 * SOL));
    assert!(w.coin_invariant_holds());
    // Nothing left.
    assert_fumpad_err(w.env.send(&[withdraw_creator_ix(&w, &ck)], &[&creator]), FumpadError::ZeroAmount);
}

#[test]
fn platform_fees_go_only_to_treasury() {
    let mut w = World::new();
    coin_with_fees(&mut w);
    let treasury = kp_pk(&w.env.treasury);
    let rando = Pubkey::new_unique();
    assert_fumpad_err(w.env.send(&[withdraw_platform_ix(&w, rando)], &[]), FumpadError::InvalidAccount);
    let before = w.env.lamports(&treasury);
    ok(w.env.send(&[withdraw_platform_ix(&w, treasury)], &[]));
    assert_eq!(w.env.lamports(&treasury), before + 3 * SOL);
    assert_eq!(w.coin_state().platform_fees_unclaimed, 0);
    assert!(w.coin_invariant_holds());
    assert_fumpad_err(w.env.send(&[withdraw_platform_ix(&w, treasury)], &[]), FumpadError::ZeroAmount);
}

#[test]
fn fee_withdrawal_never_dips_into_tracked_lamports() {
    let mut w = World::new();
    coin_with_fees(&mut w);
    // Simulate an accounting bug elsewhere: the account is 1 lamport short.
    let mut acc = w.env.account(&w.coin).unwrap();
    acc.lamports -= 1;
    w.env.svm.set_account(addr(&w.coin), acc).unwrap();
    let creator = w.creator.insecure_clone();
    let ck = kp_pk(&creator);
    assert_fumpad_err(w.env.send(&[withdraw_creator_ix(&w, &ck)], &[&creator]), FumpadError::LamportInvariant);
    let treasury = kp_pk(&w.env.treasury);
    assert_fumpad_err(w.env.send(&[withdraw_platform_ix(&w, treasury)], &[]), FumpadError::LamportInvariant);
}

// ═══════════════════════════════════════════════════════════════════════════
// Pyth fixture
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn pyth_fixture_matches_parser() {
    use base64::Engine;
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(fixtures_dir().join("pyth_sol_usd_mainnet.json")).unwrap())
            .unwrap();
    assert_eq!(v["account"]["owner"].as_str().unwrap(), fumpad::PYTH_RECEIVER_PROGRAM_ID.to_string());
    let data = base64::engine::general_purpose::STANDARD.decode(v["account"]["data"][0].as_str().unwrap()).unwrap();
    let u = fumpad::external::pyth::parse_price_update(&data).unwrap();
    assert_eq!(u.feed_id, fumpad::PYTH_SOL_USD_FEED_ID);
    assert_eq!(u.verification_level, fumpad::external::pyth::VerificationLevel::Full);
    assert_eq!(u.exponent, -8);
    assert!(u.price > 0 && u.conf < u.price as u64 / 50);
}

// ═══════════════════════════════════════════════════════════════════════════
// compute budget
// ═══════════════════════════════════════════════════════════════════════════

fn cu_limit_ix(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction { program_id: "ComputeBudget111111111111111111111111111111".parse().unwrap(), accounts: vec![], data }
}

#[test]
fn compute_units_claim_and_crank_batch() {
    let mut w = World::new();
    // Fill most of the queue with big entries that never fit (worst-case walk).
    let mut q = w.queue_state();
    for i in 0..240usize {
        q.entries[i] =
            QueueEntry { ticket: Pubkey::new_unique(), owner: Pubkey::new_unique(), amount: u64::MAX / 1_000, sell_ts: i as i64 };
    }
    q.len = 240;
    q.total_owed = (u64::MAX / 1_000) * 240;
    w.write_queue(&q);
    w.set_pool(1);
    let mut es = vec![];
    for i in 0..8 {
        let (u, t) = user_with_ticket(&mut w, 100 * M, DAY + 8 - i);
        ok(w.claim(&u, t));
        es.push((t, u.key));
    }
    w.set_pool(1_000_000 * M);
    let (cu, ct) = user_with_ticket(&mut w, 100 * M, DAY);
    let claim_cu = ok(w.claim(&cu, ct)).compute_units_consumed;
    let crank = w.process_ix(8, &es);
    let crank_cu = ok(w.env.send(&[cu_limit_ix(1_400_000), crank], &[])).compute_units_consumed;
    eprintln!("CU: claim (248-entry queue) = {claim_cu}, process_queue 8 payouts over 248 entries = {crank_cu}");
    assert_eq!(w.queue_state().len, 241); // 240 big + the last claim (queued behind older fitting ones)
    assert!(claim_cu < 200_000);
    assert!(crank_cu < 1_400_000);
}

// ═══════════════════════════════════════════════════════════════════════════
// D17 auto-claim (`claim_for`, `set_auto_claim`)
// ═══════════════════════════════════════════════════════════════════════════

use crate::flow::events;
use fumpad::events::{AutoClaimSet, ClaimEscrowed, ClaimPaid, ClaimQueued};

/// Idempotent ATA create (Token-2022) paid by `payer`.
fn create_ata_ix(payer: &Pubkey, owner: &Pubkey, mint: &Pubkey) -> Instruction {
    Instruction {
        program_id: ATA_PROGRAM,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(ata(owner, mint), false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
            AccountMeta::new_readonly(TOKEN_2022, false),
        ],
        data: vec![1],
    }
}

#[test]
fn auto_claim_keeper_pays_the_owner() {
    let mut w = World::new();
    let (u, t) = user_with_ticket(&mut w, 1_000_000 * M, DAY);
    let kk = kp_pk(&w.env.keeper);
    let (k_sol, u_sol) = (w.env.lamports(&kk), w.env.lamports(&u.key));
    let m = ok(w.claim_for(t));
    assert_eq!(token_amount(&w.env, &u.ata), 100_000 * M, "paid to the owner's ATA");
    assert_eq!(w.pool(), POOL - 100_000 * M);
    let tk = w.ticket(&t);
    assert_eq!((tk.status, tk.claim_amount, tk.claimed_at), (TicketStatus::Claimed, 100_000 * M, w.now()));
    assert_eq!(w.position(&u.key).open_count, 0);
    assert_eq!(w.coin_state().tokens_paid_out, 100_000 * M);
    let e = &events::<ClaimPaid>(&m)[0];
    assert_eq!((e.owner, e.triggered_by, e.from_queue, e.amount), (u.key, kk, false, 100_000 * M));
    assert_eq!(w.env.lamports(&kk), k_sol, "nothing charged to the keeper (fee payer is separate)");
    assert_eq!(w.env.lamports(&u.key), u_sol, "nothing charged to the owner");
    // Owner-signed claims keep working and report the owner as the trigger.
    let t2 = w.add_ticket(&u.key, 1_000 * M, base_price(), w.now() - DAY);
    let m = ok(w.claim(&u, t2));
    let e = &events::<ClaimPaid>(&m)[0];
    assert_eq!((e.owner, e.triggered_by), (u.key, u.key));
}

/// A missing owner ATA: the keeper creates it in its own transaction (paying the rent)
/// and the payout lands there; without that, the payout is escrowed with the keeper's
/// lamports, and the owner withdraws it (rent back to the keeper). Memo-required ATAs are
/// escrowed too. The owner never pays.
#[test]
fn auto_claim_missing_or_refusing_ata_caller_pays() {
    let mut w = World::new();
    let kk = kp_pk(&w.env.keeper);
    let mint = w.mint;
    // (1) keeper creates the missing ATA first.
    let (u, t) = user_with_ticket(&mut w, 1_000 * M, DAY);
    w.env.svm.set_account(addr(&u.ata), Account::default()).unwrap();
    let u_sol = w.env.lamports(&u.key);
    let k_sol = w.env.lamports(&kk);
    let k = w.env.keeper.insecure_clone();
    let i = w.claim_for_ix(&kk, t);
    ok(w.env.send_as(&k, &[create_ata_ix(&kk, &u.key, &mint), i], &[&k]));
    assert_eq!(token_amount(&w.env, &u.ata), 100 * M);
    assert_eq!(w.ticket(&t).status, TicketStatus::Claimed);
    let ata_rent = w.env.lamports(&u.ata);
    assert!(k_sol - w.env.lamports(&kk) >= ata_rent, "keeper paid the ATA rent");
    assert_eq!(w.env.lamports(&u.key), u_sol);

    // (2) missing ATA, no create → escrow, rent from the keeper.
    let (a, ta) = user_with_ticket(&mut w, 1_000 * M, DAY);
    w.env.svm.set_account(addr(&a.ata), Account::default()).unwrap();
    // (3) memo-required ATA → escrow.
    let (b, tb) = user_with_ticket(&mut w, 1_000 * M, DAY);
    w.set_balance(&b, 0, true);
    let k_sol = w.env.lamports(&kk);
    for (usr, tkt) in [(&a, ta), (&b, tb)] {
        let m = ok(w.claim_for(tkt));
        let e = &events::<ClaimEscrowed>(&m)[0];
        assert_eq!((e.owner, e.triggered_by, e.escrow, e.amount), (usr.key, kk, w.escrow_key(&tkt), 100 * M));
        let tk = w.ticket(&tkt);
        assert_eq!((tk.status, tk.escrow_payer), (TicketStatus::Escrowed, kk));
        assert_eq!(token_amount(&w.env, &w.escrow_key(&tkt)), 100 * M);
        assert_eq!(w.position(&usr.key).open_count, 0);
    }
    let rent = w.env.lamports(&w.escrow_key(&ta));
    assert_eq!(k_sol - w.env.lamports(&kk), 2 * rent, "keeper paid both escrows' rent");
    w.set_balance(&a, 0, false);
    ok(w.withdraw_escrow(&a, ta, a.ata));
    assert_eq!(token_amount(&w.env, &a.ata), 100 * M);
    assert_eq!(w.env.lamports(&kk), k_sol - rent, "escrow rent refunded to the keeper");
    assert_eq!(w.coin_state().tokens_paid_out, 300 * M);
}

#[test]
fn auto_claim_opt_out_and_back_in() {
    let mut w = World::new();
    let (u, t) = user_with_ticket(&mut w, 1_000 * M, DAY);
    let m = ok(w.set_auto_claim(&u, false));
    let e = &events::<AutoClaimSet>(&m)[0];
    assert_eq!((e.wallet, e.mint, e.enabled), (u.key, w.mint, false));
    assert_eq!(w.position(&u.key).auto_claim_opt_out, 1);
    assert_fumpad_err(w.claim_for(t), FumpadError::AutoClaimDisabled);
    assert_eq!(w.ticket(&t).status, TicketStatus::Open);
    // Someone else can't flip it (position PDA is the signer's own).
    let (v, _) = user_with_ticket(&mut w, 1_000 * M, DAY);
    let i = w.set_auto_claim_ix(&v.key, w.position_key(&u.key), true);
    let kv = v.kp.insecure_clone();
    assert_err_code(w.env.send(&[i], &[&kv]), anchor_lang::error::ErrorCode::ConstraintSeeds as u32);
    // Back in → the keeper can claim.
    ok(w.set_auto_claim(&u, true));
    assert_eq!(w.position(&u.key).auto_claim_opt_out, 0);
    ok(w.claim_for(t));
    assert_eq!(token_amount(&w.env, &u.ata), 100 * M);
    // Opted out: the owner-signed claim still works.
    let t2 = w.add_ticket(&u.key, 1_000 * M, base_price(), w.now() - DAY);
    ok(w.set_auto_claim(&u, false));
    assert_fumpad_err(w.claim_for(t2), FumpadError::AutoClaimDisabled);
    ok(w.claim(&u, t2));
    assert_eq!(token_amount(&w.env, &u.ata), 200 * M);
}

/// The keeper (or anyone) can't redirect a payout: the destination must be the owner's
/// canonical ATA and the escrow must be the ticket's own PDA; only registered keepers
/// may call.
#[test]
fn auto_claim_cannot_redirect_funds() {
    let mut w = World::new();
    let (u, t) = user_with_ticket(&mut w, 1_000 * M, DAY);
    let kk = kp_pk(&w.env.keeper);
    let k = w.env.keeper.insecure_clone();
    let thief = w.user(0);
    let side = w.side_account(&u); // the owner's own, but not the canonical ATA
    for dest in [thief.ata, ata(&kk, &w.mint), side] {
        let i = w.claim_for_ix_raw(&kk, t, dest, w.escrow_key(&t));
        assert_fumpad_err(w.env.send(&[i], &[&k]), FumpadError::InvalidAccount);
    }
    let (_, other_ticket) = user_with_ticket(&mut w, 1_000 * M, DAY);
    let i = w.claim_for_ix_raw(&kk, t, u.ata, w.escrow_key(&other_ticket));
    assert_err_code(w.env.send(&[i], &[&k]), anchor_lang::error::ErrorCode::ConstraintSeeds as u32);
    // Not a keeper.
    let tk = thief.kp.insecure_clone();
    let i = w.claim_for_ix(&thief.key, t);
    assert_fumpad_err(w.env.send(&[i], &[&tk]), FumpadError::Unauthorized);
    assert_eq!(w.ticket(&t).status, TicketStatus::Open);
    assert_eq!(w.pool(), POOL);
    ok(w.claim_for(t));
    assert_eq!(token_amount(&w.env, &u.ata), 100 * M);
    assert_eq!(token_amount(&w.env, &thief.ata), 0);
}

#[test]
fn auto_claim_rejects_queued_expired_voided_and_unchanged_rules() {
    let mut w = World::new();
    // Queued (over the cap) → can't be claimed again.
    w.set_pool(1);
    let (q, tq) = user_with_ticket(&mut w, 1_000 * M, DAY);
    let m = ok(w.claim_for(tq));
    let e = &events::<ClaimQueued>(&m)[0];
    assert_eq!((e.owner, e.triggered_by, e.queue_len), (q.key, kp_pk(&w.env.keeper), 1));
    assert_eq!(w.ticket(&tq).status, TicketStatus::Queued);
    assert_fumpad_err(w.claim_for(tq), FumpadError::TicketNotOpen);
    w.set_pool(POOL);
    // Expired.
    let (_, te) = user_with_ticket(&mut w, 1_000 * M, 90 * DAY + 1);
    assert_fumpad_err(w.claim_for(te), FumpadError::TicketExpired);
    // Voided (rebuy debited it to zero).
    let (v, tv) = user_with_ticket(&mut w, 1_000 * M, DAY);
    let mut tk = w.ticket(&tv);
    tk.tokens = 0;
    tk.status = TicketStatus::Voided;
    w.raw_set(&tv, anchor_bytes(&tk), fumpad::ID);
    assert_fumpad_err(w.claim_for(tv), FumpadError::TicketNotOpen);
    assert_eq!(token_amount(&w.env, &v.ata), 0);
    // Trigger, coverage and pause apply unchanged.
    let (_, tt) = user_with_ticket(&mut w, 1_000 * M, DAY);
    let mut tk = w.ticket(&tt);
    tk.sell_price_q64 = sell_price(2_000, M); // median is only 5x of this
    w.raw_set(&tt, anchor_bytes(&tk), fumpad::ID);
    assert_fumpad_err(w.claim_for(tt), FumpadError::TriggerNotMet);
    let (_, tp) = user_with_ticket(&mut w, 1_000 * M, DAY);
    let admin = w.env.admin.insecure_clone();
    let i = ix(
        fumpad::accounts::AdminOnly { admin: kp_pk(&admin), global: w.env.global_pda() },
        fumpad::instruction::SetPause { paused: PAUSE_CLAIMS },
    );
    ok(w.env.send(&[i], &[&admin]));
    assert_fumpad_err(w.claim_for(tp), FumpadError::Paused);
}

/// D16 applies to auto-claims: a third over-cap ticket of a wallet with 2 queue entries
/// is refused and stays Open.
#[test]
fn auto_claim_respects_wallet_queue_limit() {
    let mut w = World::new();
    w.set_pool(1);
    let u = w.user(0);
    let now = w.now();
    let ts: Vec<_> = (0..3).map(|i| w.add_ticket(&u.key, 1_000 * M, base_price(), now - DAY + i)).collect();
    ok(w.claim_for(ts[0]));
    ok(w.claim(&u, ts[1])); // mixed: owner-queued entries count too
    assert_fumpad_err(w.claim_for(ts[2]), FumpadError::WalletQueueLimit);
    assert_eq!(w.ticket(&ts[2]).status, TicketStatus::Open);
    assert_eq!(w.queue_state().len, 2);
}
