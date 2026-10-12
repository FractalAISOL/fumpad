use crate::{
    constants::BPS_DENOM,
    state::{CoinFees, SnipeConfig},
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FeeSplit {
    pub total: u64,
    pub pool: u64,
    pub platform: u64,
    /// Creator gets the rounding remainder so the parts always sum to `total`.
    pub creator: u64,
}

/// Fee on a SOL amount, rounded up (in the protocol's favor), split per the coin's
/// snapshotted fee params (D14: `Coin.fees`, taken from `Global.params` at create_coin).
pub fn compute_fee(sol_amount: u64, p: &CoinFees) -> Option<FeeSplit> {
    let total = ceil_div((sol_amount as u128).checked_mul(p.fee_bps as u128)?, BPS_DENOM as u128)?;
    let total = u64::try_from(total).ok()?;
    let pool = ((total as u128) * p.fee_pool_share_bps as u128 / BPS_DENOM as u128) as u64;
    let platform = ((total as u128) * p.fee_platform_share_bps as u128 / BPS_DENOM as u128) as u64;
    let creator = total.checked_sub(pool)?.checked_sub(platform)?;
    Some(FeeSplit { total, pool, platform, creator })
}

// ── D19 snipe tax ────────────────────────────────────────────────────────────
//
// A curve buy at slot offset d = slot − launch_slot < W pays, ON TOP of the normal fee,
// a tax of t(d) = min(start_bps, ⌈10_000·(W − d)/W⌉) bps of (curve SOL + tax): the
// buyer's `sol_in` is split into `snipe_curve_offer` (offered to the curve) and the tax,
// so the total charged (curve + tax + normal fee on the curve part) never exceeds what
// the same `sol_in` costs outside the window — the sniper just gets fewer tokens. The
// normal fee is computed on the curve part and split 50/30/20 as always; the whole tax
// goes to the reward pool (inline buyback).

/// Tax rate (bps) for a buy in `slot` (0 outside the window, or when disabled).
pub fn snipe_tax_bps(cfg: &SnipeConfig, slot: u64) -> u16 {
    let w = cfg.window_slots as u64;
    let Some(d) = slot.checked_sub(cfg.launch_slot) else { return 0 };
    if w == 0 || d >= w {
        return 0;
    }
    // ⌈10_000·(w − d)/w⌉ ∈ (0, 10_000]; w ≤ u16::MAX so no overflow.
    let ramp = ((w - d) * BPS_DENOM).div_ceil(w);
    ramp.min(cfg.start_bps as u64) as u16
}

/// The part of `sol_in` offered to the curve at tax rate `bps`: ⌊sol_in·(10_000 − bps)/10_000⌋.
pub fn snipe_curve_offer(sol_in: u64, bps: u16) -> Option<u64> {
    let keep = BPS_DENOM.checked_sub(bps as u64)?;
    u64::try_from((sol_in as u128).checked_mul(keep as u128)? / BPS_DENOM as u128).ok()
}

/// Tax on a buy whose curve part was `sol_used`: ⌈sol_used·bps/(10_000 − bps)⌉ (so the
/// tax is `bps` of curve + tax, rounded up). With `sol_used ≤ snipe_curve_offer(sol_in)`,
/// `sol_used + tax ≤ sol_in`. None for bps ≥ 10_000 or overflow.
pub fn snipe_tax(sol_used: u64, bps: u16) -> Option<u64> {
    if bps == 0 {
        return Some(0);
    }
    let keep = BPS_DENOM.checked_sub(bps as u64).filter(|k| *k > 0)?;
    u64::try_from(ceil_div((sol_used as u128).checked_mul(bps as u128)?, keep as u128)?).ok()
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
    use crate::state::Params;

    #[test]
    fn split_sums_and_matches_doc_example() {
        let p = Params::default().coin_fees();
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

    #[test]
    fn snipe_schedule_default() {
        let cfg = Params::default().snipe_config(1_000);
        let got: Vec<u16> = (998..1_006).map(|s| snipe_tax_bps(&cfg, s)).collect();
        // before launch (impossible) / offsets 0..3 / 4.. → normal
        assert_eq!(got, vec![0, 0, 9_900, 7_500, 5_000, 2_500, 0, 0]);
        assert_eq!(snipe_tax_bps(&cfg, u64::MAX), 0);
        // Disabled.
        let off = SnipeConfig { window_slots: 0, ..cfg };
        assert_eq!(snipe_tax_bps(&off, 1_000), 0);
        // Ramp rounds up; start caps it.
        let c3 = SnipeConfig { launch_slot: 0, window_slots: 3, start_bps: 9_900 };
        assert_eq!((0..4).map(|s| snipe_tax_bps(&c3, s)).collect::<Vec<_>>(), vec![9_900, 6_667, 3_334, 0]);
        let c5 = SnipeConfig { launch_slot: 0, window_slots: 5, start_bps: 5_000 };
        assert_eq!((0..6).map(|s| snipe_tax_bps(&c5, s)).collect::<Vec<_>>(), vec![5_000, 5_000, 5_000, 4_000, 2_000, 0]);
        let max = SnipeConfig { launch_slot: 7, window_slots: crate::constants::MAX_SNIPE_WINDOW_SLOTS, start_bps: 9_900 };
        assert_eq!(snipe_tax_bps(&max, 7 + 49), 200);
        assert_eq!(snipe_tax_bps(&max, 7 + 50), 0);
    }

    #[test]
    fn snipe_tax_never_exceeds_sol_in() {
        for bps in [0u16, 1, 2_500, 5_000, 6_667, 7_500, 9_899, 9_900] {
            for sol_in in [0u64, 1, 2, 99, 100, 101, 12_345, 1_000_000_007, 30_000_000_000, u64::MAX / 10_000] {
                let offer = snipe_curve_offer(sol_in, bps).unwrap();
                for used in [offer, offer / 2, offer.saturating_sub(1)] {
                    let tax = snipe_tax(used, bps).unwrap();
                    assert!(used as u128 + tax as u128 <= sol_in as u128, "bps {bps} sol_in {sol_in} used {used}");
                    // The tax is at least `bps` of (used + tax): rounded in the pool's favour.
                    assert!(tax as u128 * 10_000 >= (used as u128 + tax as u128) * bps as u128);
                }
            }
        }
        // 99%: 1 SOL offered → 0.01 SOL to the curve, 0.99 SOL tax.
        assert_eq!(snipe_curve_offer(1_000_000_000, 9_900), Some(10_000_000));
        assert_eq!(snipe_tax(10_000_000, 9_900), Some(990_000_000));
        assert_eq!(snipe_tax(10_000_000, 0), Some(0));
        assert_eq!(snipe_tax(1, 10_000), None);
    }
}
