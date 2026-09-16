use crate::*;
use anchor_lang::prelude::*;

/// Admin-only. Replace the full snapshotter allowlist (max [`ALLOWLIST_LEN`]).
#[derive(Accounts)]
pub struct SetSnapshotters<'info> {
    #[account(mut, address = store.admin)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
}

impl SetSnapshotters<'_> {
    pub fn apply(ctx: &mut Context<SetSnapshotters>, params: &SetAllowlistParams) -> Result<()> {
        ctx.accounts.store.set_snapshotters(&params.keys)
    }
}

/// Admin-only. Replace the full sender allowlist (max [`ALLOWLIST_LEN`]).
#[derive(Accounts)]
pub struct SetSenders<'info> {
    #[account(mut, address = store.admin)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
}

impl SetSenders<'_> {
    pub fn apply(ctx: &mut Context<SetSenders>, params: &SetAllowlistParams) -> Result<()> {
        ctx.accounts.store.set_senders(&params.keys)
    }
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct SetAllowlistParams {
    pub keys: Vec<Pubkey>,
}
