use crate::errors::LendMirrorError;
use crate::instructions::get_jupiter_position::compute_position_snapshot;
use crate::*;
use anchor_lang::prelude::*;

/// Fill `wrapper.snapshot` from Jupiter. Clears both send flags.
/// Signer must be `wrapper.owner` or on `store.snapshotters`.
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
        ) @ LendMirrorError::Unauthorized
    )]
    pub wrapper: Account<'info, PositionWrapper>,

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

        let wrapper = &mut ctx.accounts.wrapper;
        wrapper.snapshot = Some(snapshot);
        wrapper.lz_send_allowed = false;
        wrapper.ccip_send_allowed = false;
        Ok(())
    }
}

/// OnDemand caller unlocks both routers for the next send / send_ccip.
#[derive(Accounts)]
pub struct RequestBridgeOndemand<'info> {
    pub authority: Signer<'info>,

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

    #[account(
        seeds = [ONDEMAND_SEED, wrapper.key().as_ref()],
        bump = ondemand.bump,
        constraint = ondemand.wrapper == wrapper.key() @ LendMirrorError::Unauthorized,
        constraint = ondemand.is_caller(&authority.key()) @ LendMirrorError::Unauthorized
    )]
    pub ondemand: Account<'info, OnDemandStrategy>,
}

impl RequestBridgeOndemand<'_> {
    pub fn apply(ctx: &mut Context<RequestBridgeOndemand>) -> Result<()> {
        require!(ctx.accounts.wrapper.snapshot.is_some(), LendMirrorError::NoPositionSnapshot);
        let wrapper = &mut ctx.accounts.wrapper;
        wrapper.lz_send_allowed = true;
        wrapper.ccip_send_allowed = true;
        Ok(())
    }
}
