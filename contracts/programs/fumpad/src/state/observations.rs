use anchor_lang::prelude::*;

use crate::constants::OBSERVATION_CAPACITY;

/// Ring buffer of DAMM v2 spot-price samples (from `sqrt_price`) for one graduated coin.
/// PDA ["observations", mint]. Zero-copy; created by `init_observations` after graduation.
/// OWNER: venue/oracle module.
#[account(zero_copy)]
#[repr(C)]
pub struct Observations {
    pub mint: Pubkey,
    pub pool: Pubkey,
    /// Index the next sample will be written to.
    pub head: u16,
    /// Number of valid samples (≤ capacity).
    pub len: u16,
    pub bump: u8,
    /// 1 once a keeper sample has been recorded (`last_keeper_sample_ts` is then that
    /// sample's time; before, it is the `init_observations` time = fallback grace start).
    pub keeper_sampled: u8,
    pub _pad: [u8; 2],
    pub last_keeper_sample_ts: i64,
    pub samples: [Observation; OBSERVATION_CAPACITY],
}

#[zero_copy]
#[repr(C)]
pub struct Observation {
    pub ts: i64,
    /// 1 if recorded through the permissionless fallback path.
    pub fallback: u64,
    pub price_q64: u128,
}

/// V-L2: the window is split into this many equal sub-buckets for the time-spread check.
pub const COVERAGE_BUCKETS: i64 = 6;
/// V-L2: keeper samples must be present in at least this many of the sub-buckets.
pub const MIN_COVERED_BUCKETS: u32 = 5;

impl Observations {
    /// Median price of KEEPER samples with `ts` in `(now - window_secs, now]`, or None
    /// unless coverage is met: at least `min_samples` such samples (count) AND samples in
    /// at least `MIN_COVERED_BUCKETS` of the window's `COVERAGE_BUCKETS` equal sub-buckets
    /// (time spread, V-L2). Fallback (permissionless) samples are excluded from both the
    /// median and the coverage (V-M1): they are a liveness signal only, so during a keeper
    /// outage claims and buybacks pause (InsufficientSamples).
    /// Used by `claim` (10x check) and `execute_buyback` (deviation guard).
    /// Even count → lower middle (conservative for the 10x check).
    pub fn median_price_q64(&self, now: i64, window_secs: i64, min_samples: u16) -> Option<u128> {
        let cutoff = now.checked_sub(window_secs)?;
        let bucket_secs = (window_secs / COVERAGE_BUCKETS).max(1);
        // Heap, not stack: SBF stack frames are 4KB.
        let mut prices: Vec<u128> = Vec::with_capacity(self.len as usize);
        let mut buckets: u32 = 0;
        for s in self.samples.iter().take(self.len as usize) {
            if s.fallback == 0 && s.ts > cutoff && s.ts <= now {
                prices.push(s.price_q64);
                let b = ((now - s.ts) / bucket_secs).min(COVERAGE_BUCKETS - 1);
                buckets |= 1 << b;
            }
        }
        let n = prices.len();
        if n == 0 || n < min_samples as usize || buckets.count_ones() < MIN_COVERED_BUCKETS {
            return None;
        }
        prices.sort_unstable();
        Some(prices[(n - 1) / 2])
    }

    /// Timestamp of the most recent sample, if any.
    pub fn last_ts(&self) -> Option<i64> {
        if self.len == 0 {
            return None;
        }
        let idx = (self.head as usize + OBSERVATION_CAPACITY - 1) % OBSERVATION_CAPACITY;
        Some(self.samples[idx].ts)
    }

    pub fn push(&mut self, ts: i64, price_q64: u128, fallback: bool) {
        let i = self.head as usize % OBSERVATION_CAPACITY;
        self.samples[i] = Observation { ts, fallback: fallback as u64, price_q64 };
        self.head = ((i + 1) % OBSERVATION_CAPACITY) as u16;
        if (self.len as usize) < OBSERVATION_CAPACITY {
            self.len += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty() -> Box<Observations> {
        Box::new(bytemuck::Zeroable::zeroed())
    }

    #[test]
    fn median_window_and_coverage() {
        let mut o = empty();
        assert_eq!(o.median_price_q64(1_000, 1_800, 1), None);
        // 300 samples every 10s: ring wraps; only the last 256 survive.
        for i in 0..300i64 {
            o.push(i * 10, i as u128, false);
        }
        assert_eq!(o.len as usize, OBSERVATION_CAPACITY);
        assert_eq!(o.last_ts(), Some(2_990));
        // Window (1190, 2990] → samples 120..=299 (180 samples) → lower median = 209.
        assert_eq!(o.median_price_q64(2_990, 1_800, 84), Some(209));
        assert_eq!(o.median_price_q64(2_990, 1_800, 181), None);
        // Samples after `now` are ignored: at now=1_500 the window is (−300, 1_500] → the
        // surviving i=44..=150 (ts 440..1_500) only cover 4 of the 6 five-minute buckets.
        assert_eq!(o.median_price_q64(1_500, 1_800, 1), None);
        // With a 1_200 s window ((300, 1_500] → i=44..=150, buckets of 200 s, all 6 covered).
        assert_eq!(o.median_price_q64(1_500, 1_200, 1), Some(97));
    }

    /// V-M1: fallback samples never count (median nor coverage).
    #[test]
    fn fallback_samples_excluded() {
        let mut o = empty();
        for i in 0..120i64 {
            o.push(i * 15, 100, false);
        }
        assert_eq!(o.median_price_q64(119 * 15, 1_800, 84), Some(100));
        // Half the samples are fallback: only the 60 keeper ones count toward coverage.
        let mut o2 = empty();
        for i in 0..120i64 {
            o2.push(i * 15, 100, i % 2 == 0);
        }
        assert_eq!(o2.median_price_q64(119 * 15, 1_800, 84), None, "only 60 keeper samples");
        assert_eq!(o2.median_price_q64(119 * 15, 1_800, 60), Some(100));
        let mut o3 = empty();
        for i in 0..120i64 {
            o3.push(i * 15, if i % 3 == 0 { 100 } else { 1_000_000 }, i % 3 != 0);
        }
        assert_eq!(o3.median_price_q64(119 * 15, 1_800, 40), Some(100));
    }

    /// V-L2: the count alone is not enough — samples must be spread over ≥ 5 of the 6
    /// five-minute buckets of the 30-min window.
    #[test]
    fn coverage_requires_time_spread() {
        // 84 samples 10 s apart = 830 s → 3 buckets.
        let mut o = empty();
        for i in 0..84i64 {
            o.push(10_000 + i * 10, 100, false);
        }
        assert_eq!(o.median_price_q64(10_830, 1_800, 84), None);
        // 84 samples 21 s apart = 1,743 s → all 6 buckets.
        let mut o = empty();
        for i in 0..84i64 {
            o.push(10_000 + i * 21, 100, false);
        }
        assert_eq!(o.median_price_q64(10_000 + 83 * 21, 1_800, 84), Some(100));
        // 5 of 6 buckets is enough: one 5-minute gap (bucket 2 empty) at full rate otherwise.
        let mut o = empty();
        let now = 20_000;
        for i in 0..120i64 {
            let ts = now - i * 15;
            if !(now - ts >= 600 && now - ts < 900) {
                o.push(ts, 100, false);
            }
        }
        assert_eq!(o.median_price_q64(now, 1_800, 84), Some(100));
        // Two empty buckets → no median.
        let mut o = empty();
        for i in 0..120i64 {
            let ts = now - i * 15;
            if !(now - ts >= 600 && now - ts < 1_200) {
                o.push(ts, 100, false);
            }
        }
        assert_eq!(o.median_price_q64(now, 1_800, 60), None);
    }

    #[test]
    fn spike_does_not_move_median() {
        let mut o = empty();
        for i in 0..120i64 {
            let p = if i % 3 == 0 { 1_000_000 } else { 100 }; // 1/3 of samples manipulated
            o.push(i * 15, p, false);
        }
        assert_eq!(o.median_price_q64(119 * 15, 1_800, 84), Some(100));
    }
}
