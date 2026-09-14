use crate::errors::LendMirrorError;
use crate::tick_math::{self, debt_raw_at_tick, normalize_tick};
use crate::{
    decode_position, decode_tick, decode_vault_state_prices, decode_vault_tokens, PositionSnapshot,
    PositionSnapshotAccount, Store, JUP_POSITION_SEED, STORE_SEED,
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(params: GetJupiterPositionParams)]
pub struct GetJupiterPosition<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut, seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,

    /// Jupiter Vaults program. Must match `store.vaults_program` from init_store.
    /// CHECK: compared to Store below.
    #[account(constraint = vaults_program.key() == store.vaults_program @ LendMirrorError::InvalidJupiterAccount)]
    pub vaults_program: UncheckedAccount<'info>,

    /// Jupiter Position PDA: ["position", vault_id le, nft_id le] on Vaults.
    /// CHECK: seeds + owner.
    #[account(
        seeds = [
            b"position",
            &params.vault_id.to_le_bytes(),
            &params.nft_id.to_le_bytes()
        ],
        bump,
        seeds::program = vaults_program,
        owner = vaults_program.key()
    )]
    pub position: UncheckedAccount<'info>,

    /// Jupiter VaultState PDA: ["vault_state", vault_id le].
    /// CHECK: seeds + owner.
    #[account(
        seeds = [b"vault_state", &params.vault_id.to_le_bytes()],
        bump,
        seeds::program = vaults_program,
        owner = vaults_program.key()
    )]
    pub vault_state: UncheckedAccount<'info>,

    /// Jupiter VaultConfig PDA: ["vault_config", vault_id le].
    /// CHECK: seeds + owner.
    #[account(
        seeds = [b"vault_config", &params.vault_id.to_le_bytes()],
        bump,
        seeds::program = vaults_program,
        owner = vaults_program.key()
    )]
    pub vault_config: UncheckedAccount<'info>,

    /// Jupiter Tick PDA. Address is checked in apply from Position.tick.
    /// CHECK: owner is Vaults; PDA match after decode.
    #[account(owner = vaults_program.key())]
    pub tick: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + PositionSnapshotAccount::INIT_SPACE,
        seeds = [
            JUP_POSITION_SEED,
            &params.vault_id.to_le_bytes(),
            &params.nft_id.to_le_bytes()
        ],
        bump
    )]
    pub position_store: Account<'info, PositionSnapshotAccount>,

    pub system_program: Program<'info, System>,
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct GetJupiterPositionParams {
    pub vault_id: u16,
    pub nft_id: u32,
}

impl GetJupiterPosition<'_> {
    pub fn apply(
        ctx: &mut Context<GetJupiterPosition>,
        params: &GetJupiterPositionParams,
    ) -> Result<PositionSnapshot> {
        let vaults_program = ctx.accounts.store.vaults_program;

        let position = decode_position(&ctx.accounts.position.try_borrow_data()?)?;
        require!(
            position.vault_id == params.vault_id && position.nft_id == params.nft_id,
            LendMirrorError::PositionIdMismatch
        );

        let (expected_tick, _) = Pubkey::find_program_address(
            &[
                b"tick",
                &params.vault_id.to_le_bytes(),
                &tick_math::tick_pda_seed(position.tick),
            ],
            &vaults_program,
        );
        require!(
            ctx.accounts.tick.key() == expected_tick,
            LendMirrorError::TickPdaMismatch
        );

        let tick = decode_tick(&ctx.accounts.tick.try_borrow_data()?)?;
        require!(
            tick.vault_id == params.vault_id && tick.tick == normalize_tick(position.tick),
            LendMirrorError::TickPdaMismatch
        );
        let prices = decode_vault_state_prices(&ctx.accounts.vault_state.try_borrow_data()?)?;
        let tokens = decode_vault_tokens(&ctx.accounts.vault_config.try_borrow_data()?)?;

        let is_supply_only = position.is_supply_only_position != 0;
        let position_tick = normalize_tick(position.tick);
        let is_liquidated =
            !is_supply_only && (tick.is_liquidated != 0 || tick.total_ids > position.tick_id);

        let col_raw = position.supply_amount;
        let dust_debt = position.dust_debt_amount;
        let debt_raw = if is_supply_only {
            0
        } else {
            debt_raw_at_tick(position.tick, col_raw)?
        };
        let net_debt = debt_raw.saturating_sub(dust_debt);

        let snapshot = PositionSnapshot {
            position: ctx.accounts.position.key(),
            vault_id: params.vault_id,
            nft_id: params.nft_id,
            position_mint: position.position_mint,
            supply_token: tokens.supply_token,
            borrow_token: tokens.borrow_token,
            col_raw,
            debt_raw,
            dust_debt,
            net_debt,
            tick: position_tick,
            tick_id: position.tick_id,
            is_supply_only,
            is_liquidated,
            vault_supply_exchange_price: prices.vault_supply_exchange_price,
            vault_borrow_exchange_price: prices.vault_borrow_exchange_price,
            snapshot_time: Clock::get()?.unix_timestamp,
        };

        ctx.accounts.position_store.snapshot = snapshot.clone();
        ctx.accounts.store.last_position = Some(snapshot.clone());

        Ok(snapshot)
    }
}
