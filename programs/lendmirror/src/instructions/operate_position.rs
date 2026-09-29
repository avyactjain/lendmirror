//! `operate_position`: deposit, withdraw, borrow, or pay back on a custodied Jupiter position.
//!
//! Owns: the level gate, the fund-safety checks, and the CPI into Jupiter Vaults `operate`.
//! Does NOT own: custody (`custody.rs`), the level policy (`state/wrapper.rs::level_allows`),
//! or reading the result back (`refresh_wrapper`, which the caller runs afterwards).
//!
//! Invariants (fund safety):
//!   - Jupiter's `signer` is the wrapper authority PDA. This program signs for it with
//!     `invoke_signed`; no wallet ever holds that key.
//!   - Jupiter's `recipient` is the same PDA, and every token account in the call is that PDA's
//!     associated token account. Withdrawn collateral and borrowed tokens can only land there.
//!   - `level_allows(wrapper.level, new_col, new_debt)` must hold. Level 1 can only lower risk.
//!
//! Who may call: the wrapper owner or an OnDemand caller of that wrapper. Snapshotters only read
//! and senders only send; neither may move a position.
//!
//! Typical call: hardhat `lz:oapp:solana:operate-position --col 1000000 --debt 0` → the client
//! asks the Jupiter SDK for the account list with the authority PDA as signer → this instruction.
//!
//! Jupiter needs 35 accounts. They are named here, in Jupiter's order, so the client and the
//! IDL show exactly what is passed. The ones this program can pin are pinned with constraints;
//! the rest (`/// CHECK: Jupiter validates`) are checked by the Vaults program itself. Jupiter's
//! own extra accounts (oracle sources, branches, tick debt arrays) arrive in `remaining_accounts`.

use crate::errors::LendMirrorError;
use crate::seeds::{ONDEMAND_SEED, STORE_SEED, WRAPPER_AUTH_SEED, WRAPPER_SEED};
use crate::*;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke_signed};
use anchor_spl::associated_token::{get_associated_token_address_with_program_id, AssociatedToken};
use anchor_spl::token_interface::TokenInterface;

/// `sha256("global:operate")[..8]` of the Jupiter Vaults program.
pub const JUPITER_OPERATE_DISCRIMINATOR: [u8; 8] = [217, 106, 208, 99, 116, 151, 42, 135];

#[derive(Accounts)]
#[instruction(params: OperatePositionParams)]
pub struct OperatePosition<'info> {
    /// Pays transaction fees and any account Jupiter creates via the setup instructions.
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
        constraint = level_allows(wrapper.level, params.new_col, params.new_debt) @ LendMirrorError::LevelDenied
    )]
    pub wrapper: Box<Account<'info, PositionWrapper>>,

    #[account(
        seeds = [ONDEMAND_SEED, wrapper.key().as_ref()],
        bump = ondemand.bump,
        constraint = ondemand.wrapper == wrapper.key() @ LendMirrorError::Unauthorized
    )]
    pub ondemand: Option<Box<Account<'info, OnDemandStrategy>>>,

    /// CHECK: empty PDA. Jupiter's `signer` and `recipient`; signed via `invoke_signed`.
    #[account(mut, seeds = [WRAPPER_AUTH_SEED, wrapper.key().as_ref()], bump = wrapper.authority_bump)]
    pub wrapper_authority: UncheckedAccount<'info>,

    /// CHECK: must be the Jupiter Vaults program recorded in the Store.
    #[account(address = store.vaults_program)]
    pub vaults_program: UncheckedAccount<'info>,

    // ----- Jupiter `operate` accounts, in Jupiter's order. -----
    /// CHECK: ATA(wrapper_authority, supply_token). Verified in apply.
    #[account(mut)]
    pub signer_supply_token_account: UncheckedAccount<'info>,
    /// CHECK: ATA(wrapper_authority, borrow_token). Verified in apply.
    #[account(mut)]
    pub signer_borrow_token_account: UncheckedAccount<'info>,
    // recipient, recipient_borrow_token_account, recipient_supply_token_account:
    // the same three accounts as above, reused. Not separate fields.
    /// CHECK: seeds + owner.
    #[account(
        seeds = [b"vault_config", &wrapper.vault_id.to_le_bytes()],
        bump,
        seeds::program = vaults_program,
        owner = vaults_program.key()
    )]
    pub vault_config: UncheckedAccount<'info>,
    /// CHECK: seeds + owner.
    #[account(
        mut,
        seeds = [b"vault_state", &wrapper.vault_id.to_le_bytes()],
        bump,
        seeds::program = vaults_program,
        owner = vaults_program.key()
    )]
    pub vault_state: UncheckedAccount<'info>,
    /// CHECK: compared with the mints stored in vault_config, in apply.
    pub supply_token: UncheckedAccount<'info>,
    /// CHECK: compared with the mints stored in vault_config, in apply.
    pub borrow_token: UncheckedAccount<'info>,
    /// CHECK: Jupiter validates.
    pub oracle: UncheckedAccount<'info>,
    /// CHECK: seeds + owner.
    #[account(
        mut,
        seeds = [
            b"position",
            &wrapper.vault_id.to_le_bytes(),
            &wrapper.nft_id.to_le_bytes()
        ],
        bump,
        seeds::program = vaults_program,
        owner = vaults_program.key()
    )]
    pub position: UncheckedAccount<'info>,
    /// CHECK: ATA(wrapper_authority, position_mint) under the classic Token program. Verified in apply.
    pub position_token_account: UncheckedAccount<'info>,
    /// CHECK: Jupiter validates.
    #[account(mut)]
    pub current_position_tick: UncheckedAccount<'info>,
    /// CHECK: Jupiter validates.
    #[account(mut)]
    pub final_position_tick: UncheckedAccount<'info>,
    /// CHECK: Jupiter validates.
    pub current_position_tick_id: UncheckedAccount<'info>,
    /// CHECK: Jupiter validates.
    #[account(mut)]
    pub final_position_tick_id: UncheckedAccount<'info>,
    /// CHECK: Jupiter validates.
    #[account(mut)]
    pub new_branch: UncheckedAccount<'info>,
    /// CHECK: Jupiter validates.
    #[account(mut)]
    pub supply_token_reserves_liquidity: UncheckedAccount<'info>,
    /// CHECK: Jupiter validates.
    #[account(mut)]
    pub borrow_token_reserves_liquidity: UncheckedAccount<'info>,
    /// CHECK: Jupiter validates.
    #[account(mut)]
    pub vault_supply_position_on_liquidity: UncheckedAccount<'info>,
    /// CHECK: Jupiter validates.
    #[account(mut)]
    pub vault_borrow_position_on_liquidity: UncheckedAccount<'info>,
    /// CHECK: Jupiter validates.
    pub supply_rate_model: UncheckedAccount<'info>,
    /// CHECK: Jupiter validates.
    pub borrow_rate_model: UncheckedAccount<'info>,
    /// CHECK: Jupiter validates.
    #[account(mut)]
    pub vault_supply_token_account: UncheckedAccount<'info>,
    /// CHECK: Jupiter validates.
    #[account(mut)]
    pub vault_borrow_token_account: UncheckedAccount<'info>,
    /// CHECK: Jupiter validates. Only for claim-type transfers; usually absent.
    #[account(mut)]
    pub supply_token_claim_account: Option<UncheckedAccount<'info>>,
    /// CHECK: Jupiter validates. Only for claim-type transfers; usually absent.
    #[account(mut)]
    pub borrow_token_claim_account: Option<UncheckedAccount<'info>>,
    /// CHECK: Jupiter validates.
    pub liquidity: UncheckedAccount<'info>,
    /// CHECK: Jupiter validates.
    pub liquidity_program: UncheckedAccount<'info>,
    /// CHECK: Jupiter validates.
    pub oracle_program: UncheckedAccount<'info>,
    pub supply_token_program: Interface<'info, TokenInterface>,
    pub borrow_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Same meaning as Jupiter's `operate` arguments.
#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct OperatePositionParams {
    /// Collateral change in supply-token base units. Positive deposits, negative withdraws,
    /// `i128::MIN` withdraws everything.
    pub new_col: i128,
    /// Debt change in borrow-token base units. Positive borrows, negative pays back,
    /// `i128::MIN` pays back everything.
    pub new_debt: i128,
    /// Jupiter `TransferType`. Only `None` or `Some(1)` (direct transfer) are accepted. `Some(2)`
    /// (claim) would park withdrawn tokens in a Liquidity "claim" account that nothing here can
    /// spend, so it is rejected (`LevelDenied`).
    pub transfer_type: Option<u8>,
    /// Jupiter's `remaining_accounts_indices`: how many oracle sources, branches, and tick
    /// debt arrays follow in `remaining_accounts`. The Jupiter SDK computes this.
    pub remaining_accounts_indices: Vec<u8>,
}

impl<'info> OperatePosition<'info> {
    // The explicit lifetimes tie `remaining_accounts` to the same `'info` as the named
    // accounts, so both can go into one `Vec<AccountInfo<'info>>` for the CPI.
    pub fn apply(
        ctx: &mut Context<'_, '_, '_, 'info, OperatePosition<'info>>,
        params: &OperatePositionParams,
    ) -> Result<()> {
        // Fund safety: every token Jupiter pays out must land in the authority's ATAs, which only
        // holds for a direct transfer. Claim-type transfers and claim accounts are refused.
        require!(matches!(params.transfer_type, None | Some(1)), LendMirrorError::LevelDenied);
        require!(
            ctx.accounts.supply_token_claim_account.is_none() && ctx.accounts.borrow_token_claim_account.is_none(),
            LendMirrorError::InvalidTokenAccount
        );
        check_token_accounts(ctx)?;
        let a = &ctx.accounts;
        let wrapper_key = a.wrapper.key();
        let seeds: &[&[u8]] = &[WRAPPER_AUTH_SEED, wrapper_key.as_ref(), &[a.wrapper.authority_bump]];
        let instruction = Instruction {
            program_id: a.vaults_program.key(),
            accounts: jupiter_operate_metas(a, ctx.remaining_accounts),
            data: jupiter_operate_data(params),
        };
        let mut infos = jupiter_operate_infos(a);
        infos.extend_from_slice(ctx.remaining_accounts);
        invoke_signed(&instruction, &infos, &[seeds])?;
        Ok(())
    }
}

/// The three token accounts must be the authority's ATAs, and the mints must be the vault's.
fn check_token_accounts(ctx: &Context<'_, '_, '_, '_, OperatePosition>) -> Result<()> {
    let a = &ctx.accounts;
    let tokens = decode_vault_tokens(&a.vault_config.try_borrow_data()?)?;
    require_keys_eq!(a.supply_token.key(), tokens.supply_token, LendMirrorError::InvalidJupiterAccount);
    require_keys_eq!(a.borrow_token.key(), tokens.borrow_token, LendMirrorError::InvalidJupiterAccount);
    let owner = a.wrapper_authority.key();
    let expected_supply =
        get_associated_token_address_with_program_id(&owner, &tokens.supply_token, &a.supply_token_program.key());
    let expected_borrow =
        get_associated_token_address_with_program_id(&owner, &tokens.borrow_token, &a.borrow_token_program.key());
    // Jupiter mints the position NFT with the classic Token program (see its init_position seeds).
    let expected_nft =
        get_associated_token_address_with_program_id(&owner, &a.wrapper.position_mint, &anchor_spl::token::ID);
    require_keys_eq!(a.signer_supply_token_account.key(), expected_supply, LendMirrorError::InvalidTokenAccount);
    require_keys_eq!(a.signer_borrow_token_account.key(), expected_borrow, LendMirrorError::InvalidTokenAccount);
    require_keys_eq!(a.position_token_account.key(), expected_nft, LendMirrorError::InvalidTokenAccount);
    Ok(())
}

/// Borsh bytes Jupiter expects: discriminator, new_col, new_debt, Option<TransferType>, bytes.
///
/// `jupiter_operate_data(&{new_col: 5, new_debt: 0, transfer_type: None, indices: [1,0,0]})`
/// starts with the 8 discriminator bytes, then `5i128` little-endian, then 16 zero bytes,
/// then `0` (None), then `3,0,0,0,1,0,0` (length-prefixed vec).
pub fn jupiter_operate_data(params: &OperatePositionParams) -> Vec<u8> {
    let mut data = Vec::with_capacity(8 + 16 + 16 + 2 + 4 + params.remaining_accounts_indices.len());
    data.extend_from_slice(&JUPITER_OPERATE_DISCRIMINATOR);
    // AnchorSerialize on the params struct is Borsh, which is exactly Jupiter's arg layout.
    params.serialize(&mut data).expect("Vec<u8> writer cannot fail");
    data
}

/// Optional Jupiter accounts that are absent are passed as the Vaults program id (Anchor's
/// convention for `Option<Account>` on the callee side). The placeholder must be read-only:
/// a CPI may not mark an account writable that the outer transaction did not.
fn meta_or_program(opt: &Option<UncheckedAccount>, program: &UncheckedAccount) -> AccountMeta {
    match opt {
        Some(acc) => AccountMeta::new(acc.key(), false),
        None => AccountMeta::new_readonly(program.key(), false),
    }
}

fn info_or_program<'info>(
    opt: &Option<UncheckedAccount<'info>>,
    program: &UncheckedAccount<'info>,
) -> AccountInfo<'info> {
    opt.as_ref().map(|acc| acc.to_account_info()).unwrap_or_else(|| program.to_account_info())
}

/// Account metas in Jupiter's `operate` order. Writable flags match the Vaults IDL.
fn jupiter_operate_metas(a: &OperatePosition, remaining: &[AccountInfo]) -> Vec<AccountMeta> {
    let auth = a.wrapper_authority.key();
    let supply_ata = a.signer_supply_token_account.key();
    let borrow_ata = a.signer_borrow_token_account.key();
    let mut metas = vec![
        AccountMeta::new(auth, true), // signer (PDA, signed by invoke_signed)
        AccountMeta::new(supply_ata, false),
        AccountMeta::new(borrow_ata, false),
        AccountMeta::new_readonly(auth, false), // recipient = the same PDA
        AccountMeta::new(borrow_ata, false),    // recipient_borrow_token_account
        AccountMeta::new(supply_ata, false),    // recipient_supply_token_account
        AccountMeta::new_readonly(a.vault_config.key(), false),
        AccountMeta::new(a.vault_state.key(), false),
        AccountMeta::new_readonly(a.supply_token.key(), false),
        AccountMeta::new_readonly(a.borrow_token.key(), false),
        AccountMeta::new_readonly(a.oracle.key(), false),
        AccountMeta::new(a.position.key(), false),
        AccountMeta::new_readonly(a.position_token_account.key(), false),
        AccountMeta::new(a.current_position_tick.key(), false),
        AccountMeta::new(a.final_position_tick.key(), false),
        AccountMeta::new_readonly(a.current_position_tick_id.key(), false),
        AccountMeta::new(a.final_position_tick_id.key(), false),
        AccountMeta::new(a.new_branch.key(), false),
        AccountMeta::new(a.supply_token_reserves_liquidity.key(), false),
        AccountMeta::new(a.borrow_token_reserves_liquidity.key(), false),
        AccountMeta::new(a.vault_supply_position_on_liquidity.key(), false),
        AccountMeta::new(a.vault_borrow_position_on_liquidity.key(), false),
        AccountMeta::new_readonly(a.supply_rate_model.key(), false),
        AccountMeta::new_readonly(a.borrow_rate_model.key(), false),
        AccountMeta::new(a.vault_supply_token_account.key(), false),
        AccountMeta::new(a.vault_borrow_token_account.key(), false),
        meta_or_program(&a.supply_token_claim_account, &a.vaults_program),
        meta_or_program(&a.borrow_token_claim_account, &a.vaults_program),
        AccountMeta::new_readonly(a.liquidity.key(), false),
        AccountMeta::new_readonly(a.liquidity_program.key(), false),
        AccountMeta::new_readonly(a.oracle_program.key(), false),
        AccountMeta::new_readonly(a.supply_token_program.key(), false),
        AccountMeta::new_readonly(a.borrow_token_program.key(), false),
        AccountMeta::new_readonly(a.associated_token_program.key(), false),
        AccountMeta::new_readonly(a.system_program.key(), false),
    ];
    // Jupiter's own extra accounts keep the flags the client set on them.
    metas.extend(remaining.iter().map(|info| AccountMeta {
        pubkey: info.key(),
        is_signer: false,
        is_writable: info.is_writable,
    }));
    metas
}

/// The `AccountInfo`s the runtime needs for every meta above (plus the program itself).
fn jupiter_operate_infos<'info>(a: &OperatePosition<'info>) -> Vec<AccountInfo<'info>> {
    vec![
        a.wrapper_authority.to_account_info(),
        a.signer_supply_token_account.to_account_info(),
        a.signer_borrow_token_account.to_account_info(),
        a.vault_config.to_account_info(),
        a.vault_state.to_account_info(),
        a.supply_token.to_account_info(),
        a.borrow_token.to_account_info(),
        a.oracle.to_account_info(),
        a.position.to_account_info(),
        a.position_token_account.to_account_info(),
        a.current_position_tick.to_account_info(),
        a.final_position_tick.to_account_info(),
        a.current_position_tick_id.to_account_info(),
        a.final_position_tick_id.to_account_info(),
        a.new_branch.to_account_info(),
        a.supply_token_reserves_liquidity.to_account_info(),
        a.borrow_token_reserves_liquidity.to_account_info(),
        a.vault_supply_position_on_liquidity.to_account_info(),
        a.vault_borrow_position_on_liquidity.to_account_info(),
        a.supply_rate_model.to_account_info(),
        a.borrow_rate_model.to_account_info(),
        a.vault_supply_token_account.to_account_info(),
        a.vault_borrow_token_account.to_account_info(),
        info_or_program(&a.supply_token_claim_account, &a.vaults_program),
        info_or_program(&a.borrow_token_claim_account, &a.vaults_program),
        a.liquidity.to_account_info(),
        a.liquidity_program.to_account_info(),
        a.oracle_program.to_account_info(),
        a.supply_token_program.to_account_info(),
        a.borrow_token_program.to_account_info(),
        a.associated_token_program.to_account_info(),
        a.system_program.to_account_info(),
        a.vaults_program.to_account_info(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operate_data_matches_jupiter_borsh_layout() {
        let params = OperatePositionParams {
            new_col: 5,
            new_debt: -1,
            transfer_type: None,
            remaining_accounts_indices: vec![1, 0, 0],
        };
        let data = jupiter_operate_data(&params);
        assert_eq!(&data[..8], &JUPITER_OPERATE_DISCRIMINATOR);
        assert_eq!(&data[8..24], &5i128.to_le_bytes());
        assert_eq!(&data[24..40], &(-1i128).to_le_bytes());
        assert_eq!(data[40], 0, "Option::None is one zero byte");
        assert_eq!(&data[41..45], &3u32.to_le_bytes(), "vec length prefix");
        assert_eq!(&data[45..], &[1, 0, 0]);
        assert_eq!(data.len(), 48);
    }

    #[test]
    fn operate_data_encodes_some_transfer_type() {
        let params = OperatePositionParams {
            new_col: 0,
            new_debt: i128::MIN,
            transfer_type: Some(1),
            remaining_accounts_indices: vec![],
        };
        let data = jupiter_operate_data(&params);
        assert_eq!(&data[40..42], &[1, 1], "Some(1) is tag 1 then the value");
        assert_eq!(&data[42..46], &0u32.to_le_bytes());
        assert_eq!(data.len(), 46);
    }
}
