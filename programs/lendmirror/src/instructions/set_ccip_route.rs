use crate::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SetCcipRoute<'info> {
    #[account(mut, address = store.admin)]
    pub admin: Signer<'info>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + CcipRoute::INIT_SPACE,
        seeds = [CCIP_SEED],
        bump
    )]
    pub ccip_route: Account<'info, CcipRoute>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    pub system_program: Program<'info, System>,
}

impl SetCcipRoute<'_> {
    pub fn apply(ctx: &mut Context<SetCcipRoute>, params: &SetCcipRouteParams) -> Result<()> {
        let route = &mut ctx.accounts.ccip_route;
        route.router = params.router;
        route.fee_quoter = params.fee_quoter;
        route.rmn_remote = params.rmn_remote;
        route.link_mint = params.link_mint;
        route.dest_chain_selector = params.dest_chain_selector;
        route.receiver = params.receiver;
        route.gas_limit = if params.gas_limit == 0 { 400_000 } else { params.gas_limit };
        route.bump = ctx.bumps.ccip_route;
        Ok(())
    }
}

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
