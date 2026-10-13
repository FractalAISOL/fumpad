//! Pure reward logic (no account access): open-ticket list and claim math. v0.7: hold-time and rebuy planning
//! moved to the off-chain engine (SPEC v0.7 §5.4); the program only applies attested results.

use crate::{constants::BPS_DENOM, state::Position};
use anchor_lang::prelude::Pubkey;

pub fn push_open(pos: &mut Position, key: Pubkey) -> bool {
    if pos.open_tickets.contains(&key) {
        return false;
    }
    match pos.open_tickets.iter_mut().find(|k| **k == Pubkey::default()) {
        Some(slot) => {
            *slot = key;
            pos.open_count += 1;
            true
        }
        None => false,
    }
}

/// Idempotent: returns whether the key was present.
pub fn remove_open(pos: &mut Position, key: &Pubkey) -> bool {
    if *key == Pubkey::default() {
        return false;
    }
    match pos.open_tickets.iter_mut().find(|k| *k == key) {
        Some(slot) => {
            *slot = Pubkey::default();
            pos.open_count = pos.open_count.saturating_sub(1);
            true
        }
        None => false,
    }
}

/// Tokens owed for a ticket: `tokens × claim_bps / 10_000`, rounded down.
pub fn claim_amount(tokens: u64, claim_bps: u16) -> u64 {
    ((tokens as u128) * claim_bps as u128 / BPS_DENOM as u128) as u64
}

/// Per-claim cap: `pool × max_claim_pool_bps / 10_000`, rounded down.
pub fn claim_cap(pool: u64, max_claim_pool_bps: u16) -> u64 {
    ((pool as u128) * max_claim_pool_bps as u128 / BPS_DENOM as u128) as u64
}

/// An amount is payable from `pool` iff it is non-zero, within the per-claim cap and within the pool.
pub fn fits(amount: u64, pool: u64, max_claim_pool_bps: u16) -> bool {
    amount > 0 && amount <= claim_cap(pool, max_claim_pool_bps) && amount <= pool
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pos() -> Position {
        Position {
            bump: 0,
            wallet: Pubkey::new_unique(),
            mint: Pubkey::new_unique(),
            next_ticket_seq: 0,
            open_tickets: [Pubkey::default(); crate::constants::MAX_OPEN_TICKETS],
            open_count: 0,
            auto_claim_opt_out: 0,
            rent_payer: Pubkey::default(),
            tickets_created: 0,
            reserved: [0; 32],
        }
    }

    #[test]
    fn open_list_ops() {
        let mut s = pos();
        let (a, b, c) = (Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique());
        assert!(push_open(&mut s, a));
        assert!(!push_open(&mut s, a));
        assert!(push_open(&mut s, b));
        assert_eq!(s.open_count, 2);
        assert!(remove_open(&mut s, &a));
        assert!(!remove_open(&mut s, &a));
        assert!(!remove_open(&mut s, &Pubkey::default()));
        assert_eq!(s.open_count, 1);
        assert!(push_open(&mut s, c)); // reuses the freed slot
        assert_eq!(s.open_tickets[0], c);
        for _ in 0..3 {
            assert!(push_open(&mut s, Pubkey::new_unique()));
        }
        assert!(!push_open(&mut s, Pubkey::new_unique()), "5 max");
    }

    #[test]
    fn claim_math() {
        assert_eq!(claim_amount(1_000_000, 1_000), 100_000);
        assert_eq!(claim_amount(9, 1_000), 0);
        assert_eq!(claim_amount(u64::MAX, 10_000), u64::MAX);
        assert_eq!(claim_cap(1_000, 1_000), 100);
        assert!(fits(100, 1_000, 1_000));
        assert!(!fits(101, 1_000, 1_000));
        assert!(!fits(0, 1_000, 1_000));
        assert!(!fits(1, 9, 1_000));
        assert!(fits(1_000, 1_000, 10_000));
    }
}
