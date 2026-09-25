use crate::errors::LendMirrorError;
use crate::instructions::send_ccip::{ccip_send_instruction_data, CCIP_DATA_LIMIT};
use crate::msg_codec::LzMessage;
use crate::*;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke, program::invoke_signed, pubkey, system_instruction};
use oapp::endpoint::{
    instructions::SendParams, state::EndpointSettings, ENDPOINT_SEED, ID as ENDPOINT_ID,
};

const NATIVE_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
const TOKEN_PROGRAM: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/// OnDemand caller sends `wrapper.snapshot` on LayerZero and Chainlink.
/// Store signs LayerZero. The empty payer signs Chainlink.
#[derive(Accounts)]
#[instruction(params: SendPositionSnapshotViaChainlinkAndLzParams)]
pub struct SendPositionSnapshotViaChainlinkAndLz<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [ONDEMAND_SEED, wrapper.key().as_ref()],
        bump = ondemand.bump,
        constraint = ondemand.wrapper == wrapper.key() @ LendMirrorError::Unauthorized,
        constraint = ondemand.is_caller(&authority.key()) @ LendMirrorError::Unauthorized
    )]
    pub ondemand: Box<Account<'info, OnDemandStrategy>>,

    #[account(
        seeds = [
            WRAPPER_SEED,
            &wrapper.vault_id.to_le_bytes(),
            &wrapper.nft_id.to_le_bytes()
        ],
        bump = wrapper.bump
    )]
    pub wrapper: Box<Account<'info, PositionWrapper>>,

    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Box<Account<'info, Store>>,

    #[account(
        seeds = [
            PEER_SEED,
            &store.key().to_bytes(),
            &params.dst_eid.to_be_bytes()
        ],
        bump = peer.bump
    )]
    pub peer: Box<Account<'info, PeerConfig>>,

    #[account(seeds = [ENDPOINT_SEED], bump = endpoint.bump, seeds::program = ENDPOINT_ID)]
    pub endpoint: Box<Account<'info, EndpointSettings>>,

    /// CHECK: empty account. Signs `ccip_send` and pays the Chainlink SOL fee.
    #[account(mut, seeds = [CCIP_PAYER_SEED], bump)]
    pub ccip_payer: UncheckedAccount<'info>,

    #[account(seeds = [CCIP_SEED], bump = ccip_route.bump)]
    pub ccip_route: Box<Account<'info, CcipRoute>>,

    /// CHECK: router config PDA. Owner must be `ccip_route.router`.
    pub config: UncheckedAccount<'info>,
    /// CHECK: router dest chain state.
    #[account(mut)]
    pub dest_chain_state: UncheckedAccount<'info>,
    /// CHECK: nonce PDA for (payer, dest chain).
    #[account(mut)]
    pub nonce: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: SPL token program.
    #[account(address = TOKEN_PROGRAM)]
    pub fee_token_program: UncheckedAccount<'info>,
    /// CHECK: wrapped SOL mint.
    pub fee_token_mint: UncheckedAccount<'info>,
    /// CHECK: zero pubkey.
    pub fee_token_user: UncheckedAccount<'info>,
    /// CHECK: fee receiver.
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
    /// CHECK: native-mint billing config.
    pub fee_quoter_billing_token_config: UncheckedAccount<'info>,
    /// CHECK: LINK billing config.
    pub fee_quoter_link_token_config: UncheckedAccount<'info>,
    /// CHECK: RMN remote program id.
    pub rmn_remote: UncheckedAccount<'info>,
    /// CHECK: RMN curses PDA.
    pub rmn_remote_curses: UncheckedAccount<'info>,
    /// CHECK: RMN config PDA.
    pub rmn_remote_config: UncheckedAccount<'info>,
    /// CHECK: router token-pool signer.
    #[account(mut)]
    pub token_pools_signer: UncheckedAccount<'info>,
    /// CHECK: CCIP router program.
    #[account(address = ccip_route.router)]
    pub ccip_router: UncheckedAccount<'info>,
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct SendPositionSnapshotViaChainlinkAndLzParams {
    pub dst_eid: u32,
    pub options: Vec<u8>,
    pub native_fee: u64,
    pub lz_token_fee: u64,
    pub ccip_fee_lamports: u64,
}

impl<'info> SendPositionSnapshotViaChainlinkAndLz<'info> {
    pub fn apply(
        ctx: &mut Context<SendPositionSnapshotViaChainlinkAndLz>,
        params: &SendPositionSnapshotViaChainlinkAndLzParams,
    ) -> Result<()> {
        require!(ctx.accounts.wrapper.snapshot.is_some(), LendMirrorError::NoPositionSnapshot);

        let route = &ctx.accounts.ccip_route;
        require_keys_eq!(*ctx.accounts.config.owner, route.router, LendMirrorError::InvalidCcipAccount);
        require_keys_eq!(ctx.accounts.fee_token_mint.key(), NATIVE_MINT, LendMirrorError::InvalidCcipAccount);
        require_keys_eq!(ctx.accounts.fee_token_user.key(), Pubkey::default(), LendMirrorError::InvalidCcipAccount);
        require_keys_eq!(ctx.accounts.fee_quoter.key(), route.fee_quoter, LendMirrorError::InvalidCcipAccount);
        require_keys_eq!(ctx.accounts.rmn_remote.key(), route.rmn_remote, LendMirrorError::InvalidCcipAccount);
        require!(ctx.accounts.ccip_payer.data_is_empty(), LendMirrorError::InvalidCcipAccount);

        let lz_message = ctx.accounts.wrapper.snapshot.as_ref().unwrap().encode();
        let body = ctx.accounts.wrapper.snapshot.as_ref().unwrap().encode_body();
        require!(body.len() <= CCIP_DATA_LIMIT, LendMirrorError::InvalidCcipAccount);

        let dest_chain_selector = route.dest_chain_selector;
        let receiver = route.receiver;
        let gas_limit = route.gas_limit;
        let router = route.router;
        let store_bump = ctx.accounts.store.bump;
        let store_key = ctx.accounts.store.key();
        let peer_address = ctx.accounts.peer.peer_address;
        let options = ctx.accounts.peer.enforced_options.combine_options(&None::<Vec<u8>>, &params.options)?;
        let payer_bump = ctx.bumps.ccip_payer;

        if params.ccip_fee_lamports > 0 {
            invoke(
                &system_instruction::transfer(
                    &ctx.accounts.authority.key(),
                    &ctx.accounts.ccip_payer.key(),
                    params.ccip_fee_lamports,
                ),
                &[
                    ctx.accounts.authority.to_account_info(),
                    ctx.accounts.ccip_payer.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
            )?;
        }

        let seeds: &[&[u8]] = &[STORE_SEED, &[store_bump]];
        oapp::endpoint_cpi::send(
            ENDPOINT_ID,
            store_key,
            ctx.remaining_accounts,
            seeds,
            SendParams {
                dst_eid: params.dst_eid,
                receiver: peer_address,
                message: lz_message,
                options,
                native_fee: params.native_fee,
                lz_token_fee: params.lz_token_fee,
            },
        )?;

        let data = ccip_send_instruction_data(dest_chain_selector, &receiver, &body, gas_limit);
        let payer_key = ctx.accounts.ccip_payer.key();
        let metas = vec![
            AccountMeta::new_readonly(ctx.accounts.config.key(), false),
            AccountMeta::new(ctx.accounts.dest_chain_state.key(), false),
            AccountMeta::new(ctx.accounts.nonce.key(), false),
            AccountMeta::new(payer_key, true),
            AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.fee_token_program.key(), false),
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
            ctx.accounts.ccip_payer.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.fee_token_program.to_account_info(),
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
            ctx.accounts.ccip_router.to_account_info(),
        ];
        let payer_seeds: &[&[u8]] = &[CCIP_PAYER_SEED, &[payer_bump]];
        invoke_signed(
            &Instruction { program_id: router, accounts: metas, data },
            &infos,
            &[payer_seeds],
        )?;
        Ok(())
    }
}
