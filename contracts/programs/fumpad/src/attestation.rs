//! D31 keeper attestations: the exact message layouts (INTERFACE-v0.7.md §4) and Ed25519-precompile
//! introspection. Encoding/decoding is pure (unit-tested with the vectors in `tests/vectors/attestation.json`).

use anchor_lang::prelude::*;
use anchor_lang::compat::solana_instructions_sysvar as ix_sysvar;

use crate::{constants::ED25519_PROGRAM_ID, error::FumpadError};

pub const SELL_DOMAIN: &[u8; 14] = b"FUMPAD-SELL-v1";
pub const REBUY_DOMAIN: &[u8; 15] = b"FUMPAD-REBUY-v1";
pub const SELL_MESSAGE_LEN: usize = 284;
pub const REBUY_MESSAGE_LEN: usize = 236;
/// `venue` byte: bit0 = venue (0 DBC, 1 DAMM v2), bit7 = routed through the fumpad router.
pub const VENUE_DAMM_BIT: u8 = 0x01;
pub const VENUE_ROUTED_BIT: u8 = 0x80;

/// One attested sell (§4.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SellRecord {
    pub program_id: Pubkey,
    pub cluster_tag: u8,
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub venue: u8,
    pub signature: [u8; 64],
    pub ix_key: u32,
    pub trader: Pubkey,
    pub base_amount: u64,
    pub quote_gross: u64,
    pub ticket_tokens: u64,
    pub ticket_price_q64: u128,
    pub usd_cents: u64,
    pub pyth_publish_time: i64,
    pub slot: u64,
    pub block_time: i64,
}

/// One attested rebuy debit (§4.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RebuyRecord {
    pub program_id: Pubkey,
    pub cluster_tag: u8,
    pub mint: Pubkey,
    pub ticket: Pubkey,
    pub owner: Pubkey,
    pub signature: [u8; 64],
    pub ix_key: u32,
    pub debit_tokens: u64,
    pub slot: u64,
    pub block_time: i64,
}

struct W(Vec<u8>);
impl W {
    fn b(&mut self, x: &[u8]) -> &mut Self {
        self.0.extend_from_slice(x);
        self
    }
}

struct R<'a>(&'a [u8], usize);
impl<'a> R<'a> {
    fn take(&mut self, n: usize) -> &'a [u8] {
        let s = &self.0[self.1..self.1 + n];
        self.1 += n;
        s
    }
    fn pk(&mut self) -> Pubkey {
        Pubkey::new_from_array(self.take(32).try_into().unwrap())
    }
    fn u8(&mut self) -> u8 {
        self.take(1)[0]
    }
    fn u32(&mut self) -> u32 {
        u32::from_le_bytes(self.take(4).try_into().unwrap())
    }
    fn u64(&mut self) -> u64 {
        u64::from_le_bytes(self.take(8).try_into().unwrap())
    }
    fn i64(&mut self) -> i64 {
        i64::from_le_bytes(self.take(8).try_into().unwrap())
    }
    fn u128(&mut self) -> u128 {
        u128::from_le_bytes(self.take(16).try_into().unwrap())
    }
}

impl SellRecord {
    pub fn encode(&self) -> Vec<u8> {
        let mut w = W(Vec::with_capacity(SELL_MESSAGE_LEN));
        w.b(SELL_DOMAIN)
            .b(self.program_id.as_ref())
            .b(&[self.cluster_tag])
            .b(self.mint.as_ref())
            .b(self.pool.as_ref())
            .b(&[self.venue])
            .b(&self.signature)
            .b(&self.ix_key.to_le_bytes())
            .b(self.trader.as_ref())
            .b(&self.base_amount.to_le_bytes())
            .b(&self.quote_gross.to_le_bytes())
            .b(&self.ticket_tokens.to_le_bytes())
            .b(&self.ticket_price_q64.to_le_bytes())
            .b(&self.usd_cents.to_le_bytes())
            .b(&self.pyth_publish_time.to_le_bytes())
            .b(&self.slot.to_le_bytes())
            .b(&self.block_time.to_le_bytes());
        w.0
    }

    pub fn decode(m: &[u8]) -> Option<Self> {
        if m.len() != SELL_MESSAGE_LEN || &m[..SELL_DOMAIN.len()] != SELL_DOMAIN {
            return None;
        }
        let mut r = R(m, SELL_DOMAIN.len());
        Some(Self {
            program_id: r.pk(),
            cluster_tag: r.u8(),
            mint: r.pk(),
            pool: r.pk(),
            venue: r.u8(),
            signature: r.take(64).try_into().unwrap(),
            ix_key: r.u32(),
            trader: r.pk(),
            base_amount: r.u64(),
            quote_gross: r.u64(),
            ticket_tokens: r.u64(),
            ticket_price_q64: r.u128(),
            usd_cents: r.u64(),
            pyth_publish_time: r.i64(),
            slot: r.u64(),
            block_time: r.i64(),
        })
    }

    pub fn is_damm(&self) -> bool {
        self.venue & VENUE_DAMM_BIT != 0
    }
    pub fn is_routed(&self) -> bool {
        self.venue & VENUE_ROUTED_BIT != 0
    }
    pub fn venue_valid(&self) -> bool {
        self.venue & !(VENUE_DAMM_BIT | VENUE_ROUTED_BIT) == 0
    }
}

impl RebuyRecord {
    pub fn encode(&self) -> Vec<u8> {
        let mut w = W(Vec::with_capacity(REBUY_MESSAGE_LEN));
        w.b(REBUY_DOMAIN)
            .b(self.program_id.as_ref())
            .b(&[self.cluster_tag])
            .b(self.mint.as_ref())
            .b(self.ticket.as_ref())
            .b(self.owner.as_ref())
            .b(&self.signature)
            .b(&self.ix_key.to_le_bytes())
            .b(&self.debit_tokens.to_le_bytes())
            .b(&self.slot.to_le_bytes())
            .b(&self.block_time.to_le_bytes());
        w.0
    }

    pub fn decode(m: &[u8]) -> Option<Self> {
        if m.len() != REBUY_MESSAGE_LEN || &m[..REBUY_DOMAIN.len()] != REBUY_DOMAIN {
            return None;
        }
        let mut r = R(m, REBUY_DOMAIN.len());
        Some(Self {
            program_id: r.pk(),
            cluster_tag: r.u8(),
            mint: r.pk(),
            ticket: r.pk(),
            owner: r.pk(),
            signature: r.take(64).try_into().unwrap(),
            ix_key: r.u32(),
            debit_tokens: r.u64(),
            slot: r.u64(),
            block_time: r.i64(),
        })
    }
}

/// The verified content of the Ed25519 instruction right before the current one: the (single) message every
/// signature entry signs, and the distinct signer keys. The precompile already verified each signature (a bad
/// one fails the whole transaction), so what remains is binding: every entry must point INSIDE the Ed25519
/// instruction (index `u16::MAX`) and all entries must sign the same bytes.
pub struct VerifiedMessage {
    pub message: Vec<u8>,
    pub signers: Vec<Pubkey>,
}

const OFFSETS_START: usize = 2;
const OFFSETS_LEN: usize = 14;
const SAME_IX: u16 = u16::MAX;

/// Parse an Ed25519 precompile instruction's data (pure; see `load_attestation`).
pub fn parse_ed25519_data(data: &[u8]) -> Result<VerifiedMessage> {
    require!(data.len() >= OFFSETS_START, FumpadError::InvalidAttestation);
    let n = data[0] as usize;
    require!(n >= 1 && data.len() >= OFFSETS_START + n * OFFSETS_LEN, FumpadError::InvalidAttestation);
    let rd16 = |o: usize| u16::from_le_bytes([data[o], data[o + 1]]);
    let slice = |off: u16, len: usize| -> Result<&[u8]> {
        let s = off as usize;
        data.get(s..s.checked_add(len).ok_or(FumpadError::InvalidAttestation)?)
            .ok_or_else(|| error!(FumpadError::InvalidAttestation))
    };
    let mut message: Option<&[u8]> = None;
    let mut signers: Vec<Pubkey> = Vec::with_capacity(n);
    for i in 0..n {
        let o = OFFSETS_START + i * OFFSETS_LEN;
        let (sig_off, sig_ix) = (rd16(o), rd16(o + 2));
        let (pk_off, pk_ix) = (rd16(o + 4), rd16(o + 6));
        let (msg_off, msg_len, msg_ix) = (rd16(o + 8), rd16(o + 10) as usize, rd16(o + 12));
        require!(sig_ix == SAME_IX && pk_ix == SAME_IX && msg_ix == SAME_IX, FumpadError::InvalidAttestation);
        slice(sig_off, 64)?;
        let pk = Pubkey::new_from_array(slice(pk_off, 32)?.try_into().unwrap());
        let m = slice(msg_off, msg_len)?;
        match message {
            None => message = Some(m),
            Some(prev) => require!(prev == m, FumpadError::InvalidAttestation),
        }
        if !signers.contains(&pk) {
            signers.push(pk);
        }
    }
    Ok(VerifiedMessage { message: message.unwrap_or(&[]).to_vec(), signers })
}

/// Load the Ed25519 instruction immediately before the current instruction (which must be top-level fumpad).
pub fn load_attestation(ixs: &AccountInfo) -> Result<VerifiedMessage> {
    require_keys_eq!(*ixs.key, ix_sysvar::ID, FumpadError::InvalidAccount);
    let current = ix_sysvar::load_current_index_checked(ixs)? as usize;
    require!(current >= 1, FumpadError::MissingAttestation);
    let me = ix_sysvar::load_instruction_at_checked(current, ixs)?;
    require_keys_eq!(me.program_id, crate::ID, FumpadError::MissingAttestation);
    let ix = ix_sysvar::load_instruction_at_checked(current - 1, ixs)?;
    require_keys_eq!(ix.program_id, ED25519_PROGRAM_ID, FumpadError::MissingAttestation);
    parse_ed25519_data(&ix.data)
}

/// Number of distinct signer keys accepted by `is_attester` (active keepers).
pub fn count_attesters(signers: &[Pubkey], is_attester: impl Fn(&Pubkey) -> bool) -> (usize, [Pubkey; 2]) {
    let mut first = [Pubkey::default(); 2];
    let mut n = 0usize;
    for k in signers {
        if is_attester(k) {
            if n < 2 {
                first[n] = *k;
            }
            n += 1;
        }
    }
    (n, first)
}

/// Build Ed25519 precompile instruction data for `message` signed by `(pubkey, signature)` pairs, in the layout
/// INTERFACE §4.3 recommends: header, `sig_i ‖ pk_i` per signer, then one copy of the message.
pub fn build_ed25519_data(sigs: &[([u8; 32], [u8; 64])], message: &[u8]) -> Vec<u8> {
    let n = sigs.len();
    let header = OFFSETS_START + n * OFFSETS_LEN;
    let msg_off = header + n * 96;
    let mut d = vec![0u8; header];
    d[0] = n as u8;
    for i in 0..n {
        let sig_off = (header + i * 96) as u16;
        let pk_off = sig_off + 64;
        let o = OFFSETS_START + i * OFFSETS_LEN;
        for (j, v) in [sig_off, SAME_IX, pk_off, SAME_IX, msg_off as u16, message.len() as u16, SAME_IX]
            .iter()
            .enumerate()
        {
            d[o + 2 * j..o + 2 * j + 2].copy_from_slice(&v.to_le_bytes());
        }
    }
    for (pk, sig) in sigs {
        d.extend_from_slice(sig);
        d.extend_from_slice(pk);
    }
    d.extend_from_slice(message);
    d
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn sample_sell() -> SellRecord {
        SellRecord {
            program_id: crate::ID,
            cluster_tag: 2,
            mint: Pubkey::new_from_array([1; 32]),
            pool: Pubkey::new_from_array([2; 32]),
            venue: VENUE_ROUTED_BIT | VENUE_DAMM_BIT,
            signature: [3; 64],
            ix_key: (2 << 16) | 1,
            trader: Pubkey::new_from_array([4; 32]),
            base_amount: 1_000_000_000,
            quote_gross: 500_000_000,
            ticket_tokens: 900_000_000,
            ticket_price_q64: 9_223_372_036_854_775_808,
            usd_cents: 7_500,
            pyth_publish_time: 1_791_743_970,
            slot: 455_753_058,
            block_time: 1_791_743_975,
        }
    }

    #[test]
    fn sell_roundtrip_and_offsets() {
        let r = sample_sell();
        let m = r.encode();
        assert_eq!(m.len(), SELL_MESSAGE_LEN);
        assert_eq!(&m[0..14], b"FUMPAD-SELL-v1");
        assert_eq!(&m[14..46], crate::ID.as_ref());
        assert_eq!(m[46], 2);
        assert_eq!(&m[47..79], &[1u8; 32]);
        assert_eq!(&m[79..111], &[2u8; 32]);
        assert_eq!(m[111], 0x81);
        assert_eq!(&m[112..176], &[3u8; 64]);
        assert_eq!(&m[176..180], &((2u32 << 16) | 1).to_le_bytes());
        assert_eq!(&m[180..212], &[4u8; 32]);
        assert_eq!(&m[212..220], &1_000_000_000u64.to_le_bytes());
        assert_eq!(&m[236..252], &(1u128 << 63).to_le_bytes());
        assert_eq!(&m[276..284], &1_791_743_975i64.to_le_bytes());
        assert_eq!(SellRecord::decode(&m), Some(r));
        assert!(r.is_damm() && r.is_routed() && r.venue_valid());
        assert_eq!(SellRecord::decode(&m[..283]), None);
        let mut bad = m.clone();
        bad[0] = b'X';
        assert_eq!(SellRecord::decode(&bad), None);
    }

    #[test]
    fn rebuy_roundtrip() {
        let r = RebuyRecord {
            program_id: crate::ID,
            cluster_tag: 0,
            mint: Pubkey::new_from_array([9; 32]),
            ticket: Pubkey::new_from_array([8; 32]),
            owner: Pubkey::new_from_array([7; 32]),
            signature: [6; 64],
            ix_key: 1,
            debit_tokens: 42,
            slot: 5,
            block_time: -1,
        };
        let m = r.encode();
        assert_eq!(m.len(), REBUY_MESSAGE_LEN);
        assert_eq!(&m[0..15], b"FUMPAD-REBUY-v1");
        assert_eq!(&m[144..208], &[6u8; 64]);
        assert_eq!(RebuyRecord::decode(&m), Some(r));
        assert_eq!(SellRecord::decode(&m), None);
    }

    #[test]
    fn ed25519_parse() {
        let msg = sample_sell().encode();
        let a = ([10u8; 32], [11u8; 64]);
        let b = ([12u8; 32], [13u8; 64]);
        let d = build_ed25519_data(&[a, b], &msg);
        assert_eq!(d.len(), 2 + 28 + 2 * 96 + 284);
        let v = parse_ed25519_data(&d).unwrap();
        assert_eq!(v.message, msg);
        assert_eq!(v.signers, vec![Pubkey::new_from_array([10; 32]), Pubkey::new_from_array([12; 32])]);
        // Duplicated signer counts once.
        let v = parse_ed25519_data(&build_ed25519_data(&[a, a], &msg)).unwrap();
        assert_eq!(v.signers.len(), 1);
        // Data referenced in another instruction → rejected.
        let mut e = d.clone();
        e[2 + 12] = 0; // message_instruction_index of entry 0
        e[2 + 13] = 0;
        assert!(parse_ed25519_data(&e).is_err());
        // Entries signing different messages → rejected.
        let mut e = d.clone();
        let o = 2 + 14 + 10; // message_data_size of entry 1
        e[o..o + 2].copy_from_slice(&100u16.to_le_bytes());
        assert!(parse_ed25519_data(&e).is_err());
        // Out-of-bounds offsets → rejected.
        let mut e = d.clone();
        e[2 + 8..2 + 10].copy_from_slice(&600u16.to_le_bytes());
        assert!(parse_ed25519_data(&e).is_err());
        assert!(parse_ed25519_data(&[0, 0]).is_err());
        let (n, ks) = count_attesters(&[Pubkey::new_from_array([10; 32]), Pubkey::new_from_array([12; 32])], |k| {
            k.as_ref()[0] == 12
        });
        assert_eq!((n, ks[0]), (1, Pubkey::new_from_array([12; 32])));
    }
}
