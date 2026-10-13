//! Claims, queue (1024, skip-ahead, 2 per wallet), escrow, auto-claim, expiry and close paths (v0.6 rules, ported)
//! on a REAL graduated coin: real DBC → DAMM v2 migration, real keeper samples of the DAMM v2 pool, tickets from
//! real 2-of-3 attestations. Only the reward-vault balance and a few owner ATAs are fabricated (`set_pool`,
//! `set_memo`) to reach queue states quickly.

use anchor_lang::prelude::AccountMeta;
use fumpad::attestation::SellRecord;
use fumpad::error::FumpadError;
use fumpad::events::{ClaimEscrowed, ClaimPaid, ClaimQueued, EscrowWithdrawn, TicketClosed};
use fumpad::state::{ClaimQueue, Position, Ticket, TicketStatus, PAUSE_CLAIMS};
use litesvm::types::TransactionResult;
use solana_account::Account;
use solana_instruction::Instruction;
use solana_keypair::Keypair;

use crate::flow::*;
use crate::meteora;
use crate::*;

pub const M: u64 = 1_000_000; // 1 token
pub const DAY: i64 = 86_400;

pub struct World {
    pub env: Env,
    pub c: TCoin,
    /// Current DAMM v2 spot (Q64) = the median once sampled.
    pub spot: u128,
    pub seq: u32,
}

impl World {
    /// Graduated coin (real migration), reward pool = DBC leftover, observations + queue initialized.
    pub fn new() -> Self {
        let mut env = Env::new();
        let c = env.launch(SOL / 10);
        env.skip_launch_window();
        env.graduate_coin(&c);
        env.warp(3_600); // sells in the tests happened after the launch
        let pool = env.coin(&c).damm_pool;
        let spot = sqrt_to_q64(meteora::rd_u128(&env.data(&pool), fumpad::external::meteora::DAMM_POOL_SQRT_PRICE));
        World { env, c, spot, seq: 0 }
    }

    /// Ticket price at which the 10x trigger holds at the current spot (spot / 20).
    pub fn low_price(&self) -> u128 {
        self.spot / 20
    }

    pub fn user(&mut self) -> Keypair {
        let u = self.env.new_user(10);
        let p = kp_pk(&u);
        ok(self.env.send_as(&u, &[meteora::create_ata_idempotent_ix(&p, &p, &self.c.mint, &TOKEN_2022)], &[&u]));
        u
    }

    /// Attest a ticket for `owner` (`tokens`, `price`, sold `age` seconds ago). Returns the ticket key.
    pub fn ticket_at(&mut self, owner: &Pubkey, tokens: u64, price: u128, age: i64) -> Pubkey {
        self.seq += 1;
        let mut r: SellRecord = self.env.sell_record(&self.c, owner, tokens, price);
        r.ix_key = self.seq;
        r.block_time = self.env.now() - age;
        r.pyth_publish_time = r.block_time - 1;
        let pos = position_pda(&self.c.mint, owner);
        let seq = if self.env.exists(&pos) { self.env.fetch::<Position>(&pos).next_ticket_seq } else { 0 };
        ok(self.env.attest_sell(&r, &[0, 1]));
        ticket_pda(&self.c.mint, owner, seq)
    }

    pub fn ticket(&mut self, owner: &Pubkey, tokens: u64) -> Pubkey {
        let p = self.low_price();
        self.ticket_at(owner, tokens, p, 30)
    }

    /// Past every challenge window, with fresh full keeper coverage (30 min of samples).
    pub fn ready(&mut self) {
        self.env.warp(fumpad::DEFAULT_TICKET_CHALLENGE_SECS);
        let c = TCoin { mint: self.c.mint, creator: self.c.creator.insecure_clone(), config: self.c.config, pool: self.c.pool };
        self.env.sample_for(&c, 1_800);
    }

    pub fn t(&self, k: &Pubkey) -> Ticket {
        self.env.fetch(k)
    }

    pub fn queue(&self) -> ClaimQueue {
        self.env.fetch_zc(&self.c.claim_queue())
    }

    pub fn vault(&self) -> Pubkey {
        self.env.reward_vault(&self.c.mint)
    }

    pub fn pool(&self) -> u64 {
        self.env.token_balance(&self.vault())
    }

    /// Overwrite the reward vault's balance (fabrication: queue states without huge tickets).
    pub fn set_pool(&mut self, amount: u64) {
        let v = self.vault();
        let mut a = self.env.svm.get_account(&addr(&v)).unwrap();
        a.data[64..72].copy_from_slice(&amount.to_le_bytes());
        self.env.svm.set_account(addr(&v), a).unwrap();
    }

    /// Make the owner's canonical ATA require incoming-transfer memos (it then refuses plain payouts).
    pub fn set_memo(&mut self, owner: &Pubkey) {
        let k = base_ata(owner, &self.c.mint);
        let mut d = vec![0u8; 165];
        d[0..32].copy_from_slice(self.c.mint.as_ref());
        d[32..64].copy_from_slice(owner.as_ref());
        d[108] = 1;
        d.push(2); // AccountType::Account
        d.extend_from_slice(&[7, 0, 0, 0]); // ImmutableOwner
        d.extend_from_slice(&[8, 0, 1, 0, 1]); // MemoTransfer { require_incoming: true }
        let lamports = self.env.rent(d.len());
        self.env
            .svm
            .set_account(addr(&k), Account { lamports, data: d, owner: addr(&TOKEN_2022), executable: false, rent_epoch: 0 })
            .unwrap();
    }

    pub fn remove_ata(&mut self, owner: &Pubkey) {
        let k = base_ata(owner, &self.c.mint);
        self.env.svm.set_account(addr(&k), Account::default()).unwrap();
    }

    pub fn claim_ix(&self, owner: &Pubkey, t: &Pubkey, dest: &Pubkey) -> Instruction {
        ix(
            fumpad::accounts::Claim {
                owner: *owner,
                global: self.env.global(),
                coin: self.c.coin_pda(),
                mint: self.c.mint,
                ticket: *t,
                position: position_pda(&self.c.mint, owner),
                claim_queue: self.c.claim_queue(),
                observations: self.c.observations(),
                reward_pool: self.env.reward_pool(),
                reward_vault: self.vault(),
                owner_token_account: *dest,
                token_program: TOKEN_2022,
                event_authority: ev_auth(),
                program: fumpad::ID,
            },
            fumpad::instruction::Claim {},
        )
    }

    pub fn claim(&mut self, owner: &Keypair, t: &Pubkey) -> TransactionResult {
        let i = self.claim_ix(&kp_pk(owner), t, &base_ata(&kp_pk(owner), &self.c.mint));
        self.env.send_as(owner, &[i], &[owner])
    }

    pub fn claim_for_ix(&self, keeper: &Pubkey, t: &Pubkey) -> Instruction {
        let owner = self.t(t).owner;
        ix(
            fumpad::accounts::ClaimFor {
                keeper: *keeper,
                global: self.env.global(),
                coin: self.c.coin_pda(),
                mint: self.c.mint,
                ticket: *t,
                position: position_pda(&self.c.mint, &owner),
                claim_queue: self.c.claim_queue(),
                observations: self.c.observations(),
                reward_pool: self.env.reward_pool(),
                reward_vault: self.vault(),
                owner_ata: base_ata(&owner, &self.c.mint),
                escrow: escrow_pda(t),
                token_program: TOKEN_2022,
                system_program: SYSTEM,
                event_authority: ev_auth(),
                program: fumpad::ID,
            },
            fumpad::instruction::ClaimFor {},
        )
    }

    /// `claim_for` by operator `operator` (jobs key).
    pub fn claim_for(&mut self, operator: usize, t: &Pubkey) -> TransactionResult {
        let k = self.env.operators[operator].insecure_clone();
        let i = self.claim_for_ix(&kp_pk(&k), t);
        self.env.send_as(&k, &[i], &[&k])
    }

    pub fn process_ix(&self, cranker: &Pubkey, max: u8, entries: &[Pubkey]) -> Instruction {
        let mut rem = vec![];
        for t in entries {
            let owner = self.t(t).owner;
            rem.extend([
                rw(*t),
                rw(position_pda(&self.c.mint, &owner)),
                rw(base_ata(&owner, &self.c.mint)),
                rw(escrow_pda(t)),
            ]);
        }
        ix_rem(
            fumpad::accounts::ProcessQueue {
                cranker: *cranker,
                global: self.env.global(),
                coin: self.c.coin_pda(),
                mint: self.c.mint,
                claim_queue: self.c.claim_queue(),
                reward_pool: self.env.reward_pool(),
                reward_vault: self.vault(),
                token_program: TOKEN_2022,
                system_program: SYSTEM,
                event_authority: ev_auth(),
                program: fumpad::ID,
            },
            fumpad::instruction::ProcessQueue { max_entries: max },
            &rem,
        )
    }

    pub fn process(&mut self, max: u8, entries: &[Pubkey]) -> TransactionResult {
        let p = self.env.payer.insecure_clone();
        let i = self.process_ix(&kp_pk(&p), max, entries);
        self.env.send_as(&p, &[compute_budget_ix(1_400_000), i], &[&p])
    }

    pub fn withdraw_escrow(&mut self, owner: &Keypair, t: &Pubkey, dest: &Pubkey) -> TransactionResult {
        let tk = self.t(t);
        let i = ix(
            fumpad::accounts::WithdrawEscrow {
                owner: kp_pk(owner),
                global: self.env.global(),
                mint: self.c.mint,
                ticket: *t,
                escrow: escrow_pda(t),
                reward_pool: self.env.reward_pool(),
                destination: *dest,
                escrow_payer: tk.escrow_payer,
                token_program: TOKEN_2022,
                event_authority: ev_auth(),
                program: fumpad::ID,
            },
            fumpad::instruction::WithdrawEscrow {},
        );
        self.env.send_as(owner, &[i], &[owner])
    }

    pub fn close_ticket(&mut self, t: &Pubkey, with_queue: bool) -> TransactionResult {
        let tk = self.t(t);
        let i = ix(
            fumpad::accounts::CloseTicket {
                caller: kp_pk(&self.env.payer),
                global: self.env.global(),
                ticket: *t,
                rent_payer: tk.rent_payer,
                position: position_pda(&self.c.mint, &tk.owner),
                claim_queue: if with_queue { Some(self.c.claim_queue()) } else { None },
                coin: self.c.coin_pda(),
                event_authority: ev_auth(),
                program: fumpad::ID,
            },
            fumpad::instruction::CloseTicket {},
        );
        self.env.send(&[i], &[])
    }

    pub fn set_auto_claim(&mut self, owner: &Keypair, enabled: bool) -> TransactionResult {
        let i = ix(
            fumpad::accounts::SetAutoClaim {
                wallet: kp_pk(owner),
                position: position_pda(&self.c.mint, &kp_pk(owner)),
                event_authority: ev_auth(),
                program: fumpad::ID,
            },
            fumpad::instruction::SetAutoClaim { enabled },
        );
        self.env.send_as(owner, &[i], &[owner])
    }

    /// A Token-2022 account of `owner` for the mint that is NOT its ATA (claim destination of choice).
    pub fn side_account(&mut self, owner: &Keypair) -> Pubkey {
        let k = Keypair::new();
        let o = kp_pk(owner);
        let space = 170u64;
        let lamports = self.env.rent(space as usize);
        let create = {
            let mut data = vec![0, 0, 0, 0];
            data.extend_from_slice(&lamports.to_le_bytes());
            data.extend_from_slice(&space.to_le_bytes());
            data.extend_from_slice(TOKEN_2022.as_ref());
            raw_ix(&SYSTEM, &[sgw(o), sgw(kp_pk(&k))], data)
        };
        // InitializeImmutableOwner (22) then InitializeAccount3 (18).
        let imm = raw_ix(&TOKEN_2022, &[rw(kp_pk(&k))], vec![22]);
        let mut d = vec![18];
        d.extend_from_slice(o.as_ref());
        let init = raw_ix(&TOKEN_2022, &[rw(kp_pk(&k)), ro(self.c.mint)], d);
        ok(self.env.send_as(owner, &[create, imm, init], &[owner, &k]));
        kp_pk(&k)
    }
}

#[test]
fn claim_pays_ten_percent_immediately() {
    let mut w = World::new();
    let alice = w.user();
    let t = w.ticket(&kp_pk(&alice), 1_000 * M);
    // Inside the 6 h challenge window: not claimable yet.
    w.env.sample_for(&TCoin { mint: w.c.mint, creator: Keypair::new(), config: w.c.config, pool: w.c.pool }, 1_800);
    assert_fumpad_err(w.claim(&alice, &t), FumpadError::TicketInChallenge);
    w.ready();
    let pool0 = w.pool();
    let meta = ok(w.claim(&alice, &t));
    let ev: ClaimPaid = event(&meta);
    assert_eq!((ev.amount, ev.from_queue, ev.triggered_by), (100 * M, false, kp_pk(&alice)));
    assert_eq!(w.env.base_balance(&kp_pk(&alice), &w.c.mint), 100 * M);
    assert_eq!(w.pool(), pool0 - 100 * M);
    let tk = w.t(&t);
    assert_eq!((tk.status, tk.claim_amount), (TicketStatus::Claimed, 100 * M));
    assert_eq!(w.env.fetch::<Position>(&position_pda(&w.c.mint, &kp_pk(&alice))).open_count, 0);
    assert_eq!(w.env.coin(&w.c).tokens_paid_out, 100 * M);
    println!("claim (paid now) CU {}", meta.compute_units_consumed);
    // Claimed → closable by anyone; rent back to the attesting keeper.
    let k0 = kp_pk(&w.env.keepers[0]);
    let before = w.env.lamports(&k0);
    let meta = ok(w.close_ticket(&t, false));
    let ev: TicketClosed = event(&meta);
    assert_eq!((ev.final_status, ev.rent_payer), (TicketStatus::Claimed as u8, k0));
    assert!(w.env.lamports(&k0) > before);
    // Pays to any token account of the owner, not someone else's.
    let t2 = w.ticket(&kp_pk(&alice), 1_000 * M);
    w.ready();
    let bob = w.user();
    let i = w.claim_ix(&kp_pk(&alice), &t2, &base_ata(&kp_pk(&bob), &w.c.mint));
    assert!(w.env.send_as(&alice, &[i], &[&alice]).is_err());
    let side = w.side_account(&alice);
    let i = w.claim_ix(&kp_pk(&alice), &t2, &side);
    ok(w.env.send_as(&alice, &[i], &[&alice]));
    assert_eq!(w.env.token_balance(&side), 100 * M);
}

#[test]
fn claim_rules_trigger_samples_owner_pause_expiry() {
    let mut w = World::new();
    let alice = w.user();
    let p = w.spot / 9; // only 9x
    let t9 = w.ticket_at(&kp_pk(&alice), 1_000 * M, p, 30);
    let t = w.ticket(&kp_pk(&alice), 1_000 * M);
    w.ready();
    assert_fumpad_err(w.claim(&alice, &t9), FumpadError::TriggerNotMet);
    // Someone else can't claim alice's ticket.
    let bob = w.user();
    let i = w.claim_ix(&kp_pk(&bob), &t, &base_ata(&kp_pk(&bob), &w.c.mint));
    assert!(w.env.send_as(&bob, &[i], &[&bob]).is_err());
    // Pause.
    let admin = w.env.admin.insecure_clone();
    ok(w.env.set_pause(&admin, PAUSE_CLAIMS));
    assert_fumpad_err(w.claim(&alice, &t), FumpadError::Paused);
    ok(w.env.set_pause(&admin, 0));
    // Keeper outage: samples older than the window → InsufficientSamples.
    w.env.warp(1_801);
    assert_fumpad_err(w.claim(&alice, &t), FumpadError::InsufficientSamples);
    // Expiry: 90 days after the sell → TicketExpired; then permissionless close (Expired, rent to keeper).
    w.env.warp(90 * DAY);
    w.ready();
    assert_fumpad_err(w.claim(&alice, &t), FumpadError::TicketExpired);
    let meta = ok(w.close_ticket(&t, false));
    assert_eq!(event::<TicketClosed>(&meta).final_status, TicketStatus::Expired as u8);
    // Zero claim amount (9 base units → 10% = 0).
    let t0 = w.ticket(&kp_pk(&alice), 9);
    w.ready();
    assert_fumpad_err(w.claim(&alice, &t0), FumpadError::ZeroAmount);
}

#[test]
fn claims_need_a_graduated_coin() {
    let mut env = Env::new();
    let c = env.launch(SOL / 10);
    env.skip_launch_window();
    let alice = env.new_user(1);
    let r = env.sell_record(&c, &kp_pk(&alice), 1_000 * M, 1);
    ok(env.attest_sell(&r, &[0, 1]));
    // No observations / queue exist before graduation: claim can't even load them.
    let w_claim = ix(
        fumpad::accounts::Claim {
            owner: kp_pk(&alice),
            global: env.global(),
            coin: c.coin_pda(),
            mint: c.mint,
            ticket: ticket_pda(&c.mint, &kp_pk(&alice), 0),
            position: position_pda(&c.mint, &kp_pk(&alice)),
            claim_queue: c.claim_queue(),
            observations: c.observations(),
            reward_pool: env.reward_pool(),
            reward_vault: env.reward_vault(&c.mint),
            owner_token_account: base_ata(&kp_pk(&alice), &c.mint),
            token_program: TOKEN_2022,
            event_authority: ev_auth(),
            program: fumpad::ID,
        },
        fumpad::instruction::Claim {},
    );
    assert!(env.send_as(&alice, &[w_claim], &[&alice]).is_err());
    // init_observations / init_claim_queue require Graduated.
    let k = env.keepers[0].insecure_clone();
    let i = ix(
        fumpad::accounts::InitObservations { payer: kp_pk(&k), coin: c.coin_pda(), observations: c.observations(), system_program: SYSTEM },
        fumpad::instruction::InitObservations {},
    );
    assert_fumpad_err(env.send_as(&k, &[i], &[&k]), FumpadError::WrongCoinStatus);
    let i = ix(
        fumpad::accounts::InitClaimQueue { payer: kp_pk(&k), coin: c.coin_pda(), claim_queue: c.claim_queue(), system_program: SYSTEM },
        fumpad::instruction::InitClaimQueue {},
    );
    assert_fumpad_err(env.send_as(&k, &[i], &[&k]), FumpadError::WrongCoinStatus);
}

#[test]
fn over_cap_claims_queue_skip_ahead_and_never_expire() {
    let mut w = World::new();
    let (a, b, c) = (w.user(), w.user(), w.user());
    // Oldest first: A (big), B (small), C (small).
    let ta = w.ticket_at(&kp_pk(&a), 2_000 * M, w.low_price(), 300);
    let tb = w.ticket_at(&kp_pk(&b), 500 * M, w.low_price(), 200);
    let tc = w.ticket_at(&kp_pk(&c), 500 * M, w.low_price(), 100);
    w.ready();
    // Pool 1,000 tokens: cap 100 → A's 200 doesn't fit → queued.
    w.set_pool(1_000 * M);
    let meta = ok(w.claim(&a, &ta));
    let ev: ClaimQueued = event(&meta);
    assert_eq!((ev.amount, ev.queue_len), (200 * M, 1));
    assert_eq!(w.t(&ta).status, TicketStatus::Queued);
    // B fits (50 ≤ 100) and nothing older fits → paid now (skip-ahead).
    let meta = ok(w.claim(&b, &tb));
    assert_eq!(event::<ClaimPaid>(&meta).amount, 50 * M);
    // Pool grows: the crank pays A, then C claims normally.
    w.set_pool(10_000 * M);
    let meta = ok(w.process(10, &[ta]));
    let ev: ClaimPaid = event(&meta);
    assert_eq!((ev.ticket, ev.amount, ev.from_queue), (ta, 200 * M, true));
    assert_eq!(w.queue().len, 0);
    // A queued ticket never expires.
    w.set_pool(100 * M);
    let td = w.ticket(&kp_pk(&c), 2_000 * M);
    w.ready();
    ok(w.claim(&c, &td));
    assert_eq!(w.t(&td).status, TicketStatus::Queued);
    w.env.warp(200 * DAY);
    assert_fumpad_err(w.close_ticket(&td, true), FumpadError::TicketNotClosable);
    w.set_pool(1_000_000 * M);
    ok(w.process(1, &[td]));
    assert_eq!(w.t(&td).status, TicketStatus::Claimed);
    let _ = tc;
}

#[test]
fn instant_claim_waits_behind_older_fitting_entry_and_wallet_limit() {
    let mut w = World::new();
    let (a, b) = (w.user(), w.user());
    let ta1 = w.ticket_at(&kp_pk(&a), 1_100 * M, w.low_price(), 500);
    let ta2 = w.ticket_at(&kp_pk(&a), 1_100 * M, w.low_price(), 400);
    let ta3 = w.ticket_at(&kp_pk(&a), 1_100 * M, w.low_price(), 300);
    let tb = w.ticket_at(&kp_pk(&b), 500 * M, w.low_price(), 100);
    w.ready();
    w.set_pool(1_000 * M); // cap 100: 110-token claims queue
    ok(w.claim(&a, &ta1));
    ok(w.claim(&a, &ta2));
    // D16: a 3rd entry for the same wallet reverts; the ticket stays Open.
    assert_fumpad_err(w.claim(&a, &ta3), FumpadError::WalletQueueLimit);
    assert_eq!(w.t(&ta3).status, TicketStatus::Open);
    // Pool grows enough for A's entries: B (newer) must queue behind them instead of jumping ahead.
    w.set_pool(1_200 * M); // cap 120: A's 110 fit
    let meta = ok(w.claim(&b, &tb));
    assert_eq!(event::<ClaimQueued>(&meta).queue_len, 3);
    // A crank that omits A's entries halts before B (can't reorder).
    let r = w.process(10, &[tb]);
    assert!(r.is_err() || w.t(&tb).status == TicketStatus::Queued);
    // max_entries bounds payments per call.
    w.set_pool(100_000 * M);
    ok(w.process(1, &[ta1, ta2, tb]));
    assert_eq!(w.queue().len, 2);
    ok(w.process(10, &[ta2, tb]));
    assert_eq!(w.queue().len, 0);
    for t in [ta1, ta2, tb] {
        assert_eq!(w.t(&t).status, TicketStatus::Claimed);
    }
}

#[test]
fn process_queue_rejects_spoofing() {
    let mut w = World::new();
    let (a, b) = (w.user(), w.user());
    let ta = w.ticket_at(&kp_pk(&a), 2_000 * M, w.low_price(), 200);
    let tb = w.ticket_at(&kp_pk(&b), 2_000 * M, w.low_price(), 100);
    w.ready();
    w.set_pool(1_000 * M);
    ok(w.claim(&a, &ta));
    ok(w.claim(&b, &tb));
    w.set_pool(100_000 * M);
    // Out of order quadruples.
    assert_fumpad_err(w.process(10, &[tb, ta]), FumpadError::InvalidAccount);
    // A ticket that is not in the queue.
    let tx = w.ticket(&kp_pk(&a), 10 * M);
    assert_fumpad_err(w.process(10, &[ta, tb, tx]), FumpadError::InvalidAccount);
    // Owner ATA swapped for the attacker's.
    let p = w.env.payer.insecure_clone();
    let mut i = w.process_ix(&kp_pk(&p), 10, &[ta]);
    let n = i.accounts.len();
    i.accounts[n - 2].pubkey = addr(&base_ata(&kp_pk(&b), &w.c.mint));
    assert_fumpad_err(w.env.send_as(&p, &[i], &[&p]), FumpadError::InvalidAccount);
    ok(w.process(10, &[ta, tb]));
}

#[test]
fn regression_memo_refusing_or_missing_atas_are_escrowed_and_leave_the_queue() {
    let mut w = World::new();
    let (a, b) = (w.user(), w.user());
    let ta = w.ticket_at(&kp_pk(&a), 2_000 * M, w.low_price(), 200);
    let tb = w.ticket_at(&kp_pk(&b), 2_000 * M, w.low_price(), 100);
    w.ready();
    w.set_pool(1_000 * M);
    ok(w.claim(&a, &ta));
    ok(w.claim(&b, &tb));
    w.set_memo(&kp_pk(&a));
    w.remove_ata(&kp_pk(&b));
    w.set_pool(100_000 * M);
    let cranker = kp_pk(&w.env.payer);
    let before = w.env.lamports(&cranker);
    let meta = ok(w.process(10, &[ta, tb]));
    let evs = events::<ClaimEscrowed>(&meta);
    assert_eq!(evs.len(), 2);
    assert_eq!(w.queue().len, 0, "refusing entries leave the queue");
    for t in [ta, tb] {
        let tk = w.t(&t);
        assert_eq!((tk.status, tk.escrow_payer), (TicketStatus::Escrowed, cranker));
        assert_eq!(w.env.token_balance(&escrow_pda(&t)), 200 * M);
    }
    assert!(before > w.env.lamports(&cranker), "cranker paid the escrow rent");
    // Escrowed tickets can't be closed until withdrawn.
    assert_fumpad_err(w.close_ticket(&ta, false), FumpadError::TicketNotClosable);
    // The owner withdraws to any of its accounts; rent back to the cranker; ticket → Claimed.
    let side = w.side_account(&a);
    let c0 = w.env.lamports(&cranker);
    let meta = ok(w.withdraw_escrow(&a, &ta, &side));
    assert_eq!(event::<EscrowWithdrawn>(&meta).amount, 200 * M);
    assert_eq!(w.env.token_balance(&side), 200 * M);
    assert!(w.env.lamports(&cranker) > c0);
    assert_eq!(w.t(&ta).status, TicketStatus::Claimed);
    assert!(!w.env.exists(&escrow_pda(&ta)));
    assert!(w.withdraw_escrow(&a, &ta, &side).is_err(), "escrow closed: nothing left to withdraw");
    ok(w.close_ticket(&ta, false));
}

#[test]
fn auto_claim_pays_only_the_owner_and_respects_opt_out() {
    let mut w = World::new();
    let a = w.user();
    let t1 = w.ticket(&kp_pk(&a), 1_000 * M);
    let t2 = w.ticket(&kp_pk(&a), 1_000 * M);
    let t3 = w.ticket(&kp_pk(&a), 1_000 * M);
    w.ready();
    let meta = ok(w.claim_for(1, &t1));
    let ev: ClaimPaid = event(&meta);
    assert_eq!((ev.amount, ev.triggered_by), (100 * M, kp_pk(&w.env.operators[1])));
    assert_eq!(w.env.base_balance(&kp_pk(&a), &w.c.mint), 100 * M);
    println!("claim_for (paid) CU {}", meta.compute_units_consumed);
    // Not an operator → Unauthorized; attestor keys (Global.keepers) have no auto-claim power.
    let rando = w.env.new_user(1);
    let i = w.claim_for_ix(&kp_pk(&rando), &t2);
    assert_fumpad_err(w.env.send_as(&rando, &[i], &[&rando]), FumpadError::Unauthorized);
    let attestor = w.env.keepers[0].insecure_clone();
    let i = w.claim_for_ix(&kp_pk(&attestor), &t2);
    assert_fumpad_err(w.env.send_as(&attestor, &[i], &[&attestor]), FumpadError::Unauthorized);
    // The operator can't redirect: owner_ata is address-checked.
    let k = w.env.op();
    let mut i = w.claim_for_ix(&kp_pk(&k), &t2);
    i.accounts[10].pubkey = addr(&base_ata(&kp_pk(&k), &w.c.mint));
    assert_fumpad_err(w.env.send_as(&k, &[i], &[&k]), FumpadError::InvalidAccount);
    // Opt-out → AutoClaimDisabled; the owner can still claim; back in → works.
    ok(w.set_auto_claim(&a, false));
    assert_fumpad_err(w.claim_for(0, &t2), FumpadError::AutoClaimDisabled);
    ok(w.claim(&a, &t2));
    ok(w.set_auto_claim(&a, true));
    // Missing ATA → escrow, keeper pays the rent; the owner pays nothing.
    w.remove_ata(&kp_pk(&a));
    let meta = ok(w.claim_for(0, &t3));
    assert_eq!(event::<ClaimEscrowed>(&meta).triggered_by, kp_pk(&k));
    assert_eq!(w.t(&t3).escrow_payer, kp_pk(&k));
    println!("claim_for (escrowed) CU {}", meta.compute_units_consumed);
}

#[test]
fn regression_rebuy_updates_queue_entry_so_order_holds() {
    let mut w = World::new();
    let (a, b) = (w.user(), w.user());
    let ta = w.ticket_at(&kp_pk(&a), 2_000 * M, w.low_price(), 300);
    let tb = w.ticket_at(&kp_pk(&b), 2_000 * M, w.low_price(), 200);
    w.ready();
    w.set_pool(1_000 * M);
    ok(w.claim(&a, &ta));
    ok(w.claim(&b, &tb));
    assert_eq!(w.queue().total_owed, 400 * M);
    // Rebuy debit on A (queued): the claim queue is required and updated in the same instruction.
    let tk = w.t(&ta);
    let rb = rebuy_record(&tk, ta, 1_500 * M, tk.sell_ts + 60);
    assert_fumpad_err(w.env.attest_rebuy(&rb, &[0, 1], false), FumpadError::QueueAccountRequired);
    ok(w.env.attest_rebuy(&rb, &[0, 1], true));
    let q = w.queue();
    assert_eq!((q.entries[0].ticket, q.entries[0].amount, q.total_owed), (ta, 50 * M, 250 * M));
    assert_eq!(w.t(&ta).claim_amount, 50 * M);
    // Voiding B removes its entry.
    let tkb = w.t(&tb);
    let rb2 = rebuy_record(&tkb, tb, 5_000 * M, tkb.sell_ts + 60);
    ok(w.env.attest_rebuy(&rb2, &[0, 1], true));
    let q = w.queue();
    assert_eq!((q.len, q.total_owed), (1, 50 * M));
    assert_eq!(w.t(&tb).status, TicketStatus::Voided);
    ok(w.close_ticket(&tb, true));
}

#[test]
fn queue_full_reverts_and_ticket_stays_open() {
    let mut w = World::new();
    let a = w.user();
    let t = w.ticket(&kp_pk(&a), 2_000 * M);
    w.ready();
    // Fabricate a full queue of 1024 old entries (other wallets).
    let key = w.c.claim_queue();
    let mut acc = w.env.svm.get_account(&addr(&key)).unwrap();
    let base = 8usize;
    let len = fumpad::CLAIM_QUEUE_CAPACITY;
    acc.data[base + 32..base + 34].copy_from_slice(&(len as u16).to_le_bytes());
    for i in 0..len {
        let o = base + 48 + i * 80;
        acc.data[o..o + 32].copy_from_slice(Pubkey::new_unique().as_ref());
        acc.data[o + 32..o + 64].copy_from_slice(Pubkey::new_unique().as_ref());
        acc.data[o + 64..o + 72].copy_from_slice(&(1_000_000 * M).to_le_bytes());
        acc.data[o + 72..o + 80].copy_from_slice(&(i as i64).to_le_bytes());
    }
    acc.data[base + 40..base + 48].copy_from_slice(&((len as u64) * 1_000_000 * M).to_le_bytes());
    w.env.svm.set_account(addr(&key), acc).unwrap();
    w.set_pool(1_000 * M);
    assert_fumpad_err(w.claim(&a, &t), FumpadError::QueueFull);
    assert_eq!(w.t(&t).status, TicketStatus::Open);
    // The walk over a full queue fits easily (CU).
    let p = w.env.payer.insecure_clone();
    let i = w.process_ix(&kp_pk(&p), 13, &[]);
    let meta = ok(w.env.send_as(&p, &[compute_budget_ix(1_400_000), i], &[&p]));
    println!("process_queue full-queue walk CU {}", meta.compute_units_consumed);
}

#[test]
fn regression_positions_can_be_closed_when_empty() {
    let mut w = World::new();
    let a = w.user();
    let t = w.ticket(&kp_pk(&a), 1_000 * M);
    // Open ticket inside its claim window: not closable.
    assert_fumpad_err(w.close_ticket(&t, false), FumpadError::TicketNotClosable);
    w.ready();
    ok(w.claim(&a, &t));
    let pos = position_pda(&w.c.mint, &kp_pk(&a));
    let close_pos = |w: &World, signer: &Pubkey, tickets: &[Pubkey]| {
        let rp = w.env.fetch::<Position>(&pos).rent_payer;
        let rem: Vec<AccountMeta> = tickets.iter().map(|k| ro(*k)).collect();
        ix_rem(
            fumpad::accounts::ClosePosition { signer: *signer, position: pos, rent_payer: rp, event_authority: ev_auth(), program: fumpad::ID },
            fumpad::instruction::ClosePosition {},
            &rem,
        )
    };
    // Ticket not closed yet → PositionNotEmpty.
    let i = close_pos(&w, &kp_pk(&a), &[t]);
    assert_fumpad_err(w.env.send_as(&a, &[i], &[&a]), FumpadError::PositionNotEmpty);
    ok(w.close_ticket(&t, false));
    // A stranger can't close it.
    let rando = w.env.new_user(1);
    let i = close_pos(&w, &kp_pk(&rando), &[t]);
    assert_fumpad_err(w.env.send_as(&rando, &[i], &[&rando]), FumpadError::Unauthorized);
    // Wrong ticket list.
    let i = close_pos(&w, &kp_pk(&a), &[]);
    assert_fumpad_err(w.env.send_as(&a, &[i], &[&a]), FumpadError::PositionNotEmpty);
    // The wallet closes; rent → the keeper that paid it.
    let rp = w.env.fetch::<Position>(&pos).rent_payer;
    let before = w.env.lamports(&rp);
    let i = close_pos(&w, &kp_pk(&a), &[t]);
    ok(w.env.send_as(&a, &[i], &[&a]));
    assert!(!w.env.exists(&pos));
    assert!(w.env.lamports(&rp) > before);
    // Re-created on the next ticket: seq restarts at 0 without colliding.
    let t2 = w.ticket(&kp_pk(&a), 1_000 * M);
    assert_eq!(t2, ticket_pda(&w.c.mint, &kp_pk(&a), 0));
}
