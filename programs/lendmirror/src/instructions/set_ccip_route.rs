use crate::*;
use anchor_lang::prelude::*;

/// Admin writes where CCIP should deliver the snapshot.
/// Call once. Call again to change the destination. Only the Store admin can call this.
///
/// Creates one account, `CcipRoute`. Its address is fixed:
/// program id + the seed text "LendMirrorCcip".
#[derive(Accounts)]
pub struct SetCcipRoute<'info> {
    /// Must be the Store admin. Pays the rent if this is the first call.
    #[account(mut, address = store.admin)]
    pub admin: Signer<'info>,

    /// Our CCIP settings. Created on the first call, overwritten on later calls.
    /// `init_if_needed` creates it when the address is empty.
    /// `space` is the 8-byte type tag plus the settings bytes.
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + CcipRoute::INIT_SPACE,
        seeds = [CCIP_SEED],
        bump
    )]
    pub ccip_route: Account<'info, CcipRoute>,

    /// Existing Store. Used only to check that `admin` really is the Store admin.
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,

    /// Required so the first call can create the account.
    pub system_program: Program<'info, System>,
}

impl SetCcipRoute<'_> {
    pub fn apply(ctx: &mut Context<SetCcipRoute>, params: &SetCcipRouteParams) -> Result<()> {
        let route = &mut ctx.accounts.ccip_route;
        // Chainlink programs on this Solana cluster. The send script derives
        // the rest of the CCIP accounts from these three ids.
        route.router = params.router;
        route.fee_quoter = params.fee_quoter;
        route.rmn_remote = params.rmn_remote;
        // LINK mint. Used to price the fee. The fee itself is paid in SOL.
        route.link_mint = params.link_mint;
        // Sepolia's CCIP chain number.
        route.dest_chain_selector = params.dest_chain_selector;
        // Sepolia LendMirror proxy, 20 bytes.
        route.receiver = params.receiver;
        // Gas the Sepolia contract may spend inside ccipReceive. 0 means 400_000.
        route.gas_limit = if params.gas_limit == 0 { 400_000 } else { params.gas_limit };
        route.bump = ctx.bumps.ccip_route;
        Ok(())
    }
}

/// Values the admin passes in. Nothing here is derived.
#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct SetCcipRouteParams {
    pub router: Pubkey,
    pub fee_quoter: Pubkey,
    pub rmn_remote: Pubkey,
    pub link_mint: Pubkey,
    pub dest_chain_selector: u64,
    pub receiver: [u8; 20],
    pub gas_limit: u64,
}
