//! `refresh_wrapper`: read one Jupiter position and store the live numbers in the wrapper.
//!
//! Owns: the account checks for a refresh and who may call it. Does NOT own: the math (see
//! `get_jupiter_position.rs::compute_position_snapshot`) or sending (see
//! `send_position_snapshot.rs`).
//!
//! Who may call: the wrapper owner, any Store snapshotter, or (if the wrapper has an OnDemand
//! list) anyone on that list.
//!
//! Anchor notes:
//!   - `#[derive(Accounts)]` turns this struct into the list of accounts the instruction needs and
//!     the checks that run before `apply`. If any check fails, `apply` never runs.
//!   - `seeds = [...]` + `bump = x.bump` means "this account's address must be the PDA of these
//!     seeds". A caller cannot pass a look-alike account.
//!   - `Option<Account<..>>` is an account the caller may leave out. The client passes the
//!     program id in that slot and Anchor gives us `None`.
//!   - `UncheckedAccount` skips Anchor's type check; we say what we verified in a `/// CHECK:`
//!     line (Anchor refuses to compile without it).

use crate::errors::LendMirrorError;
use crate::instructions::get_jupiter_position::compute_position_snapshot;
use crate::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct RefreshWrapper<'info> {
    pub authority: Signer<'info>,

    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,

    #[account(
        mut,
        seeds = [
            WRAPPER_SEED,
            &wrapper.vault_id.to_le_bytes(),
            &wrapper.nft_id.to_le_bytes()
        ],
        bump = wrapper.bump,
        constraint = (
            wrapper.is_owner(&authority.key())
            || store.is_snapshotter(&authority.key())
            || ondemand.as_ref().is_some_and(|list| list.is_caller(&authority.key()))
        ) @ LendMirrorError::Unauthorized
    )]
    pub wrapper: Account<'info, PositionWrapper>,

    /// Optional. Only needed when the caller is on the OnDemand list rather than owner or
    /// snapshotter. When present it must be this wrapper's list.
    #[account(
        seeds = [ONDEMAND_SEED, wrapper.key().as_ref()],
        bump = ondemand.bump,
        constraint = ondemand.wrapper == wrapper.key() @ LendMirrorError::Unauthorized
    )]
    pub ondemand: Option<Account<'info, OnDemandStrategy>>,

    /// CHECK: compared to Store.
    #[account(constraint = vaults_program.key() == store.vaults_program @ LendMirrorError::InvalidJupiterAccount)]
    pub vaults_program: UncheckedAccount<'info>,

    /// CHECK: seeds + owner.
    #[account(
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

    /// CHECK: seeds + owner.
    #[account(
        seeds = [b"vault_state", &wrapper.vault_id.to_le_bytes()],
        bump,
        seeds::program = vaults_program,
        owner = vaults_program.key()
    )]
    pub vault_state: UncheckedAccount<'info>,

    /// CHECK: seeds + owner.
    #[account(
        seeds = [b"vault_config", &wrapper.vault_id.to_le_bytes()],
        bump,
        seeds::program = vaults_program,
        owner = vaults_program.key()
    )]
    pub vault_config: UncheckedAccount<'info>,

    /// CHECK: owner is Vaults; PDA match in compute.
    #[account(owner = vaults_program.key())]
    pub tick: UncheckedAccount<'info>,

    /// CHECK: owner is Vaults; PDA match in compute.
    #[account(owner = vaults_program.key())]
    pub tick_id_liquidation: Option<UncheckedAccount<'info>>,
}

impl RefreshWrapper<'_> {
    pub fn apply(ctx: &mut Context<RefreshWrapper>) -> Result<()> {
        let vault_id = ctx.accounts.wrapper.vault_id;
        let nft_id = ctx.accounts.wrapper.nft_id;
        let position = ctx.accounts.position.to_account_info();
        let tick = ctx.accounts.tick.to_account_info();
        let vault_state = ctx.accounts.vault_state.to_account_info();
        let vault_config = ctx.accounts.vault_config.to_account_info();
        let tick_id_liq = ctx.accounts.tick_id_liquidation.as_ref().map(|a| a.to_account_info());

        // Branch accounts for a liquidated tick arrive in `remaining_accounts`; the client
        // works out which ones to pass (see lib/client/lendmirror.ts collectLivePositionAccounts).
        let snapshot = compute_position_snapshot(
            &ctx.accounts.store.vaults_program,
            vault_id,
            nft_id,
            &position,
            &tick,
            &vault_state,
            &vault_config,
            tick_id_liq.as_ref(),
            ctx.remaining_accounts,
        )?;

        // `snapshot_time` is the current clock, so this snapshot is newer than anything sent
        // before. That is what re-arms the send guard (see PositionWrapper::can_send).
        ctx.accounts.wrapper.snapshot = Some(snapshot);
        Ok(())
    }
}
