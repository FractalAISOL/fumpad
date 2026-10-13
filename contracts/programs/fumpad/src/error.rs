use anchor_lang::prelude::*;

/// v0.7 (D39): fresh error enum, codes 6000 + index. Append only (INTERFACE-v0.7.md §7).
#[error_code]
pub enum FumpadError {
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
    #[msg("Wrong venue program, pool or account list")]
    WrongVenue,
    #[msg("DBC config is not on the FUMPAD allow-list")]
    ConfigNotAllowed,
    #[msg("DBC config does not have the FUMPAD shape (fee claimer, leftover receiver, token, migration, locks)")]
    InvalidConfig,
    #[msg("Config allow-list is full")]
    ConfigListFull,
    #[msg("No parameter change is queued")]
    NoPendingParams,
    #[msg("No config change is queued")]
    NoPendingConfig,
    #[msg("No admin change is proposed")]
    NoPendingAdmin,
    #[msg("Timelock (48h) has not elapsed")]
    TimelockNotElapsed,
    #[msg("Global account layout is unknown or newer than this program")]
    UnsupportedGlobalLayout,
    #[msg("DBC pool already completed or migrated")]
    PoolNotFresh,
    #[msg("DBC pool has not been migrated to DAMM v2 yet")]
    NotMigrated,
    #[msg("DAMM v2 pool or position is not the coin's locked migration pool")]
    InvalidMigratedPool,
    #[msg("Launch window (anti-snipe fee) still active")]
    LaunchWindowActive,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Launch-window fees not settled yet: call claim_fees first")]
    LaunchFeesUnsettled,
    #[msg("Nothing to buy back")]
    NothingToBuyBack,
    #[msg("Spot price deviates too far from the guard price")]
    PriceDeviation,
    #[msg("No fresh keeper sample")]
    StaleSample,
    #[msg("Not enough keeper price samples spread over the window (claims and buybacks pause during a keeper outage)")]
    InsufficientSamples,
    #[msg("Sample too soon after the previous one")]
    SampleTooSoon,
    #[msg("Sampling transaction must contain only the sampling instruction")]
    SampleTxNotIsolated,
    #[msg("A buyback may not complete the curve")]
    WouldCompleteCurve,
    #[msg("Ed25519 attestation instruction missing right before this instruction")]
    MissingAttestation,
    #[msg("Malformed attestation")]
    InvalidAttestation,
    #[msg("Not enough distinct active keeper signatures")]
    NotEnoughKeeperSignatures,
    #[msg("Attestation is too old")]
    AttestationExpired,
    #[msg("Attestation is for another program or cluster")]
    WrongCluster,
    #[msg("Pool is not this coin's DBC or DAMM v2 pool")]
    PoolNotOfCoin,
    #[msg("Coin creator's sells never create tickets")]
    CreatorSell,
    #[msg("Ticket value below the USD minimum")]
    BelowMinimumUsd,
    #[msg("Invalid ticket amount or price")]
    InvalidTicketAmount,
    #[msg("Pyth price too far from the trade's block time")]
    StalePythPrice,
    /// Reserved since the M-1 fix: the rate cap defers tickets instead of rejecting them.
    #[msg("Attestation rate cap reached for this coin: retry later")]
    AttestRateLimited,
    #[msg("Wallet has the maximum number of open tickets on this coin")]
    TooManyOpenTickets,
    #[msg("This trade was already attested")]
    AlreadyConsumed,
    #[msg("Challenge window is over")]
    ChallengeWindowOver,
    #[msg("Ticket is still in its challenge window")]
    TicketInChallenge,
    #[msg("Ticket is not open")]
    TicketNotOpen,
    #[msg("Ticket has expired")]
    TicketExpired,
    #[msg("Price has not held the trigger multiple of the sell price")]
    TriggerNotMet,
    #[msg("Claim queue is full")]
    QueueFull,
    #[msg("Wallet already has the maximum number of queued claims on this coin")]
    WalletQueueLimit,
    #[msg("Claim queue account required: the ticket is queued")]
    QueueAccountRequired,
    #[msg("Ticket has no escrowed payout")]
    NoEscrow,
    #[msg("The ticket owner opted out of auto-claim for this coin")]
    AutoClaimDisabled,
    #[msg("Ticket cannot be closed yet")]
    TicketNotClosable,
    #[msg("Consumed marker cannot be closed yet")]
    ConsumedNotClosable,
    #[msg("Position still has open or unclosed tickets")]
    PositionNotEmpty,
    #[msg("Coin lamport accounting invariant violated")]
    LamportInvariant,
    #[msg("Rebuy is outside the ticket's rebuy window")]
    RebuyOutOfWindow,
    #[msg("The DAMM v2 pool is disabled by its operator")]
    PoolDisabled,
    #[msg("Attested ticket price is below the trade's execution price (D12: ticket price >= execution)")]
    TicketPriceBelowExecution,
    #[msg("A key cannot be both an attestor (keeper) and an operator")]
    KeeperOperatorOverlap,
    #[msg("This DBC pool's coin is registered: use claim_fees")]
    PoolIsRegistered,
}
