//! A coin's fee-policy snapshot (INTERFACE §5.9). A coin registered on a config whose allow-list slot carries a
//! non-standard policy gets it appended to its Coin account: the Coin is created `COIN_LEN + COIN_POLICY_TAIL_LEN`
//! bytes long and the tail (after the borsh `Coin`) holds the policy as it was at `register_coin`. No extra account
//! (the launch transaction has no byte to spare), and nothing outside the coin can change it: removing or replacing
//! the config never alters an existing coin's routing. Anchor (de)serializes only the `Coin` prefix, so the tail is
//! read and written raw here. `Coin.fee_policy_kind != 0` ⇔ the tail exists.

use anchor_lang::prelude::*;

use crate::{
    constants::FEE_POLICY_STANDARD,
    error::FumpadError,
    state::{Coin, FeePolicy},
};

/// Length (with discriminator) of a standard Coin account.
pub const COIN_LEN: usize = 8 + Coin::INIT_SPACE;
/// Bytes appended to a non-standard coin's account (`CoinPolicyTail`).
pub const COIN_POLICY_TAIL_LEN: usize = CoinPolicyTail::INIT_SPACE;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace)]
pub struct CoinPolicyTail {
    /// The config slot's policy at registration (immutable afterwards).
    pub policy: FeePolicy,
    /// Cumulative lamports paid to `policy.wallet` (stats; the only field that changes).
    pub wallet_paid_lamports: u64,
}

/// Account length a coin on a config with `policy` is created with.
pub fn coin_account_len(policy: &FeePolicy) -> usize {
    COIN_LEN + if policy.kind == FEE_POLICY_STANDARD { 0 } else { COIN_POLICY_TAIL_LEN }
}

/// The coin's policy tail (`InvalidAccount` if the account is too short for one).
pub fn read_policy_tail(coin: &AccountInfo) -> Result<CoinPolicyTail> {
    let d = coin.try_borrow_data()?;
    require!(d.len() >= COIN_LEN + COIN_POLICY_TAIL_LEN, FumpadError::InvalidAccount);
    CoinPolicyTail::deserialize(&mut &d[COIN_LEN..COIN_LEN + COIN_POLICY_TAIL_LEN]).map_err(|_| error!(FumpadError::InvalidAccount))
}

pub fn write_policy_tail(coin: &AccountInfo, tail: &CoinPolicyTail) -> Result<()> {
    let mut d = coin.try_borrow_mut_data()?;
    require!(d.len() >= COIN_LEN + COIN_POLICY_TAIL_LEN, FumpadError::InvalidAccount);
    let mut w: &mut [u8] = &mut d[COIN_LEN..COIN_LEN + COIN_POLICY_TAIL_LEN];
    tail.serialize(&mut w).map_err(|_| error!(FumpadError::InvalidAccount))
}
