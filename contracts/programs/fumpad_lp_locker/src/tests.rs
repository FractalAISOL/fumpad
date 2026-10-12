//! Pure-math tests of the locker's √k accounting (integration tests: tests/src/locker_tests.rs).
use super::*;

fn lock_with(held0: u64, x0: u64, q0: u64, l0: u64) -> Lock {
    let xq = x0 as u128 * q0 as u128;
    let s = isqrt(xq);
    let s0 = if s * s < xq { s + 1 } else { s };
    Lock {
        bump: 0,
        pool: Pubkey::default(),
        mint: Pubkey::default(),
        lp_mint: Pubkey::default(),
        lp_vault: Pubkey::default(),
        base_dest: Pubkey::default(),
        quote_dest: Pubkey::default(),
        principal_num: held0 as u128 * s0,
        lp_supply_at_lock: l0,
        lp_locked: held0,
        locked_at: 0,
        lp_skimmed: 0,
        base_skimmed: 0,
        quote_skimmed: 0,
    }
}

/// PumpSwap-style proportional withdraw (floor), returns new (x, q, L).
fn withdraw(x: u64, q: u64, l: u64, lp_in: u64) -> (u64, u64, u64) {
    let bo = (lp_in as u128 * x as u128 / l as u128) as u64;
    let qo = (lp_in as u128 * q as u128 / l as u128) as u64;
    (x - bo, q - qo, l - lp_in)
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.next() % (hi - lo)
    }
}

#[test]
fn isqrt_exact() {
    for n in [0u128, 1, 2, 3, 4, 15, 16, 17, 99, 100, 101, u64::MAX as u128, u128::MAX] {
        let s = isqrt(n);
        assert!(s * s <= n, "{n}");
        assert!((s + 1).checked_mul(s + 1).map_or(true, |v| v > n), "{n}");
    }
    let mut r = Rng(7);
    for _ in 0..5_000 {
        let n = (r.next() as u128) * (r.next() as u128);
        let s = isqrt(n);
        assert!(s * s <= n && (s + 1).checked_mul(s + 1).map_or(true, |v| v > n));
    }
}

#[test]
fn mul_div_ceil_matches_reference() {
    assert_eq!(mul_div_ceil(10, 10, 3), Some(34));
    assert_eq!(mul_div_ceil(1, 1, 0), None);
    assert_eq!(mul_div_ceil(u128::MAX, u128::MAX, u128::MAX), Some(u128::MAX));
    assert_eq!(mul_div_ceil(u128::MAX, u128::MAX, u128::MAX - 1), None);
    let mut r = Rng(11);
    for _ in 0..2_000 {
        let (a, b, d) = (r.next() as u128, r.next() as u128 >> 3, (r.next() as u128) + 1);
        assert_eq!(mul_div_ceil(a << 64, b, d << 64), Some((a * b).div_ceil(d)));
    }
}

#[test]
fn quote_value_never_exceeds_real_liquidity() {
    assert_eq!(quote_value(100, 0, 0), 100);
    assert_eq!(quote_value(100, -30, 30), 70); // v2 fees waiting in the vault
    assert_eq!(quote_value(100, 50, 0), 100); // boost: real liquidity only
    assert_eq!(quote_value(100, 5, 3), 97);
    assert_eq!(quote_value(100, -200, 0), 0);
    assert_eq!(quote_value(u64::MAX, i128::MAX, 0), u64::MAX);
}

#[test]
fn nothing_to_skim_without_growth() {
    // Fresh lock, reserves unchanged, or only proportional deposits/withdrawals by others.
    let mut r = Rng(3);
    for _ in 0..2_000 {
        let (x, q) = (r.range(1_000_000, 1 << 50), r.range(1_000_000, 1 << 50));
        let l = isqrt(x as u128 * q as u128) as u64;
        let held = l - r.range(0, 1_000);
        let lock = lock_with(held, x, q, l);
        assert!(lock.keep(isqrt(x as u128 * q as u128), l).unwrap() > held);
        // Another LP deposits d LP worth (pays ceil), the pool is now bigger.
        let d = r.range(1, l);
        let (x2, q2) = (x + (d as u128 * x as u128).div_ceil(l as u128) as u64, q + (d as u128 * q as u128).div_ceil(l as u128) as u64);
        assert!(lock.keep(isqrt(x2 as u128 * q2 as u128), l + d).unwrap() > held);
    }
}

/// Fee growth → skim exactly the excess; after the (floor-rounded) withdraw the LP left is
/// still worth ≥ the principal, repeatedly, under random growth, deposits and withdrawals.
#[test]
fn skim_never_touches_principal() {
    let mut r = Rng(42);
    let mut skims = 0;
    for _ in 0..500 {
        let (mut x, mut q) = (r.range(1 << 30, 1 << 50), r.range(1 << 30, 1 << 50));
        let mut l = isqrt(x as u128 * q as u128) as u64;
        let mut held = l - 100; // PumpSwap may keep a little
        let lock = lock_with(held, x, q, l);
        let p_exact = held as f64 * ((x as f64) * (q as f64)).sqrt() / l as f64;
        for _ in 0..20 {
            match r.next() % 4 {
                // Swaps / donations: k grows by 0–3%, price moves either way.
                // (PumpSwap rounds swaps in the pool's favour: k never decreases.)
                0 | 1 => {
                    let k = x as u128 * q as u128;
                    let g = 1.0 + (r.next() % 300) as f64 / 10_000.0;
                    let m = 0.5 + (r.next() % 1000) as f64 / 1000.0;
                    x = ((x as f64) * m.sqrt() * g.sqrt()) as u64;
                    q = ((q as f64) / m.sqrt() * g.sqrt()) as u64;
                    q += (k.saturating_sub(x as u128 * q as u128)).div_ceil(x as u128) as u64;
                }
                // Third-party deposit (ceil) or withdraw (floor) of their own LP.
                2 => {
                    let d = r.range(1, l / 2);
                    x += (d as u128 * x as u128).div_ceil(l as u128) as u64;
                    q += (d as u128 * q as u128).div_ceil(l as u128) as u64;
                    l += d;
                }
                _ => {
                    let other = l - held;
                    if other > 1 {
                        (x, q, l) = withdraw(x, q, l, r.range(1, other));
                    }
                }
            }
            let s = isqrt(x as u128 * q as u128);
            let lp_in = held.saturating_sub(lock.keep(s, l).unwrap());
            if lp_in >= MIN_SKIM_LP {
                (x, q, l) = withdraw(x, q, l, lp_in);
                held -= lp_in;
                skims += 1;
                // The program's post-skim check (exact, 256-bit, √ floored) must pass.
                assert!(lock.covers(held, isqrt(x as u128 * q as u128), l), "principal violated");
            }
            let value = held as f64 * ((x as f64) * (q as f64)).sqrt() / l as f64;
            assert!(value >= p_exact * (1.0 - 1e-9), "{value} < {p_exact}");
        }
    }
    assert!(skims > 1_000, "only {skims} skims exercised");
}

#[test]
fn covers_is_exact() {
    let lock = lock_with(1_000, 100, 100, 1_000); // P = 1000 · 100 / 1000 = 100 √k units
    assert!(lock.covers(1_000, 100, 1_000));
    assert!(!lock.covers(999, 100, 1_000));
    assert!(lock.covers(500, 200, 1_000));
    assert!(!lock.covers(499, 200, 1_000));
}

/// H-1 (was C-Info4 "exact length"): the locker reads the stable 287-byte prefix of any Pool
/// at least that long (PumpSwap's `extend_account` grows pools to 301 bytes), and refuses
/// shorter pools and a wrong discriminator. Identity cross-checks: `locker_tests`.
#[test]
fn parse_pool_accepts_extended_pools_and_refuses_short_ones() {
    let mut d = vec![0u8; POOL_LEN];
    d[..8].copy_from_slice(&POOL_DISCRIMINATOR);
    d[8] = 253;
    d[9..11].copy_from_slice(&3u16.to_le_bytes());
    d[203..211].copy_from_slice(&7u64.to_le_bytes());
    d[271..279].copy_from_slice(&5u64.to_le_bytes());
    d[279..287].copy_from_slice(&6u64.to_le_bytes());
    let p = parse_pool(&d).unwrap();
    assert_eq!((p.bump, p.index, p.lp_supply, p.waiting_fees), (253, 3, 7, 11));
    for len in [POOL_LEN, 288, 301, 1_024] {
        let mut x = d.clone();
        x.resize(len, 0xAB); // appended fields never change the prefix read
        let q = parse_pool(&x).unwrap();
        assert_eq!((q.bump, q.index, q.lp_supply, q.waiting_fees), (253, 3, 7, 11), "len {len}");
    }
    for len in [0usize, 7, 8, 211, 261, 286] {
        let mut x = d.clone();
        x.resize(len, 0);
        if len >= 8 {
            x[..8].copy_from_slice(&POOL_DISCRIMINATOR);
        }
        assert!(parse_pool(&x).is_err(), "len {len} accepted");
    }
    let mut bad = d.clone();
    bad.resize(301, 0);
    bad[0] ^= 1;
    assert!(parse_pool(&bad).is_err());
}
