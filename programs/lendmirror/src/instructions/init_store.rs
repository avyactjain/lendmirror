use crate::errors::LendMirrorError;
use crate::*;
use oapp::endpoint::{instructions::RegisterOAppParams, ID as ENDPOINT_ID};

/// BPF-loader ProgramData PDA for this program.
/// Seeds: `[program_id]` under `bpf_loader_upgradeable`.
pub fn program_data_address() -> Pubkey {
    Pubkey::find_program_address(
        &[crate::ID.as_ref()],
        &anchor_lang::solana_program::bpf_loader_upgradeable::ID,
    )
    .0
}

/// Anchor: #[derive(Accounts)] writes the checks that run BEFORE apply().
/// If a check fails, apply never runs.
///
/// #[instruction(params)] lets seed constraints below read params
/// (not used here; send.rs uses params.dst_eid in seeds).
///
/// 'info = these account refs live only for this instruction.
#[derive(Accounts)]
#[instruction(params: InitStoreParams)]
pub struct InitStore<'info> {
    /// Signs and pays rent.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// init = create this account now. Fails if it already exists.
    /// payer = who pays rent. space = bytes allocated.
    /// seeds + bump = address MUST be PDA(STORE_SEED, this program).
    /// Bare `bump` (no `= store.bump`) means: find the bump, then create.
    /// Later instructions use `bump = store.bump` to verify, not recreate.
    #[account(
        init,
        payer = payer,
        space = 8 + Store::INIT_SPACE,
        seeds = [STORE_SEED],
        bump
    )]
    pub store: Account<'info, Store>,

    /// This program's executable account. Binds `program_data` to us so a
    /// caller cannot pass another program's ProgramData.
    pub program: Program<'info, crate::program::Lendmirror>,

    /// BPF-loader ProgramData for `program`. Upgrade authority is set at deploy.
    /// `payer` must be that authority. `params.admin` is Store admin, not the gate.
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key()) @ LendMirrorError::Unauthorized,
        constraint = program_data.upgrade_authority_address.as_ref() == Some(&payer.key()) @ LendMirrorError::Unauthorized
    )]
    pub program_data: Account<'info, ProgramData>,

    /// System program creates accounts. Must be in the list or init fails.
    pub system_program: Program<'info, System>,
}

impl InitStore<'_> {
    pub fn apply(ctx: &mut Context<InitStore>, params: &InitStoreParams) -> Result<()> {
        require!(
            ctx.accounts.program_data.upgrade_authority_address.as_ref()
                == Some(&ctx.accounts.payer.key()),
            LendMirrorError::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.program_data.key(),
            program_data_address(),
            LendMirrorError::Unauthorized
        );

        ctx.accounts.store.admin = params.admin;
        ctx.accounts.store.bump = ctx.bumps.store;
        ctx.accounts.store.endpoint_program = params.endpoint;
        ctx.accounts.store.vaults_program = params.vaults_program;
        ctx.accounts.store.last_position = None;
        // Seed both allowlists with admin so create → snapshot → send works
        // without an extra set_* call. Admin can replace the lists later.
        ctx.accounts.store.set_snapshotters(&[params.admin])?;
        ctx.accounts.store.set_senders(&[params.admin])?;

        // Prepare the delegate address for the OApp registration.
        let register_params = RegisterOAppParams { delegate: ctx.accounts.store.admin };

        // The Store PDA 'signs' CPI to the Endpoint program to register the OApp.
        let seeds: &[&[u8]] = &[STORE_SEED, &[ctx.accounts.store.bump]];
        oapp::endpoint_cpi::register_oapp(
            ENDPOINT_ID,
            ctx.accounts.store.key(),
            ctx.remaining_accounts,
            seeds,
            register_params,
        )?;

        Ok(())
    }
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct InitStoreParams {
    pub admin: Pubkey,
    pub endpoint: Pubkey,
    pub vaults_program: Pubkey,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn program_data_pda_matches_bpf_loader_derivation() {
        let (expected, _) = Pubkey::find_program_address(
            &[crate::ID.as_ref()],
            &anchor_lang::solana_program::bpf_loader_upgradeable::ID,
        );
        assert_eq!(program_data_address(), expected);
        assert_ne!(program_data_address(), crate::ID);
    }
}
