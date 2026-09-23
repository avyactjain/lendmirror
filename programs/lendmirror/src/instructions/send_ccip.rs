use crate::errors::LendMirrorError;
use crate::*;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke_signed, pubkey};

/// `sha256("global:ccip_send")[..8]`.
pub const CCIP_SEND_DISCRIMINATOR: [u8; 8] = [108, 216, 134, 191, 249, 234, 33, 84];
/// CCIP router rejects message data above this.
pub const CCIP_DATA_LIMIT: usize = 256;
/// Chainlink `GenericExtraArgsV2` tag, then ABI-encoded `(uint256 gasLimit, bool allowOutOfOrder)`.
const EXTRA_ARGS_V2_TAG: [u8; 4] = [0x18, 0x1d, 0xcf, 0x10];
const NATIVE_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

/// Accounts the CCIP router names on `ccip_send`, plus our Store and route.
/// No tokens move. Fees are native SOL, paid from the Store.
#[derive(Accounts)]
pub struct SendCcip<'info> {
    /// Must be on `store.senders`.
    pub authority: Signer<'info>,
    /// Signs the router CPI. Must hold SOL for the CCIP fee.
    #[account(
        mut,
        seeds = [STORE_SEED],
        bump = store.bump,
        constraint = store.is_sender(&authority.key()) @ LendMirrorError::Unauthorized
    )]
    pub store: Account<'info, Store>,
    #[account(seeds = [CCIP_SEED], bump = ccip_route.bump)]
    pub ccip_route: Account<'info, CcipRoute>,

    /// CHECK: router config PDA. Owner must be `ccip_route.router`.
    pub config: UncheckedAccount<'info>,
    /// CHECK: router dest chain state. Router checks the seeds.
    #[account(mut)]
    pub dest_chain_state: UncheckedAccount<'info>,
    /// CHECK: nonce PDA for (store, dest chain). Router checks the seeds.
    #[account(mut)]
    pub nonce: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: wrapped SOL mint. Native fees still name this mint.
    pub fee_token_mint: UncheckedAccount<'info>,
    /// CHECK: zero pubkey. Native SOL does not use a fee-token account.
    pub fee_token_user: UncheckedAccount<'info>,
    /// CHECK: account that receives the fee. Router checks it.
    #[account(mut)]
    pub fee_token_receiver: UncheckedAccount<'info>,
    /// CHECK: router fee billing signer PDA.
    pub fee_billing_signer: UncheckedAccount<'info>,
    /// CHECK: fee quoter program id.
    pub fee_quoter: UncheckedAccount<'info>,
    /// CHECK: fee quoter config PDA.
    pub fee_quoter_config: UncheckedAccount<'info>,
    /// CHECK: fee quoter dest chain PDA.
    pub fee_quoter_dest_chain: UncheckedAccount<'info>,
    /// CHECK: native-mint billing config on the fee quoter.
    pub fee_quoter_billing_token_config: UncheckedAccount<'info>,
    /// CHECK: LINK billing config on the fee quoter.
    pub fee_quoter_link_token_config: UncheckedAccount<'info>,
    /// CHECK: RMN remote program id.
    pub rmn_remote: UncheckedAccount<'info>,
    /// CHECK: RMN curses PDA.
    pub rmn_remote_curses: UncheckedAccount<'info>,
    /// CHECK: RMN config PDA.
    pub rmn_remote_config: UncheckedAccount<'info>,
    /// CHECK: router token-pool signer. Unused when no tokens move. Router still requires it.
    #[account(mut)]
    pub token_pools_signer: UncheckedAccount<'info>,
}

impl SendCcip<'_> {
    pub fn apply(ctx: &mut Context<SendCcip>) -> Result<()> {
        let route = &ctx.accounts.ccip_route;
        require_keys_eq!(
            *ctx.accounts.config.owner,
            route.router,
            LendMirrorError::InvalidCcipAccount
        );
        require_keys_eq!(ctx.accounts.fee_token_mint.key(), NATIVE_MINT, LendMirrorError::InvalidCcipAccount);
        require_keys_eq!(
            ctx.accounts.fee_token_user.key(),
            Pubkey::default(),
            LendMirrorError::InvalidCcipAccount
        );
        require_keys_eq!(ctx.accounts.fee_quoter.key(), route.fee_quoter, LendMirrorError::InvalidCcipAccount);
        require_keys_eq!(ctx.accounts.rmn_remote.key(), route.rmn_remote, LendMirrorError::InvalidCcipAccount);

        let snapshot = ctx
            .accounts
            .store
            .last_position
            .as_ref()
            .ok_or(error!(LendMirrorError::NoPositionSnapshot))?;
        let body = snapshot.encode_body();
        require!(body.len() <= CCIP_DATA_LIMIT, LendMirrorError::InvalidCcipAccount);

        let data = ccip_send_instruction_data(route.dest_chain_selector, &route.receiver, &body, route.gas_limit);
        let store_key = ctx.accounts.store.key();
        let metas = vec![
            AccountMeta::new_readonly(ctx.accounts.config.key(), false),
            AccountMeta::new(ctx.accounts.dest_chain_state.key(), false),
            AccountMeta::new(ctx.accounts.nonce.key(), false),
            AccountMeta::new(store_key, true),
            AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.fee_token_mint.key(), false),
            AccountMeta::new_readonly(ctx.accounts.fee_token_user.key(), false),
            AccountMeta::new(ctx.accounts.fee_token_receiver.key(), false),
            AccountMeta::new_readonly(ctx.accounts.fee_billing_signer.key(), false),
            AccountMeta::new_readonly(ctx.accounts.fee_quoter.key(), false),
            AccountMeta::new_readonly(ctx.accounts.fee_quoter_config.key(), false),
            AccountMeta::new_readonly(ctx.accounts.fee_quoter_dest_chain.key(), false),
            AccountMeta::new_readonly(ctx.accounts.fee_quoter_billing_token_config.key(), false),
            AccountMeta::new_readonly(ctx.accounts.fee_quoter_link_token_config.key(), false),
            AccountMeta::new_readonly(ctx.accounts.rmn_remote.key(), false),
            AccountMeta::new_readonly(ctx.accounts.rmn_remote_curses.key(), false),
            AccountMeta::new_readonly(ctx.accounts.rmn_remote_config.key(), false),
            AccountMeta::new(ctx.accounts.token_pools_signer.key(), false),
        ];
        let infos = vec![
            ctx.accounts.config.to_account_info(),
            ctx.accounts.dest_chain_state.to_account_info(),
            ctx.accounts.nonce.to_account_info(),
            ctx.accounts.store.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.fee_token_mint.to_account_info(),
            ctx.accounts.fee_token_user.to_account_info(),
            ctx.accounts.fee_token_receiver.to_account_info(),
            ctx.accounts.fee_billing_signer.to_account_info(),
            ctx.accounts.fee_quoter.to_account_info(),
            ctx.accounts.fee_quoter_config.to_account_info(),
            ctx.accounts.fee_quoter_dest_chain.to_account_info(),
            ctx.accounts.fee_quoter_billing_token_config.to_account_info(),
            ctx.accounts.fee_quoter_link_token_config.to_account_info(),
            ctx.accounts.rmn_remote.to_account_info(),
            ctx.accounts.rmn_remote_curses.to_account_info(),
            ctx.accounts.rmn_remote_config.to_account_info(),
            ctx.accounts.token_pools_signer.to_account_info(),
        ];
        let bump = ctx.accounts.store.bump;
        let seeds: &[&[u8]] = &[STORE_SEED, &[bump]];
        invoke_signed(
            &Instruction { program_id: route.router, accounts: metas, data },
            &infos,
            &[seeds],
        )?;
        Ok(())
    }
}

/// Router instruction bytes for a snapshot body and no token transfer.
pub fn ccip_send_instruction_data(
    dest_chain_selector: u64,
    receiver: &[u8],
    body: &[u8],
    gas_limit: u64,
) -> Vec<u8> {
    let extra = evm_extra_args_v2(gas_limit);
    let mut data = Vec::with_capacity(256);
    data.extend_from_slice(&CCIP_SEND_DISCRIMINATOR);
    data.extend_from_slice(&dest_chain_selector.to_le_bytes());
    push_borsh_bytes(&mut data, receiver);
    push_borsh_bytes(&mut data, body);
    data.extend_from_slice(&0u32.to_le_bytes());
    data.extend_from_slice(&[0u8; 32]);
    push_borsh_bytes(&mut data, &extra);
    data.extend_from_slice(&0u32.to_le_bytes());
    data
}

pub fn evm_extra_args_v2(gas_limit: u64) -> Vec<u8> {
    let mut out = vec![0u8; 68];
    out[..4].copy_from_slice(&EXTRA_ARGS_V2_TAG);
    out[28..36].copy_from_slice(&gas_limit.to_be_bytes());
    out[67] = 1;
    out
}

fn push_borsh_bytes(buf: &mut Vec<u8>, bytes: &[u8]) {
    buf.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    buf.extend_from_slice(bytes);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extra_args_match_chainlink_v2() {
        let args = evm_extra_args_v2(400_000);
        assert_eq!(args.len(), 68);
        assert_eq!(&args[..4], &[0x18, 0x1d, 0xcf, 0x10]);
        assert_eq!(&args[28..36], &400_000u64.to_be_bytes());
        assert_eq!(args[67], 1);
    }

    #[test]
    fn ccip_data_carries_the_snapshot_body() {
        let body = vec![7u8; 225];
        let receiver = [9u8; 20];
        let data = ccip_send_instruction_data(42, &receiver, &body, 400_000);
        assert_eq!(&data[..8], &CCIP_SEND_DISCRIMINATOR);
        assert_eq!(&data[8..16], &42u64.to_le_bytes());
        let body_at = 8 + 8 + 4 + 20 + 4;
        assert_eq!(&data[body_at..body_at + 225], body.as_slice());
        assert!(body.len() <= CCIP_DATA_LIMIT);
    }
}
