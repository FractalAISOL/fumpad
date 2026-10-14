use anchor_lang::prelude::*;

use crate::state::FeePolicy;

/// A coin's fee policy, snapshotted by `register_coin` from its config's allow-list slot when that policy isn't
/// standard (`Coin.fee_policy_kind != 0`). PDA ["fee_policy", mint]; rent paid by the creator. Only
/// `wallet_paid_lamports` changes afterwards: removing or re-queuing the config never touches it.
#[account]
#[derive(InitSpace)]
pub struct CoinFeePolicy {
    pub bump: u8,
    pub mint: Pubkey,
    /// The coin's DBC config at registration.
    pub dbc_config: Pubkey,
    pub policy: FeePolicy,
    /// Cumulative lamports paid to `policy.wallet` (stats).
    pub wallet_paid_lamports: u64,
    pub reserved: [u8; 32],
}
