//! Shared LiteSVM harness for FUMPAD integration tests.
//!
//! Type bridge: Anchor 1.2 speaks solana v3 types (`anchor_lang::prelude::Pubkey`),
//! LiteSVM 0.18 speaks v4 (`solana_address::Address`). Convert ONLY through `addr()` /
//! `pk()` / `ix()` here. Modules add their own helpers in their own files
//! (e.g. `curve_helpers.rs`), not in this one, to keep merges clean.

use anchor_lang::{prelude::Pubkey, AccountDeserialize, InstructionData, ToAccountMetas};
use litesvm::{types::TransactionResult, LiteSVM};
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

pub use fumpad;

pub const SOL: u64 = 1_000_000_000;

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

/// Build a v4 instruction for the fumpad program from Anchor's generated types.
pub fn ix(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    ix_with_remaining(accounts, data, &[])
}

pub fn ix_with_remaining(
    accounts: impl ToAccountMetas,
    data: impl InstructionData,
    remaining: &[anchor_lang::prelude::AccountMeta],
) -> Instruction {
    let metas = accounts
        .to_account_metas(None)
        .into_iter()
        .chain(remaining.iter().cloned())
        .map(|m| AccountMeta { pubkey: addr(&m.pubkey), is_signer: m.is_signer, is_writable: m.is_writable })
        .collect();
    Instruction { program_id: addr(&fumpad::ID), accounts: metas, data: data.data() }
}

pub struct Env {
    pub svm: LiteSVM,
    /// Fee payer + fumpad upgrade authority.
    pub payer: Keypair,
    pub admin: Keypair,
    pub treasury: Keypair,
    pub keeper: Keypair,
}

impl Env {
    /// Fresh SVM with fumpad, PumpSwap (+ its fee program and GlobalConfig) loaded and
    /// `initialize_global` run with default params.
    pub fn new() -> Self {
        Self::with_params(fumpad::state::Params::default())
    }

    pub fn with_params(params: fumpad::state::Params) -> Self {
        let mut svm = LiteSVM::new();
        let payer = Keypair::new();
        let admin = Keypair::new();
        let treasury = Keypair::new();
        let keeper = Keypair::new();
        for k in [&payer, &admin, &treasury, &keeper] {
            svm.airdrop(&k.pubkey(), 1_000 * SOL).unwrap();
        }

        let fumpad_so = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/deploy/fumpad.so");
        svm.add_program_from_file(addr(&fumpad::ID), &fumpad_so).expect("run `anchor build` first");
        set_upgrade_authority(&mut svm, &fumpad::ID, &kp_pk(&payer));

        svm.add_program_from_file(addr(&fumpad::PUMPSWAP_PROGRAM_ID), fixtures_dir().join("pump_amm.so")).unwrap();
        svm.add_program_from_file(addr(&fumpad::PUMP_FEES_PROGRAM_ID), fixtures_dir().join("pump_fees.so")).unwrap();
        load_account_fixture(&mut svm, "pump_amm_global_config.json");

        let mut env = Env { svm, payer, admin, treasury, keeper };
        let global = env.global_pda();
        let program_data = Pubkey::find_program_address(
            &[fumpad::ID.as_ref()],
            &anchor_lang::solana_program::bpf_loader_upgradeable::ID,
        )
        .0;
        let init = ix(
            fumpad::accounts::InitializeGlobal {
                payer: kp_pk(&env.payer),
                global,
                program: fumpad::ID,
                program_data,
                system_program: anchor_lang::system_program::ID,
            },
            fumpad::instruction::InitializeGlobal {
                admin: kp_pk(&env.admin),
                platform_treasury: kp_pk(&env.treasury),
                params,
            },
        );
        env.send(&[init], &[]).expect("initialize_global");
        let mut keepers = [Pubkey::default(); fumpad::MAX_KEEPERS];
        keepers[0] = kp_pk(&env.keeper);
        let set = ix(
            fumpad::accounts::AdminOnly { admin: kp_pk(&env.admin), global },
            fumpad::instruction::SetKeepers { keepers },
        );
        let admin = env.admin.insecure_clone();
        env.send(&[set], &[&admin]).expect("set_keepers");
        env
    }

    pub fn global_pda(&self) -> Pubkey {
        Pubkey::find_program_address(&[fumpad::GLOBAL_SEED], &fumpad::ID).0
    }

    /// Send instructions with `payer` as fee payer plus extra signers.
    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TransactionResult {
        let mut all: Vec<&Keypair> = vec![&self.payer];
        all.extend_from_slice(signers);
        let msg = Message::new(ixs, Some(&self.payer.pubkey()));
        let tx = Transaction::new(&all, msg, self.svm.latest_blockhash());
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        res
    }

    /// Send with `fee_payer` (must be in `signers`) — for user-paid transactions.
    pub fn send_as(&mut self, fee_payer: &Keypair, ixs: &[Instruction], signers: &[&Keypair]) -> TransactionResult {
        let msg = Message::new(ixs, Some(&fee_payer.pubkey()));
        let tx = Transaction::new(signers, msg, self.svm.latest_blockhash());
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        res
    }

    pub fn account(&self, key: &Pubkey) -> Option<Account> {
        self.svm.get_account(&addr(key))
    }

    pub fn fetch<T: AccountDeserialize>(&self, key: &Pubkey) -> T {
        let acc = self.account(key).unwrap_or_else(|| panic!("account {key} missing"));
        T::try_deserialize(&mut acc.data.as_slice()).expect("deserialize")
    }

    /// Zero-copy accounts: skip the 8-byte discriminator and cast.
    pub fn fetch_zc<T: bytemuck_like::Pod>(&self, key: &Pubkey) -> T {
        let acc = self.account(key).unwrap_or_else(|| panic!("account {key} missing"));
        bytemuck_like::read(&acc.data[8..])
    }

    pub fn lamports(&self, key: &Pubkey) -> u64 {
        self.account(key).map(|a| a.lamports).unwrap_or(0)
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<litesvm_clock::Clock>().unix_timestamp
    }

    /// Advance the clock by `secs` (and slots proportionally).
    pub fn warp(&mut self, secs: i64) {
        let mut c = self.svm.get_sysvar::<litesvm_clock::Clock>();
        c.unix_timestamp += secs;
        c.slot += (secs.max(0) as u64) * 5 / 2;
        self.svm.set_sysvar(&c);
    }

    pub fn new_user(&mut self, sol: u64) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), sol * SOL).unwrap();
        k
    }
}

/// The Clock sysvar type LiteSVM expects (pinned to LiteSVM's solana-clock).
pub mod litesvm_clock {
    pub use solana_clock::Clock;
}

/// Minimal Pod read without adding a bytemuck version to this crate's API.
pub mod bytemuck_like {
    pub trait Pod: Copy + 'static {}
    impl<T: Copy + 'static> Pod for T {}
    pub fn read<T: Pod>(bytes: &[u8]) -> T {
        assert!(bytes.len() >= std::mem::size_of::<T>(), "account too small");
        unsafe { std::ptr::read_unaligned(bytes.as_ptr() as *const T) }
    }
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
    fn global_initialized_with_defaults() {
        let env = Env::new();
        let g: fumpad::state::Global = env.fetch(&env.global_pda());
        assert_eq!(g.params, fumpad::state::Params::default());
        assert_eq!(g.admin, kp_pk(&env.admin));
        assert!(g.is_keeper(&kp_pk(&env.keeper)));
    }

    #[test]
    fn non_admin_cannot_update_params() {
        let mut env = Env::new();
        let rando = env.new_user(1);
        let bad = ix(
            fumpad::accounts::AdminOnly { admin: kp_pk(&rando), global: env.global_pda() },
            fumpad::instruction::SetPause { paused: 7 },
        );
        assert!(env.send(&[bad], &[&rando]).is_err());
    }
}

#[cfg(test)] mod curve_tests;
