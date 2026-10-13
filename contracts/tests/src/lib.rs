//! Shared LiteSVM harness for the FUMPAD v0.7 integration tests: fumpad + the MAINNET Meteora DBC 0.2.1 and
//! DAMM v2 0.2.4 binaries + the mainnet DAMM v2 migration config (`fixtures/`, dumped read-only from mainnet).
//!
//! Type bridge: Anchor 1.2 speaks solana v3 types (`anchor_lang::prelude::Pubkey`), LiteSVM 0.18 speaks v4
//! (`solana_address::Address`). Convert only through `addr()` / `pk()` / the instruction builders here.

use anchor_lang::{prelude::Pubkey, AccountDeserialize, InstructionData, ToAccountMetas};
use litesvm::{
    types::{FailedTransactionMetadata, TransactionMetadata, TransactionResult},
    LiteSVM,
};
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

pub use fumpad;
pub mod meteora;

pub const SOL: u64 = 1_000_000_000;
pub const SPL_TOKEN: Pubkey = anchor_lang::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022: Pubkey = anchor_lang::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ATA_PROGRAM: Pubkey = anchor_lang::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const SYSTEM: Pubkey = anchor_lang::pubkey!("11111111111111111111111111111111");
pub const IX_SYSVAR: Pubkey = anchor_lang::pubkey!("Sysvar1nstructions1111111111111111111111111");
pub const COMPUTE_BUDGET: Pubkey = anchor_lang::pubkey!("ComputeBudget111111111111111111111111111111");
/// `cluster_tag` used by every test Global (2 = localnet/test).
pub const CLUSTER_TAG: u8 = 2;

pub fn fixtures_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}

pub fn addr(p: &Pubkey) -> Address {
    Address::new_from_array(p.to_bytes())
}

pub fn pk(a: &Address) -> Pubkey {
    Pubkey::new_from_array(a.to_bytes())
}

pub fn kp_pk(k: &Keypair) -> Pubkey {
    pk(&k.pubkey())
}

pub fn ev_auth() -> Pubkey {
    fumpad::EVENT_AUTHORITY_AND_BUMP.0
}

pub fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &fumpad::ID).0
}

pub fn ata(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), token_program.as_ref(), mint.as_ref()], &ATA_PROGRAM).0
}

pub fn wsol_ata(owner: &Pubkey) -> Pubkey {
    ata(owner, &fumpad::WSOL_MINT, &SPL_TOKEN)
}

pub fn base_ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    ata(owner, mint, &TOKEN_2022)
}

/// A v4 instruction for an arbitrary program from v3 metas.
pub fn raw_ix(program: &Pubkey, metas: &[anchor_lang::prelude::AccountMeta], data: Vec<u8>) -> Instruction {
    Instruction {
        program_id: addr(program),
        accounts: metas
            .iter()
            .map(|m| AccountMeta { pubkey: addr(&m.pubkey), is_signer: m.is_signer, is_writable: m.is_writable })
            .collect(),
        data,
    }
}

/// A fumpad instruction from Anchor's generated account/arg types (+ remaining accounts).
pub fn ix(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    ix_rem(accounts, data, &[])
}

pub fn ix_rem(
    accounts: impl ToAccountMetas,
    data: impl InstructionData,
    remaining: &[anchor_lang::prelude::AccountMeta],
) -> Instruction {
    let mut metas = accounts.to_account_metas(None);
    metas.extend_from_slice(remaining);
    raw_ix(&fumpad::ID, &metas, data.data())
}

pub fn ro(k: Pubkey) -> anchor_lang::prelude::AccountMeta {
    anchor_lang::prelude::AccountMeta::new_readonly(k, false)
}
pub fn rw(k: Pubkey) -> anchor_lang::prelude::AccountMeta {
    anchor_lang::prelude::AccountMeta::new(k, false)
}
pub fn sg(k: Pubkey) -> anchor_lang::prelude::AccountMeta {
    anchor_lang::prelude::AccountMeta::new_readonly(k, true)
}
pub fn sgw(k: Pubkey) -> anchor_lang::prelude::AccountMeta {
    anchor_lang::prelude::AccountMeta::new(k, true)
}

pub fn compute_budget_ix(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction { program_id: addr(&COMPUTE_BUDGET), accounts: vec![], data }
}

pub struct Env {
    pub svm: LiteSVM,
    /// Fee payer + fumpad upgrade authority.
    pub payer: Keypair,
    pub admin: Keypair,
    pub treasury: Keypair,
    pub keepers: [Keypair; 3],
    /// The allow-listed FUMPAD DBC config (mainnet parameters).
    pub config: Pubkey,
}

/// Anchor custom error code of a failed transaction, if any.
pub fn err_code(r: &TransactionResult) -> Option<u32> {
    r.as_ref().err().and_then(custom_code)
}

fn custom_code(e: &FailedTransactionMetadata) -> Option<u32> {
    let s = format!("{:?}", e.err);
    let i = s.find("Custom(")?;
    s[i + 7..].split(')').next()?.parse().ok()
}

pub fn fumpad_err(e: fumpad::error::FumpadError) -> u32 {
    6000 + e as u32
}

/// Assert a transaction failed with a given fumpad error.
#[track_caller]
pub fn assert_fumpad_err(r: TransactionResult, e: fumpad::error::FumpadError) {
    match r {
        Ok(_) => panic!("expected {e:?}, transaction succeeded"),
        Err(f) => {
            let code = custom_code(&f);
            assert_eq!(code, Some(fumpad_err(e)), "expected {e:?} ({}), got {:?}\n{}", fumpad_err(e), f.err, f.meta.logs.join("\n"));
        }
    }
}

#[track_caller]
pub fn ok(r: TransactionResult) -> TransactionMetadata {
    match r {
        Ok(m) => m,
        Err(f) => panic!("transaction failed: {:?}\n{}", f.err, f.meta.logs.join("\n")),
    }
}

impl Env {
    /// Fresh SVM: fumpad + mainnet DBC/DAMM v2, Global initialized (default params, cluster tag 2), 3 keepers past
    /// their 6h attestation freeze, and the mainnet FUMPAD DBC config created and allow-listed (48h timelock).
    pub fn new() -> Self {
        Self::with_params(fumpad::state::Params::default())
    }

    pub fn with_params(params: fumpad::state::Params) -> Self {
        let mut env = Self::bare(params);
        let config = env.create_dbc_config(&meteora::mainnet_config_params());
        env.allow_config(config);
        env.config = config;
        env
    }

    /// Global + keepers only (no DBC config).
    pub fn bare(params: fumpad::state::Params) -> Self {
        let mut svm = LiteSVM::new();
        let payer = Keypair::new();
        let admin = Keypair::new();
        let treasury = Keypair::new();
        let keepers = [Keypair::new(), Keypair::new(), Keypair::new()];
        for k in [&payer, &admin, &treasury].into_iter().chain(keepers.iter()) {
            svm.airdrop(&k.pubkey(), 10_000 * SOL).unwrap();
        }
        let so = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/deploy/fumpad.so");
        svm.add_program_from_file(addr(&fumpad::ID), &so).expect("run `anchor build` first");
        set_upgrade_authority(&mut svm, &fumpad::ID, &kp_pk(&payer));
        svm.add_program_from_file(addr(&meteora::DBC), fixtures_dir().join("dbc_mainnet.so")).unwrap();
        svm.add_program_from_file(addr(&meteora::DAMM), fixtures_dir().join("damm_v2_mainnet.so")).unwrap();
        load_account_fixture(&mut svm, "damm_v2_migration_config_mainnet.json");
        load_account_fixture(&mut svm, "wsol_mint.json");
        // DBC fronts DAMM v2 rent from its pool authority during migration ("flash rent"); mainnet keeps it funded.
        svm.airdrop(&addr(&fumpad::external::meteora::DBC_POOL_AUTHORITY), 100 * SOL).unwrap();

        let mut env = Env { svm, payer, admin, treasury, keepers, config: Pubkey::default() };
        let program_data =
            Pubkey::find_program_address(&[fumpad::ID.as_ref()], &anchor_lang::solana_program::bpf_loader_upgradeable::ID).0;
        let init = ix(
            fumpad::accounts::InitializeGlobal {
                payer: kp_pk(&env.payer),
                global: env.global(),
                program: fumpad::ID,
                program_data,
                system_program: SYSTEM,
                event_authority: ev_auth(),
            },
            fumpad::instruction::InitializeGlobal {
                admin: kp_pk(&env.admin),
                platform_treasury: kp_pk(&env.treasury),
                cluster_tag: CLUSTER_TAG,
                params,
            },
        );
        ok(env.send(&[init], &[]));
        let keepers = [kp_pk(&env.keepers[0]), kp_pk(&env.keepers[1]), kp_pk(&env.keepers[2])];
        ok(env.set_keepers(keepers));
        env.warp(fumpad::KEEPER_ATTEST_FREEZE_SECS);
        env
    }

    pub fn set_keepers(&mut self, keepers: [Pubkey; 3]) -> TransactionResult {
        let i = ix(
            fumpad::accounts::AdminOnly { admin: kp_pk(&self.admin), global: self.global(), event_authority: ev_auth(), program: fumpad::ID },
            fumpad::instruction::SetKeepers { keepers },
        );
        let admin = self.admin.insecure_clone();
        self.send(&[i], &[&admin])
    }

    /// Create a DBC config whose fee claimer / leftover receiver are fumpad's PDAs.
    pub fn create_dbc_config(&mut self, params: &meteora::ConfigParameters) -> Pubkey {
        let config = Keypair::new();
        let i = meteora::create_config_ix(
            &kp_pk(&config),
            &self.fee_claimer(),
            &self.reward_pool(),
            &kp_pk(&self.payer),
            params,
        );
        ok(self.send(&[i], &[&config]));
        kp_pk(&config)
    }

    pub fn queue_config(&mut self, config: Pubkey, add: bool) -> TransactionResult {
        let i = ix(
            fumpad::accounts::QueueConfig {
                admin: kp_pk(&self.admin),
                global: self.global(),
                dbc_config: config,
                event_authority: ev_auth(),
                program: fumpad::ID,
            },
            fumpad::instruction::QueueConfig { config, add },
        );
        let admin = self.admin.insecure_clone();
        self.send(&[i], &[&admin])
    }

    pub fn execute_config(&mut self, config: Pubkey) -> TransactionResult {
        let i = ix(
            fumpad::accounts::ExecuteConfig { caller: kp_pk(&self.payer), global: self.global(), dbc_config: config, event_authority: ev_auth(), program: fumpad::ID },
            fumpad::instruction::ExecuteConfig {},
        );
        self.send(&[i], &[])
    }

    /// queue_config(add) → 48h → execute_config.
    pub fn allow_config(&mut self, config: Pubkey) {
        ok(self.queue_config(config, true));
        self.warp(fumpad::CONFIG_TIMELOCK_SECS);
        ok(self.execute_config(config));
    }

    pub fn queue_params(&mut self, params: fumpad::state::Params) -> TransactionResult {
        let i = ix(
            fumpad::accounts::AdminOnly { admin: kp_pk(&self.admin), global: self.global(), event_authority: ev_auth(), program: fumpad::ID },
            fumpad::instruction::QueueParams { params },
        );
        let admin = self.admin.insecure_clone();
        self.send(&[i], &[&admin])
    }

    pub fn execute_params(&mut self) -> TransactionResult {
        let i = ix(
            fumpad::accounts::PermissionlessGlobal { caller: kp_pk(&self.payer), global: self.global(), event_authority: ev_auth(), program: fumpad::ID },
            fumpad::instruction::ExecuteParams {},
        );
        self.send(&[i], &[])
    }

    pub fn set_params_timelocked(&mut self, params: fumpad::state::Params) {
        ok(self.queue_params(params));
        self.warp(fumpad::PARAMS_TIMELOCK_SECS);
        ok(self.execute_params());
    }

    pub fn set_pause(&mut self, signer: &Keypair, paused: u8) -> TransactionResult {
        let i = ix(
            fumpad::accounts::GuardianOrAdmin { authority: kp_pk(signer), global: self.global(), event_authority: ev_auth(), program: fumpad::ID },
            fumpad::instruction::SetPause { paused },
        );
        let s = signer.insecure_clone();
        self.send(&[i], &[&s])
    }

    pub fn global(&self) -> Pubkey {
        pda(&[fumpad::GLOBAL_SEED])
    }
    pub fn fee_claimer(&self) -> Pubkey {
        pda(&[fumpad::FEE_CLAIMER_SEED])
    }
    pub fn reward_pool(&self) -> Pubkey {
        pda(&[fumpad::REWARD_POOL_SEED])
    }
    pub fn buyback_pda(&self) -> Pubkey {
        pda(&[fumpad::BUYBACK_SEED])
    }
    pub fn fee_wsol(&self) -> Pubkey {
        pda(&[fumpad::FEE_WSOL_SEED])
    }
    pub fn coin_pda(&self, mint: &Pubkey) -> Pubkey {
        pda(&[fumpad::COIN_SEED, mint.as_ref()])
    }
    pub fn reward_vault(&self, mint: &Pubkey) -> Pubkey {
        base_ata(&self.reward_pool(), mint)
    }

    /// Send with `payer` as fee payer plus extra signers.
    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TransactionResult {
        let mut all: Vec<&Keypair> = vec![&self.payer];
        all.extend_from_slice(signers);
        let msg = Message::new(ixs, Some(&self.payer.pubkey()));
        let tx = Transaction::new(&all, msg, self.svm.latest_blockhash());
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        res
    }

    /// Send with `fee_payer` (must be in `signers`).
    pub fn send_as(&mut self, fee_payer: &Keypair, ixs: &[Instruction], signers: &[&Keypair]) -> TransactionResult {
        let msg = Message::new(ixs, Some(&fee_payer.pubkey()));
        let tx = Transaction::new(signers, msg, self.svm.latest_blockhash());
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        res
    }

    /// Serialized size of a legacy transaction carrying `ixs` (fee payer `payer` + signers).
    pub fn tx_size(&self, payer: &Keypair, ixs: &[Instruction], signers: &[&Keypair]) -> usize {
        let msg = Message::new(ixs, Some(&payer.pubkey()));
        let tx = Transaction::new(signers, msg, self.svm.latest_blockhash());
        bincode_len(&tx)
    }

    pub fn account(&self, key: &Pubkey) -> Option<Account> {
        self.svm.get_account(&addr(key)).filter(|a| a.lamports > 0 || !a.data.is_empty())
    }

    pub fn exists(&self, key: &Pubkey) -> bool {
        self.account(key).is_some()
    }

    pub fn data(&self, key: &Pubkey) -> Vec<u8> {
        self.account(key).unwrap_or_else(|| panic!("account {key} missing")).data
    }

    pub fn fetch<T: AccountDeserialize>(&self, key: &Pubkey) -> T {
        let acc = self.account(key).unwrap_or_else(|| panic!("account {key} missing"));
        T::try_deserialize(&mut acc.data.as_slice()).expect("deserialize")
    }

    /// Zero-copy accounts: skip the 8-byte discriminator and read.
    pub fn fetch_zc<T: bytemuck::Pod>(&self, key: &Pubkey) -> T {
        let d = self.data(key);
        *bytemuck::from_bytes(&d[8..8 + std::mem::size_of::<T>()])
    }

    pub fn lamports(&self, key: &Pubkey) -> u64 {
        self.svm.get_account(&addr(key)).map(|a| a.lamports).unwrap_or(0)
    }

    pub fn token_balance(&self, key: &Pubkey) -> u64 {
        self.account(key).map(|a| u64::from_le_bytes(a.data[64..72].try_into().unwrap())).unwrap_or(0)
    }

    pub fn rent(&self, len: usize) -> u64 {
        self.svm.minimum_balance_for_rent_exemption(len)
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<solana_clock::Clock>().unix_timestamp
    }

    pub fn slot(&self) -> u64 {
        self.svm.get_sysvar::<solana_clock::Clock>().slot
    }

    /// Advance the clock by `secs` (and slots at 2.5 per second).
    pub fn warp(&mut self, secs: i64) {
        let mut c = self.svm.get_sysvar::<solana_clock::Clock>();
        c.unix_timestamp += secs;
        c.slot += (secs.max(0) as u64) * 5 / 2;
        self.svm.set_sysvar(&c);
    }

    /// Advance the slot only.
    pub fn advance_slots(&mut self, n: u64) {
        let mut c = self.svm.get_sysvar::<solana_clock::Clock>();
        c.slot += n;
        self.svm.set_sysvar(&c);
    }

    pub fn new_user(&mut self, sol: u64) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), sol * SOL).unwrap();
        k
    }
}

/// Legacy transaction wire size (signatures + message), computed without a bincode dependency.
fn bincode_len(tx: &Transaction) -> usize {
    fn short_vec(n: usize) -> usize {
        if n < 0x80 {
            1
        } else if n < 0x4000 {
            2
        } else {
            3
        }
    }
    let m = &tx.message;
    let mut len = short_vec(tx.signatures.len()) + 64 * tx.signatures.len();
    len += 3 + short_vec(m.account_keys.len()) + 32 * m.account_keys.len() + 32;
    len += short_vec(m.instructions.len());
    for i in &m.instructions {
        len += 1 + short_vec(i.accounts.len()) + i.accounts.len() + short_vec(i.data.len()) + i.data.len();
    }
    len
}

fn set_upgrade_authority(svm: &mut LiteSVM, program: &Pubkey, authority: &Pubkey) {
    let loader = anchor_lang::solana_program::bpf_loader_upgradeable::ID;
    let pd = Pubkey::find_program_address(&[program.as_ref()], &loader).0;
    let mut acc = svm.get_account(&addr(&pd)).expect("programdata");
    // UpgradeableLoaderState::ProgramData = u32 tag | u64 slot | Option<Pubkey>
    acc.data[12] = 1;
    acc.data[13..45].copy_from_slice(authority.as_ref());
    svm.set_account(addr(&pd), acc).unwrap();
}

/// Load an account dumped with `solana account <addr> --output json`.
pub fn load_account_fixture(svm: &mut LiteSVM, file: &str) {
    use base64::Engine;
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(fixtures_dir().join(file)).unwrap()).unwrap();
    let key: Address = v["pubkey"].as_str().unwrap().parse().unwrap();
    let a = &v["account"];
    let data = base64::engine::general_purpose::STANDARD.decode(a["data"][0].as_str().unwrap()).unwrap();
    svm.set_account(
        key,
        Account {
            lamports: a["lamports"].as_u64().unwrap(),
            data,
            owner: a["owner"].as_str().unwrap().parse().unwrap(),
            executable: a["executable"].as_bool().unwrap(),
            rent_epoch: 0,
        },
    )
    .unwrap();
}

#[cfg(test)]
mod smoke {
    use super::*;

    #[test]
    fn global_initialized_and_config_allowed() {
        let env = Env::new();
        let g: fumpad::state::Global = env.fetch(&env.global());
        assert_eq!(g.params, fumpad::state::Params::default());
        assert_eq!(g.admin, kp_pk(&env.admin));
        assert_eq!(g.cluster_tag, CLUSTER_TAG);
        assert!(g.is_keeper(&kp_pk(&env.keepers[2])));
        assert!(g.is_allowed_config(&env.config));
    }
}

#[cfg(test)]
mod config_tests;

pub mod flow;
#[cfg(test)]
mod lifecycle_tests;
