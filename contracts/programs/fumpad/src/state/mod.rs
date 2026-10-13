pub mod claim_queue;
pub mod coin;
pub mod consumed;
pub mod global;
pub mod observations;
pub mod position;
pub mod ticket;

pub use claim_queue::*;
pub use coin::*;
pub use consumed::*;
pub use global::*;
pub use observations::*;
pub use position::*;
pub use ticket::*;

#[cfg(test)]
mod size_tests {
    use super::*;
    use anchor_lang::Space;

    /// v0.7 fresh layouts (D39): account sizes incl. the 8-byte discriminator (INTERFACE §5, CONTRACTS.md).
    #[test]
    fn account_sizes() {
        assert_eq!(8 + Global::INIT_SPACE, 1_044);
        assert_eq!(Params::INIT_SPACE, 168);
        assert_eq!(8 + Coin::INIT_SPACE, 546);
        assert_eq!(8 + Position::INIT_SPACE, 315);
        assert_eq!(8 + Ticket::INIT_SPACE, 276);
        assert_eq!(8 + Consumed::INIT_SPACE, 98);
        assert_eq!(8 + core::mem::size_of::<ClaimQueue>(), 81_976);
        assert_eq!(8 + core::mem::size_of::<Observations>(), 8_280);
    }
}
