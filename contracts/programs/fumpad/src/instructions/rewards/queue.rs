//! ClaimQueue operations (pure, on the zero-copy struct). OWNER: rewards module.
//!
//! Invariants maintained here:
//! - `entries[..len]` sorted strictly ascending by `(sell_ts, ticket)`; no duplicate tickets.
//! - `total_owed == Σ entries[..len].amount`.

use anchor_lang::prelude::*;

use crate::{
    constants::CLAIM_QUEUE_CAPACITY,
    error::FumpadError,
    state::{ClaimQueue, QueueEntry},
};

use super::logic::fits;

pub fn order_key(sell_ts: i64, ticket: &Pubkey) -> (i64, [u8; 32]) {
    (sell_ts, ticket.to_bytes())
}

fn entry_key(e: &QueueEntry) -> (i64, [u8; 32]) {
    order_key(e.sell_ts, &e.ticket)
}

/// Is there a queued entry strictly ahead of `(sell_ts, ticket)` that fits the pool now?
pub fn has_older_fitting(q: &ClaimQueue, sell_ts: i64, ticket: &Pubkey, pool: u64, max_bps: u16) -> bool {
    let k = order_key(sell_ts, ticket);
    q.entries[..q.len as usize].iter().take_while(|e| entry_key(e) < k).any(|e| fits(e.amount, pool, max_bps))
}

/// Insert keeping sort order. Returns the new length.
pub fn insert(q: &mut ClaimQueue, e: QueueEntry) -> Result<u16> {
    let len = q.len as usize;
    require!(len < CLAIM_QUEUE_CAPACITY, FumpadError::QueueFull);
    let k = entry_key(&e);
    let pos = q.entries[..len].partition_point(|x| entry_key(x) < k);
    require!(pos == len || q.entries[pos].ticket != e.ticket, FumpadError::InvalidAccount);
    q.entries.copy_within(pos..len, pos + 1);
    q.entries[pos] = e;
    q.len += 1;
    q.total_owed = q.total_owed.checked_add(e.amount).ok_or(FumpadError::MathOverflow)?;
    Ok(q.len)
}

/// Remove the entry for `ticket` if present.
pub fn remove(q: &mut ClaimQueue, ticket: &Pubkey) -> Option<QueueEntry> {
    let len = q.len as usize;
    let i = q.entries[..len].iter().position(|e| e.ticket == *ticket)?;
    let e = q.entries[i];
    q.entries.copy_within(i + 1..len, i);
    q.entries[len - 1] = bytemuck::Zeroable::zeroed();
    q.len -= 1;
    q.total_owed = q.total_owed.saturating_sub(e.amount);
    Some(e)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn empty() -> Box<ClaimQueue> {
        Box::new(bytemuck::Zeroable::zeroed())
    }

    pub fn entry(sell_ts: i64, amount: u64) -> QueueEntry {
        QueueEntry { ticket: Pubkey::new_unique(), owner: Pubkey::new_unique(), amount, sell_ts }
    }

    fn sorted(q: &ClaimQueue) -> bool {
        q.entries[..q.len as usize].windows(2).all(|w| entry_key(&w[0]) < entry_key(&w[1]))
            && q.total_owed == q.entries[..q.len as usize].iter().map(|e| e.amount).sum::<u64>()
    }

    #[test]
    fn insert_sorted_remove_and_capacity() {
        let mut q = empty();
        let es: Vec<_> = [50, 10, 30, 10, 20].iter().map(|&ts| entry(ts, ts as u64)).collect();
        for e in &es {
            insert(&mut q, *e).unwrap();
            assert!(sorted(&q));
        }
        assert_eq!(q.len, 5);
        assert_eq!(q.entries[0].sell_ts, 10);
        assert_eq!(q.entries[4].sell_ts, 50);
        // duplicate ticket rejected
        assert!(insert(&mut q, es[2]).is_err());
        assert_eq!(remove(&mut q, &es[2].ticket).unwrap().sell_ts, 30);
        assert!(remove(&mut q, &es[2].ticket).is_none());
        assert!(sorted(&q));
        assert_eq!(q.len, 4);
        while (q.len as usize) < CLAIM_QUEUE_CAPACITY {
            let n = q.len as i64;
            insert(&mut q, entry(n, 1)).unwrap();
        }
        assert!(sorted(&q));
        assert!(insert(&mut q, entry(0, 1)).is_err());
    }

    /// `init_claim_queue` writes the header by byte offset; keep it in sync with the struct.
    #[test]
    fn header_offsets_match_init() {
        let mut q = empty();
        q.mint = Pubkey::new_from_array([7; 32]);
        q.len = 0x0102;
        q.bump = 9;
        let b = bytemuck::bytes_of(&*q);
        assert_eq!(&b[0..32], &[7u8; 32]);
        assert_eq!(&b[32..34], &[2, 1]);
        assert_eq!(b[34], 9);
        assert_eq!(core::mem::size_of::<ClaimQueue>(), 48 + 80 * CLAIM_QUEUE_CAPACITY);
    }

    #[test]
    fn older_fitting() {
        let mut q = empty();
        let big = entry(10, 500);
        let small = entry(20, 50);
        insert(&mut q, big).unwrap();
        insert(&mut q, small).unwrap();
        // pool 1_000, cap 100: `big` doesn't fit, `small` does.
        let me = Pubkey::new_unique();
        assert!(!has_older_fitting(&q, 15, &me, 1_000, 1_000));
        assert!(has_older_fitting(&q, 25, &me, 1_000, 1_000));
        assert!(!has_older_fitting(&q, 20, &Pubkey::default(), 1_000, 1_000)); // tie → by key
        assert!(!has_older_fitting(&q, 25, &me, 400, 1_000));
    }
}
