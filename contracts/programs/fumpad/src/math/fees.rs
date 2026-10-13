use crate::{constants::BPS_DENOM, state::FeeSplitBps};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FeeSplit {
    pub total: u64,
    pub buyback: u64,
    pub platform: u64,
    pub creator: u64,
}

/// D32: split a claimed fee amount. Platform and creator get exact floors; the rounding remainder goes to the
/// buyback (reward pool), so the parts always sum to `total`.
pub fn split_fee(total: u64, s: &FeeSplitBps) -> FeeSplit {
    let platform = ((total as u128) * s.platform_bps as u128 / BPS_DENOM as u128) as u64;
    let creator = ((total as u128) * s.creator_bps as u128 / BPS_DENOM as u128) as u64;
    // platform + creator ≤ total because the shares sum to 10_000 (Params::is_valid).
    let buyback = total - platform - creator;
    FeeSplit { total, buyback, platform, creator }
}

/// D33: everything claimed before the launch fees are settled goes to the buyback balance.
pub fn launch_window_split(total: u64) -> FeeSplit {
    FeeSplit { total, buyback: total, platform: 0, creator: 0 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Params;

    #[test]
    fn split_sums_and_matches_spike() {
        let s = Params::default().fee_split();
        // spike: 8,934,810 claimed → 4,467,405 / 2,680,443 / 1,786,962
        let f = split_fee(8_934_810, &s);
        assert_eq!((f.buyback, f.platform, f.creator), (4_467_405, 2_680_443, 1_786_962));
        for t in [0u64, 1, 7, 99, 101, 1_202_049, u64::MAX] {
            let f = split_fee(t, &s);
            assert_eq!(f.buyback as u128 + f.platform as u128 + f.creator as u128, t as u128);
            assert!(f.buyback >= t / 2);
        }
        assert_eq!(launch_window_split(5), FeeSplit { total: 5, buyback: 5, platform: 0, creator: 0 });
    }
}
