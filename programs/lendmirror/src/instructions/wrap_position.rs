use crate::errors::LendMirrorError;
use crate::*;
use anchor_lang::prelude::*;

/// Create a wrapper PDA for one Jupiter position. Signer becomes `wrapper.owner`.
#[derive(Accounts)]
#[instruction(params: WrapPositionParams)]
pub struct WrapPosition<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + PositionWrapper::INIT_SPACE,
        seeds = [
            WRAPPER_SEED,
            &params.vault_id.to_le_bytes(),
            &params.nft_id.to_le_bytes()
        ],
        bump
    )]
    pub wrapper: Account<'info, PositionWrapper>,

    pub system_program: Program<'info, System>,
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct WrapPositionParams {
    pub vault_id: u16,
    pub nft_id: u32,
}

impl WrapPosition<'_> {
    pub fn apply(ctx: &mut Context<WrapPosition>, params: &WrapPositionParams) -> Result<()> {
        let wrapper = &mut ctx.accounts.wrapper;
        wrapper.owner = ctx.accounts.authority.key();
        wrapper.vault_id = params.vault_id;
        wrapper.nft_id = params.nft_id;
        wrapper.bump = ctx.bumps.wrapper;
        wrapper.snapshot = None;
        wrapper.lz_send_allowed = false;
        wrapper.ccip_send_allowed = false;
        Ok(())
    }
}

/// Owner creates the OnDemand strategy PDA. Seeds callers with the owner.
#[derive(Accounts)]
pub struct AttachOndemand<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [
            WRAPPER_SEED,
            &wrapper.vault_id.to_le_bytes(),
            &wrapper.nft_id.to_le_bytes()
        ],
        bump = wrapper.bump,
        constraint = wrapper.is_owner(&authority.key()) @ LendMirrorError::Unauthorized
    )]
    pub wrapper: Account<'info, PositionWrapper>,

    #[account(
        init,
        payer = authority,
        space = 8 + OnDemandStrategy::INIT_SPACE,
        seeds = [ONDEMAND_SEED, wrapper.key().as_ref()],
        bump
    )]
    pub ondemand: Account<'info, OnDemandStrategy>,

    pub system_program: Program<'info, System>,
}

impl AttachOndemand<'_> {
    pub fn apply(ctx: &mut Context<AttachOndemand>) -> Result<()> {
        let ondemand = &mut ctx.accounts.ondemand;
        ondemand.wrapper = ctx.accounts.wrapper.key();
        ondemand.bump = ctx.bumps.ondemand;
        ondemand.set_callers(&[ctx.accounts.authority.key()])?;
        Ok(())
    }
}

/// Owner replaces the OnDemand caller list (max 8).
#[derive(Accounts)]
pub struct SetOndemandCallers<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [
            WRAPPER_SEED,
            &wrapper.vault_id.to_le_bytes(),
            &wrapper.nft_id.to_le_bytes()
        ],
        bump = wrapper.bump,
        constraint = wrapper.is_owner(&authority.key()) @ LendMirrorError::Unauthorized
    )]
    pub wrapper: Account<'info, PositionWrapper>,

    #[account(
        mut,
        seeds = [ONDEMAND_SEED, wrapper.key().as_ref()],
        bump = ondemand.bump,
        constraint = ondemand.wrapper == wrapper.key() @ LendMirrorError::Unauthorized
    )]
    pub ondemand: Account<'info, OnDemandStrategy>,
}

impl SetOndemandCallers<'_> {
    pub fn apply(ctx: &mut Context<SetOndemandCallers>, params: &SetAllowlistParams) -> Result<()> {
        ctx.accounts.ondemand.set_callers(&params.keys)
    }
}
