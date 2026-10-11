use crate::{constants::BPS_DENOM, state::Params};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FeeSplit {
    pub total: u64,
    pub pool: u64,
    pub platform: u64,
    /// Creator gets the rounding remainder so the parts always sum to `total`.
    pub creator: u64,
}

/// Fee on a SOL amount, rounded up (in the protocol's favor), split per params.
pub fn compute_fee(sol_amount: u64, p: &Params) -> Option<FeeSplit> {
    let total = ceil_div((sol_amount as u128).checked_mul(p.fee_bps as u128)?, BPS_DENOM as u128)?;
    let total = u64::try_from(total).ok()?;
    let pool = ((total as u128) * p.fee_pool_share_bps as u128 / BPS_DENOM as u128) as u64;
    let platform = ((total as u128) * p.fee_platform_share_bps as u128 / BPS_DENOM as u128) as u64;
    let creator = total.checked_sub(pool)?.checked_sub(platform)?;
    Some(FeeSplit { total, pool, platform, creator })
}

pub fn ceil_div(a: u128, b: u128) -> Option<u128> {
    if b == 0 {
        return None;
    }
    a.checked_add(b - 1)?.checked_div(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_sums_and_matches_doc_example() {
        let p = Params::default();
        // $10,000 trade → $100 fee → 50 / 30 / 20 (concept doc §03), in lamports.
        let f = compute_fee(10_000_000_000, &p).unwrap();
        assert_eq!(f.total, 100_000_000);
        assert_eq!((f.pool, f.platform, f.creator), (50_000_000, 30_000_000, 20_000_000));
        for amt in [0u64, 1, 99, 101, 12_345_678, u64::MAX / 10_000] {
            let f = compute_fee(amt, &p).unwrap();
            assert_eq!(f.pool + f.platform + f.creator, f.total);
            assert!(f.total as u128 * 10_000 >= amt as u128 * p.fee_bps as u128);
        }
    }
}
