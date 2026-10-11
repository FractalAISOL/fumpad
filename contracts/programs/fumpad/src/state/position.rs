use anchor_lang::prelude::*;

use crate::constants::MAX_OPEN_TICKETS;

/// A wallet's reward-eligibility state for one coin. PDA ["position", mint, wallet].
/// Created (init_if_needed, paid by the user) on the first FUMPAD trade or `register_holdings`.
///
/// Eligibility uses two buckets so a new buy doesn't reset the clock on tokens already held:
/// - `matured`: tokens held ≥ min_hold_secs (eligible for tickets)
/// - `pending`: tokens added at `pending_since`; they move to `matured` once
///   `now - pending_since >= min_hold_secs` (lazily, in `settle`).
/// Adding while `pending` hasn't matured merges into `pending` and restarts its clock.
/// Eligible amounts are always capped by the wallet's actual token balance at sell time.
#[account]
#[derive(InitSpace)]
pub struct Position {
    pub bump: u8,
    pub wallet: Pubkey,
    pub mint: Pubkey,
    pub matured: u64,
    pub pending: u64,
    pub pending_since: i64,
    /// Next ticket PDA seed.
    pub next_ticket_seq: u64,
    /// Open/queued ticket accounts (Pubkey::default() = empty). Buys must pass all of
    /// them so the rebuy rule can be applied.
    pub open_tickets: [Pubkey; MAX_OPEN_TICKETS],
    pub open_count: u8,
    pub reserved: [u8; 64],
}

impl Position {
    /// Callers using `init_if_needed` must call this before the hooks.
    pub fn init_if_new(&mut self, wallet: Pubkey, mint: Pubkey, bump: u8) {
        if self.wallet == Pubkey::default() {
            self.wallet = wallet;
            self.mint = mint;
            self.bump = bump;
        }
    }

    /// Move `pending` into `matured` if its hold period has elapsed.
    pub fn settle(&mut self, now: i64, min_hold_secs: i64) {
        if self.pending > 0 && now.saturating_sub(self.pending_since) >= min_hold_secs {
            self.matured = self.matured.saturating_add(self.pending);
            self.pending = 0;
        }
    }

    /// Record newly acquired tokens (FUMPAD buy or registered holdings).
    pub fn add(&mut self, amount: u64, now: i64, min_hold_secs: i64) {
        self.settle(now, min_hold_secs);
        self.pending = self.pending.saturating_add(amount);
        self.pending_since = now;
    }
}
