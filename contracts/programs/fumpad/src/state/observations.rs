use anchor_lang::prelude::*;

use crate::constants::OBSERVATION_CAPACITY;

/// Ring buffer of PumpSwap spot-price samples for one graduated coin.
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
    pub _pad: [u8; 3],
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

impl Observations {
    /// Median price of samples with `ts > now - window_secs`, or None if fewer than
    /// `min_samples` such samples exist. Used by `claim` (10x check) and `execute_buyback`
    /// (deviation guard).
    /// Even count → lower middle (conservative for the 10x check).
    pub fn median_price_q64(&self, now: i64, window_secs: i64, min_samples: u16) -> Option<u128> {
        let cutoff = now.checked_sub(window_secs)?;
        // Heap, not stack: SBF stack frames are 4KB.
        let mut prices: Vec<u128> = Vec::with_capacity(self.len as usize);
        for s in self.samples.iter().take(self.len as usize) {
            if s.ts > cutoff && s.ts <= now {
                prices.push(s.price_q64);
            }
        }
        let n = prices.len();
        if n == 0 || n < min_samples as usize {
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
        // Samples after `now` are ignored: at now=1_500 the window is (−300, 1_500] → i=44..=150.
        assert_eq!(o.median_price_q64(1_500, 1_800, 1), Some(97));
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
