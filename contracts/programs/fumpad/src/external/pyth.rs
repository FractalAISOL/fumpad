//! Pyth PriceUpdateV2 parsing (no crate dependency). OWNER: rewards module.
//!
//! Layout (Borsh, Anchor account of the Pyth Solana Receiver `rec5EKMG…`), verified
//! byte-for-byte against the live mainnet sponsored SOL/USD account
//! `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE` (fixture:
//! `tests/fixtures/pyth_sol_usd_mainnet.json`, 134 bytes):
//!
//! | off | size | field                                             |
//! |-----|------|---------------------------------------------------|
//! |   0 |    8 | discriminator = sha256("account:PriceUpdateV2")[..8] |
//! |   8 |   32 | write_authority                                   |
//! |  40 |  1/2 | verification_level: 0 = Partial{num_signatures:u8}, 1 = Full |
//! |  +0 |   32 | price_message.feed_id                             |
//! |  +32|    8 | price (i64)                                       |
//! |  +40|    8 | conf (u64)                                        |
//! |  +48|    4 | exponent (i32)                                    |
//! |  +52|    8 | publish_time (i64)                                |
//! |  +60|    8 | prev_publish_time (i64)                           |
//! |  +68|    8 | ema_price (i64)                                   |
//! |  +76|    8 | ema_conf (u64)                                    |
//! |  +84|    8 | posted_slot (u64)                                 |
//!
//! With `Full` the price message starts at offset 41 (account is allocated for the
//! larger `Partial` variant, so one trailing byte is unused).
//!
//! Checks: account owner == PYTH_RECEIVER_PROGRAM_ID, discriminator, verification level
//! Full, feed id == global.params.sol_usd_feed_id, price > 0, publish_time staleness
//! ≤ max_price_age_secs, conf ≤ MAX_CONF_BPS of price. USD conversion uses the
//! conservative lower bound `price - conf`.

use anchor_lang::prelude::*;

use crate::constants::PYTH_RECEIVER_PROGRAM_ID;

/// sha256("account:PriceUpdateV2")[..8]
pub const PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd];
/// Reject prices whose confidence interval is wider than 2% of the price.
pub const MAX_CONF_BPS: u64 = 200;

const VL_OFFSET: usize = 40;
const MESSAGE_LEN: usize = 32 + 8 + 8 + 4 + 8 + 8 + 8 + 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VerificationLevel {
    Partial { num_signatures: u8 },
    Full,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PriceUpdate {
    pub write_authority: Pubkey,
    pub verification_level: VerificationLevel,
    pub feed_id: [u8; 32],
    pub price: i64,
    pub conf: u64,
    pub exponent: i32,
    pub publish_time: i64,
    pub prev_publish_time: i64,
    pub ema_price: i64,
    pub ema_conf: u64,
    pub posted_slot: u64,
}

/// Why a price could not be used. Callers decide whether that is fatal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OracleIssue {
    WrongOwner,
    Malformed,
    NotFullyVerified,
    WrongFeed,
    NonPositivePrice,
    Stale,
    ConfidenceTooWide,
    BadExponent,
}

/// A validated, conservative SOL/USD price: `price × 10^exponent` USD per SOL, where
/// `price` is already the lower confidence bound (`price - conf`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UsdPrice {
    pub price: u64,
    pub exponent: i32,
}

fn rd<const N: usize>(d: &[u8], off: usize) -> [u8; N] {
    let mut a = [0u8; N];
    a.copy_from_slice(&d[off..off + N]);
    a
}

/// Parse raw account data (discriminator included).
pub fn parse_price_update(data: &[u8]) -> core::result::Result<PriceUpdate, OracleIssue> {
    if data.len() < VL_OFFSET + 1 || data[..8] != PRICE_UPDATE_V2_DISCRIMINATOR {
        return Err(OracleIssue::Malformed);
    }
    let write_authority = Pubkey::new_from_array(rd::<32>(data, 8));
    let (verification_level, m) = match data[VL_OFFSET] {
        0 => {
            let n = *data.get(VL_OFFSET + 1).ok_or(OracleIssue::Malformed)?;
            (VerificationLevel::Partial { num_signatures: n }, VL_OFFSET + 2)
        }
        1 => (VerificationLevel::Full, VL_OFFSET + 1),
        _ => return Err(OracleIssue::Malformed),
    };
    if data.len() < m + MESSAGE_LEN + 8 {
        return Err(OracleIssue::Malformed);
    }
    Ok(PriceUpdate {
        write_authority,
        verification_level,
        feed_id: rd::<32>(data, m),
        price: i64::from_le_bytes(rd(data, m + 32)),
        conf: u64::from_le_bytes(rd(data, m + 40)),
        exponent: i32::from_le_bytes(rd(data, m + 48)),
        publish_time: i64::from_le_bytes(rd(data, m + 52)),
        prev_publish_time: i64::from_le_bytes(rd(data, m + 60)),
        ema_price: i64::from_le_bytes(rd(data, m + 68)),
        ema_conf: u64::from_le_bytes(rd(data, m + 76)),
        posted_slot: u64::from_le_bytes(rd(data, m + MESSAGE_LEN)),
    })
}

/// Validate a parsed update for use as the SOL/USD price at `now`.
pub fn validate(
    u: &PriceUpdate,
    feed_id: &[u8; 32],
    now: i64,
    max_age_secs: u64,
) -> core::result::Result<UsdPrice, OracleIssue> {
    if u.verification_level != VerificationLevel::Full {
        return Err(OracleIssue::NotFullyVerified);
    }
    if &u.feed_id != feed_id {
        return Err(OracleIssue::WrongFeed);
    }
    if u.price <= 0 {
        return Err(OracleIssue::NonPositivePrice);
    }
    // A publish_time slightly ahead of the validator clock counts as age 0.
    let age = now.saturating_sub(u.publish_time).max(0) as u64;
    if age > max_age_secs {
        return Err(OracleIssue::Stale);
    }
    let price = u.price as u64;
    if (u.conf as u128) * 10_000 > (price as u128) * MAX_CONF_BPS as u128 {
        return Err(OracleIssue::ConfidenceTooWide);
    }
    if !(-18..=18).contains(&u.exponent) {
        return Err(OracleIssue::BadExponent);
    }
    // conf ≤ 2% of price, so this is > 0.
    Ok(UsdPrice { price: price - u.conf, exponent: u.exponent })
}

/// Load + validate the SOL/USD price from an account. Never panics.
pub fn load_sol_usd(
    info: &AccountInfo,
    feed_id: &[u8; 32],
    now: i64,
    max_age_secs: u64,
) -> core::result::Result<UsdPrice, OracleIssue> {
    if info.owner != &PYTH_RECEIVER_PROGRAM_ID {
        return Err(OracleIssue::WrongOwner);
    }
    let data = info.try_borrow_data().map_err(|_| OracleIssue::Malformed)?;
    let u = parse_price_update(&data)?;
    validate(&u, feed_id, now, max_age_secs)
}

/// USD cents for `lamports` at `p`, rounded down:
/// cents = lamports × price × 10^exponent × 100 / 10^9.
pub fn lamports_to_usd_cents(lamports: u64, p: &UsdPrice) -> Option<u64> {
    let v = (lamports as u128).checked_mul(p.price as u128)?;
    let e = p.exponent.checked_add(2 - 9)?; // ×100 cents, ÷1e9 lamports/SOL
    let v = if e >= 0 {
        v.checked_mul(10u128.checked_pow(e as u32)?)?
    } else {
        let d = 10u128.checked_pow(e.unsigned_abs())?;
        v / d
    };
    u64::try_from(v).ok()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::constants::PYTH_SOL_USD_FEED_ID;

    /// Live mainnet account 7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE (same bytes as
    /// tests/fixtures/pyth_sol_usd_mainnet.json).
    pub const MAINNET_SOL_USD: [u8; 134] = [
        34, 241, 35, 99, 157, 126, 244, 205, 96, 49, 71, 4, 52, 13, 237, 223, 55, 31, 212, 36, 114, 20, 143, 36,
        142, 157, 26, 109, 26, 94, 178, 172, 58, 205, 139, 127, 213, 214, 178, 67, 1, 239, 13, 139, 111, 218, 44,
        235, 164, 29, 161, 93, 64, 149, 209, 218, 57, 42, 13, 47, 142, 208, 198, 199, 188, 15, 76, 250, 200, 194,
        128, 181, 109, 103, 246, 122, 154, 2, 0, 0, 0, 190, 60, 48, 0, 0, 0, 0, 0, 248, 255, 255, 255, 226, 215,
        203, 106, 0, 0, 0, 0, 225, 215, 203, 106, 0, 0, 0, 0, 244, 220, 235, 154, 2, 0, 0, 0, 210, 214, 50, 0, 0,
        0, 0, 0, 98, 61, 42, 27, 0, 0, 0, 0, 0,
    ];

    #[test]
    fn parses_live_mainnet_account() {
        let u = parse_price_update(&MAINNET_SOL_USD).unwrap();
        assert_eq!(u.verification_level, VerificationLevel::Full);
        assert_eq!(u.feed_id, PYTH_SOL_USD_FEED_ID);
        assert_eq!(u.price, 11_181_684_327); // $111.81684327
        assert_eq!(u.conf, 3_161_278);
        assert_eq!(u.exponent, -8);
        assert_eq!(u.publish_time, 1_791_743_970);
        assert_eq!(u.prev_publish_time, 1_791_743_969);
        assert_eq!(u.ema_price, 11_189_083_380);
        assert_eq!(u.ema_conf, 3_331_794);
        assert_eq!(u.posted_slot, 455_753_058);

        let p = validate(&u, &PYTH_SOL_USD_FEED_ID, u.publish_time + 60, 60).unwrap();
        assert_eq!(p, UsdPrice { price: 11_181_684_327 - 3_161_278, exponent: -8 });
        // 1 SOL at the lower bound ≈ $111.78
        assert_eq!(lamports_to_usd_cents(1_000_000_000, &p), Some(11_178));
    }

    #[test]
    fn rejections() {
        let u = parse_price_update(&MAINNET_SOL_USD).unwrap();
        let f = PYTH_SOL_USD_FEED_ID;
        assert_eq!(validate(&u, &f, u.publish_time + 61, 60), Err(OracleIssue::Stale));
        assert!(validate(&u, &f, u.publish_time - 5, 60).is_ok()); // clock skew tolerated
        assert_eq!(validate(&u, &[1u8; 32], u.publish_time, 60), Err(OracleIssue::WrongFeed));
        let mut p = u;
        p.verification_level = VerificationLevel::Partial { num_signatures: 5 };
        assert_eq!(validate(&p, &f, u.publish_time, 60), Err(OracleIssue::NotFullyVerified));
        let mut p = u;
        p.price = 0;
        assert_eq!(validate(&p, &f, u.publish_time, 60), Err(OracleIssue::NonPositivePrice));
        let mut p = u;
        p.conf = (p.price as u64) / 49; // > 2%
        assert_eq!(validate(&p, &f, u.publish_time, 60), Err(OracleIssue::ConfidenceTooWide));
        let mut p = u;
        p.exponent = -40;
        assert_eq!(validate(&p, &f, u.publish_time, 60), Err(OracleIssue::BadExponent));

        let mut bad = MAINNET_SOL_USD;
        bad[0] ^= 1;
        assert_eq!(parse_price_update(&bad), Err(OracleIssue::Malformed));
        let mut bad = MAINNET_SOL_USD;
        bad[40] = 7;
        assert_eq!(parse_price_update(&bad), Err(OracleIssue::Malformed));
        assert_eq!(parse_price_update(&MAINNET_SOL_USD[..100]), Err(OracleIssue::Malformed));
        // Partial layout shifts the message by one byte.
        let mut partial = MAINNET_SOL_USD.to_vec();
        partial[40] = 0;
        partial.insert(41, 3);
        let pu = parse_price_update(&partial).unwrap();
        assert_eq!(pu.verification_level, VerificationLevel::Partial { num_signatures: 3 });
        assert_eq!(pu.price, u.price);
    }

    #[test]
    fn cents_conversion() {
        let p = UsdPrice { price: 150_00000000, exponent: -8 }; // $150
        assert_eq!(lamports_to_usd_cents(333_333_334, &p), Some(5_000)); // $50.00
        assert_eq!(lamports_to_usd_cents(333_333_333, &p), Some(4_999)); // rounds down
        assert_eq!(lamports_to_usd_cents(0, &p), Some(0));
        assert_eq!(lamports_to_usd_cents(u64::MAX, &p).is_some(), true);
        let p = UsdPrice { price: 150, exponent: 0 };
        assert_eq!(lamports_to_usd_cents(1_000_000_000, &p), Some(15_000));
        let p = UsdPrice { price: 15, exponent: 1 };
        assert_eq!(lamports_to_usd_cents(1_000_000_000, &p), Some(15_000));
    }
}
