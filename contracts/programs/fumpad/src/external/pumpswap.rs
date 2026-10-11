//! PumpSwap integration (raw CPI, no crate dependency — see external-idl/pump_amm.json).
//! OWNERS: `create_pool` CPI → curve module (graduation). buy/sell CPI, reserve reads,
//! spot price → venue/oracle module. Put each in its own clearly-marked section.
//!
//! Design rule: PumpSwap has shipped breaking account-list changes several times.
//! Validate only what matters (program id, pool, mints, user token accounts) and
//! measure results by balance deltas, passing the rest through from the client.

// ════════════════════════════════════════════════════════════════════════════
// create_pool section — OWNER: curve module.
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// swap / reserves section — OWNER: venue/oracle module.
// ════════════════════════════════════════════════════════════════════════════
//
// The router never trusts PumpSwap's account list or return data:
//   * The client passes PumpSwap's FULL account list for the chosen instruction (in
//     PumpSwap's order) as a contiguous slice of `remaining_accounts` — the "venue slice".
//   * We validate the leading accounts whose positions have been stable across every
//     PumpSwap upgrade so far (upgrades only append): pool, user, global_config, mints,
//     the user's token accounts and the pool vaults. Everything after index 8 (programs,
//     fee config, fee recipients, volume accumulators, event authority, future additions)
//     is passed through untouched — a PumpSwap account-list change needs a client update,
//     not a program upgrade.
//   * Results are measured by token-balance deltas on accounts WE validated.
//   * The CPI program id is the hard-coded PUMPSWAP_PROGRAM_ID, so a spoofed "program"
//     account in the slice can never redirect the call.
//
// We use the v2 trade instructions (`buy_exact_quote_in_v2`, `sell_v2`): 17 accounts,
// no remaining accounts, and they work on every non-cashback pool (FUMPAD pools are
// never cashback pools). Their first 9 accounts match v1's.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke_signed};

use crate::{constants::PUMPSWAP_PROGRAM_ID, error::FumpadError, math::price_q64};

pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
pub const SPL_TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const SPL_TOKEN_2022_PROGRAM_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/// Anchor discriminators from external-idl/pump_amm.json.
pub const POOL_ACCOUNT_DISCRIMINATOR: [u8; 8] = [241, 154, 109, 4, 17, 177, 109, 188];
pub const IX_BUY_EXACT_QUOTE_IN_V2: [u8; 8] = [194, 171, 28, 70, 104, 77, 91, 47];
pub const IX_SELL_V2: [u8; 8] = [93, 246, 130, 60, 231, 233, 64, 178];

/// Positions inside the venue slice (identical for buy/sell v1 and v2).
pub mod venue_idx {
    pub const POOL: usize = 0;
    pub const USER: usize = 1;
    pub const GLOBAL_CONFIG: usize = 2;
    pub const BASE_MINT: usize = 3;
    pub const QUOTE_MINT: usize = 4;
    pub const USER_BASE: usize = 5;
    pub const USER_QUOTE: usize = 6;
    pub const POOL_BASE: usize = 7;
    pub const POOL_QUOTE: usize = 8;
}
/// The venue slice must contain at least the validated prefix.
pub const VENUE_MIN_ACCOUNTS: usize = 9;
/// Hard cap so a client can't make us copy an unbounded list into the CPI.
pub const VENUE_MAX_ACCOUNTS: usize = 40;

// Pool layout (after the 8-byte discriminator), from the IDL `Pool` type.
const POOL_OFF_BASE_MINT: usize = 8 + 1 + 2 + 32; // 43 (bump u8, index u16, creator)
const POOL_OFF_QUOTE_MINT: usize = POOL_OFF_BASE_MINT + 32; // 75
const POOL_OFF_BASE_VAULT: usize = POOL_OFF_QUOTE_MINT + 32 + 32; // 139 (skips lp_mint)
const POOL_OFF_QUOTE_VAULT: usize = POOL_OFF_BASE_VAULT + 32; // 171
const POOL_MIN_LEN: usize = POOL_OFF_QUOTE_VAULT + 32; // 203
// lp_supply u64 @203, coin_creator @211, is_mayhem_mode @243, is_cashback_coin @244
const POOL_OFF_VIRTUAL_QUOTE: usize = 245; // i128, appended field
const POOL_VIRTUAL_QUOTE_END: usize = POOL_OFF_VIRTUAL_QUOTE + 16;

// SPL token account layout (identical base layout for Token and Token-2022).
const TOKEN_ACC_MIN_LEN: usize = 165;
const TOKEN_OFF_MINT: usize = 0;
const TOKEN_OFF_AMOUNT: usize = 64;

/// The fields of a PumpSwap `Pool` the router and oracle rely on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PoolState {
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub pool_base_token_account: Pubkey,
    pub pool_quote_token_account: Pubkey,
    /// Signed; may be negative (v2 fees kept in the vault). 0 on short legacy accounts.
    pub virtual_quote_reserves: i128,
}

/// Pool reserves as PumpSwap prices them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reserves {
    /// Raw base-vault balance.
    pub base: u64,
    /// Effective quote reserves = quote-vault balance + Pool.virtual_quote_reserves.
    pub quote: u64,
}

impl Reserves {
    /// Spot price, lamports per base unit, Q64.64.
    pub fn spot_price_q64(&self) -> Result<u128> {
        require!(self.quote > 0, FumpadError::InsufficientReserves);
        price_q64(self.quote, self.base).ok_or_else(|| error!(FumpadError::InsufficientReserves))
    }
}

fn read_pubkey(d: &[u8], off: usize) -> Pubkey {
    let mut b = [0u8; 32];
    b.copy_from_slice(&d[off..off + 32]);
    Pubkey::new_from_array(b)
}

/// Parse a PumpSwap Pool from raw bytes. Tolerates short legacy accounts (appended
/// fields missing → zero) but requires everything up to the vault keys.
pub fn parse_pool(data: &[u8]) -> Result<PoolState> {
    require!(data.len() >= POOL_MIN_LEN, FumpadError::WrongVenue);
    require!(data[..8] == POOL_ACCOUNT_DISCRIMINATOR, FumpadError::WrongVenue);
    let virtual_quote_reserves = if data.len() >= POOL_VIRTUAL_QUOTE_END {
        let mut b = [0u8; 16];
        b.copy_from_slice(&data[POOL_OFF_VIRTUAL_QUOTE..POOL_VIRTUAL_QUOTE_END]);
        i128::from_le_bytes(b)
    } else {
        0
    };
    Ok(PoolState {
        base_mint: read_pubkey(data, POOL_OFF_BASE_MINT),
        quote_mint: read_pubkey(data, POOL_OFF_QUOTE_MINT),
        pool_base_token_account: read_pubkey(data, POOL_OFF_BASE_VAULT),
        pool_quote_token_account: read_pubkey(data, POOL_OFF_QUOTE_VAULT),
        virtual_quote_reserves,
    })
}

/// Read a PumpSwap pool account: owner must be PumpSwap.
pub fn read_pool(pool: &AccountInfo) -> Result<PoolState> {
    require_keys_eq!(*pool.owner, PUMPSWAP_PROGRAM_ID, FumpadError::WrongVenue);
    let data = pool.try_borrow_data()?;
    parse_pool(&data)
}

/// (mint, amount) of an SPL / Token-2022 token account, owner-checked.
pub fn read_token_account(acc: &AccountInfo) -> Result<(Pubkey, u64)> {
    require!(
        *acc.owner == SPL_TOKEN_PROGRAM_ID || *acc.owner == SPL_TOKEN_2022_PROGRAM_ID,
        FumpadError::InvalidAccount
    );
    let d = acc.try_borrow_data()?;
    require!(d.len() >= TOKEN_ACC_MIN_LEN, FumpadError::InvalidAccount);
    let mut a = [0u8; 8];
    a.copy_from_slice(&d[TOKEN_OFF_AMOUNT..TOKEN_OFF_AMOUNT + 8]);
    Ok((read_pubkey(&d, TOKEN_OFF_MINT), u64::from_le_bytes(a)))
}

/// Token amount only (for balance deltas on accounts the caller already validated).
pub fn token_amount(acc: &AccountInfo) -> Result<u64> {
    Ok(read_token_account(acc)?.1)
}

/// effective = vault + virtual (signed). PumpSwap guarantees it is in [0, u64::MAX];
/// we check anyway rather than cast blindly.
pub fn effective_quote(vault_amount: u64, virtual_quote_reserves: i128) -> Result<u64> {
    let e = (vault_amount as i128)
        .checked_add(virtual_quote_reserves)
        .ok_or_else(|| error!(FumpadError::MathOverflow))?;
    u64::try_from(e).map_err(|_| error!(FumpadError::InsufficientReserves))
}

/// Reserves of `pool` (already parsed), reading the two vault accounts, which must be
/// exactly the pool's vaults and hold the pool's mints.
pub fn read_reserves(pool: &PoolState, base_vault: &AccountInfo, quote_vault: &AccountInfo) -> Result<Reserves> {
    require_keys_eq!(base_vault.key(), pool.pool_base_token_account, FumpadError::WrongVenue);
    require_keys_eq!(quote_vault.key(), pool.pool_quote_token_account, FumpadError::WrongVenue);
    let (bm, base) = read_token_account(base_vault)?;
    let (qm, quote_raw) = read_token_account(quote_vault)?;
    require_keys_eq!(bm, pool.base_mint, FumpadError::WrongVenue);
    require_keys_eq!(qm, pool.quote_mint, FumpadError::WrongVenue);
    Ok(Reserves { base, quote: effective_quote(quote_raw, pool.virtual_quote_reserves)? })
}

/// What the caller expects the security-relevant venue accounts to be.
pub struct VenueExpect {
    pub pool: Pubkey,
    pub base_mint: Pubkey,
    /// PumpSwap `user` (the trader / token-account authority).
    pub user: Pubkey,
    pub user_base: Pubkey,
    pub user_quote: Pubkey,
}

/// Validate the venue slice prefix and return the pool state + current reserves.
pub fn validate_venue(venue: &[AccountInfo], e: &VenueExpect) -> Result<(PoolState, Reserves)> {
    use venue_idx::*;
    require!(
        venue.len() >= VENUE_MIN_ACCOUNTS && venue.len() <= VENUE_MAX_ACCOUNTS,
        FumpadError::WrongVenue
    );
    require_keys_eq!(venue[POOL].key(), e.pool, FumpadError::WrongVenue);
    let pool = read_pool(&venue[POOL])?;
    require_keys_eq!(pool.base_mint, e.base_mint, FumpadError::WrongVenue);
    require_keys_eq!(pool.quote_mint, WSOL_MINT, FumpadError::WrongVenue);
    require_keys_eq!(venue[USER].key(), e.user, FumpadError::WrongVenue);
    require_keys_eq!(
        venue[GLOBAL_CONFIG].key(),
        crate::constants::PUMPSWAP_GLOBAL_CONFIG,
        FumpadError::WrongVenue
    );
    require_keys_eq!(venue[BASE_MINT].key(), e.base_mint, FumpadError::WrongVenue);
    require_keys_eq!(venue[QUOTE_MINT].key(), WSOL_MINT, FumpadError::WrongVenue);
    require_keys_eq!(venue[USER_BASE].key(), e.user_base, FumpadError::WrongVenue);
    require_keys_eq!(venue[USER_QUOTE].key(), e.user_quote, FumpadError::WrongVenue);
    let reserves = read_reserves(&pool, &venue[POOL_BASE], &venue[POOL_QUOTE])?;
    Ok((pool, reserves))
}

/// Re-read reserves after a trade (vault accounts at their validated positions).
pub fn venue_reserves(venue: &[AccountInfo], pool: &PoolState) -> Result<Reserves> {
    read_reserves(pool, &venue[venue_idx::POOL_BASE], &venue[venue_idx::POOL_QUOTE])
}

fn ix_data(disc: [u8; 8], a: u64, b: u64) -> Vec<u8> {
    let mut d = Vec::with_capacity(24);
    d.extend_from_slice(&disc);
    d.extend_from_slice(&a.to_le_bytes());
    d.extend_from_slice(&b.to_le_bytes());
    d
}

/// CPI into PumpSwap with the venue slice as the account list. `program` must be the
/// PumpSwap program account. With `pda_user_seeds`, the `user` meta is marked signer and
/// the PDA signs; no other account ever gets a signature it didn't bring.
fn invoke_venue<'info>(
    venue: &[AccountInfo<'info>],
    program: &AccountInfo<'info>,
    data: Vec<u8>,
    pda_user_seeds: Option<&[&[u8]]>,
) -> Result<()> {
    require_keys_eq!(program.key(), PUMPSWAP_PROGRAM_ID, FumpadError::WrongVenue);
    let metas = venue
        .iter()
        .enumerate()
        .map(|(i, a)| AccountMeta {
            pubkey: a.key(),
            is_signer: a.is_signer || (pda_user_seeds.is_some() && i == venue_idx::USER),
            is_writable: a.is_writable,
        })
        .collect();
    let ix = Instruction { program_id: PUMPSWAP_PROGRAM_ID, accounts: metas, data };
    let mut infos: Vec<AccountInfo<'info>> = Vec::with_capacity(venue.len() + 1);
    infos.extend_from_slice(venue);
    infos.push(program.clone());
    match pda_user_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, &[seeds])?,
        None => invoke_signed(&ix, &infos, &[])?,
    }
    Ok(())
}

/// `buy_exact_quote_in_v2(spendable_quote_in, min_base_amount_out)`.
pub fn cpi_buy_exact_quote_in<'info>(
    venue: &[AccountInfo<'info>],
    program: &AccountInfo<'info>,
    spendable_quote_in: u64,
    min_base_amount_out: u64,
    pda_user_seeds: Option<&[&[u8]]>,
) -> Result<()> {
    invoke_venue(
        venue,
        program,
        ix_data(IX_BUY_EXACT_QUOTE_IN_V2, spendable_quote_in, min_base_amount_out.max(1)),
        pda_user_seeds,
    )
}

/// `sell_v2(base_amount_in, min_quote_amount_out)`.
pub fn cpi_sell<'info>(
    venue: &[AccountInfo<'info>],
    program: &AccountInfo<'info>,
    base_amount_in: u64,
    min_quote_amount_out: u64,
) -> Result<()> {
    invoke_venue(venue, program, ix_data(IX_SELL_V2, base_amount_in, min_quote_amount_out), None)
}

#[cfg(test)]
mod venue_tests {
    use super::*;

    fn pool_bytes(len: usize, vqr: i128) -> Vec<u8> {
        let mut d = vec![0u8; len.max(300)];
        d[..8].copy_from_slice(&POOL_ACCOUNT_DISCRIMINATOR);
        d[POOL_OFF_BASE_MINT..POOL_OFF_BASE_MINT + 32].copy_from_slice(&[1; 32]);
        d[POOL_OFF_QUOTE_MINT..POOL_OFF_QUOTE_MINT + 32].copy_from_slice(WSOL_MINT.as_ref());
        d[POOL_OFF_BASE_VAULT..POOL_OFF_BASE_VAULT + 32].copy_from_slice(&[2; 32]);
        d[POOL_OFF_QUOTE_VAULT..POOL_OFF_QUOTE_VAULT + 32].copy_from_slice(&[3; 32]);
        d[POOL_OFF_VIRTUAL_QUOTE..POOL_VIRTUAL_QUOTE_END].copy_from_slice(&vqr.to_le_bytes());
        d.truncate(len);
        d
    }

    #[test]
    fn parses_current_and_legacy_pools() {
        let p = parse_pool(&pool_bytes(300, -12_345)).unwrap();
        assert_eq!(p.base_mint, Pubkey::new_from_array([1; 32]));
        assert_eq!(p.quote_mint, WSOL_MINT);
        assert_eq!(p.pool_base_token_account, Pubkey::new_from_array([2; 32]));
        assert_eq!(p.pool_quote_token_account, Pubkey::new_from_array([3; 32]));
        assert_eq!(p.virtual_quote_reserves, -12_345);
        // Legacy (pre-virtual-reserves) layouts: field reads as 0.
        assert_eq!(parse_pool(&pool_bytes(211, 7)).unwrap().virtual_quote_reserves, 0);
        assert_eq!(parse_pool(&pool_bytes(260, 7)).unwrap().virtual_quote_reserves, 0);
        // Too short / wrong discriminator.
        assert!(parse_pool(&pool_bytes(202, 0)).is_err());
        let mut bad = pool_bytes(300, 0);
        bad[0] ^= 1;
        assert!(parse_pool(&bad).is_err());
    }

    #[test]
    fn effective_quote_is_signed() {
        assert_eq!(effective_quote(100, 0).unwrap(), 100);
        assert_eq!(effective_quote(100, -30).unwrap(), 70);
        assert_eq!(effective_quote(100, 50).unwrap(), 150);
        assert!(effective_quote(100, -101).is_err());
        assert!(effective_quote(u64::MAX, 1).is_err());
    }

    #[test]
    fn spot_price_rejects_empty_sides() {
        assert!(Reserves { base: 0, quote: 1 }.spot_price_q64().is_err());
        assert!(Reserves { base: 1, quote: 0 }.spot_price_q64().is_err());
        assert_eq!(Reserves { base: 4, quote: 2 }.spot_price_q64().unwrap(), 1u128 << 63);
    }
}
