//! Attestation test vectors for the services (keepers, watcher): `tests/vectors/attestation.json`.
//! Deterministic keeper keys (secret seed = [i; 32]) and Ed25519 signatures; the USD value is computed from the
//! mainnet Pyth SOL/USD fixture the way the engine does it (lower confidence bound, floor). Regenerate with
//! `UPDATE_VECTORS=1 cargo test -p tests vectors`; otherwise the test checks the checked-in file byte for byte and
//! that the program accepts the vector's Ed25519 instruction.

use crate::flow::*;
use crate::*;
use fumpad::attestation::{build_ed25519_data, RebuyRecord, SellRecord, VENUE_DAMM_BIT, VENUE_ROUTED_BIT};
use serde_json::{json, Value};
use solana_keypair::Keypair;

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Pyth PriceUpdateV2 (Full verification) → (price, conf, expo, publish_time). Same layout as the v0.6 parser.
fn pyth_fixture() -> (i64, u64, i32, i64) {
    use base64::Engine;
    let v: Value = serde_json::from_str(&std::fs::read_to_string(fixtures_dir().join("pyth_sol_usd_mainnet.json")).unwrap()).unwrap();
    let d = base64::engine::general_purpose::STANDARD.decode(v["account"]["data"][0].as_str().unwrap()).unwrap();
    assert_eq!(d[40], 1, "Full verification");
    let m = 41;
    let rd = |o: usize, n: usize| d[o..o + n].to_vec();
    (
        i64::from_le_bytes(rd(m + 32, 8).try_into().unwrap()),
        u64::from_le_bytes(rd(m + 40, 8).try_into().unwrap()),
        i32::from_le_bytes(rd(m + 48, 4).try_into().unwrap()),
        i64::from_le_bytes(rd(m + 52, 8).try_into().unwrap()),
    )
}

/// USD cents of `lamports` at the lower confidence bound (price − conf), rounded down (v0.6 rule).
fn usd_cents(lamports: u64, price: i64, conf: u64, expo: i32) -> u64 {
    let p = (price as u64 - conf) as u128;
    let v = lamports as u128 * p;
    let e = expo + 2 - 9;
    (if e >= 0 { v * 10u128.pow(e as u32) } else { v / 10u128.pow((-e) as u32) }) as u64
}

fn keepers() -> Vec<Keypair> {
    (1u8..=3).map(|i| Keypair::new_from_array([i; 32])).collect()
}

fn sign(k: &Keypair, m: &[u8]) -> [u8; 64] {
    <[u8; 64]>::try_from(k.sign_message(m).as_ref()).unwrap()
}

pub fn build_vectors() -> Value {
    let ks = keepers();
    let (price, conf, expo, publish) = pyth_fixture();
    let mint = Pubkey::new_from_array([0x11; 32]);
    let dbc_pool = Pubkey::new_from_array([0x22; 32]);
    let damm_pool = Pubkey::new_from_array([0x33; 32]);
    let trader = Pubkey::new_from_array([0x44; 32]);
    let mut sig = [0u8; 64];
    for (i, b) in sig.iter_mut().enumerate() {
        *b = i as u8;
    }
    let quote_gross: u64 = 1_250_000_000; // 1.25 SOL before fees
    let base_amount: u64 = 25_000_000_000_000; // 25M tokens
    let sells = [
        ("dbc_outside", SellRecord {
            program_id: fumpad::ID,
            cluster_tag: 0,
            mint,
            pool: dbc_pool,
            venue: 0,
            signature: sig,
            ix_key: (3 << 16) | 2,
            trader,
            base_amount,
            quote_gross,
            ticket_tokens: base_amount,
            ticket_price_q64: fumpad::math::price_q64(quote_gross, base_amount).unwrap(),
            usd_cents: usd_cents(quote_gross, price, conf, expo),
            pyth_publish_time: publish,
            slot: 455_753_100,
            block_time: publish + 12,
        }),
        ("damm_routed_partial", SellRecord {
            program_id: fumpad::ID,
            cluster_tag: 1,
            mint,
            pool: damm_pool,
            venue: VENUE_DAMM_BIT | VENUE_ROUTED_BIT,
            signature: sig,
            ix_key: 1,
            trader,
            base_amount,
            quote_gross,
            ticket_tokens: base_amount / 3,
            // D12 floor above the execution price (engine-computed).
            ticket_price_q64: fumpad::math::price_q64(quote_gross, base_amount).unwrap() * 11 / 10,
            usd_cents: usd_cents(quote_gross / 3, price, conf, expo),
            pyth_publish_time: publish,
            slot: 455_753_101,
            block_time: publish + 60,
        }),
    ];
    let mut sell_json = vec![];
    for (name, r) in sells.iter() {
        let msg = r.encode();
        let s0 = sign(&ks[0], &msg);
        let s1 = sign(&ks[1], &msg);
        let ed = build_ed25519_data(&[(kp_pk(&ks[0]).to_bytes(), s0), (kp_pk(&ks[1]).to_bytes(), s1)], &msg);
        sell_json.push(json!({
            "name": name,
            "record": {
                "program_id": r.program_id.to_string(),
                "cluster_tag": r.cluster_tag,
                "mint": r.mint.to_string(),
                "pool": r.pool.to_string(),
                "venue": r.venue,
                "signature_hex": hex(&r.signature),
                "ix_key": r.ix_key,
                "trader": r.trader.to_string(),
                "base_amount": r.base_amount.to_string(),
                "quote_gross": r.quote_gross.to_string(),
                "ticket_tokens": r.ticket_tokens.to_string(),
                "ticket_price_q64": r.ticket_price_q64.to_string(),
                "usd_cents": r.usd_cents.to_string(),
                "pyth_publish_time": r.pyth_publish_time,
                "slot": r.slot.to_string(),
                "block_time": r.block_time,
            },
            "message_hex": hex(&msg),
            "message_len": msg.len(),
            "signatures": [
                {"keeper": kp_pk(&ks[0]).to_string(), "signature_hex": hex(&s0)},
                {"keeper": kp_pk(&ks[1]).to_string(), "signature_hex": hex(&s1)},
            ],
            "ed25519_ix_data_hex": hex(&ed),
            "consumed_pda": sell_consumed_pda(&r.signature, r.ix_key).to_string(),
            "position_pda": position_pda(&r.mint, &r.trader).to_string(),
            "ticket_pda_seq0": ticket_pda(&r.mint, &r.trader, 0).to_string(),
        }));
    }
    let ticket = ticket_pda(&mint, &trader, 0);
    let rb = RebuyRecord {
        program_id: fumpad::ID,
        cluster_tag: 0,
        mint,
        ticket,
        owner: trader,
        signature: sig,
        ix_key: (5 << 16) | 0,
        debit_tokens: 1_000_000_000_000,
        slot: 455_800_000,
        block_time: publish + 3_600,
    };
    let msg = rb.encode();
    let s0 = sign(&ks[0], &msg);
    let s2 = sign(&ks[2], &msg);
    let ed = build_ed25519_data(&[(kp_pk(&ks[0]).to_bytes(), s0), (kp_pk(&ks[2]).to_bytes(), s2)], &msg);
    json!({
        "description": "FUMPAD v0.7 attestation vectors (INTERFACE-v0.7.md §4). Keeper secret seeds are [i;32] for i=1..3 (ed25519 seed, NOT for production). usd_cents from tests/fixtures/pyth_sol_usd_mainnet.json at the lower confidence bound, floored.",
        "program_id": fumpad::ID.to_string(),
        "keepers": ks.iter().enumerate().map(|(i, k)| json!({"seed_hex": hex(&[(i + 1) as u8; 32]), "pubkey": kp_pk(k).to_string()})).collect::<Vec<_>>(),
        "pyth": {"price": price, "conf": conf, "expo": expo, "publish_time": publish},
        "sells": sell_json,
        "rebuys": [{
            "name": "rebuy_debit",
            "record": {
                "program_id": rb.program_id.to_string(),
                "cluster_tag": rb.cluster_tag,
                "mint": rb.mint.to_string(),
                "ticket": rb.ticket.to_string(),
                "owner": rb.owner.to_string(),
                "signature_hex": hex(&rb.signature),
                "ix_key": rb.ix_key,
                "debit_tokens": rb.debit_tokens.to_string(),
                "slot": rb.slot.to_string(),
                "block_time": rb.block_time,
            },
            "message_hex": hex(&msg),
            "message_len": msg.len(),
            "signatures": [
                {"keeper": kp_pk(&ks[0]).to_string(), "signature_hex": hex(&s0)},
                {"keeper": kp_pk(&ks[2]).to_string(), "signature_hex": hex(&s2)},
            ],
            "ed25519_ix_data_hex": hex(&ed),
            "consumed_pda": rebuy_consumed_pda(&rb.signature, rb.ix_key, &rb.ticket).to_string(),
        }],
    })
}

#[test]
fn attestation_vectors_match_checked_in_file() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("vectors/attestation.json");
    let v = build_vectors();
    let text = serde_json::to_string_pretty(&v).unwrap() + "\n";
    if std::env::var("UPDATE_VECTORS").is_ok() || !path.exists() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &text).unwrap();
    }
    assert_eq!(std::fs::read_to_string(&path).unwrap(), text, "vectors drifted: rerun with UPDATE_VECTORS=1");
    // Decode round trip.
    for s in v["sells"].as_array().unwrap() {
        let m = s["message_hex"].as_str().unwrap();
        let bytes: Vec<u8> = (0..m.len()).step_by(2).map(|i| u8::from_str_radix(&m[i..i + 2], 16).unwrap()).collect();
        assert!(SellRecord::decode(&bytes).is_some());
    }
}

/// The vector keepers, used as the real keeper set, get a ticket attested with the vector's exact Ed25519 data.
#[test]
fn program_accepts_vector_style_attestation() {
    let mut env = Env::new();
    let ks = keepers();
    for k in &ks {
        env.svm.airdrop(&k.pubkey(), 100 * SOL).unwrap();
    }
    ok(env.set_keepers([kp_pk(&ks[0]), kp_pk(&ks[1]), kp_pk(&ks[2])]));
    env.keepers = [ks[0].insecure_clone(), ks[1].insecure_clone(), ks[2].insecure_clone()];
    env.warp(fumpad::KEEPER_ATTEST_FREEZE_SECS);
    let c = env.launch(SOL / 10);
    env.skip_launch_window();
    env.warp(60);
    let (price, conf, expo, _) = pyth_fixture();
    let mut r = env.sell_record(&c, &Pubkey::new_from_array([0x44; 32]), 25_000_000_000_000, 1 << 40);
    r.quote_gross = 1_250_000_000;
    // D12: the attested price is never below the execution price (the vectors use exactly the execution price).
    r.ticket_price_q64 = fumpad::math::price_q64(r.quote_gross, r.base_amount).unwrap();
    r.usd_cents = usd_cents(r.quote_gross, price, conf, expo);
    ok(env.attest_sell(&r, &[0, 1]));
}
