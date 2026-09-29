//! `operate_position`: supply, withdraw, borrow, or pay back on a custodied Jupiter position,
//! through Jupiter's `operate_dex`. That is Jupiter's instruction for smart vaults: T2 (smart
//! collateral, normal debt), T3 (normal collateral, smart debt) and T4 (both smart).
//!
//! Owns: the level gate, the fund-safety checks, and the CPI into Jupiter Vaults `operate_dex`.
//! Does NOT own: custody (`custody.rs`), the level policy (`state/wrapper.rs::level_allows`),
//! or reading the result back (`refresh_wrapper`, which the caller runs afterwards).
//!
//! Plain (T1) vaults are not supported. Jupiter only accepts `operate` there and refuses
//! `operate_dex` on them (`VaultInvalidVaultTypeForDex`).
//!
//! Invariants (fund safety):
//!   - Jupiter's `signer` is the wrapper authority PDA. This program signs for it with
//!     `invoke_signed`; no wallet ever holds that key.
//!   - Jupiter's `recipient` is absent or that PDA, and every account Jupiter can pay into
//!     (`jupiter_slot::PAYOUT`) is absent or a token account owned by that PDA. Withdrawn
//!     collateral and borrowed tokens can only land there.
//!   - The position is the wrapper's own position, and its NFT sits in the PDA's token account.
//!   - `level_allows(wrapper.level, raises_risk(params))` holds. Level 1 can only lower risk.
//!   - Only direct transfers. A claim-type transfer would park tokens in a Liquidity claim
//!     account that nothing here can spend.
//!
//! Who may call: the wrapper owner or an OnDemand caller of that wrapper. Snapshotters only read
//! and senders only send; neither may move a position.
//!
//! Accounts: this instruction names only its own six accounts. Jupiter's 73 `operate_dex`
//! accounts follow in `remaining_accounts`, in Jupiter's order (Vaults IDL), then Jupiter's own
//! extras (oracle sources, branches, tick debt arrays). An absent optional Jupiter account is
//! passed as the Vaults program id, Anchor's convention. The client builds the whole list with
//! the Jupiter SDK (`getOperateDexIx`, with the PDA as signer, owner and recipient).
//!
//! Typical call: `lz:oapp:solana:operate-position --vault-id 95 --nft-id 34 --col-action supply
//! --col-token1 1000000` → the client asks the SDK for accounts and amounts → this instruction.

use crate::errors::LendMirrorError;
use crate::seeds::{ONDEMAND_SEED, STORE_SEED, WRAPPER_AUTH_SEED, WRAPPER_SEED};
use crate::*;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke_signed};
use anchor_spl::associated_token::get_associated_token_address_with_program_id;

/// `sha256("global:operate_dex")[..8]` of the Jupiter Vaults program.
pub const JUPITER_OPERATE_DEX_DISCRIMINATOR: [u8; 8] = [223, 122, 223, 181, 133, 132, 116, 33];

/// Positions in Jupiter's `operate_dex` account list (Vaults IDL, 73 named accounts).
pub mod jupiter_slot {
    pub const SIGNER: usize = 0;
    pub const RECIPIENT: usize = 3;
    pub const POSITION: usize = 11;
    pub const POSITION_TOKEN_ACCOUNT: usize = 12;
    /// Every slot Jupiter can pay tokens into: the signer's and the recipient's token accounts
    /// of the normal legs (1, 2, 4, 5), and the user and recipient token0/token1 accounts of
    /// the collateral pool group (34, 35, 50, 51) and of the debt pool group (54, 55, 70, 71).
    pub const PAYOUT: [usize; 12] = [1, 2, 4, 5, 34, 35, 50, 51, 54, 55, 70, 71];
    /// Named accounts before Jupiter's own extras.
    pub const NAMED: usize = 73;
}

#[derive(Accounts)]
#[instruction(params: OperatePositionParams)]
pub struct OperatePosition<'info> {
    /// Pays transaction fees and any account the setup instructions create.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Box<Account<'info, Store>>,

    #[account(
        seeds = [
            WRAPPER_SEED,
            &wrapper.vault_id.to_le_bytes(),
            &wrapper.nft_id.to_le_bytes()
        ],
        bump = wrapper.bump,
        constraint = (
            wrapper.is_owner(&authority.key())
            || ondemand.as_ref().is_some_and(|list| list.is_caller(&authority.key()))
        ) @ LendMirrorError::Unauthorized,
        constraint = wrapper.custody @ LendMirrorError::NoCustody,
        constraint = level_allows(wrapper.level, raises_risk(&params)) @ LendMirrorError::LevelDenied
    )]
    pub wrapper: Box<Account<'info, PositionWrapper>>,

    #[account(
        seeds = [ONDEMAND_SEED, wrapper.key().as_ref()],
        bump = ondemand.bump,
        constraint = ondemand.wrapper == wrapper.key() @ LendMirrorError::Unauthorized
    )]
    pub ondemand: Option<Box<Account<'info, OnDemandStrategy>>>,

    /// Empty PDA: Jupiter's `signer` and `recipient`, signed via `invoke_signed`. It pays rent
    /// for accounts Jupiter creates during the call, so it holds a little SOL.
    /// CHECK: the seeds below pin it to this wrapper.
    #[account(mut, seeds = [WRAPPER_AUTH_SEED, wrapper.key().as_ref()], bump = wrapper.authority_bump)]
    pub wrapper_authority: UncheckedAccount<'info>,

    /// CHECK: must be the Jupiter Vaults program recorded in the Store.
    #[account(address = store.vaults_program)]
    pub vaults_program: UncheckedAccount<'info>,
}

/// Jupiter's `OperateDexAmounts`: signed token deltas for a smart (pool) leg and a share bound.
#[derive(Clone, Debug, PartialEq, AnchorSerialize, AnchorDeserialize)]
pub struct DexAmounts {
    pub token0: i128,
    pub token1: i128,
    /// Minimum shares on a supply, maximum shares burned on a withdraw (same sign as the leg).
    pub shares_min_max: i128,
}

/// Jupiter's `OperateDexColAmounts`: `amounts` for a smart collateral leg, `new_col` for a
/// normal one. Positive supplies, negative withdraws.
#[derive(Clone, Debug, PartialEq, AnchorSerialize, AnchorDeserialize)]
pub struct DexColAmounts {
    pub amounts: Option<DexAmounts>,
    pub new_col: Option<i128>,
}

/// Jupiter's `OperateDexDebtAmounts`: `amounts` for a smart debt leg, `new_debt` for a normal
/// one. Positive borrows, negative pays back.
#[derive(Clone, Debug, PartialEq, AnchorSerialize, AnchorDeserialize)]
pub struct DexDebtAmounts {
    pub amounts: Option<DexAmounts>,
    pub new_debt: Option<i128>,
}

/// Same fields, order and Borsh layout as Jupiter's `operate_dex` arguments, so the bytes after
/// our discriminator are exactly the bytes Jupiter receives.
#[derive(Clone, Debug, PartialEq, AnchorSerialize, AnchorDeserialize)]
pub struct OperatePositionParams {
    pub col_amounts: Option<DexColAmounts>,
    pub debt_amounts: Option<DexDebtAmounts>,
    /// Jupiter `TransferType`: 0 skip, 1 direct, 2 claim. Only `None` or `Some(1)` are accepted.
    pub transfer_type: Option<u8>,
    /// How many oracle sources, branches and tick debt arrays follow in the extras.
    /// The Jupiter SDK computes this.
    pub remaining_accounts_indices: Vec<u8>,
}

/// True when the call takes collateral out or adds debt.
///
/// Jupiter's signs: collateral fields are positive on supply and negative on withdraw; debt
/// fields are positive on borrow and negative on payback. The share bound carries the leg's
/// sign. Any single field in the risky direction counts, so a mixed leg needs level 2.
///
/// Withdraw 1 USDC of smart collateral (`token1: -1_000_000`) → true.
/// Pay back 1 USDC of normal debt (`new_debt: Some(-1_000_000)`) → false.
pub fn raises_risk(params: &OperatePositionParams) -> bool {
    let takes_collateral = params.col_amounts.as_ref().is_some_and(|col| {
        col.new_col.is_some_and(|amount| amount < 0)
            || col.amounts.as_ref().is_some_and(|a| a.token0 < 0 || a.token1 < 0 || a.shares_min_max < 0)
    });
    let adds_debt = params.debt_amounts.as_ref().is_some_and(|debt| {
        debt.new_debt.is_some_and(|amount| amount > 0)
            || debt.amounts.as_ref().is_some_and(|a| a.token0 > 0 || a.token1 > 0 || a.shares_min_max > 0)
    });
    takes_collateral || adds_debt
}

impl<'info> OperatePosition<'info> {
    // The explicit lifetimes tie `remaining_accounts` to the same `'info` as the named
    // accounts, so both can go into one `Vec<AccountInfo<'info>>` for the CPI.
    pub fn apply(
        ctx: &mut Context<'_, '_, '_, 'info, OperatePosition<'info>>,
        params: &OperatePositionParams,
    ) -> Result<()> {
        require!(matches!(params.transfer_type, None | Some(1)), LendMirrorError::LevelDenied);
        let jupiter = ctx.remaining_accounts;
        require!(jupiter.len() >= jupiter_slot::NAMED, LendMirrorError::InvalidJupiterAccount);
        check_jupiter_accounts(ctx.accounts, jupiter)?;

        let a = &ctx.accounts;
        let authority = a.wrapper_authority.key();
        // Every account keeps the writability the transaction gave it. Only the PDA signs.
        let metas = jupiter
            .iter()
            .map(|info| AccountMeta { pubkey: info.key(), is_signer: info.key() == authority, is_writable: info.is_writable })
            .collect();
        let mut infos = jupiter.to_vec();
        infos.push(a.vaults_program.to_account_info());
        let wrapper_key = a.wrapper.key();
        let seeds: &[&[u8]] = &[WRAPPER_AUTH_SEED, wrapper_key.as_ref(), &[a.wrapper.authority_bump]];
        invoke_signed(
            &Instruction { program_id: a.vaults_program.key(), accounts: metas, data: jupiter_operate_dex_data(params) },
            &infos,
            &[seeds],
        )?;
        Ok(())
    }
}

/// The fund-safety checks on Jupiter's account list. Jupiter validates everything else.
fn check_jupiter_accounts(a: &OperatePosition, jupiter: &[AccountInfo]) -> Result<()> {
    use jupiter_slot::*;
    let authority = a.wrapper_authority.key();
    let vaults = a.vaults_program.key();
    // Anchor passes an absent optional account as the id of the program being called.
    let absent = vaults;

    require_keys_eq!(jupiter[SIGNER].key(), authority, LendMirrorError::InvalidJupiterAccount);
    let recipient = jupiter[RECIPIENT].key();
    require!(recipient == absent || recipient == authority, LendMirrorError::InvalidJupiterAccount);
    for slot in PAYOUT {
        require!(is_absent_or_owned_by(&jupiter[slot], &absent, &authority)?, LendMirrorError::InvalidTokenAccount);
    }

    // The position is this wrapper's, and its NFT sits in the authority's token account.
    let position = &jupiter[POSITION];
    require_keys_eq!(*position.owner, vaults, LendMirrorError::InvalidJupiterAccount);
    let decoded = decode_position(&position.try_borrow_data()?)?;
    require!(
        decoded.vault_id == a.wrapper.vault_id && decoded.nft_id == a.wrapper.nft_id,
        LendMirrorError::PositionIdMismatch
    );
    // Jupiter mints the position NFT with the classic Token program (see its init_position seeds).
    let nft_account =
        get_associated_token_address_with_program_id(&authority, &a.wrapper.position_mint, &anchor_spl::token::ID);
    require_keys_eq!(jupiter[POSITION_TOKEN_ACCOUNT].key(), nft_account, LendMirrorError::InvalidTokenAccount);
    Ok(())
}

/// True when `info` is the placeholder for an absent optional account, or a token account
/// (classic Token or Token-2022) whose owner is `authority`.
///
/// A USDC account owned by the PDA → true. The same account owned by any wallet → false.
fn is_absent_or_owned_by(info: &AccountInfo, absent: &Pubkey, authority: &Pubkey) -> Result<bool> {
    if info.key() == *absent {
        return Ok(true);
    }
    let is_token_account = *info.owner == anchor_spl::token::ID || *info.owner == anchor_spl::token_2022::ID;
    let data = info.try_borrow_data()?;
    // SPL token account layout, the same in Token-2022: mint at 0..32, owner at 32..64.
    Ok(is_token_account && data.len() >= 64 && data[32..64] == authority.as_ref()[..])
}

/// Borsh bytes Jupiter expects: the discriminator, then the arguments in the layout of
/// `OperatePositionParams`.
pub fn jupiter_operate_dex_data(params: &OperatePositionParams) -> Vec<u8> {
    let mut data = JUPITER_OPERATE_DEX_DISCRIMINATOR.to_vec();
    // AnchorSerialize on the params struct is Borsh, which is exactly Jupiter's arg layout.
    params.serialize(&mut data).expect("Vec<u8> writer cannot fail");
    data
}

#[cfg(test)]
mod tests {
    use super::*;

    fn smart_col(token0: i128, token1: i128, shares_min_max: i128) -> OperatePositionParams {
        OperatePositionParams {
            col_amounts: Some(DexColAmounts { amounts: Some(DexAmounts { token0, token1, shares_min_max }), new_col: None }),
            debt_amounts: Some(DexDebtAmounts { amounts: None, new_debt: Some(0) }),
            transfer_type: Some(1),
            remaining_accounts_indices: vec![6, 1, 2, 0],
        }
    }

    fn normal_debt(new_debt: i128) -> OperatePositionParams {
        OperatePositionParams {
            col_amounts: None,
            debt_amounts: Some(DexDebtAmounts { amounts: None, new_debt: Some(new_debt) }),
            transfer_type: Some(1),
            remaining_accounts_indices: vec![],
        }
    }

    /// Bytes the Jupiter SDK built on mainnet (2026-09-30) for "withdraw 1 USDC of smart
    /// collateral" on vault 95 / nft 34: token1 = -1_000_000, share bound = -9_895_200_710.
    #[test]
    fn data_matches_the_jupiter_sdk_bytes() {
        let params = smart_col(0, -1_000_000, -9_895_200_710);
        let expected = "df7adfb585847421010100000000000000000000000000000000c0bdf0ffffffffffffffffffffffffff\
                        3a3833b2fdffffffffffffffffffffff000100010000000000000000000000000000000001010400000006010200";
        let hex: String = jupiter_operate_dex_data(&params).iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, expected);
    }

    #[test]
    fn supply_and_payback_lower_risk() {
        assert!(!raises_risk(&smart_col(0, 1_000_000, 900)), "supply USDC as smart collateral");
        assert!(!raises_risk(&smart_col(2_000_000, 1_000_000, 0)), "supply both pool tokens");
        assert!(!raises_risk(&normal_debt(-1_000_000)), "pay back normal debt");
        assert!(!raises_risk(&normal_debt(0)), "the SDK sends Some(0) for an untouched debt leg");
        let smart_payback = OperatePositionParams {
            col_amounts: None,
            debt_amounts: Some(DexDebtAmounts {
                amounts: Some(DexAmounts { token0: -5, token1: -5, shares_min_max: -1 }),
                new_debt: None,
            }),
            transfer_type: None,
            remaining_accounts_indices: vec![],
        };
        assert!(!raises_risk(&smart_payback), "pay back smart debt");
    }

    #[test]
    fn withdraw_and_borrow_raise_risk() {
        assert!(raises_risk(&smart_col(0, -1_000_000, -9_895_200_710)), "withdraw smart collateral");
        assert!(raises_risk(&smart_col(1_000_000, -1, 0)), "a mixed leg counts as a withdraw");
        assert!(raises_risk(&smart_col(0, 0, -1)), "a negative share bound is a withdraw");
        assert!(raises_risk(&normal_debt(1)), "borrow normal debt");
        let normal_withdraw = OperatePositionParams {
            col_amounts: Some(DexColAmounts { amounts: None, new_col: Some(-1) }),
            debt_amounts: None,
            transfer_type: None,
            remaining_accounts_indices: vec![],
        };
        assert!(raises_risk(&normal_withdraw), "withdraw normal collateral");
        let smart_borrow = OperatePositionParams {
            col_amounts: None,
            debt_amounts: Some(DexDebtAmounts {
                amounts: Some(DexAmounts { token0: 0, token1: 1, shares_min_max: 0 }),
                new_debt: None,
            }),
            transfer_type: None,
            remaining_accounts_indices: vec![],
        };
        assert!(raises_risk(&smart_borrow), "borrow smart debt");
    }

    #[test]
    fn nothing_to_do_lowers_nothing() {
        let empty = OperatePositionParams {
            col_amounts: None,
            debt_amounts: None,
            transfer_type: None,
            remaining_accounts_indices: vec![],
        };
        assert!(!raises_risk(&empty));
    }

    fn token_account(owner_field: &Pubkey) -> Vec<u8> {
        let mut data = vec![0u8; 165];
        data[32..64].copy_from_slice(owner_field.as_ref());
        data
    }

    #[test]
    fn payout_accounts_must_belong_to_the_pda() {
        let (absent, pda, wallet) = (Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique());
        let key = Pubkey::new_unique();
        let (mut l1, mut l2, mut l3, mut l4, mut l5) = (0u64, 0u64, 0u64, 0u64, 0u64);

        let mut ours = token_account(&pda);
        let info = AccountInfo::new(&key, false, true, &mut l1, &mut ours, &anchor_spl::token::ID, false, 0);
        assert!(is_absent_or_owned_by(&info, &absent, &pda).unwrap(), "classic Token account owned by the PDA");

        let mut ours_2022 = token_account(&pda);
        let info = AccountInfo::new(&key, false, true, &mut l2, &mut ours_2022, &anchor_spl::token_2022::ID, false, 0);
        assert!(is_absent_or_owned_by(&info, &absent, &pda).unwrap(), "Token-2022 account owned by the PDA");

        let mut theirs = token_account(&wallet);
        let info = AccountInfo::new(&key, false, true, &mut l3, &mut theirs, &anchor_spl::token::ID, false, 0);
        assert!(!is_absent_or_owned_by(&info, &absent, &pda).unwrap(), "a wallet's token account is refused");

        let mut fake = token_account(&pda);
        let other_program = Pubkey::new_unique();
        let info = AccountInfo::new(&key, false, true, &mut l4, &mut fake, &other_program, false, 0);
        assert!(!is_absent_or_owned_by(&info, &absent, &pda).unwrap(), "same bytes under another program are refused");

        let mut nothing: Vec<u8> = vec![];
        let info = AccountInfo::new(&absent, false, false, &mut l5, &mut nothing, &absent, true, 0);
        assert!(is_absent_or_owned_by(&info, &absent, &pda).unwrap(), "the absent placeholder passes");
    }
}
