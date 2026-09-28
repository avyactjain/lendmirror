//! Custody of the Jupiter position NFT and the admin-set access level.
//!
//! Owns: `set_wrapper_level`, `deposit_position_nft`, `release_position_nft`. Does NOT own:
//! operating the position (see `operate_position.rs`) or the level policy itself
//! (`state/wrapper.rs::level_allows`).
//!
//! Invariants:
//!   - The NFT lives in the associated token account of the wrapper AUTHORITY PDA, never in a
//!     wallet, while `wrapper.custody` is true.
//!   - Whoever holds the NFT can deposit it, and that wallet becomes the wrapper owner. Only the
//!     Store admin can release, and release always returns the NFT to the wrapper owner, never
//!     to a caller-chosen address. So the NFT always goes back to the wallet that put it in.
//!
//! Typical call: `wrap_position` → `deposit_position_nft` → admin `set_wrapper_level 1` →
//! `operate_position` (deposit / payback) → admin `set_wrapper_level 2` → withdraw / borrow.
//!
//! Anchor + SPL notes:
//!   - `InterfaceAccount<Mint>` / `InterfaceAccount<TokenAccount>` accept both the classic Token
//!     program and Token-2022. `Interface<TokenInterface>` is the matching program account.
//!   - `associated_token::mint = m, associated_token::authority = a` pins an account to the ATA of
//!     (a, m). An ATA is a PDA of the Associated Token program, so nobody can substitute another
//!     token account for it.
//!   - `init_if_needed` creates the ATA on first use and accepts it if it already exists.
//!   - `transfer_checked` is the SPL transfer that also verifies mint and decimals.

use crate::errors::LendMirrorError;
use crate::*;
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked};

/// Admin sets `wrapper.level`. `level` must be 0..=4.
#[derive(Accounts)]
pub struct SetWrapperLevel<'info> {
    #[account(address = store.admin)]
    pub admin: Signer<'info>,

    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,

    #[account(
        mut,
        seeds = [
            WRAPPER_SEED,
            &wrapper.vault_id.to_le_bytes(),
            &wrapper.nft_id.to_le_bytes()
        ],
        bump = wrapper.bump
    )]
    pub wrapper: Account<'info, PositionWrapper>,
}

impl SetWrapperLevel<'_> {
    pub fn apply(ctx: &mut Context<SetWrapperLevel>, level: u8) -> Result<()> {
        require!(level <= LEVEL_MAX, LendMirrorError::InvalidLevel);
        ctx.accounts.wrapper.level = level;
        Ok(())
    }
}

/// The NFT holder hands the position NFT to the wrapper authority and becomes the wrapper owner.
///
/// The wrapper may have been created by an ops wallet (a snapshotter). Requiring that wallet to
/// also hold the NFT would make custody impossible for any position it does not own itself. So
/// the only check on the signer is the one the token program enforces anyway: they must own the
/// token account the NFT leaves from.
#[derive(Accounts)]
pub struct DepositPositionNft<'info> {
    /// Holds the NFT now and pays for the authority's token account. Becomes `wrapper.owner`.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Box<Account<'info, Store>>,

    #[account(
        mut,
        seeds = [
            WRAPPER_SEED,
            &wrapper.vault_id.to_le_bytes(),
            &wrapper.nft_id.to_le_bytes()
        ],
        bump = wrapper.bump,
        constraint = !wrapper.custody @ LendMirrorError::AlreadyInCustody
    )]
    pub wrapper: Box<Account<'info, PositionWrapper>>,

    /// CHECK: empty PDA, only its address matters here. Becomes the NFT holder.
    #[account(seeds = [WRAPPER_AUTH_SEED, wrapper.key().as_ref()], bump = wrapper.authority_bump)]
    pub wrapper_authority: UncheckedAccount<'info>,

    /// CHECK: must be the Jupiter Vaults program recorded in the Store.
    #[account(address = store.vaults_program)]
    pub vaults_program: UncheckedAccount<'info>,

    /// The position NFT mint. Jupiter derives it as
    /// `["position_mint", vault_id le, nft_id le]` under the Vaults program, so the seeds
    /// check proves this mint belongs to exactly this (vault, nft).
    #[account(
        seeds = [
            b"position_mint",
            &wrapper.vault_id.to_le_bytes(),
            &wrapper.nft_id.to_le_bytes()
        ],
        bump,
        seeds::program = vaults_program,
        mint::token_program = token_program
    )]
    pub position_mint: Box<InterfaceAccount<'info, Mint>>,

    /// The signer's token account holding the single NFT. `token::authority = authority` is the
    /// ownership proof: only the wallet that owns this account can sign the transfer out of it.
    #[account(
        mut,
        token::mint = position_mint,
        token::authority = authority,
        token::token_program = token_program,
        constraint = source_nft_ata.amount == 1 @ LendMirrorError::InvalidTokenAccount
    )]
    pub source_nft_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The authority's associated token account for the NFT. Created here if missing.
    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = position_mint,
        associated_token::authority = wrapper_authority,
        associated_token::token_program = token_program
    )]
    pub wrapper_nft_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

impl DepositPositionNft<'_> {
    pub fn apply(ctx: &mut Context<DepositPositionNft>) -> Result<()> {
        let a = &ctx.accounts;
        transfer_checked(
            CpiContext::new(
                a.token_program.to_account_info(),
                TransferChecked {
                    from: a.source_nft_ata.to_account_info(),
                    mint: a.position_mint.to_account_info(),
                    to: a.wrapper_nft_ata.to_account_info(),
                    authority: a.authority.to_account_info(),
                },
            ),
            1,
            a.position_mint.decimals,
        )?;
        let wrapper = &mut ctx.accounts.wrapper;
        wrapper.custody = true;
        wrapper.position_mint = ctx.accounts.position_mint.key();
        // The depositor owns the wrapper from now on: `release_position_nft` returns the NFT to
        // `wrapper.owner`, so this is what guarantees it goes back to the wallet that put it in.
        wrapper.owner = ctx.accounts.authority.key();
        Ok(())
    }
}

/// Admin returns the position NFT to the wrapper owner. Escape hatch outside the level policy.
#[derive(Accounts)]
pub struct ReleasePositionNft<'info> {
    /// Store admin. Pays for the owner's token account if it does not exist yet.
    #[account(mut, address = store.admin)]
    pub admin: Signer<'info>,

    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Box<Account<'info, Store>>,

    #[account(
        mut,
        seeds = [
            WRAPPER_SEED,
            &wrapper.vault_id.to_le_bytes(),
            &wrapper.nft_id.to_le_bytes()
        ],
        bump = wrapper.bump,
        constraint = wrapper.custody @ LendMirrorError::NoCustody
    )]
    pub wrapper: Box<Account<'info, PositionWrapper>>,

    /// CHECK: empty PDA. Signs the transfer out via `invoke_signed`.
    #[account(seeds = [WRAPPER_AUTH_SEED, wrapper.key().as_ref()], bump = wrapper.authority_bump)]
    pub wrapper_authority: UncheckedAccount<'info>,

    /// CHECK: the wrapper owner, fixed by the wrapper. The NFT can only go here.
    #[account(address = wrapper.owner)]
    pub owner: UncheckedAccount<'info>,

    #[account(address = wrapper.position_mint, mint::token_program = token_program)]
    pub position_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = position_mint,
        associated_token::authority = wrapper_authority,
        associated_token::token_program = token_program
    )]
    pub wrapper_nft_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = admin,
        associated_token::mint = position_mint,
        associated_token::authority = owner,
        associated_token::token_program = token_program
    )]
    pub owner_nft_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

impl ReleasePositionNft<'_> {
    pub fn apply(ctx: &mut Context<ReleasePositionNft>) -> Result<()> {
        let a = &ctx.accounts;
        let wrapper_key = a.wrapper.key();
        // `invoke_signed` needs the exact seeds of the signing PDA, bump included.
        let seeds: &[&[u8]] = &[WRAPPER_AUTH_SEED, wrapper_key.as_ref(), &[a.wrapper.authority_bump]];
        transfer_checked(
            CpiContext::new_with_signer(
                a.token_program.to_account_info(),
                TransferChecked {
                    from: a.wrapper_nft_ata.to_account_info(),
                    mint: a.position_mint.to_account_info(),
                    to: a.owner_nft_ata.to_account_info(),
                    authority: a.wrapper_authority.to_account_info(),
                },
                &[seeds],
            ),
            1,
            a.position_mint.decimals,
        )?;
        ctx.accounts.wrapper.custody = false;
        Ok(())
    }
}
