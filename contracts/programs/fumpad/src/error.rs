use anchor_lang::prelude::*;

/// Single error enum for the program. Modules add variants ONLY inside their own
/// section (keep the section order) so parallel branches merge cleanly.
#[error_code]
pub enum FumpadError {
    // ── common ──────────────────────────────────────────────────────────────
    #[msg("Not implemented")]
    NotImplemented,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid parameters")]
    InvalidParams,
    #[msg("Paused")]
    Paused,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Slippage exceeded")]
    SlippageExceeded,
    #[msg("Zero amount")]
    ZeroAmount,
    #[msg("Invalid account")]
    InvalidAccount,
    #[msg("Wrong coin status for this action")]
    WrongCoinStatus,

    // ── curve / launch / graduation ─────────────────────────────────────────
    #[msg("Name, symbol or URI too long")]
    MetadataTooLong,
    #[msg("Curve has no tokens left")]
    CurveExhausted,
    #[msg("Curve is not complete")]
    CurveNotComplete,
    #[msg("Insufficient reserves")]
    InsufficientReserves,
    #[msg("Name and symbol must not be empty")]
    EmptyMetadata,
    #[msg("PumpSwap pool creation did not move the expected amounts")]
    GraduationMismatch,

    // ── rewards / claims / queue ────────────────────────────────────────────
    #[msg("Oracle price is stale or invalid")]
    StaleOraclePrice,
    #[msg("Ticket is not open")]
    TicketNotOpen,
    #[msg("Ticket has expired")]
    TicketExpired,
    #[msg("Price has not held 10x the sell price")]
    TriggerNotMet,
    #[msg("Not enough price samples in the window")]
    InsufficientSamples,
    #[msg("Claim queue is full")]
    QueueFull,
    #[msg("Open tickets passed do not match the position")]
    OpenTicketsMismatch,
    #[msg("Ticket cannot be closed yet")]
    TicketNotClosable,
    #[msg("Coin lamport accounting invariant violated")]
    LamportInvariant,

    // ── venue / router / oracle / buyback ───────────────────────────────────
    #[msg("Wrong venue program or pool")]
    WrongVenue,
    #[msg("Sample too soon after the previous one")]
    SampleTooSoon,
    #[msg("Sampling transaction must contain only the sampling instruction")]
    SampleTxNotIsolated,
    #[msg("Spot price deviates too far from the median")]
    PriceDeviation,
    #[msg("Nothing to buy back")]
    NothingToBuyBack,
    #[msg("No skimmed LP fees to settle")]
    NothingToSettle,
}
