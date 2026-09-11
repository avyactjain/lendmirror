use crate::*;
use anchor_lang::solana_program::address_lookup_table::program::ID as ALT_PROGRAM_ID;
use oapp::endpoint::{instructions::RegisterOAppParams, ID as ENDPOINT_ID};

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
    /// mut = writable (lamports leave this account to pay rent).
    /// Signer = this pubkey signed the tx.
    /// Anyone can call once. First caller wins. We will lock this later.
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
        space = Store::SIZE,
        seeds = [STORE_SEED],
        bump
    )]
    pub store: Account<'info, Store>,
    /// Second PDA. Seed includes the new store address, so it is 1:1 with Store.
    /// Executor looks this up by this exact seed string.
    #[account(
        init,
        payer = payer,
        space = LzReceiveTypesAccounts::SIZE,
        seeds = [LZ_RECEIVE_TYPES_SEED, &store.key().to_bytes()],
        bump
    )]
    pub lz_receive_types_accounts: Account<'info, LzReceiveTypesAccounts>,
    /// Optional. owner = only accept if this program owns the account.
    /// UncheckedAccount = do not deserialize a typed layout.
    #[account(owner = ALT_PROGRAM_ID)]
    pub alt: Option<UncheckedAccount<'info>>,
    /// System program creates accounts. Must be in the list or init fails.
    pub system_program: Program<'info, System>,
}

// NOTE: This example init_store may be front-run. It can be called by anyone, and can only be called once.
// The first caller will be able to set the admin and endpoint program for the store. If front-runned, the program will need to be redeployed and re-initialized with the correct parameters.
// You should modify this instruction accordingly for your use case with the appropriate access control and checks.
impl InitStore<'_> {
    pub fn apply(ctx: &mut Context<InitStore>, params: &InitStoreParams) -> Result<()> {
        ctx.accounts.store.admin = params.admin;
        ctx.accounts.store.bump = ctx.bumps.store;
        ctx.accounts.store.endpoint_program = params.endpoint;
        ctx.accounts.lz_receive_types_accounts.store = ctx.accounts.store.key();
        ctx.accounts.lz_receive_types_accounts.alt =
            ctx.accounts.alt.as_ref().map(|a| a.key()).unwrap_or_default();
        ctx.accounts.lz_receive_types_accounts.bump = ctx.bumps.lz_receive_types_accounts;
        // the above lines are required for all OApp implementations

        // the line below is specific to this string-passing example
        ctx.accounts.store.string = "Nothing received yet.".to_string();

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
}
