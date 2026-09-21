use crate::errors::LendMirrorError;
use crate::live_position::{liquidation_record, walk_branches, Branch, LivePosition};
use crate::tick_math::{
    self, debt_raw_at_tick, liquidation_debt_raw_at_tick, normalize_tick, MIN_TICK,
};
use crate::{
    branch_address, decode_branch, decode_position, decode_tick, decode_tick_id_liquidation,
    decode_vault_state_prices, decode_vault_tokens, tick_id_liquidation_address, PositionSnapshot,
    PositionSnapshotAccount, Store, JUP_POSITION_SEED, STORE_SEED,
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(params: GetJupiterPositionParams)]
pub struct GetJupiterPosition<'info> {
    /// Must be on `store.snapshotters`.
    pub authority: Signer<'info>,

    /// Pays rent for `position_store` if created.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [STORE_SEED],
        bump = store.bump,
        constraint = store.is_snapshotter(&authority.key()) @ LendMirrorError::Unauthorized
    )]
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

    /// Jupiter TickIdLiquidation PDA, when the tick flushed this position's id
    /// out of the Tick account. Address is checked in apply. Leave it out when
    /// the Tick still holds the record, or when the account was never created.
    /// CHECK: owner is Vaults; PDA match in apply.
    #[account(owner = vaults_program.key())]
    pub tick_id_liquidation: Option<UncheckedAccount<'info>>,

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
    /// Read the position and, if its tick was liquidated, recompute what is
    /// actually left.
    ///
    /// Branch accounts come in through `remaining_accounts`. The caller works
    /// out the chain off-chain and passes it; we re-derive every branch address
    /// from the id we are walking to, so a wrong or forged account is rejected
    /// rather than trusted.
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
            &[b"tick", &params.vault_id.to_le_bytes(), &tick_math::tick_pda_seed(position.tick)],
            &vaults_program,
        );
        require!(ctx.accounts.tick.key() == expected_tick, LendMirrorError::TickPdaMismatch);

        let tick = decode_tick(&ctx.accounts.tick.try_borrow_data()?)?;
        require!(
            tick.vault_id == params.vault_id && tick.tick == normalize_tick(position.tick),
            LendMirrorError::TickPdaMismatch
        );
        let prices = decode_vault_state_prices(&ctx.accounts.vault_state.try_borrow_data()?)?;
        let tokens = decode_vault_tokens(&ctx.accounts.vault_config.try_borrow_data()?)?;

        let is_supply_only = position.is_supply_only_position != 0;
        let stored_tick = normalize_tick(position.tick);
        let is_liquidated =
            !is_supply_only && (tick.is_liquidated != 0 || tick.total_ids > position.tick_id);

        // What the Position account says today.
        let stored_col_raw = position.supply_amount;
        let mut dust_debt = position.dust_debt_amount;
        let stored_debt_raw =
            if is_supply_only { 0 } else { debt_raw_at_tick(position.tick, stored_col_raw)? };

        // Without a liquidation, live and stored are the same thing.
        let mut live = LivePosition {
            tick: stored_tick,
            col_raw: stored_col_raw,
            debt_raw: stored_debt_raw,
            branch_id: 0,
        };
        let mut is_fully_liquidated = false;

        if is_liquidated {
            let flushed = match &ctx.accounts.tick_id_liquidation {
                Some(account) => {
                    let expected = tick_id_liquidation_address(
                        &vaults_program,
                        params.vault_id,
                        stored_tick,
                        position.tick_id,
                    );
                    require_keys_eq!(account.key(), expected, LendMirrorError::TickPdaMismatch);
                    Some(decode_tick_id_liquidation(&account.try_borrow_data()?)?)
                },
                None => None,
            };
            // Older ids live on TickIdLiquidation, not on the Tick. Missing that
            // account would look like "not liquidated" and wipe the numbers.
            require!(
                tick.total_ids == position.tick_id || flushed.is_some(),
                LendMirrorError::MissingLiquidationRecord
            );

            let record = liquidation_record(position.tick_id, &tick, flushed.as_ref());

            if record.is_fully_liquidated {
                // Collateral and debt were both taken. Nothing is owed and
                // nothing is left to withdraw.
                live = LivePosition {
                    tick: MIN_TICK,
                    col_raw: 0,
                    debt_raw: 0,
                    branch_id: record.branch_id,
                };
                dust_debt = 0;
                is_fully_liquidated = true;
            } else {
                let branches = ctx.remaining_accounts;
                live = walk_branches(
                    record.branch_id,
                    record.connection_factor,
                    liquidation_debt_raw_at_tick(position.tick, stored_col_raw)?,
                    |branch_id| {
                        let expected = branch_address(&vaults_program, params.vault_id, branch_id);
                        let account = branches
                            .iter()
                            .find(|account| account.key() == expected)
                            .ok_or(error!(LendMirrorError::MissingBranchAccount))?;
                        require_keys_eq!(
                            *account.owner,
                            vaults_program,
                            LendMirrorError::InvalidJupiterAccount
                        );
                        let decoded = decode_branch(&account.try_borrow_data()?)?;
                        require!(
                            decoded.vault_id == params.vault_id && decoded.branch_id == branch_id,
                            LendMirrorError::InvalidJupiterAccount
                        );
                        Ok(Branch {
                            status: decoded.status,
                            minima_tick: decoded.minima_tick,
                            minima_tick_partials: decoded.minima_tick_partials,
                            debt_factor: decoded.debt_factor,
                            connected_branch_id: decoded.connected_branch_id,
                        })
                    },
                )?;
            }
        }

        if live.col_raw == 0 && live.debt_raw == 0 && is_liquidated {
            is_fully_liquidated = true;
        }

        let net_debt = live.debt_raw.saturating_sub(dust_debt);

        let snapshot = PositionSnapshot {
            position: ctx.accounts.position.key(),
            vault_id: params.vault_id,
            nft_id: params.nft_id,
            position_mint: position.position_mint,
            supply_token: tokens.supply_token,
            borrow_token: tokens.borrow_token,
            col_raw: live.col_raw,
            debt_raw: live.debt_raw,
            dust_debt,
            net_debt,
            tick: live.tick,
            tick_id: position.tick_id,
            stored_col_raw,
            stored_debt_raw,
            stored_tick,
            is_supply_only,
            is_liquidated,
            is_fully_liquidated,
            branch_id: live.branch_id,
            vault_supply_exchange_price: prices.vault_supply_exchange_price,
            vault_borrow_exchange_price: prices.vault_borrow_exchange_price,
            snapshot_time: Clock::get()?.unix_timestamp,
        };

        ctx.accounts.position_store.snapshot = snapshot.clone();
        ctx.accounts.store.last_position = Some(snapshot.clone());

        Ok(snapshot)
    }
}
