//! FUMPAD LP locker (SPEC D11). IMMUTABLE: no admin, no config, no close, and it is deployed
//! with its upgrade authority removed (CONTRACTS.md). Two instructions:
//!
//! * `lock`  — CPI'd by FUMPAD's `graduate` (signer: FUMPAD's pool-authority PDA, the
//!   creator of every FUMPAD PumpSwap pool). Moves ALL the pool's LP tokens into a vault
//!   owned by this program's `authority` PDA and fixes the principal.
//! * `skim`  — permissionless. Withdraws (PumpSwap `withdraw`) only the LP worth more than
//!   the principal, paying base → the coin's FUMPAD reward vault and WSOL → a FUMPAD-owned
//!   account (ATA of the coin PDA), both derived from the hard-coded FUMPAD program id.
//!
//! Principal, in √k units. r = √(base · quote) / lp_supply is the value of one LP token as
//! PumpSwap's withdraw pays it: proportional to `Pool.lp_supply` (which ignores direct
//! burns — a burned LP's share stays in the pool, so lp_supply, not the mint supply, is the
//! redeemable denominator; using the smaller mint supply would overstate r and skim
//! principal; we take max(lp_supply, mint supply) as a layout-change guard). Swaps grow √k by the LP fee, donations grow it, proportional deposits and
//! withdrawals keep r constant (their rounding favours the pool). At lock the principal is
//! P = held₀ · r₀ (√ rounded UP), forever. A skim keeps ⌈P / r_now⌉ LP (√ rounded DOWN, plus
//! a 2⁻²⁰ relative margin) and withdraws the rest, then re-measures and reverts unless the
//! remaining LP is still worth ≥ P. Quote = min(vault + virtual_quote_reserves, vault −
//! waiting protocol/creator fees): never more than the real liquidity.
//!
//! No code path moves LP out of the vault except that PumpSwap `withdraw` CPI (exact amount,
//! checked by balance delta). If PumpSwap changes `withdraw`, skims fail and the LP simply
//! stays locked.

use anchor_lang::{
    prelude::*,
    solana_program::{instruction::Instruction, program::invoke_signed},
};
use anchor_spl::{
    associated_token::{get_associated_token_address_with_program_id, AssociatedToken},
    token_2022::Token2022,
    token_interface::{self, Mint, TokenAccount, TransferChecked},
};

declare_id!("8TkV5aWsBJ9bHr96HV5iQXrCJ51XvHTTtxnufMQmEaY9");

pub const FUMPAD_PROGRAM_ID: Pubkey = pubkey!("ASVE6Nk8T1c2Uv81vjPeNDnX54nHGWg98G1afYt2j8Cv");
pub const PUMPSWAP_PROGRAM_ID: Pubkey = pubkey!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
pub const SPL_TOKEN_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const LOCK_SEED: &[u8] = b"lock";
pub const AUTHORITY_SEED: &[u8] = b"authority";
/// Skims below this many LP base units (LP has 9 decimals) are refused (dust).
pub const MIN_SKIM_LP: u64 = 1_000_000;
const IX_WITHDRAW: [u8; 8] = [183, 18, 70, 156, 148, 109, 161, 34];
const POOL_DISCRIMINATOR: [u8; 8] = [241, 154, 109, 4, 17, 177, 109, 188];
/// PumpSwap `withdraw` account list: positions validated here (the rest pass through).
const V_POOL: usize = 0;
const V_USER: usize = 2;
const V_BASE_MINT: usize = 3;
const V_QUOTE_MINT: usize = 4;
const V_LP_MINT: usize = 5;
const V_USER_BASE: usize = 6;
const V_USER_QUOTE: usize = 7;
const V_USER_LP: usize = 8;
const V_POOL_BASE: usize = 9;
const V_POOL_QUOTE: usize = 10;
const VENUE_MAX: usize = 40;

#[program]
pub mod fumpad_lp_locker {
    use super::*;

    pub fn lock(ctx: Context<LockLp>) -> Result<()> {
        let a = ctx.accounts;
        let pool = read_pool(&a.pool)?;
        require_keys_eq!(pool.creator, a.fumpad_authority.key(), LockerError::NotFumpadPool);
        require_keys_eq!(pool.quote_mint, WSOL_MINT, LockerError::NotFumpadPool);
        require_keys_eq!(pool.lp_mint, a.lp_mint.key(), LockerError::WrongAccount);
        let amount = a.source_lp.amount;
        require!(amount > 0, LockerError::NothingToLock);
        token_interface::transfer_checked(
            CpiContext::new(
                a.token_program.key(),
                TransferChecked {
                    from: a.source_lp.to_account_info(),
                    mint: a.lp_mint.to_account_info(),
                    to: a.lp_vault.to_account_info(),
                    authority: a.fumpad_authority.to_account_info(),
                },
            ),
            amount,
            a.lp_mint.decimals,
        )?;
        a.lp_vault.reload()?;
        require!(a.lp_vault.amount == amount, LockerError::WrongAccount);

        let lp_mint_info = a.lp_mint.to_account_info();
        let (xq, lp_supply) = measure(&pool, &a.pool_base_vault, &a.pool_quote_vault, &lp_mint_info)?;
        let s0 = isqrt(xq);
        let s0 = if s0 * s0 < xq { s0 + 1 } else { s0 }; // ⌈√⌉: principal never understated
        require!(s0 > 0 && lp_supply > 0, LockerError::BadReserves);
        let mint = pool.base_mint;
        let coin = Pubkey::find_program_address(&[b"coin", mint.as_ref()], &FUMPAD_PROGRAM_ID).0;
        a.lock.set_inner(Lock {
            bump: ctx.bumps.lock,
            pool: a.pool.key(),
            mint,
            lp_mint: pool.lp_mint,
            lp_vault: a.lp_vault.key(),
            base_dest: Pubkey::find_program_address(&[b"reward_vault", mint.as_ref()], &FUMPAD_PROGRAM_ID).0,
            quote_dest: get_associated_token_address_with_program_id(&coin, &WSOL_MINT, &SPL_TOKEN_ID),
            principal_num: (amount as u128).checked_mul(s0).ok_or(LockerError::MathOverflow)?,
            lp_supply_at_lock: lp_supply,
            lp_locked: amount,
            locked_at: Clock::get()?.unix_timestamp,
            lp_skimmed: 0,
            base_skimmed: 0,
            quote_skimmed: 0,
        });
        emit!(Locked { pool: a.pool.key(), mint, lp_locked: amount, lp_supply, sqrt_k: s0 });
        Ok(())
    }

    /// remaining_accounts = PumpSwap `withdraw` accounts in PumpSwap order (user = `authority`,
    /// user_base = lock.base_dest, user_quote = lock.quote_dest, user_pool = lock.lp_vault).
    pub fn skim<'info>(ctx: Context<'info, Skim<'info>>) -> Result<()> {
        let v = ctx.remaining_accounts;
        let lock = &mut ctx.accounts.lock;
        require!(v.len() > V_POOL_QUOTE && v.len() <= VENUE_MAX, LockerError::WrongAccount);
        let pool = read_pool(&v[V_POOL])?;
        for (i, key) in [
            (V_POOL, lock.pool),
            (V_USER, ctx.accounts.authority.key()),
            (V_BASE_MINT, lock.mint),
            (V_QUOTE_MINT, WSOL_MINT),
            (V_LP_MINT, lock.lp_mint),
            (V_USER_BASE, lock.base_dest),
            (V_USER_QUOTE, lock.quote_dest),
            (V_USER_LP, lock.lp_vault),
        ] {
            require_keys_eq!(v[i].key(), key, LockerError::WrongAccount);
        }
        let held = token_amount(&v[V_USER_LP])?;
        let (xq, lp_supply) = measure(&pool, &v[V_POOL_BASE], &v[V_POOL_QUOTE], &v[V_LP_MINT])?;
        let lp_in = held.saturating_sub(lock.keep(isqrt(xq), lp_supply)?);
        require!(lp_in >= MIN_SKIM_LP, LockerError::NothingToSkim);
        let (base0, quote0) = (token_amount(&v[V_USER_BASE])?, token_amount(&v[V_USER_QUOTE])?);

        let mut data = IX_WITHDRAW.to_vec();
        data.extend_from_slice(&lp_in.to_le_bytes());
        data.extend_from_slice(&[0u8; 16]); // min_base_out = min_quote_out = 0 (proportional, unsandwichable)
        let metas = v
            .iter()
            .enumerate()
            .map(|(i, x)| AccountMeta { pubkey: x.key(), is_signer: x.is_signer || i == V_USER, is_writable: x.is_writable })
            .collect();
        let mut infos = v.to_vec();
        infos.push(ctx.accounts.pumpswap_program.to_account_info());
        invoke_signed(
            &Instruction { program_id: PUMPSWAP_PROGRAM_ID, accounts: metas, data },
            &infos,
            &[&[AUTHORITY_SEED, &[ctx.bumps.authority]]],
        )?;

        let held_after = token_amount(&v[V_USER_LP])?;
        require!(held.checked_sub(held_after) == Some(lp_in), LockerError::WrongAccount);
        let base_out = token_amount(&v[V_USER_BASE])?.checked_sub(base0).ok_or(LockerError::WrongAccount)?;
        let quote_out = token_amount(&v[V_USER_QUOTE])?.checked_sub(quote0).ok_or(LockerError::WrongAccount)?;
        // Safety net: re-measure; the LP left must still be worth the principal.
        let (xq, lp_supply) = measure(&read_pool(&v[V_POOL])?, &v[V_POOL_BASE], &v[V_POOL_QUOTE], &v[V_LP_MINT])?;
        require!(lock.covers(held_after, isqrt(xq), lp_supply), LockerError::PrincipalViolated);

        lock.lp_skimmed = lock.lp_skimmed.saturating_add(lp_in);
        lock.base_skimmed = lock.base_skimmed.saturating_add(base_out);
        lock.quote_skimmed = lock.quote_skimmed.saturating_add(quote_out);
        emit!(Skimmed { pool: lock.pool, mint: lock.mint, lp_withdrawn: lp_in, base_out, quote_out, lp_held: held_after });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct LockLp<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// FUMPAD's pool-authority PDA: only FUMPAD can sign for it (only `graduate` does).
    #[account(seeds = [b"pool_authority"], bump, seeds::program = FUMPAD_PROGRAM_ID)]
    pub fumpad_authority: Signer<'info>,
    /// CHECK: PumpSwap pool; owner, discriminator and creator checked in the handler.
    pub pool: UncheckedAccount<'info>,
    #[account(mint::token_program = token_program)]
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = lp_mint, token::authority = fumpad_authority, token::token_program = token_program)]
    pub source_lp: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init, payer = payer, space = 8 + Lock::INIT_SPACE, seeds = [LOCK_SEED, pool.key().as_ref()], bump)]
    pub lock: Box<Account<'info, Lock>>,
    /// CHECK: PDA owning every LP vault; signs only the PumpSwap `withdraw` in `skim`.
    #[account(seeds = [AUTHORITY_SEED], bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        associated_token::mint = lp_mint,
        associated_token::authority = authority,
        associated_token::token_program = token_program,
    )]
    pub lp_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: must be the pool's base vault (checked in `measure`).
    pub pool_base_vault: UncheckedAccount<'info>,
    /// CHECK: must be the pool's quote vault (checked in `measure`).
    pub pool_quote_vault: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Skim<'info> {
    #[account(mut, seeds = [LOCK_SEED, lock.pool.as_ref()], bump = lock.bump)]
    pub lock: Account<'info, Lock>,
    /// CHECK: PDA, the LP vault owner (signs the withdraw).
    #[account(seeds = [AUTHORITY_SEED], bump)]
    pub authority: UncheckedAccount<'info>,
    /// CHECK: the only program `skim` calls.
    #[account(address = PUMPSWAP_PROGRAM_ID @ LockerError::WrongAccount)]
    pub pumpswap_program: UncheckedAccount<'info>,
}

/// One per FUMPAD pool, PDA ["lock", pool]. Never closed.
#[account]
#[derive(InitSpace)]
pub struct Lock {
    pub bump: u8,
    pub pool: Pubkey,
    pub mint: Pubkey,
    pub lp_mint: Pubkey,
    pub lp_vault: Pubkey,
    /// FUMPAD ["reward_vault", mint].
    pub base_dest: Pubkey,
    /// ATA(FUMPAD ["coin", mint], WSOL).
    pub quote_dest: Pubkey,
    /// Principal P = principal_num / lp_supply_at_lock √k units (= held₀ · ⌈√k₀⌉ / L₀).
    pub principal_num: u128,
    pub lp_supply_at_lock: u64,
    pub lp_locked: u64,
    pub locked_at: i64,
    pub lp_skimmed: u64,
    pub base_skimmed: u64,
    pub quote_skimmed: u64,
}

impl Lock {
    /// LP to keep so the vault is worth ≥ P at r = s / lp_supply: ⌈P·L/s⌉ plus a 2⁻²⁰
    /// relative margin (absorbs √ flooring after the withdraw; errs toward skimming less).
    pub fn keep(&self, s: u128, lp_supply: u64) -> Result<u64> {
        require!(s > 0, LockerError::BadReserves);
        let den = (self.lp_supply_at_lock as u128) * s; // < 2^64 · 2^64
        let k = mul_div_ceil(self.principal_num, lp_supply as u128, den).ok_or(LockerError::MathOverflow)?;
        Ok(u64::try_from(k.saturating_add(k >> 20).saturating_add(1)).unwrap_or(u64::MAX))
    }

    /// held · s / lp_supply ≥ P, exactly (256-bit).
    pub fn covers(&self, held: u64, s: u128, lp_supply: u64) -> bool {
        wide_mul(held as u128, (self.lp_supply_at_lock as u128) * s) >= wide_mul(self.principal_num, lp_supply as u128)
    }
}

#[event]
pub struct Locked {
    pub pool: Pubkey,
    pub mint: Pubkey,
    pub lp_locked: u64,
    pub lp_supply: u64,
    pub sqrt_k: u128,
}

#[event]
pub struct Skimmed {
    pub pool: Pubkey,
    pub mint: Pubkey,
    pub lp_withdrawn: u64,
    pub base_out: u64,
    pub quote_out: u64,
    pub lp_held: u64,
}

#[error_code]
pub enum LockerError {
    #[msg("Not a FUMPAD PumpSwap pool")]
    NotFumpadPool,
    #[msg("Wrong account")]
    WrongAccount,
    #[msg("No LP to lock")]
    NothingToLock,
    #[msg("Fee growth below the skim threshold")]
    NothingToSkim,
    #[msg("Skim would touch the principal")]
    PrincipalViolated,
    #[msg("Empty or invalid pool reserves")]
    BadReserves,
    #[msg("Math overflow")]
    MathOverflow,
}

// ── PumpSwap pool / token reads ─────────────────────────────────────────────

pub struct PoolView {
    pub creator: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub lp_mint: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub lp_supply: u64,
    pub virtual_quote: i128,
    pub waiting_fees: u64,
}

fn key_at(d: &[u8], o: usize) -> Pubkey {
    Pubkey::new_from_array(d[o..o + 32].try_into().unwrap())
}

fn u64_at(d: &[u8], o: usize) -> u64 {
    if d.len() >= o + 8 { u64::from_le_bytes(d[o..o + 8].try_into().unwrap()) } else { 0 }
}

/// Pool layout per PumpSwap IDL; appended fields missing on short accounts read as 0.
pub fn parse_pool(d: &[u8]) -> Result<PoolView> {
    require!(d.len() >= 211 && d[..8] == POOL_DISCRIMINATOR, LockerError::WrongAccount);
    let virtual_quote = if d.len() >= 261 { i128::from_le_bytes(d[245..261].try_into().unwrap()) } else { 0 };
    Ok(PoolView {
        creator: key_at(d, 11),
        base_mint: key_at(d, 43),
        quote_mint: key_at(d, 75),
        lp_mint: key_at(d, 107),
        base_vault: key_at(d, 139),
        quote_vault: key_at(d, 171),
        lp_supply: u64_at(d, 203),
        virtual_quote,
        waiting_fees: u64_at(d, 271).saturating_add(u64_at(d, 279)), // protocol_fees + creator_fees
    })
}

fn read_pool(info: &AccountInfo) -> Result<PoolView> {
    require_keys_eq!(*info.owner, PUMPSWAP_PROGRAM_ID, LockerError::WrongAccount);
    parse_pool(&info.try_borrow_data()?)
}

fn token_amount(info: &AccountInfo) -> Result<u64> {
    require!(*info.owner == SPL_TOKEN_ID || *info.owner == anchor_spl::token_2022::ID, LockerError::WrongAccount);
    let d = info.try_borrow_data()?;
    require!(d.len() >= 165, LockerError::WrongAccount);
    Ok(u64_at(&d, 64))
}

/// (base · quote, LP denominator); quote = min(effective, real) — never above real
/// liquidity. Denominator = max(Pool.lp_supply, LP mint supply): equal to lp_supply under
/// PumpSwap's semantics (it counts burned LP too), and if a future Pool layout ever made
/// the lp_supply read come out too small, the mint supply still bounds r from above.
fn measure(p: &PoolView, base_vault: &AccountInfo, quote_vault: &AccountInfo, lp_mint: &AccountInfo) -> Result<(u128, u64)> {
    require_keys_eq!(base_vault.key(), p.base_vault, LockerError::WrongAccount);
    require_keys_eq!(quote_vault.key(), p.quote_vault, LockerError::WrongAccount);
    require_keys_eq!(lp_mint.key(), p.lp_mint, LockerError::WrongAccount);
    require_keys_eq!(*lp_mint.owner, anchor_spl::token_2022::ID, LockerError::WrongAccount);
    let mint_supply = u64_at(&lp_mint.try_borrow_data()?, 36);
    let (base, vault) = (token_amount(base_vault)?, token_amount(quote_vault)?);
    let quote = quote_value(vault, p.virtual_quote, p.waiting_fees);
    let lp_supply = p.lp_supply.max(mint_supply);
    require!(lp_supply > 0, LockerError::BadReserves);
    Ok((base as u128 * quote as u128, lp_supply))
}

pub fn quote_value(vault: u64, virtual_quote: i128, waiting_fees: u64) -> u64 {
    let effective = (vault as i128).saturating_add(virtual_quote).clamp(0, u64::MAX as i128) as u64;
    effective.min(vault.saturating_sub(waiting_fees))
}

// ── integer math ────────────────────────────────────────────────────────────

/// ⌊√n⌋.
pub fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    let mut x = 1u128 << ((128 - n.leading_zeros()).div_ceil(2)); // ≥ √n
    loop {
        let y = (x + n / x) / 2;
        if y >= x {
            return x;
        }
        x = y;
    }
}

/// a · b as (hi, lo); tuples compare as u256.
pub fn wide_mul(a: u128, b: u128) -> (u128, u128) {
    const M: u128 = u64::MAX as u128;
    let (a1, a0, b1, b0) = (a >> 64, a & M, b >> 64, b & M);
    let (p00, p01, p10) = (a0 * b0, a0 * b1, a1 * b0);
    let mid = (p00 >> 64) + (p01 & M) + (p10 & M);
    ((a1 * b1) + (p01 >> 64) + (p10 >> 64) + (mid >> 64), (p00 & M) | (mid << 64))
}

/// ⌈a · b / d⌉; None if d = 0 or the quotient overflows u128.
pub fn mul_div_ceil(a: u128, b: u128, d: u128) -> Option<u128> {
    if d == 0 {
        return None;
    }
    let (hi, lo) = wide_mul(a, b);
    if hi == 0 {
        return Some(lo.div_ceil(d));
    }
    if hi >= d {
        return None;
    }
    let (mut rem, mut q) = (hi, 0u128);
    for i in (0..128).rev() {
        let carry = rem >> 127;
        rem = (rem << 1) | ((lo >> i) & 1);
        q <<= 1;
        if carry == 1 || rem >= d {
            rem = rem.wrapping_sub(d);
            q |= 1;
        }
    }
    q.checked_add((rem != 0) as u128)
}

#[cfg(test)]
mod tests;
