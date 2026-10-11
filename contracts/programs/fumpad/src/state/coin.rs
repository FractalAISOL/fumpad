use anchor_lang::prelude::*;

/// One per launched coin. PDA ["coin", mint].
///
/// Lamport accounting: this account's lamports always equal
///   rent_exempt_minimum + real_sol_reserves + creator_fees_unclaimed
///   + platform_fees_unclaimed + buyback_lamports
/// (tested as an invariant). After graduation `real_sol_reserves` is 0.
#[account]
#[derive(InitSpace)]
pub struct Coin {
    pub bump: u8,
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub status: CoinStatus,
    pub created_at: i64,

    // Curve (pump.fun-style constant product on virtual reserves)
    pub virtual_sol_reserves: u64,
    pub virtual_token_reserves: u64,
    pub real_sol_reserves: u64,
    pub real_token_reserves: u64,

    // Graduation
    pub completed_at: i64,
    pub graduated_at: i64,
    /// PumpSwap pool, set at graduation.
    pub amm_pool: Pubkey,

    // Fee accounting (lamports held by this account)
    pub creator_fees_unclaimed: u64,
    pub platform_fees_unclaimed: u64,
    /// Post-graduation pool share of fees, waiting for `execute_buyback`.
    pub buyback_lamports: u64,

    // Stats (informational; the indexer is the source of truth for history)
    pub volume_lamports: u64,
    pub trade_count: u64,
    pub tickets_created: u64,
    pub tokens_paid_out: u64,

    pub reserved: [u8; 128],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum CoinStatus {
    /// Trading on the bonding curve.
    Curve,
    /// Curve filled; waiting for `graduate`. No trading.
    Complete,
    /// Liquidity on PumpSwap; trades via the router; claims enabled.
    Graduated,
}
