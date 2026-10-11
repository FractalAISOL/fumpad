use crate::constants::{BPS_DENOM, Q64};

/// Price in lamports per base unit, Q64.64. None if `tokens == 0` or overflow.
pub fn price_q64(lamports: u64, tokens: u64) -> Option<u128> {
    if tokens == 0 {
        return None;
    }
    // lamports < 2^64, so lamports * 2^64 < 2^128.
    ((lamports as u128) << 64).checked_div(tokens as u128)
}

/// True if `current` ≥ `reference` × multiple_bps / 10_000, compared exactly as
/// current × 10_000 ≥ reference × multiple_bps using 256-bit products.
pub fn meets_multiple(current_q64: u128, reference_q64: u128, multiple_bps: u32) -> bool {
    widening_mul(current_q64, BPS_DENOM as u128) >= widening_mul(reference_q64, multiple_bps as u128)
}

/// a × b as (hi, lo) u128 limbs; tuples compare lexicographically, i.e. as u256.
fn widening_mul(a: u128, b: u128) -> (u128, u128) {
    const M: u128 = u64::MAX as u128;
    let (a1, a0) = (a >> 64, a & M);
    let (b1, b0) = (b >> 64, b & M);
    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let p11 = a1 * b1;
    let mid = (p00 >> 64) + (p01 & M) + (p10 & M);
    let lo = (p00 & M) | (mid << 64);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    (hi, lo)
}

/// Lamports value of `tokens` at `price_q64`, rounded down.
pub fn lamports_for(tokens: u64, price_q64: u128) -> Option<u64> {
    let v = (tokens as u128).checked_mul(price_q64)? / Q64;
    u64::try_from(v).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ten_x() {
        let sell = price_q64(1_000, 1_000_000).unwrap();
        assert!(!meets_multiple(price_q64(9_999, 1_000_000).unwrap(), sell, 100_000));
        assert!(meets_multiple(price_q64(10_000, 1_000_000).unwrap(), sell, 100_000));
        assert!(meets_multiple(u128::MAX, u128::MAX / 20, 100_000));
        assert!(!meets_multiple(u128::MAX / 11, u128::MAX / 10, 100_000));
    }
}
