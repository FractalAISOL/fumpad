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

/// ⌈a × b ÷ d⌉ with a 256-bit intermediate. None if d == 0 or the quotient > u128::MAX.
pub fn mul_div_ceil(a: u128, b: u128, d: u128) -> Option<u128> {
    if d == 0 {
        return None;
    }
    let (hi, lo) = widening_mul(a, b);
    if hi == 0 {
        return Some(lo / d + (lo % d != 0) as u128);
    }
    if hi >= d {
        return None;
    }
    // Long division of (hi, lo) by d; the remainder stays < d throughout.
    let (mut rem, mut q) = (hi, 0u128);
    for i in (0..128).rev() {
        let carry = rem >> 127;
        rem = (rem << 1) | ((lo >> i) & 1);
        q <<= 1;
        if carry == 1 || rem >= d {
            rem = rem.wrapping_sub(d);
            q |= 1;
        }
    }
    if rem != 0 {
        q = q.checked_add(1)?;
    }
    Some(q)
}

/// Meteora DBC / DAMM v2 `sqrt_price` (Q64.64 of √(quote raw / base raw)) → price in lamports per base unit,
/// Q64.64: `sqrt² >> 64`, rounded down. None if the result doesn't fit u128 (never for FUMPAD-range prices).
pub fn price_q64_from_sqrt(sqrt_price: u128) -> Option<u128> {
    let (hi, lo) = widening_mul(sqrt_price, sqrt_price);
    if hi >> 64 != 0 {
        return None;
    }
    Some((hi << 64) | (lo >> 64))
}

/// a × b as (hi, lo) u128 limbs; tuples compare lexicographically, i.e. as u256.
pub fn widening_mul(a: u128, b: u128) -> (u128, u128) {
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

    #[test]
    fn sqrt_price_conversion() {
        // Spike DAMM read: sqrt 36563035070389125 → 3.9287e-9 SOL/token = 3.9287e-6 lamports per base unit.
        let p = price_q64_from_sqrt(36_563_035_070_389_125).unwrap();
        let lamports_per_unit = p as f64 / Q64 as f64;
        assert!((lamports_per_unit - 3.9287e-6).abs() < 1e-9, "{lamports_per_unit}");
        assert_eq!(price_q64_from_sqrt(1u128 << 64), Some(1u128 << 64)); // price 1
        assert_eq!(price_q64_from_sqrt(0), Some(0));
        assert_eq!(price_q64_from_sqrt(u128::MAX), None);
        // Exact: (2^64 · 3)² >> 64 = 9 · 2^64.
        assert_eq!(price_q64_from_sqrt(3u128 << 64), Some(9u128 << 64));
    }

    #[test]
    fn mul_div_ceil_exact_and_wide() {
        assert_eq!(mul_div_ceil(10, 10, 3), Some(34));
        assert_eq!(mul_div_ceil(10, 9, 3), Some(30));
        assert_eq!(mul_div_ceil(0, 9, 3), Some(0));
        assert_eq!(mul_div_ceil(1, 1, 0), None);
        // 256-bit intermediates.
        assert_eq!(mul_div_ceil(u128::MAX, u128::MAX, u128::MAX), Some(u128::MAX));
        assert_eq!(mul_div_ceil(u128::MAX, 1 << 64, 1 << 64), Some(u128::MAX));
        assert_eq!(mul_div_ceil(u128::MAX, 3, 3), Some(u128::MAX));
        assert_eq!(mul_div_ceil(u128::MAX, 2, 3), Some(u128::MAX / 3 * 2));
        assert_eq!(mul_div_ceil(u128::MAX, u128::MAX, u128::MAX - 1), None);
        assert_eq!(mul_div_ceil(1 << 100, 1 << 100, 1 << 90), Some(1 << 110));
        assert_eq!(mul_div_ceil(1 << 100, (1 << 100) + 1, 1 << 90), Some((1 << 110) + (1 << 10)));
        assert_eq!(mul_div_ceil((1 << 100) + 1, 1 << 100, (1 << 90) * 3), Some(((1u128 << 110) + (1 << 10)) / 3 + 1));
        // Against a u128 reference on random-ish inputs that fit.
        let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
        for _ in 0..2_000 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let (a, b, d) = ((x >> 3) as u128, (x.rotate_left(21) >> 5) as u128, (x.rotate_left(40) as u128 >> 9) + 1);
            let exact = a * b;
            assert_eq!(mul_div_ceil(a, b, d), Some(exact.div_ceil(d)));
            // Same quotient computed in the wide path: scale a and d by 2^64.
            assert_eq!(mul_div_ceil(a << 64, b, d << 64), Some(exact.div_ceil(d)));
        }
    }
}
