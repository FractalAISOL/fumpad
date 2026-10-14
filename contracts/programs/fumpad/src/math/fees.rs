use crate::{constants::BPS_DENOM, state::FeeSplitBps};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FeeSplit {
    pub total: u64,
    pub buyback: u64,
    pub platform: u64,
    pub creator: u64,
    /// Wallet-split policy only (`FeePolicy.wallet`).
    pub wallet: u64,
}

/// D32: split a claimed fee amount. Platform and creator get exact floors; the rounding remainder goes to the
/// buyback (reward pool), so the parts always sum to `total`.
pub fn split_fee(total: u64, s: &FeeSplitBps) -> FeeSplit {
    let platform = ((total as u128) * s.platform_bps as u128 / BPS_DENOM as u128) as u64;
    let creator = ((total as u128) * s.creator_bps as u128 / BPS_DENOM as u128) as u64;
    // platform + creator ≤ total because the shares sum to 10_000 (Params::is_valid).
    let buyback = total - platform - creator;
    FeeSplit { total, buyback, platform, creator, wallet: 0 }
}

/// D33: everything claimed before the launch fees are settled goes to the buyback balance.
pub fn launch_window_split(total: u64) -> FeeSplit {
    FeeSplit { total, buyback: total, platform: 0, creator: 0, wallet: 0 }
}

/// Wallet-split policy (first coin): the wallet gets the exact floor of `wallet_share / (buyback_share +
/// wallet_share)` of the claim, the rounding remainder goes to the buyback (like D32's split). Shares are
/// `FeePolicy::is_valid` (wallet_share > 0).
pub fn wallet_split(total: u64, buyback_share: u16, wallet_share: u16) -> FeeSplit {
    let den = buyback_share as u128 + wallet_share as u128;
    let wallet = ((total as u128) * wallet_share as u128 / den.max(1)) as u64;
    FeeSplit { total, buyback: total - wallet, platform: 0, creator: 0, wallet }
}

/// Wallet-split policy: the launch-window claim goes 100% to the wallet.
pub fn wallet_launch_window_split(total: u64) -> FeeSplit {
    FeeSplit { total, buyback: 0, platform: 0, creator: 0, wallet: total }
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
        assert_eq!(launch_window_split(5), FeeSplit { total: 5, buyback: 5, platform: 0, creator: 0, wallet: 0 });
    }

    #[test]
    fn wallet_split_first_coin() {
        // 1.0% of volume → buyback, 1.4% → wallet: of what we claim (2.4% of volume), 1/2.4 and 1.4/2.4.
        let f = wallet_split(2_400_000, 100, 140);
        assert_eq!((f.buyback, f.wallet, f.platform, f.creator), (1_000_000, 1_400_000, 0, 0));
        // Rounding: wallet = floor(t × 140 / 240), remainder → buyback.
        let f = wallet_split(1_000_001, 100, 140);
        assert_eq!(f.wallet, 583_333);
        assert_eq!(f.buyback, 416_668);
        for t in [0u64, 1, 2, 7, 239, 240, 241, 1_234_567, u64::MAX] {
            let f = wallet_split(t, 100, 140);
            assert_eq!(f.buyback as u128 + f.wallet as u128, t as u128);
            assert_eq!(f.wallet as u128, t as u128 * 140 / 240);
            assert!(f.buyback as u128 * 240 >= t as u128 * 100);
        }
        assert_eq!(wallet_split(9, 0, 140).wallet, 9);
        assert_eq!(wallet_launch_window_split(7), FeeSplit { total: 7, buyback: 0, platform: 0, creator: 0, wallet: 7 });
    }
}
