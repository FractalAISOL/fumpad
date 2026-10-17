//! The launch transaction as the API now builds it (services/api launch prepare, @fumpad/sdk `launchAltAddresses`): a v0
//! message through the FUMPAD launch address lookup table — created, extended with the 11 static launch accounts and
//! frozen in one transaction by the real Address Lookup Table program — with the WORST-CASE byte budget: max name (32
//! B) + symbol (10 B) + `https://ipfs.io/ipfs/<CIDv0>` uri + the creator's first buy (wrap → swap2 with the
//! instructions sysvar → close) + the launch co-signer (`Params.launch_signer`) + compute limit + priority price.
//!
//! What it proves (no program change): the message fits 1,232 bytes (inline it doesn't); `register_coin` registers the
//! coin with every static account (Global, reward pool, event authority, Token-2022, ATA / System programs) loaded from
//! the table; DBC's first-swap min-fee introspection still sees the pool init through the instructions sysvar loaded
//! from the table (the creator gets exactly what an inline launch of the same buy gets); the L1 co-signature check is
//! unchanged (signers can't come from a table); and a frozen table can't be extended, deactivated or closed.

use anchor_lang::prelude::Pubkey;
use fumpad::error::FumpadError;
use fumpad::external::meteora as m;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::{v0, AddressLookupTableAccount, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

use crate::meteora::{self, WSOL};
use crate::*;

const ALT_PROGRAM: Pubkey = anchor_lang::pubkey!("AddressLookupTab1e1111111111111111111111111");
const NAME: &str = "WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW"; // 32 bytes (the app's max)
const SYMBOL: &str = "WWWWWWWWWW"; // 10 bytes (the app's max)
const URI: &str = "https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";

/// @fumpad/sdk `launchAltAddresses()`, same order.
fn launch_alt_addresses(env: &Env) -> Vec<Pubkey> {
    vec![
        env.global(),
        env.reward_pool(),
        ev_auth(),
        m::DBC_POOL_AUTHORITY,
        meteora::dbc_event_authority(),
        WSOL,
        SPL_TOKEN,
        TOKEN_2022,
        ATA_PROGRAM,
        SYSTEM,
        IX_SYSVAR,
    ]
}

fn alt_ix(data: Vec<u8>, metas: &[anchor_lang::prelude::AccountMeta]) -> Instruction {
    raw_ix(&ALT_PROGRAM, metas, data)
}
/// CreateLookupTable { recent_slot, bump } (bincode enum tag 0); authority need not sign (relaxed check).
fn create_alt_ix(authority: &Pubkey, payer: &Pubkey, recent_slot: u64) -> (Instruction, Pubkey) {
    let (table, bump) = Pubkey::find_program_address(&[authority.as_ref(), &recent_slot.to_le_bytes()], &ALT_PROGRAM);
    let mut data = 0u32.to_le_bytes().to_vec();
    data.extend_from_slice(&recent_slot.to_le_bytes());
    data.push(bump);
    (alt_ix(data, &[rw(table), ro(*authority), sgw(*payer), ro(SYSTEM)]), table)
}
/// ExtendLookupTable { new_addresses } (tag 2).
fn extend_alt_ix(table: &Pubkey, authority: &Pubkey, payer: &Pubkey, keys: &[Pubkey]) -> Instruction {
    let mut data = 2u32.to_le_bytes().to_vec();
    data.extend_from_slice(&(keys.len() as u64).to_le_bytes());
    for k in keys {
        data.extend_from_slice(k.as_ref());
    }
    alt_ix(data, &[rw(*table), sg(*authority), sgw(*payer), ro(SYSTEM)])
}
fn freeze_alt_ix(table: &Pubkey, authority: &Pubkey) -> Instruction {
    alt_ix(1u32.to_le_bytes().to_vec(), &[rw(*table), sg(*authority)])
}
fn deactivate_alt_ix(table: &Pubkey, authority: &Pubkey) -> Instruction {
    alt_ix(3u32.to_le_bytes().to_vec(), &[rw(*table), sg(*authority)])
}

/// The bootstrap's `--step alt`: create + extend + freeze in ONE transaction, then one slot so the entries resolve.
fn create_launch_alt(env: &mut Env) -> Pubkey {
    let authority = env.payer.insecure_clone();
    let slot = env.slot();
    // the table's recent slot must be in SlotHashes (the harness moves the clock without producing slots)
    env.svm.set_sysvar(&solana_slot_hashes::SlotHashes::new(&[(slot, solana_hash::Hash::new_from_array([7; 32]))]));
    let (create, table) = create_alt_ix(&kp_pk(&authority), &kp_pk(&authority), slot);
    let keys = launch_alt_addresses(env);
    let ixs = [create, extend_alt_ix(&table, &kp_pk(&authority), &kp_pk(&authority), &keys), freeze_alt_ix(&table, &kp_pk(&authority))];
    ok(env.send(&ixs, &[]));
    env.advance_slots(1);
    // frozen: Option<authority> = None (meta byte 21), the 11 keys after the 56-byte meta
    let d = env.data(&table);
    assert_eq!(d[21], 0, "table must be frozen");
    assert_eq!((d.len() - 56) / 32, keys.len());
    table
}

fn cu_price_ix(micro_lamports: u64) -> Instruction {
    let mut data = vec![3u8];
    data.extend_from_slice(&micro_lamports.to_le_bytes());
    Instruction { program_id: addr(&COMPUTE_BUDGET), accounts: vec![], data }
}
fn close_wsol_ix(owner: &Pubkey) -> Instruction {
    raw_ix(&SPL_TOKEN, &[rw(wsol_ata(owner)), rw(*owner), sg(*owner)], vec![9])
}

/// @fumpad/sdk `launchInstructions` with a priority fee, a first buy and the launch co-signer.
fn api_launch_ixs(env: &Env, creator: &Pubkey, mint: &Pubkey, buy: u64, launch_signer: Option<&Pubkey>, name: &str, symbol: &str, uri: &str) -> Vec<Instruction> {
    let config = env.config;
    let pool = meteora::dbc_pool_pda(&config, mint);
    let mut v = vec![compute_budget_ix(400_000), cu_price_ix(5_000_000)];
    v.extend(meteora::wrap_sol_ixs(creator, buy));
    v.push(meteora::init_pool_ix(&config, creator, mint, creator, name, symbol, uri));
    v.push(meteora::create_ata_idempotent_ix(creator, creator, mint, &TOKEN_2022));
    v.push(meteora::dbc_buy_ix(&config, mint, creator, buy, 1, 0, true));
    let mut reg = env.register_coin_ix(&config, &pool, creator, mint);
    if let Some(s) = launch_signer {
        let at = reg.accounts.len() - 3; // optional `launch_signer`, right before the event-CPI pair
        reg.accounts[at] = AccountMeta::new_readonly(addr(s), true);
    }
    v.push(reg);
    v.push(close_wsol_ix(creator));
    v
}

fn v0_tx(env: &Env, payer: &Keypair, ixs: &[Instruction], tables: &[AddressLookupTableAccount], signers: &[&Keypair]) -> VersionedTransaction {
    let msg = v0::Message::try_compile(&payer.pubkey(), ixs, tables, env.svm.latest_blockhash()).unwrap();
    VersionedTransaction::try_new(VersionedMessage::V0(msg), signers).unwrap()
}

/// Wire size of a v0 transaction (signatures + 0x80 prefix + message), without a bincode dependency.
fn v0_len(tx: &VersionedTransaction) -> usize {
    fn sv(n: usize) -> usize {
        if n < 0x80 {
            1
        } else if n < 0x4000 {
            2
        } else {
            3
        }
    }
    let VersionedMessage::V0(m) = &tx.message else { panic!("v0 expected") };
    let mut len = sv(tx.signatures.len()) + 64 * tx.signatures.len() + 1 + 3 + sv(m.account_keys.len()) + 32 * m.account_keys.len() + 32;
    len += sv(m.instructions.len());
    for i in &m.instructions {
        len += 1 + sv(i.accounts.len()) + i.accounts.len() + sv(i.data.len()) + i.data.len();
    }
    len += sv(m.address_table_lookups.len());
    for l in &m.address_table_lookups {
        len += 32 + sv(l.writable_indexes.len()) + l.writable_indexes.len() + sv(l.readonly_indexes.len()) + l.readonly_indexes.len();
    }
    len
}

fn env_with_launch_signer(launch_key: &Keypair) -> Env {
    let mut env = Env::new();
    let params = fumpad::state::Params { launch_signer: kp_pk(launch_key), ..fumpad::state::Params::default() };
    env.set_params_timelocked(params);
    env
}

#[test]
fn v0_alt_launch_worst_case_fits_and_registers() {
    let launch_key = Keypair::new();
    let mut env = env_with_launch_signer(&launch_key);
    let table = create_launch_alt(&mut env);
    let alt = AddressLookupTableAccount { key: addr(&table), addresses: launch_alt_addresses(&env).iter().map(addr).collect() };
    let creator = env.new_user(100);
    let mint = Keypair::new();
    let (c, mk, lk) = (kp_pk(&creator), kp_pk(&mint), kp_pk(&launch_key));
    let buy = SOL / 2;
    let ixs = api_launch_ixs(&env, &c, &mk, buy, Some(&lk), NAME, SYMBOL, URI);
    let tx = v0_tx(&env, &creator, &ixs, &[alt.clone()], &[&creator, &mint, &launch_key]);
    let size = v0_len(&tx);
    // the same instructions inline: over the packet limit (the reason for the table)
    let inline = v0_tx(&env, &creator, &ixs, &[], &[&creator, &mint, &launch_key]);
    println!("launch tx, worst case: v0 + ALT {size} B ({} B spare), inline {} B", 1_232 - size, v0_len(&inline));
    assert!(size <= 1_232, "v0 + ALT launch is {size} B");
    assert!(v0_len(&inline) > 1_232);
    // signers + invoked programs stay static; every static launch account comes from the table
    let VersionedMessage::V0(msg) = &tx.message else { unreachable!() };
    assert_eq!(msg.header.num_required_signatures, 3);
    for k in [env.global(), env.reward_pool(), IX_SYSVAR, TOKEN_2022] {
        assert!(!msg.account_keys.contains(&addr(&k)), "{k} should be loaded from the table");
    }
    assert_eq!(msg.address_table_lookups.len(), 1);
    ok(env.svm.send_transaction(tx));
    env.svm.expire_blockhash();

    // registered with the exact metadata
    let coin = env.coin(&flow::TCoin { mint: mk, creator: creator.insecure_clone(), config: env.config, pool: meteora::dbc_pool_pda(&env.config, &mk) });
    assert_eq!(coin.mint, mk);
    assert_eq!(coin.creator, c);
    let mint_data = env.data(&mk);
    for s in [NAME, SYMBOL, URI] {
        assert!(mint_data.windows(s.len()).any(|w| w == s.as_bytes()), "{s} in the Token-2022 metadata");
    }
    assert!(env.exists(&env.reward_vault(&mk)));
    assert_eq!(env.lamports(&wsol_ata(&c)), 0, "WSOL closed");

    // DBC's first-swap min fee (instructions-sysvar introspection) still applies: the same buy through an inline
    // legacy launch on a fresh, identical chain gets exactly the same tokens
    let alt_tokens = env.base_balance(&c, &mk);
    let mut env2 = Env::new();
    let creator2 = env2.new_user(100);
    let mint2 = Keypair::new();
    env2.fund_wsol(&creator2, buy);
    let ixs2 = env2.launch_ixs(&env2.config.clone(), &kp_pk(&creator2), &kp_pk(&mint2), buy);
    ok(env2.send_as(&creator2, &ixs2, &[&creator2, &mint2]));
    assert_eq!(alt_tokens, env2.base_balance(&kp_pk(&creator2), &kp_pk(&mint2)), "first buy at the min fee through the ALT");
    assert!(alt_tokens > 0);
}

#[test]
fn v0_alt_launch_keeps_the_co_signer_check_and_the_table_is_immutable() {
    let launch_key = Keypair::new();
    let mut env = env_with_launch_signer(&launch_key);
    let table = create_launch_alt(&mut env);
    let alt = AddressLookupTableAccount { key: addr(&table), addresses: launch_alt_addresses(&env).iter().map(addr).collect() };
    let creator = env.new_user(100);
    let mint = Keypair::new();
    let (c, mk) = (kp_pk(&creator), kp_pk(&mint));
    // without the co-signer (program id in its slot), or co-signed by another key: refused as before
    let ixs = api_launch_ixs(&env, &c, &mk, SOL / 10, None, NAME, SYMBOL, URI);
    let tx = v0_tx(&env, &creator, &ixs, &[alt.clone()], &[&creator, &mint]);
    assert_fumpad_err(env.svm.send_transaction(tx), FumpadError::Unauthorized);
    env.svm.expire_blockhash();
    let rando = Keypair::new();
    let ixs = api_launch_ixs(&env, &c, &mk, SOL / 10, Some(&kp_pk(&rando)), NAME, SYMBOL, URI);
    let tx = v0_tx(&env, &creator, &ixs, &[alt.clone()], &[&creator, &mint, &rando]);
    assert_fumpad_err(env.svm.send_transaction(tx), FumpadError::Unauthorized);
    env.svm.expire_blockhash();
    // frozen: no extend, no deactivate (so never closed), by the former authority or anyone
    let payer = kp_pk(&env.payer);
    assert!(env.send(&[extend_alt_ix(&table, &payer, &payer, &[Pubkey::new_unique()])], &[]).is_err());
    assert!(env.send(&[deactivate_alt_ix(&table, &payer)], &[]).is_err());
    assert_eq!((env.data(&table).len() - 56) / 32, 11);
    // and the real launch still goes through it
    let ixs = api_launch_ixs(&env, &c, &mk, SOL / 10, Some(&kp_pk(&launch_key)), NAME, SYMBOL, URI);
    let tx = v0_tx(&env, &creator, &ixs, &[alt], &[&creator, &mint, &launch_key]);
    ok(env.svm.send_transaction(tx));
    assert!(env.exists(&env.coin_pda(&mk)));
}
