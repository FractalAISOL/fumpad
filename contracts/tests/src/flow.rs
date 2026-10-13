//! Lifecycle helpers: launch (real DBC init + top-level creator swap + register_coin in one tx), router and direct
//! trades, curve completion, migration, graduation, post-graduation setup, fee claims, samples, attestations.

use anchor_lang::prelude::Pubkey;
use fumpad::attestation::{build_ed25519_data, RebuyRecord, SellRecord};
use fumpad::external::meteora as m;
use litesvm::types::TransactionResult;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;

use crate::meteora::{self, WSOL};
use crate::*;

pub struct TCoin {
    pub mint: Pubkey,
    pub creator: Keypair,
    pub config: Pubkey,
    pub pool: Pubkey,
}

impl TCoin {
    pub fn coin_pda(&self) -> Pubkey {
        pda(&[fumpad::COIN_SEED, self.mint.as_ref()])
    }
    pub fn damm_pool(&self) -> Pubkey {
        meteora::damm_pool_pda(&meteora::DAMM_MIGRATION_CONFIG, &self.mint)
    }
    pub fn observations(&self) -> Pubkey {
        pda(&[fumpad::OBSERVATIONS_SEED, self.mint.as_ref()])
    }
    pub fn claim_queue(&self) -> Pubkey {
        pda(&[fumpad::CLAIM_QUEUE_SEED, self.mint.as_ref()])
    }
    pub fn base_vault(&self) -> Pubkey {
        meteora::dbc_vault(&self.mint, &self.pool)
    }
    pub fn quote_vault(&self) -> Pubkey {
        meteora::dbc_vault(&WSOL, &self.pool)
    }
}

pub fn position_pda(mint: &Pubkey, wallet: &Pubkey) -> Pubkey {
    pda(&[fumpad::POSITION_SEED, mint.as_ref(), wallet.as_ref()])
}
pub fn ticket_pda(mint: &Pubkey, wallet: &Pubkey, seq: u64) -> Pubkey {
    pda(&[fumpad::TICKET_SEED, mint.as_ref(), wallet.as_ref(), &seq.to_le_bytes()])
}
pub fn escrow_pda(ticket: &Pubkey) -> Pubkey {
    pda(&[fumpad::ESCROW_SEED, ticket.as_ref()])
}
pub fn sell_consumed_pda(signature: &[u8; 64], ix_key: u32) -> Pubkey {
    let h = fumpad::instructions::sell_consumed_seeds_hash(signature);
    pda(&[fumpad::CONSUMED_SEED, &h, &ix_key.to_le_bytes()])
}
pub fn rebuy_consumed_pda(signature: &[u8; 64], ix_key: u32, ticket: &Pubkey) -> Pubkey {
    let h = fumpad::instructions::sell_consumed_seeds_hash(signature);
    pda(&[fumpad::CONSUMED_SEED, &h, &ix_key.to_le_bytes(), ticket.as_ref()])
}

impl Env {
    pub fn coin(&self, c: &TCoin) -> fumpad::state::Coin {
        self.fetch(&c.coin_pda())
    }

    /// Wrap `lamports` into the user's WSOL ATA (creates it).
    pub fn fund_wsol(&mut self, user: &Keypair, lamports: u64) {
        let ixs = meteora::wrap_sol_ixs(&kp_pk(user), lamports);
        ok(self.send_as(user, &ixs, &[user]));
    }

    /// The launch transaction (SPEC v0.7 §2): DBC init (vanity mint co-signs) → creator ATA → creator's top-level
    /// `swap2` (min fee) → `register_coin`. Creator pays (fee payer); `creator_buy` lamports from its WSOL ATA.
    pub fn launch_ixs(&self, config: &Pubkey, creator: &Pubkey, mint: &Pubkey, creator_buy: u64) -> Vec<Instruction> {
        let pool = meteora::dbc_pool_pda(config, mint);
        let mut v = vec![
            meteora::init_pool_ix(config, creator, mint, creator, "FUMPAD Test", "FMBL", "https://fumpad.fun/t.json"),
            meteora::create_ata_idempotent_ix(creator, creator, mint, &TOKEN_2022),
        ];
        if creator_buy > 0 {
            v.push(meteora::dbc_buy_ix(config, mint, creator, creator_buy, 0, 0, true));
        }
        v.push(self.register_coin_ix(config, &pool, creator, mint));
        v
    }

    pub fn register_coin_ix(&self, config: &Pubkey, pool: &Pubkey, creator: &Pubkey, mint: &Pubkey) -> Instruction {
        ix(
            fumpad::accounts::RegisterCoin {
                creator: *creator,
                global: self.global(),
                mint: *mint,
                dbc_config: *config,
                dbc_pool: *pool,
                coin: self.coin_pda(mint),
                reward_pool: self.reward_pool(),
                reward_vault: self.reward_vault(mint),
                token_2022_program: TOKEN_2022,
                associated_token_program: ATA_PROGRAM,
                system_program: SYSTEM,
                launch_signer: None,
                event_authority: ev_auth(),
                program: fumpad::ID,
            },
            fumpad::instruction::RegisterCoin {},
        )
    }

    /// Launch a coin on the allow-listed config with a creator buy of `creator_buy` lamports.
    pub fn launch(&mut self, creator_buy: u64) -> TCoin {
        let config = self.config;
        self.launch_on(config, creator_buy)
    }

    pub fn launch_on(&mut self, config: Pubkey, creator_buy: u64) -> TCoin {
        let creator = self.new_user(1_000);
        let mint = Keypair::new();
        if creator_buy > 0 {
            self.fund_wsol(&creator, creator_buy);
        }
        let ixs = self.launch_ixs(&config, &kp_pk(&creator), &kp_pk(&mint), creator_buy);
        ok(self.send_as(&creator, &ixs, &[&creator, &mint]));
        let mint = kp_pk(&mint);
        TCoin { mint, creator, config, pool: meteora::dbc_pool_pda(&config, &mint) }
    }

    /// Skip the D33 anti-snipe window (8 slots) of a just-launched coin.
    pub fn skip_launch_window(&mut self) {
        self.advance_slots(meteora::SNIPE_PERIODS as u64 + 1);
    }

    // ── router ───────────────────────────────────────────────────────────────
    fn route_ix(&self, c: &TCoin, user: &Pubkey, is_buy: bool, amount: u64, min_out: u64, mode: u8) -> Instruction {
        let coin = self.coin(c);
        let graduated = coin.status == fumpad::state::CoinStatus::Graduated;
        let (program, rem) = if graduated {
            let (input, output) =
                if is_buy { (wsol_ata(user), base_ata(user, &c.mint)) } else { (base_ata(user, &c.mint), wsol_ata(user)) };
            (meteora::DAMM, meteora::damm_swap_accounts(&coin.damm_pool, &c.mint, user, &input, &output))
        } else {
            let (input, output) =
                if is_buy { (wsol_ata(user), base_ata(user, &c.mint)) } else { (base_ata(user, &c.mint), wsol_ata(user)) };
            (meteora::DBC, meteora::dbc_swap_accounts(&c.config, &c.mint, user, &input, &output, false))
        };
        let accounts = fumpad::accounts::Route {
            trader: *user,
            global: self.global(),
            coin: c.coin_pda(),
            venue_program: program,
            event_authority: ev_auth(),
            program: fumpad::ID,
        };
        if is_buy {
            ix_rem(accounts, fumpad::instruction::Buy { amount_in: amount, min_out, mode }, &rem)
        } else {
            ix_rem(accounts, fumpad::instruction::Sell { amount_in: amount, min_out }, &rem)
        }
    }

    pub fn router_buy_ix(&self, c: &TCoin, user: &Pubkey, lamports: u64, min_out: u64, mode: u8) -> Instruction {
        self.route_ix(c, user, true, lamports, min_out, mode)
    }
    pub fn router_sell_ix(&self, c: &TCoin, user: &Pubkey, tokens: u64, min_out: u64) -> Instruction {
        self.route_ix(c, user, false, tokens, min_out, 0)
    }

    /// Router buy (wraps `lamports` first, creates the base ATA).
    pub fn router_buy(&mut self, c: &TCoin, user: &Keypair, lamports: u64) -> TransactionResult {
        self.router_buy_mode(c, user, lamports, 0)
    }

    pub fn router_buy_mode(&mut self, c: &TCoin, user: &Keypair, lamports: u64, mode: u8) -> TransactionResult {
        let u = kp_pk(user);
        let mut ixs = meteora::wrap_sol_ixs(&u, lamports);
        ixs.push(meteora::create_ata_idempotent_ix(&u, &u, &c.mint, &TOKEN_2022));
        ixs.push(self.router_buy_ix(c, &u, lamports, 0, mode));
        self.send_as(user, &ixs, &[user])
    }

    pub fn router_sell(&mut self, c: &TCoin, user: &Keypair, tokens: u64) -> TransactionResult {
        let u = kp_pk(user);
        let ixs = vec![meteora::create_ata_idempotent_ix(&u, &u, &WSOL, &SPL_TOKEN), self.router_sell_ix(c, &u, tokens, 0)];
        self.send_as(user, &ixs, &[user])
    }

    /// Third-party (non-FUMPAD) buy straight on the venue.
    pub fn direct_buy(&mut self, c: &TCoin, user: &Keypair, lamports: u64) -> TransactionResult {
        let u = kp_pk(user);
        let coin = self.coin(c);
        let mut ixs = meteora::wrap_sol_ixs(&u, lamports);
        ixs.push(meteora::create_ata_idempotent_ix(&u, &u, &c.mint, &TOKEN_2022));
        if coin.status == fumpad::state::CoinStatus::Graduated {
            ixs.push(meteora::damm_buy_ix(&coin.damm_pool, &c.mint, &u, lamports, 0));
        } else {
            ixs.push(meteora::dbc_buy_ix(&c.config, &c.mint, &u, lamports, 0, 0, false));
        }
        self.send_as(user, &ixs, &[user])
    }

    pub fn direct_sell(&mut self, c: &TCoin, user: &Keypair, tokens: u64) -> TransactionResult {
        let u = kp_pk(user);
        let coin = self.coin(c);
        let mut ixs = vec![meteora::create_ata_idempotent_ix(&u, &u, &WSOL, &SPL_TOKEN)];
        if coin.status == fumpad::state::CoinStatus::Graduated {
            ixs.push(meteora::damm_sell_ix(&coin.damm_pool, &c.mint, &u, tokens, 0));
        } else {
            ixs.push(meteora::dbc_sell_ix(&c.config, &c.mint, &u, tokens, 0));
        }
        self.send_as(user, &ixs, &[user])
    }

    pub fn base_balance(&self, owner: &Pubkey, mint: &Pubkey) -> u64 {
        self.token_balance(&base_ata(owner, mint))
    }

    pub fn dbc_pool_data(&self, c: &TCoin) -> Vec<u8> {
        self.data(&c.pool)
    }

    pub fn dbc_quote_reserve(&self, c: &TCoin) -> u64 {
        meteora::rd_u64(&self.dbc_pool_data(c), m::DBC_POOL_QUOTE_RESERVE)
    }

    /// Complete the curve with a router PartialFill buy by a fresh whale. Returns the whale.
    pub fn complete_curve(&mut self, c: &TCoin) -> Keypair {
        let whale = self.new_user(200);
        ok(self.router_buy_mode(c, &whale, 100 * SOL, m::SWAP_MODE_PARTIAL_FILL));
        whale
    }

    // ── graduation ───────────────────────────────────────────────────────────
    pub fn migrate_pool_ix(&self, c: &TCoin, caller: &Pubkey, nft_mint: &Pubkey) -> Instruction {
        ix_rem(
            fumpad::accounts::MigratePool {
                caller: *caller,
                global: self.global(),
                coin: c.coin_pda(),
                dbc_program: meteora::DBC,
                event_authority: ev_auth(),
                program: fumpad::ID,
            },
            fumpad::instruction::MigratePool {},
            &meteora::migration_accounts(&c.config, &c.mint, nft_mint, caller),
        )
    }

    /// `migrate_pool` by `caller` (fresh NFT mint keypair). Returns the NFT mint.
    pub fn migrate(&mut self, c: &TCoin, caller: &Keypair) -> (TransactionResult, Pubkey) {
        let nft = Keypair::new();
        let i = self.migrate_pool_ix(c, &kp_pk(caller), &kp_pk(&nft));
        let r = self.send_as(caller, &[compute_budget_ix(1_000_000), i], &[caller, &nft]);
        (r, kp_pk(&nft))
    }

    pub fn graduate_ix(&self, c: &TCoin, caller: &Pubkey, nft_mint: &Pubkey, migrator: &Pubkey) -> Instruction {
        ix(
            fumpad::accounts::Graduate {
                caller: *caller,
                global: self.global(),
                coin: c.coin_pda(),
                mint: c.mint,
                dbc_config: c.config,
                dbc_pool: c.pool,
                dbc_quote_vault: c.quote_vault(),
                dbc_base_vault: c.base_vault(),
                damm_config: meteora::DAMM_MIGRATION_CONFIG,
                damm_pool: c.damm_pool(),
                damm_position: meteora::damm_position(nft_mint),
                position_nft_account: meteora::damm_position_nft_account(nft_mint),
                fee_claimer: self.fee_claimer(),
                fee_wsol: self.fee_wsol(),
                reward_pool: self.reward_pool(),
                reward_vault: self.reward_vault(&c.mint),
                wsol_mint: WSOL,
                migrator: *migrator,
                observations: c.observations(),
                claim_queue: c.claim_queue(),
                token_program: SPL_TOKEN,
                token_2022_program: TOKEN_2022,
                system_program: SYSTEM,
                dbc_pool_authority: m::DBC_POOL_AUTHORITY,
                dbc_event_authority: m::DBC_EVENT_AUTHORITY,
                dbc_program: meteora::DBC,
                event_authority: ev_auth(),
                program: fumpad::ID,
            },
            fumpad::instruction::Graduate {},
        )
    }

    pub fn graduate(&mut self, c: &TCoin, caller: &Keypair, nft_mint: &Pubkey) -> TransactionResult {
        let coin = self.coin(c);
        let migrator = if coin.migrator == Pubkey::default() { kp_pk(caller) } else { coin.migrator };
        let i = self.graduate_ix(c, &kp_pk(caller), nft_mint, &migrator);
        self.send_as(caller, &[compute_budget_ix(400_000), i], &[caller])
    }

    /// init_observations + 9 × init_claim_queue (one tx each, keeper pays only shortfalls).
    pub fn post_grad_setup(&mut self, c: &TCoin, payer: &Keypair) {
        let p = kp_pk(payer);
        let obs = ix(
            fumpad::accounts::InitObservations { payer: p, coin: c.coin_pda(), observations: c.observations(), system_program: SYSTEM },
            fumpad::instruction::InitObservations {},
        );
        ok(self.send_as(payer, &[obs], &[payer]));
        let q = ix(
            fumpad::accounts::InitClaimQueue { payer: p, coin: c.coin_pda(), claim_queue: c.claim_queue(), system_program: SYSTEM },
            fumpad::instruction::InitClaimQueue {},
        );
        let qs: Vec<Instruction> = (0..fumpad::instructions::CLAIM_QUEUE_INIT_CALLS).map(|_| q.clone()).collect();
        ok(self.send_as(payer, &qs, &[payer]));
    }

    /// Complete → migrate (keeper 0) → graduate → setup. Returns the NFT mint.
    pub fn graduate_coin(&mut self, c: &TCoin) -> Pubkey {
        if self.coin(c).status == fumpad::state::CoinStatus::Curve
            && meteora::rd_u64(&self.dbc_pool_data(c), m::DBC_POOL_QUOTE_RESERVE) < meteora::MAINNET_THRESHOLD
        {
            self.complete_curve(c);
        }
        let k = self.keepers[0].insecure_clone();
        let (r, nft) = self.migrate(c, &k);
        ok(r);
        ok(self.graduate(c, &k, &nft));
        self.post_grad_setup(c, &k);
        nft
    }

    // ── fees ─────────────────────────────────────────────────────────────────
    pub fn claim_fees_ix(&self, c: &TCoin, caller: &Pubkey) -> Instruction {
        ix(
            fumpad::accounts::ClaimFees {
                caller: *caller,
                global: self.global(),
                coin: c.coin_pda(),
                mint: c.mint,
                dbc_config: c.config,
                dbc_pool: c.pool,
                dbc_base_vault: c.base_vault(),
                dbc_quote_vault: c.quote_vault(),
                fee_claimer: self.fee_claimer(),
                fee_wsol: self.fee_wsol(),
                reward_vault: self.reward_vault(&c.mint),
                wsol_mint: WSOL,
                token_program: SPL_TOKEN,
                token_2022_program: TOKEN_2022,
                system_program: SYSTEM,
                dbc_pool_authority: m::DBC_POOL_AUTHORITY,
                dbc_event_authority: m::DBC_EVENT_AUTHORITY,
                dbc_program: meteora::DBC,
                event_authority: ev_auth(),
                program: fumpad::ID,
            },
            fumpad::instruction::ClaimFees {},
        )
    }

    pub fn claim_fees(&mut self, c: &TCoin) -> TransactionResult {
        let k = self.keepers[0].insecure_clone();
        let i = self.claim_fees_ix(c, &kp_pk(&k));
        self.send_as(&k, &[i], &[&k])
    }

    pub fn claim_lp_fees_ix(&self, c: &TCoin, caller: &Pubkey, nft_mint: &Pubkey) -> Instruction {
        let coin = self.coin(c);
        ix(
            fumpad::accounts::ClaimLpFees {
                caller: *caller,
                global: self.global(),
                coin: c.coin_pda(),
                mint: c.mint,
                damm_pool: coin.damm_pool,
                damm_position: meteora::damm_position(nft_mint),
                position_nft_account: meteora::damm_position_nft_account(nft_mint),
                damm_token_a_vault: meteora::damm_vault(&c.mint, &coin.damm_pool),
                damm_token_b_vault: meteora::damm_vault(&WSOL, &coin.damm_pool),
                fee_claimer: self.fee_claimer(),
                fee_wsol: self.fee_wsol(),
                reward_vault: self.reward_vault(&c.mint),
                wsol_mint: WSOL,
                token_program: SPL_TOKEN,
                token_2022_program: TOKEN_2022,
                system_program: SYSTEM,
                damm_pool_authority: m::DAMM_POOL_AUTHORITY,
                damm_event_authority: m::DAMM_EVENT_AUTHORITY,
                damm_program: meteora::DAMM,
                event_authority: ev_auth(),
                program: fumpad::ID,
            },
            fumpad::instruction::ClaimLpFees {},
        )
    }

    pub fn claim_lp_fees(&mut self, c: &TCoin, nft_mint: &Pubkey) -> TransactionResult {
        let k = self.keepers[0].insecure_clone();
        let i = self.claim_lp_fees_ix(c, &kp_pk(&k), nft_mint);
        self.send_as(&k, &[i], &[&k])
    }

    /// Coin lamport invariant (state/coin.rs).
    #[track_caller]
    pub fn assert_coin_invariant(&self, c: &TCoin) {
        let coin = self.coin(c);
        let lamports = self.lamports(&c.coin_pda());
        let want = self.rent(8 + <fumpad::state::Coin as anchor_lang::Space>::INIT_SPACE)
            + coin.creator_fees_unclaimed
            + coin.platform_fees_unclaimed
            + coin.buyback_lamports;
        assert_eq!(lamports, want, "Coin lamport invariant");
    }

    // ── oracle ───────────────────────────────────────────────────────────────
    pub fn record_samples_ix(&self, sampler: &Pubkey, coins: &[&TCoin]) -> Instruction {
        let mut rem = vec![];
        for c in coins {
            let coin = self.coin(c);
            let pool = if coin.status == fumpad::state::CoinStatus::Graduated { coin.damm_pool } else { c.pool };
            rem.extend([rw(c.coin_pda()), ro(pool), rw(c.observations())]);
        }
        ix_rem(
            fumpad::accounts::RecordSamples {
                sampler: *sampler,
                global: self.global(),
                instructions: IX_SYSVAR,
                event_authority: ev_auth(),
                program: fumpad::ID,
            },
            fumpad::instruction::RecordSamples {},
            &rem,
        )
    }

    pub fn sample(&mut self, keeper: usize, coins: &[&TCoin]) -> TransactionResult {
        let k = self.keepers[keeper].insecure_clone();
        let i = self.record_samples_ix(&kp_pk(&k), coins);
        self.send_as(&k, &[i], &[&k])
    }

    /// Keeper samples every 15 s for `secs` (claim/buyback median coverage).
    pub fn sample_for(&mut self, c: &TCoin, secs: i64) {
        let mut t = 0;
        while t < secs {
            ok(self.sample(0, &[c]));
            self.warp(15);
            t += 15;
        }
        ok(self.sample(0, &[c]));
    }

    // ── attestations ─────────────────────────────────────────────────────────
    /// Ed25519 precompile instruction for `message` signed by `signers`.
    pub fn ed25519_ix(message: &[u8], signers: &[&Keypair]) -> Instruction {
        let sigs: Vec<([u8; 32], [u8; 64])> = signers
            .iter()
            .map(|k| (kp_pk(k).to_bytes(), <[u8; 64]>::try_from(k.sign_message(message).as_ref()).unwrap()))
            .collect();
        Instruction {
            program_id: addr(&fumpad::ED25519_PROGRAM_ID),
            accounts: vec![],
            data: build_ed25519_data(&sigs, message),
        }
    }

    pub fn attest_sell_ix(&self, submitter: &Pubkey, r: &SellRecord) -> Instruction {
        let pos = position_pda(&r.mint, &r.trader);
        let seq = self.account(&pos).map(|_| self.fetch::<fumpad::state::Position>(&pos).next_ticket_seq).unwrap_or(0);
        ix(
            fumpad::accounts::AttestSell {
                keeper: *submitter,
                global: self.global(),
                coin: pda(&[fumpad::COIN_SEED, r.mint.as_ref()]),
                position: pos,
                ticket: ticket_pda(&r.mint, &r.trader, seq),
                consumed: sell_consumed_pda(&r.signature, r.ix_key),
                instructions: IX_SYSVAR,
                system_program: SYSTEM,
                event_authority: ev_auth(),
                program: fumpad::ID,
            },
            fumpad::instruction::AttestSell {},
        )
    }

    /// Attest `r` signed by keepers `by` (indices), submitted by keeper `by[0]`.
    pub fn attest_sell(&mut self, r: &SellRecord, by: &[usize]) -> TransactionResult {
        let signers: Vec<Keypair> = by.iter().map(|&i| self.keepers[i].insecure_clone()).collect();
        let refs: Vec<&Keypair> = signers.iter().collect();
        let sub = signers[0].insecure_clone();
        let ixs = vec![Self::ed25519_ix(&r.encode(), &refs), self.attest_sell_ix(&kp_pk(&sub), r)];
        self.send_as(&sub, &ixs, &[&sub])
    }

    pub fn attest_rebuy_ix(&self, submitter: &Pubkey, r: &RebuyRecord, queued: bool) -> Instruction {
        ix(
            fumpad::accounts::AttestRebuy {
                keeper: *submitter,
                global: self.global(),
                coin: pda(&[fumpad::COIN_SEED, r.mint.as_ref()]),
                ticket: r.ticket,
                position: position_pda(&r.mint, &r.owner),
                consumed: rebuy_consumed_pda(&r.signature, r.ix_key, &r.ticket),
                claim_queue: if queued { Some(pda(&[fumpad::CLAIM_QUEUE_SEED, r.mint.as_ref()])) } else { None },
                instructions: IX_SYSVAR,
                system_program: SYSTEM,
                event_authority: ev_auth(),
                program: fumpad::ID,
            },
            fumpad::instruction::AttestRebuy {},
        )
    }

    /// `void_ticket(reason, reopen)` signed by `authority` (accounts read from the ticket).
    pub fn void_ticket_ix(&self, authority: &Pubkey, ticket: &Pubkey, reason: u8, reopen: bool) -> Instruction {
        let t: fumpad::state::Ticket = self.fetch(ticket);
        ix(
            fumpad::accounts::VoidTicket {
                authority: *authority,
                global: self.global(),
                coin: self.coin_pda(&t.mint),
                mint: t.mint,
                ticket: *ticket,
                position: position_pda(&t.mint, &t.owner),
                consumed: t.consumed,
                event_authority: ev_auth(),
                program: fumpad::ID,
            },
            fumpad::instruction::VoidTicket { reason, reopen },
        )
    }

    pub fn attest_rebuy(&mut self, r: &RebuyRecord, by: &[usize], queued: bool) -> TransactionResult {
        let signers: Vec<Keypair> = by.iter().map(|&i| self.keepers[i].insecure_clone()).collect();
        let refs: Vec<&Keypair> = signers.iter().collect();
        let sub = signers[0].insecure_clone();
        let ixs = vec![Self::ed25519_ix(&r.encode(), &refs), self.attest_rebuy_ix(&kp_pk(&sub), r, queued)];
        self.send_as(&sub, &ixs, &[&sub])
    }

    /// A valid sell record for `trader` on `c` (current pool, now − 30 s), `tokens` at `price_q64`.
    pub fn sell_record(&self, c: &TCoin, trader: &Pubkey, tokens: u64, price_q64: u128) -> SellRecord {
        let coin = self.coin(c);
        let graduated = coin.status == fumpad::state::CoinStatus::Graduated;
        let now = self.now();
        let mut sig = [0u8; 64];
        sig[..32].copy_from_slice(Pubkey::new_unique().as_ref());
        SellRecord {
            program_id: fumpad::ID,
            cluster_tag: CLUSTER_TAG,
            mint: c.mint,
            pool: if graduated { coin.damm_pool } else { c.pool },
            venue: if graduated { 1 } else { 0 },
            signature: sig,
            ix_key: (1 << 16) | 1,
            trader: *trader,
            base_amount: tokens,
            quote_gross: fumpad::math::lamports_for(tokens, price_q64).unwrap_or(1).max(1),
            ticket_tokens: tokens,
            ticket_price_q64: price_q64,
            usd_cents: 10_000,
            pyth_publish_time: now - 31,
            slot: self.slot(),
            block_time: now - 30,
        }
    }
}

pub fn rebuy_record(t: &fumpad::state::Ticket, ticket: Pubkey, debit: u64, block_time: i64) -> RebuyRecord {
    let mut sig = [0u8; 64];
    sig[..32].copy_from_slice(Pubkey::new_unique().as_ref());
    RebuyRecord {
        program_id: fumpad::ID,
        cluster_tag: CLUSTER_TAG,
        mint: t.mint,
        ticket,
        owner: t.owner,
        signature: sig,
        ix_key: 1,
        debit_tokens: debit,
        slot: 1,
        block_time,
    }
}

/// Q64 price from lamports per whole token (1e6 base units).
pub fn q64_per_token(lamports_per_token: f64) -> u128 {
    (lamports_per_token / 1e6 * 18_446_744_073_709_551_616.0) as u128
}

/// Q64 price from a Meteora sqrt price.
pub fn sqrt_to_q64(sqrt: u128) -> u128 {
    fumpad::math::price_q64_from_sqrt(sqrt).unwrap()
}
