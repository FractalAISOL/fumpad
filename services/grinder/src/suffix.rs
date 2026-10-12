//! Base58 suffix matching without encoding every candidate.
//!
//! A Solana address is the base58 encoding of the 32-byte public key read as one
//! big-endian integer (leading zero bytes become leading `1`s, which only affects the
//! prefix). Its last `k` characters are therefore the base-58 digits of
//! `n mod 58^k`, so a candidate matches iff that remainder equals the suffix's value.
//! That is ~32 cheap u64 steps instead of a full base58 encode; matches are then
//! confirmed with a real `bs58` encode before they are stored.

pub const ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// Longest suffix the u64 fast path supports (58^9 · 256 < 2^64).
pub const MAX_SUFFIX_LEN: usize = 9;

#[derive(Clone, Debug)]
pub struct Matcher {
    pub suffix: String,
    modulus: u64,
    target: u64,
}

impl Matcher {
    pub fn new(suffix: &str) -> Result<Self, String> {
        if suffix.is_empty() {
            return Err("suffix must not be empty".into());
        }
        if suffix.len() > MAX_SUFFIX_LEN {
            return Err(format!("suffix longer than {MAX_SUFFIX_LEN} characters"));
        }
        let mut modulus: u64 = 1;
        let mut target: u64 = 0;
        for c in suffix.bytes() {
            let d = ALPHABET
                .iter()
                .position(|&a| a == c)
                .ok_or_else(|| format!("`{}` is not a base58 character (base58 has no 0, O, I or l)", c as char))?;
            target = target * 58 + d as u64;
            modulus *= 58;
        }
        Ok(Self { suffix: suffix.to_string(), modulus, target })
    }

    /// Expected number of random keys per match (58^len).
    pub fn expected_tries(&self) -> u64 {
        self.modulus
    }

    #[inline(always)]
    pub fn matches(&self, pubkey: &[u8; 32]) -> bool {
        let m = self.modulus;
        let mut r: u64 = 0;
        for &b in pubkey {
            r = ((r << 8) | b as u64) % m;
        }
        r == self.target
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_base58() {
        assert!(Matcher::new("fmbl").is_err(), "lowercase l is not base58");
        assert!(Matcher::new("0").is_err());
        assert!(Matcher::new("").is_err());
        assert!(Matcher::new("1234567890").is_err());
        assert!(Matcher::new("fmbL").is_ok());
    }

    #[test]
    fn fast_path_agrees_with_bs58() {
        use rand_core::{OsRng, RngCore};
        for suffix in ["L", "bL", "mbL", "z", "1", "11"] {
            let m = Matcher::new(suffix).unwrap();
            let mut hits = 0;
            for i in 0..200_000u32 {
                let mut k = [0u8; 32];
                OsRng.fill_bytes(&mut k);
                if i % 7 == 0 {
                    k[0] = 0; // leading zero bytes only change the prefix
                }
                let s = bs58::encode(k).into_string();
                assert_eq!(m.matches(&k), s.ends_with(suffix), "{suffix} vs {s}");
                hits += m.matches(&k) as u32;
            }
            assert!(hits > 0 || suffix.len() > 2);
        }
    }
}
