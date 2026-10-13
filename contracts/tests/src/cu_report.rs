//! Compute units per instruction, worst cases (mainnet binaries). `cargo test -p tests cu_report -- --nocapture`.
//! Every row is asserted below the 1.4M transaction limit; rows that need more than the 200k default note it.

use crate::flow::*;
use crate::meteora;
use crate::rewards_tests::{World, M};
use crate::*;
use anchor_lang::prelude::AccountMeta;
use fumpad::external::meteora as m;
use solana_keypair::Keypair;

struct Report(Vec<(String, u64, usize)>);
impl Report {
    fn add(&mut self, name: &str, meta: &litesvm::types::TransactionMetadata, tx_bytes: usize) {
        self.0.push((name.to_string(), meta.compute_units_consumed, tx_bytes));
    }
}

fn fill_queue(w: &mut World, n: usize, amount: u64) {
    let key = w.c.claim_queue();
    let mut acc = w.env.svm.get_account(&addr(&key)).unwrap();
    let base = 8usize;
    acc.data[base + 32..base + 34].copy_from_slice(&(n as u16).to_le_bytes());
    for i in 0..n {
        let o = base + 48 + i * 80;
        acc.data[o..o + 32].copy_from_slice(Pubkey::new_unique().as_ref());
        acc.data[o + 32..o + 64].copy_from_slice(Pubkey::new_unique().as_ref());
        acc.data[o + 64..o + 72].copy_from_slice(&amount.to_le_bytes());
        acc.data[o + 72..o + 80].copy_from_slice(&(1_000 + i as i64).to_le_bytes());
    }
    acc.data[base + 40..base + 48].copy_from_slice(&((n as u64) * amount).to_le_bytes());
    w.env.svm.set_account(addr(&key), acc).unwrap();
}

#[test]
fn cu_report() {
    let mut r = Report(vec![]);

    // ── launch, router, fees, samples, buyback (curve) ──
    let mut env = Env::new();
    let creator = env.new_user(10);
    let mint = Keypair::new();
    env.fund_wsol(&creator, SOL / 10);
    let ixs = env.launch_ixs(&env.config.clone(), &kp_pk(&creator), &kp_pk(&mint), SOL / 10);
    let size = env.tx_size(&creator, &ixs, &[&creator, &mint]);
    let meta = ok(env.send_as(&creator, &ixs, &[&creator, &mint]));
    r.add("launch tx (DBC init + ATA + creator swap2 + register_coin)", &meta, size);
    let c = TCoin { mint: kp_pk(&mint), creator, config: env.config, pool: meteora::dbc_pool_pda(&env.config, &kp_pk(&mint)) };
    let sniper = env.new_user(100);
    ok(env.direct_buy(&c, &sniper, 2 * SOL));
    env.skip_launch_window();
    let alice = env.new_user(1_000);
    let a = kp_pk(&alice);
    // First router buy (creates nothing in fumpad; ATA + wrap are separate ixs in the same tx).
    let meta = ok(env.router_buy(&c, &alice, 5 * SOL));
    r.add("buy (router, DBC)", &meta, 0);
    let bal = env.base_balance(&a, &c.mint);
    let meta = ok(env.router_sell(&c, &alice, bal / 2));
    r.add("sell (router, DBC)", &meta, 0);
    let meta = ok(env.claim_fees(&c));
    r.add("claim_fees (DBC, launch window → buyback)", &meta, 0);
    ok(env.router_buy(&c, &alice, 20 * SOL));
    let meta = ok(env.claim_fees(&c));
    r.add("claim_fees (DBC, 50/30/20)", &meta, 0);
    let meta = ok(env.sample(0, &[&c]));
    r.add("record_samples (1 coin, pre-grad)", &meta, 0);
    let k0 = env.keepers[0].insecure_clone();
    let meta = ok(env.buyback(&c, &k0, u64::MAX));
    r.add("execute_buyback (DBC, pre-grad; creates buyback WSOL ATA)", &meta, 0);
    // Attest on the curve: first ticket of a wallet (creates position + ticket + marker).
    env.warp(60);
    let rec = env.sell_record(&c, &Pubkey::new_unique(), 1_000 * M, 1 << 40);
    let k1 = env.keepers[1].insecure_clone();
    let ixs = vec![Env::ed25519_ix(&rec.encode(), &[&k0, &k1]), env.attest_sell_ix(&kp_pk(&k0), &rec)];
    let size = env.tx_size(&k0, &ixs, &[&k0]);
    let meta = ok(env.send_as(&k0, &ixs, &[&k0]));
    r.add("attest_sell (new position; tx incl. Ed25519 2 sigs)", &meta, size);
    let rec2 = env.sell_record(&c, &rec.trader, 1_000 * M, 1 << 40);
    let meta = ok(env.attest_sell(&rec2, &[0, 1]));
    r.add("attest_sell (existing position)", &meta, 0);

    // ── completion, migration, graduation ──
    let whale = env.new_user(200);
    let meta = ok(env.router_buy_mode(&c, &whale, 100 * SOL, m::SWAP_MODE_PARTIAL_FILL));
    r.add("buy (router, DBC PartialFill completing the curve)", &meta, 0);
    let nft_kp = Keypair::new();
    let mi = env.migrate_pool_ix(&c, &kp_pk(&k0), &kp_pk(&nft_kp));
    let size = env.tx_size(&k0, &[compute_budget_ix(1_000_000), mi.clone()], &[&k0, &nft_kp]);
    let meta = ok(env.send_as(&k0, &[compute_budget_ix(1_000_000), mi], &[&k0, &nft_kp]));
    let nft = kp_pk(&nft_kp);
    r.add("migrate_pool (DBC migration_damm_v2 CPI; budget 1M)", &meta, size);
    let gi = env.graduate_ix(&c, &kp_pk(&k0), &nft, &kp_pk(&k0));
    let size = env.tx_size(&k0, &[compute_budget_ix(400_000), gi.clone()], &[&k0]);
    let meta = ok(env.graduate(&c, &k0, &nft));
    r.add("graduate (leftover + migration fee + surplus + prefund)", &meta, size);
    let p = kp_pk(&k0);
    let obs = ix(
        fumpad::accounts::InitObservations { payer: p, coin: c.coin_pda(), observations: c.observations(), system_program: SYSTEM },
        fumpad::instruction::InitObservations {},
    );
    let meta = ok(env.send_as(&k0, &[obs], &[&k0]));
    r.add("init_observations", &meta, 0);
    let q = ix(
        fumpad::accounts::InitClaimQueue { payer: p, coin: c.coin_pda(), claim_queue: c.claim_queue(), system_program: SYSTEM },
        fumpad::instruction::InitClaimQueue {},
    );
    let qs: Vec<_> = (0..fumpad::instructions::CLAIM_QUEUE_INIT_CALLS).map(|_| q.clone()).collect();
    let meta = ok(env.send_as(&k0, &qs, &[&k0]));
    r.add("init_claim_queue × 9 (one tx, total)", &meta, 0);

    // ── graduated: router, LP fees, samples, buyback ──
    let meta = ok(env.router_buy(&c, &alice, 5 * SOL));
    r.add("buy (router, DAMM v2)", &meta, 0);
    let bal = env.base_balance(&a, &c.mint);
    let meta = ok(env.router_sell(&c, &alice, bal / 3));
    r.add("sell (router, DAMM v2)", &meta, 0);
    let meta = ok(env.claim_lp_fees(&c, &nft));
    r.add("claim_lp_fees (DAMM v2 position)", &meta, 0);
    // 10 coins in one record_samples: graduate 9 more coins.
    let mut coins = vec![];
    for _ in 0..9 {
        let cc = env.launch(SOL / 10);
        env.skip_launch_window();
        env.graduate_coin(&cc);
        coins.push(cc);
    }
    env.warp(20);
    let meta = ok(env.sample(0, &[&c]));
    r.add("record_samples (1 coin, DAMM)", &meta, 0);
    env.warp(20);
    let refs: Vec<&TCoin> = std::iter::once(&c).chain(coins.iter().take(4)).collect();
    let i = env.record_samples_ix(&kp_pk(&k0), &refs);
    let size = env.tx_size(&k0, &[i], &[&k0]);
    let meta = ok(env.sample(0, &refs));
    r.add("record_samples (5 coins, legacy tx)", &meta, size);
    env.warp(20);
    let refs: Vec<&TCoin> = std::iter::once(&c).chain(coins.iter()).collect();
    let i = env.record_samples_ix(&kp_pk(&k0), &refs);
    let size = env.tx_size(&k0, &[i], &[&k0]);
    let meta = ok(env.sample(0, &refs));
    r.add("record_samples (10 coins; needs v0 + ALT for size)", &meta, size);
    env.warp(15);
    env.sample_for(&c, 1_800);
    let meta = ok(env.buyback(&c, &k0, u64::MAX));
    r.add("execute_buyback (DAMM v2, full 30-min median)", &meta, 0);

    // ── tickets & claims on a full queue (worst cases) ──
    let mut w = World::new();
    let u = w.user();
    let tq = w.ticket(&kp_pk(&u), 2_000 * M);
    let tpay = w.ticket(&kp_pk(&u), 1_000 * M);
    let tfor = w.ticket(&kp_pk(&u), 1_000 * M);
    let tesc = w.ticket(&kp_pk(&u), 1_000 * M);
    w.ready();
    fill_queue(&mut w, fumpad::CLAIM_QUEUE_CAPACITY - 2, 1_000_000_000 * M);
    let meta = ok(w.claim(&u, &tpay));
    r.add("claim (paid now, behind 1022 non-fitting entries)", &meta, 0);
    // Queued at the FRONT of a nearly full queue (older than every fabricated entry? no: fabricated are older) →
    // inserted at the end; then the front insert case: a ticket older than all entries.
    let meta = ok(w.claim_for(1, &tfor));
    r.add("claim_for (paid now, scan 1022)", &meta, 0);
    let pool = w.pool();
    w.set_pool(1_000 * M);
    let meta = ok(w.claim(&u, &tq));
    r.add("claim (queued at the end, queue → 1023)", &meta, 0);
    w.set_pool(pool);
    // attest_rebuy on the queued ticket: queue entry update over a 1023 queue.
    let tk = w.t(&tq);
    let rb = rebuy_record(&tk, tq, 10 * M, tk.sell_ts + 60);
    let meta = ok(w.env.attest_rebuy(&rb, &[0, 1], true));
    r.add("attest_rebuy (queued ticket, 1023-entry queue)", &meta, 0);
    w.remove_ata(&kp_pk(&u));
    let meta = ok(w.claim_for(1, &tesc));
    r.add("claim_for (escrowed, scan 1022)", &meta, 0);
    let p = w.env.payer.insecure_clone();
    let i = w.process_ix(&kp_pk(&p), 13, &[]);
    let meta = ok(w.env.send_as(&p, &[compute_budget_ix(1_400_000), i], &[&p]));
    r.add("process_queue (walk 1023, none fit)", &meta, 0);

    // process_queue paying 13 entries / escrowing 13 on a full queue: 13 real queued tickets at the front.
    let mut w = World::new();
    let users: Vec<Keypair> = (0..7).map(|_| w.user()).collect();
    let mut tickets = vec![];
    for (i, u) in users.iter().enumerate() {
        for j in 0..2 {
            if tickets.len() == 13 {
                break;
            }
            let t = w.ticket_at(&kp_pk(u), 2_000 * M, w.low_price(), 3_000 - (i * 2 + j) as i64);
            tickets.push(t);
        }
    }
    w.ready();
    w.set_pool(1_000 * M);
    for (i, t) in tickets.iter().enumerate() {
        ok(w.claim(&users[i / 2], t));
    }
    // Append fabricated newer entries up to capacity (they sort after the real ones).
    let key = w.c.claim_queue();
    let mut acc = w.env.svm.get_account(&addr(&key)).unwrap();
    let base = 8usize;
    let len = u16::from_le_bytes([acc.data[base + 32], acc.data[base + 33]]) as usize;
    for i in len..fumpad::CLAIM_QUEUE_CAPACITY {
        let o = base + 48 + i * 80;
        acc.data[o..o + 32].copy_from_slice(Pubkey::new_unique().as_ref());
        acc.data[o + 32..o + 64].copy_from_slice(Pubkey::new_unique().as_ref());
        acc.data[o + 64..o + 72].copy_from_slice(&(1_000_000_000 * M).to_le_bytes());
        acc.data[o + 72..o + 80].copy_from_slice(&(i64::MAX - 10_000 + i as i64).to_le_bytes());
    }
    acc.data[base + 32..base + 34].copy_from_slice(&(fumpad::CLAIM_QUEUE_CAPACITY as u16).to_le_bytes());
    w.env.svm.set_account(addr(&key), acc).unwrap();
    w.set_pool(1_000_000 * M);
    // Escrow all 13 (missing ATAs) — the most expensive crank.
    for u in &users {
        w.remove_ata(&kp_pk(u));
    }
    let p = w.env.payer.insecure_clone();
    let i = w.process_ix(&kp_pk(&p), 13, &tickets);
    let size = w.env.tx_size(&p, &[compute_budget_ix(1_400_000), i.clone()], &[&p]);
    let meta = ok(w.env.send_as(&p, &[compute_budget_ix(1_400_000), i], &[&p]));
    r.add("process_queue (full 1024 queue, 13 escrowed)", &meta, size);
    let side = w.side_account(&users[0]);
    let meta = ok(w.withdraw_escrow(&users[0], &tickets[0], &side));
    r.add("withdraw_escrow", &meta, 0);
    let meta = ok(w.close_ticket(&tickets[0], true));
    r.add("close_ticket (claimed, full queue passed)", &meta, 0);

    // A paid-crank batch: 13 entries paid directly.
    let mut w = World::new();
    let users: Vec<Keypair> = (0..7).map(|_| w.user()).collect();
    let mut tickets = vec![];
    for (i, u) in users.iter().enumerate() {
        for j in 0..2 {
            if tickets.len() == 13 {
                break;
            }
            tickets.push(w.ticket_at(&kp_pk(u), 2_000 * M, w.low_price(), 3_000 - (i * 2 + j) as i64));
        }
    }
    w.ready();
    w.set_pool(1_000 * M);
    for (i, t) in tickets.iter().enumerate() {
        ok(w.claim(&users[i / 2], t));
    }
    w.set_pool(1_000_000 * M);
    let p = w.env.payer.insecure_clone();
    let i = w.process_ix(&kp_pk(&p), 13, &tickets);
    let meta = ok(w.env.send_as(&p, &[compute_budget_ix(1_400_000), i], &[&p]));
    r.add("process_queue (13 paid)", &meta, 0);

    // Front insert into a 1023-entry queue (every fabricated entry is newer), then a rebuy voiding that front entry.
    let mut w = World::new();
    let u = w.user();
    let tq = w.ticket(&kp_pk(&u), 2_000 * M);
    w.ready();
    let key = w.c.claim_queue();
    let mut acc = w.env.svm.get_account(&addr(&key)).unwrap();
    let n = fumpad::CLAIM_QUEUE_CAPACITY - 1;
    acc.data[8 + 32..8 + 34].copy_from_slice(&(n as u16).to_le_bytes());
    for i in 0..n {
        let o = 8 + 48 + i * 80;
        acc.data[o..o + 32].copy_from_slice(Pubkey::new_unique().as_ref());
        acc.data[o + 32..o + 64].copy_from_slice(Pubkey::new_unique().as_ref());
        acc.data[o + 64..o + 72].copy_from_slice(&(1_000_000_000 * M).to_le_bytes());
        acc.data[o + 72..o + 80].copy_from_slice(&(i64::MAX - 10_000 + i as i64).to_le_bytes());
    }
    w.env.svm.set_account(addr(&key), acc).unwrap();
    w.set_pool(1_000 * M);
    let meta = ok(w.claim(&u, &tq));
    r.add("claim (queued at the FRONT, 1023 entries shifted → full)", &meta, 0);
    let tk = w.t(&tq);
    let rb = rebuy_record(&tk, tq, 10_000 * M, tk.sell_ts + 60);
    let meta = ok(w.env.attest_rebuy(&rb, &[0, 1], true));
    r.add("attest_rebuy (voids the front entry of a full queue)", &meta, 0);

    // void / close_consumed / set_auto_claim / close_position.
    let mut w = World::new();
    let u = w.user();
    let t = w.ticket(&kp_pk(&u), 1_000 * M);
    let consumed = w.t(&t).consumed;
    let rent_payer = w.t(&t).rent_payer;
    let admin = w.env.admin.insecure_clone();
    let v = ix(
        fumpad::accounts::VoidTicket { authority: kp_pk(&admin), global: w.env.global(), ticket: t, position: position_pda(&w.c.mint, &kp_pk(&u)), event_authority: ev_auth(), program: fumpad::ID },
        fumpad::instruction::VoidTicket { reason: 1 },
    );
    let meta = ok(w.env.send(&[v], &[&admin]));
    r.add("void_ticket", &meta, 0);
    let meta = ok(w.close_ticket(&t, false));
    r.add("close_ticket (voided, no queue)", &meta, 0);
    let meta = ok(w.set_auto_claim(&u, false));
    r.add("set_auto_claim", &meta, 0);
    w.env.warp(fumpad::MAX_MAX_ATTEST_AGE_SECS + 1);
    let cc = ix(
        fumpad::accounts::CloseConsumed { caller: kp_pk(&w.env.payer), global: w.env.global(), consumed, rent_payer, ticket: t, event_authority: ev_auth(), program: fumpad::ID },
        fumpad::instruction::CloseConsumed {},
    );
    let meta = ok(w.env.send(&[cc], &[]));
    r.add("close_consumed", &meta, 0);
    let pos = position_pda(&w.c.mint, &kp_pk(&u));
    let i = ix_rem(
        fumpad::accounts::ClosePosition { signer: kp_pk(&u), position: pos, rent_payer, event_authority: ev_auth(), program: fumpad::ID },
        fumpad::instruction::ClosePosition {},
        &[AccountMeta::new_readonly(t, false)],
    );
    let meta = ok(w.env.send_as(&u, &[i], &[&u]));
    r.add("close_position (1 ticket)", &meta, 0);

    let so = std::fs::metadata(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/deploy/fumpad.so")).unwrap().len() as usize;
    println!("\n| Account | bytes | rent (LiteSVM, mainnet features) |\n|---|---|---|");
    for (n, len) in [
        ("fumpad.so program data (+45 header)", so + 45),
        ("Global", 1_044),
        ("Coin", 546),
        ("Position", 315),
        ("Ticket", 276),
        ("Consumed", 82),
        ("ClaimQueue", 81_976),
        ("Observations", 8_280),
    ] {
        println!("| {n} | {len} | {} |", w.env.rent(len));
    }
    println!("\n| Instruction (worst case measured) | CU | tx bytes |\n|---|---|---|");
    for (n, cu, b) in &r.0 {
        let bytes = if *b > 0 { b.to_string() } else { "—".into() };
        println!("| {n} | {cu} | {bytes} |");
        assert!(*cu < 1_400_000, "{n}: {cu}");
    }
}

