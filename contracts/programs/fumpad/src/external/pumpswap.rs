//! PumpSwap integration (raw CPI, no crate dependency — see external-idl/pump_amm.json).
//! OWNERS: `create_pool` CPI → curve module (graduation). buy/sell CPI, reserve reads,
//! spot price → venue/oracle module. Put each in its own clearly-marked section.
//!
//! Design rule: PumpSwap has shipped breaking account-list changes several times.
//! Validate only what matters (program id, pool, mints, user token accounts) and
//! measure results by balance deltas, passing the rest through from the client.

use anchor_lang::{
    prelude::*,
    solana_program::{instruction::Instruction, program::invoke_signed},
};

use crate::constants::{PUMPSWAP_IX_CREATE_POOL, PUMPSWAP_PROGRAM_ID};

/// Wrapped SOL mint (quote side of every FUMPAD pool).
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

// ═════════════════════════════════════════════════════════════════════════════
// create_pool — OWNER: curve module (graduation)
// ═════════════════════════════════════════════════════════════════════════════

pub const POOL_SEED: &[u8] = b"pool";
pub const POOL_LP_MINT_SEED: &[u8] = b"pool_lp_mint";
pub const EVENT_AUTHORITY_SEED: &[u8] = b"__event_authority";

/// PumpSwap pool PDA: ["pool", index (u16 LE), creator, base_mint, quote_mint].
pub fn pool_pda(index: u16, creator: &Pubkey, base_mint: &Pubkey, quote_mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[POOL_SEED, &index.to_le_bytes(), creator.as_ref(), base_mint.as_ref(), quote_mint.as_ref()],
        &PUMPSWAP_PROGRAM_ID,
    )
    .0
}

/// LP mint PDA: ["pool_lp_mint", pool].
pub fn lp_mint_pda(pool: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[POOL_LP_MINT_SEED, pool.as_ref()], &PUMPSWAP_PROGRAM_ID).0
}

pub fn event_authority_pda() -> Pubkey {
    Pubkey::find_program_address(&[EVENT_AUTHORITY_SEED], &PUMPSWAP_PROGRAM_ID).0
}

/// Arguments of `create_pool` (layout per external-idl/pump_amm.json; the `Option*`
/// IDL types are single-field structs, i.e. serialized as the bare value).
#[derive(AnchorSerialize, Clone, Copy, Debug)]
pub struct CreatePoolArgs {
    pub index: u16,
    pub base_amount_in: u64,
    pub quote_amount_in: u64,
    pub coin_creator: Pubkey,
    pub is_mayhem_mode: bool,
    pub is_cashback_coin: bool,
    pub creator_fee_bps: u64,
    pub can_edit_creator_fee: bool,
    pub is_holder_reward: bool,
}

/// Accounts of `create_pool`, in IDL order.
pub struct CreatePoolAccounts<'a, 'info> {
    pub pool: &'a AccountInfo<'info>,
    pub global_config: &'a AccountInfo<'info>,
    /// Signer + payer of every account PumpSwap creates.
    pub creator: &'a AccountInfo<'info>,
    pub base_mint: &'a AccountInfo<'info>,
    pub quote_mint: &'a AccountInfo<'info>,
    pub lp_mint: &'a AccountInfo<'info>,
    pub user_base_token_account: &'a AccountInfo<'info>,
    pub user_quote_token_account: &'a AccountInfo<'info>,
    pub user_pool_token_account: &'a AccountInfo<'info>,
    pub pool_base_token_account: &'a AccountInfo<'info>,
    pub pool_quote_token_account: &'a AccountInfo<'info>,
    pub system_program: &'a AccountInfo<'info>,
    pub token_2022_program: &'a AccountInfo<'info>,
    pub base_token_program: &'a AccountInfo<'info>,
    pub quote_token_program: &'a AccountInfo<'info>,
    pub associated_token_program: &'a AccountInfo<'info>,
    pub event_authority: &'a AccountInfo<'info>,
    pub program: &'a AccountInfo<'info>,
}

/// Raw CPI into PumpSwap `create_pool`. `extra` accounts are appended verbatim so a
/// PumpSwap upgrade that only appends accounts needs a client change, not an upgrade.
pub fn create_pool<'info>(
    accts: &CreatePoolAccounts<'_, 'info>,
    args: &CreatePoolArgs,
    extra: &[AccountInfo<'info>],
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    require_keys_eq!(*accts.program.key, PUMPSWAP_PROGRAM_ID, crate::error::FumpadError::WrongVenue);
    let ordered: [(&AccountInfo<'info>, bool); 18] = [
        (accts.pool, true),
        (accts.global_config, false),
        (accts.creator, true),
        (accts.base_mint, false),
        (accts.quote_mint, false),
        (accts.lp_mint, true),
        (accts.user_base_token_account, true),
        (accts.user_quote_token_account, true),
        (accts.user_pool_token_account, true),
        (accts.pool_base_token_account, true),
        (accts.pool_quote_token_account, true),
        (accts.system_program, false),
        (accts.token_2022_program, false),
        (accts.base_token_program, false),
        (accts.quote_token_program, false),
        (accts.associated_token_program, false),
        (accts.event_authority, false),
        (accts.program, false),
    ];
    let mut metas = Vec::with_capacity(ordered.len() + extra.len());
    let mut infos = Vec::with_capacity(ordered.len() + extra.len());
    for (i, (info, writable)) in ordered.iter().enumerate() {
        let signer = i == 2; // creator
        metas.push(if *writable { AccountMeta::new(*info.key, signer) } else { AccountMeta::new_readonly(*info.key, signer) });
        infos.push((*info).clone());
    }
    for e in extra {
        metas.push(if e.is_writable { AccountMeta::new(*e.key, e.is_signer) } else { AccountMeta::new_readonly(*e.key, e.is_signer) });
        infos.push(e.clone());
    }
    let mut data = PUMPSWAP_IX_CREATE_POOL.to_vec();
    args.serialize(&mut data)?;
    invoke_signed(&Instruction { program_id: PUMPSWAP_PROGRAM_ID, accounts: metas, data }, &infos, signer_seeds)
        .map_err(Into::into)
}
