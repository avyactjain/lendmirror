//! `send_position_snapshot_via_chainlink_and_lz`: push the wrapper's snapshot to the EVM side
//! over LayerZero and Chainlink CCIP in one transaction.
//!
//! Owns: the send authorization, the once-per-refresh guard, and the two CPIs. Does NOT own:
//! the message bytes (`state/jupiter_position.rs::encode_body`) or the CCIP instruction layout
//! (`send_ccip.rs`).
//!
//! Who may call: anyone on the wrapper's OnDemand list, or anyone on `store.senders`. The
//! senders list is the "operator" list: one key that may sync every wrapper without being added
//! to each wrapper's 8-slot OnDemand list.
//!
//! Invariants:
//!   - A snapshot goes out at most once. `wrapper.can_send` must be true; `record_send` runs
//!     after both CPIs succeed. If either CPI fails the whole transaction reverts, so the guard
//!     never records a send that did not happen.
//!   - The Store PDA signs LayerZero (it is our OApp identity). The empty CCIP payer PDA signs
//!     Chainlink and pays its SOL fee. Neither key exists off-chain: `invoke_signed` lets this
//!     program sign as a PDA by supplying the seeds that derive it.
//!
//! Typical call: hardhat task `lz:oapp:solana:send-position-snapshot-via-chainlink-and-lz`
//! (or `sync-all-positions`) → this instruction → Sepolia `lzReceive` and `ccipReceive`.
//!
//! Anchor notes:
//!   - `#[instruction(params: ...)]` lets the account constraints read the instruction's
//!     arguments; `peer` needs `params.dst_eid` for its seeds.
//!   - `Box<Account<..>>` puts the deserialized account on the heap. Solana's stack frame is 4 KB
//!     and this struct has 27 accounts, so the boxes keep the frame small.
//!   - `remaining_accounts` are extra accounts appended by the client. LayerZero's Endpoint needs
//!     a long list (send library, DVNs, fee payers) that we do not name here; the LayerZero SDK
//!     assembles it and the Endpoint CPI consumes it.

use crate::errors::LendMirrorError;
use crate::instructions::send_ccip::{ccip_send_instruction_data, CCIP_DATA_LIMIT};
use crate::msg_codec::LzMessage;
use crate::*;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke, program::invoke_signed, pubkey, system_instruction};
use oapp::endpoint::{
    instructions::SendParams, state::EndpointSettings, ENDPOINT_SEED, ID as ENDPOINT_ID,
};

/// Wrapped SOL mint. CCIP bills the fee against this mint even when we pay in native SOL.
const NATIVE_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
const TOKEN_PROGRAM: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

#[derive(Accounts)]
#[instruction(params: SendPositionSnapshotViaChainlinkAndLzParams)]
pub struct SendPositionSnapshotViaChainlinkAndLz<'info> {
    /// Pays the LayerZero fee (via remaining accounts) and tops up the CCIP payer.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Optional. Needed only when the caller is on this wrapper's OnDemand list.
    #[account(
        seeds = [ONDEMAND_SEED, wrapper.key().as_ref()],
        bump = ondemand.bump,
        constraint = ondemand.wrapper == wrapper.key() @ LendMirrorError::Unauthorized
    )]
    pub ondemand: Option<Box<Account<'info, OnDemandStrategy>>>,

    /// `mut` because `record_send` writes the guard fields after the CPIs.
    #[account(
        mut,
        seeds = [
            WRAPPER_SEED,
            &wrapper.vault_id.to_le_bytes(),
            &wrapper.nft_id.to_le_bytes()
        ],
        bump = wrapper.bump,
        constraint = (
            store.is_sender(&authority.key())
            || ondemand.as_ref().is_some_and(|list| list.is_caller(&authority.key()))
        ) @ LendMirrorError::Unauthorized
    )]
    pub wrapper: Box<Account<'info, PositionWrapper>>,

    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Box<Account<'info, Store>>,

    /// LayerZero peer for `params.dst_eid`: the EVM proxy address and enforced options.
    #[account(
        seeds = [
            PEER_SEED,
            &store.key().to_bytes(),
            &params.dst_eid.to_be_bytes()
        ],
        bump = peer.bump
    )]
    pub peer: Box<Account<'info, PeerConfig>>,

    /// LayerZero Endpoint settings PDA, owned by the Endpoint program (`seeds::program`).
    #[account(seeds = [ENDPOINT_SEED], bump = endpoint.bump, seeds::program = ENDPOINT_ID)]
    pub endpoint: Box<Account<'info, EndpointSettings>>,

    /// CHECK: empty account. Signs the Chainlink CPI and pays its SOL fee.
    #[account(mut, seeds = [CCIP_PAYER_SEED], bump)]
    pub ccip_payer: UncheckedAccount<'info>,

    #[account(seeds = [CCIP_SEED], bump = ccip_route.bump)]
    pub ccip_route: Box<Account<'info, CcipRoute>>,

    // --- Chainlink router accounts. Derived by lib/client/ccip.ts ccipSendAccounts. ---
    /// CHECK: router config PDA. Owner must be `ccip_route.router` (checked in apply).
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
    /// CHECK: wrapped SOL mint (checked in apply).
    pub fee_token_mint: UncheckedAccount<'info>,
    /// CHECK: zero pubkey = "pay the fee in native SOL" (checked in apply).
    pub fee_token_user: UncheckedAccount<'info>,
    /// CHECK: fee receiver.
    #[account(mut)]
    pub fee_token_receiver: UncheckedAccount<'info>,
    /// CHECK: router fee billing signer PDA.
    pub fee_billing_signer: UncheckedAccount<'info>,
    /// CHECK: fee quoter program id (checked in apply).
    pub fee_quoter: UncheckedAccount<'info>,
    /// CHECK: fee quoter config PDA.
    pub fee_quoter_config: UncheckedAccount<'info>,
    /// CHECK: fee quoter dest chain PDA.
    pub fee_quoter_dest_chain: UncheckedAccount<'info>,
    /// CHECK: native-mint billing config.
    pub fee_quoter_billing_token_config: UncheckedAccount<'info>,
    /// CHECK: LINK billing config.
    pub fee_quoter_link_token_config: UncheckedAccount<'info>,
    /// CHECK: RMN remote program id (checked in apply).
    pub rmn_remote: UncheckedAccount<'info>,
    /// CHECK: RMN curses PDA.
    pub rmn_remote_curses: UncheckedAccount<'info>,
    /// CHECK: RMN config PDA.
    pub rmn_remote_config: UncheckedAccount<'info>,
    /// CHECK: router token-pool signer. Required even with no tokens in the message.
    #[account(mut)]
    pub token_pools_signer: UncheckedAccount<'info>,
    /// CHECK: CCIP router program.
    #[account(address = ccip_route.router)]
    pub ccip_router: UncheckedAccount<'info>,
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct SendPositionSnapshotViaChainlinkAndLzParams {
    /// LayerZero destination endpoint id (Sepolia 40161, Arbitrum 30110).
    pub dst_eid: u32,
    /// Extra LayerZero options (executor gas). Combined with the peer's enforced options.
    pub options: Vec<u8>,
    /// LayerZero fee in lamports, from `quote_send`.
    pub native_fee: u64,
    pub lz_token_fee: u64,
    /// Lamports moved from `authority` to the CCIP payer before the Chainlink CPI.
    pub ccip_fee_lamports: u64,
}

impl<'info> SendPositionSnapshotViaChainlinkAndLz<'info> {
    pub fn apply(
        ctx: &mut Context<SendPositionSnapshotViaChainlinkAndLz>,
        params: &SendPositionSnapshotViaChainlinkAndLzParams,
    ) -> Result<()> {
        let snapshot = ctx
            .accounts
            .wrapper
            .snapshot
            .clone()
            .ok_or(error!(LendMirrorError::NoPositionSnapshot))?;
        require!(
            ctx.accounts.wrapper.can_send(snapshot.snapshot_time),
            LendMirrorError::SnapshotAlreadySent
        );
        check_ccip_accounts(ctx)?;

        let lz_message = snapshot.encode();
        let body = snapshot.encode_body();
        require!(body.len() <= CCIP_DATA_LIMIT, LendMirrorError::InvalidCcipAccount);

        fund_ccip_payer(ctx, params.ccip_fee_lamports)?;
        send_layerzero(ctx, params, lz_message)?;
        send_chainlink(ctx, &body)?;

        ctx.accounts.wrapper.record_send(snapshot.snapshot_time);
        Ok(())
    }
}

/// The CCIP accounts we can verify against our own route. The router verifies the rest.
fn check_ccip_accounts(ctx: &Context<SendPositionSnapshotViaChainlinkAndLz>) -> Result<()> {
    let a = &ctx.accounts;
    let route = &a.ccip_route;
    require_keys_eq!(*a.config.owner, route.router, LendMirrorError::InvalidCcipAccount);
    require_keys_eq!(a.fee_token_mint.key(), NATIVE_MINT, LendMirrorError::InvalidCcipAccount);
    require_keys_eq!(a.fee_token_user.key(), Pubkey::default(), LendMirrorError::InvalidCcipAccount);
    require_keys_eq!(a.fee_quoter.key(), route.fee_quoter, LendMirrorError::InvalidCcipAccount);
    require_keys_eq!(a.rmn_remote.key(), route.rmn_remote, LendMirrorError::InvalidCcipAccount);
    // The payer must stay empty: the System program refuses to transfer SOL out of an account
    // that holds data, and the router charges the fee with exactly such a transfer.
    require!(a.ccip_payer.data_is_empty(), LendMirrorError::InvalidCcipAccount);
    Ok(())
}

/// Move `lamports` from the caller onto the CCIP payer so the router can charge its fee.
fn fund_ccip_payer(ctx: &Context<SendPositionSnapshotViaChainlinkAndLz>, lamports: u64) -> Result<()> {
    if lamports == 0 {
        return Ok(());
    }
    let a = &ctx.accounts;
    invoke(
        &system_instruction::transfer(&a.authority.key(), &a.ccip_payer.key(), lamports),
        &[
            a.authority.to_account_info(),
            a.ccip_payer.to_account_info(),
            a.system_program.to_account_info(),
        ],
    )?;
    Ok(())
}

/// LayerZero leg. The Store PDA signs: `seeds` are what `invoke_signed` needs to prove that
/// this program controls the Store address.
fn send_layerzero(
    ctx: &Context<SendPositionSnapshotViaChainlinkAndLz>,
    params: &SendPositionSnapshotViaChainlinkAndLzParams,
    message: Vec<u8>,
) -> Result<()> {
    let a = &ctx.accounts;
    let options = a.peer.enforced_options.combine_options(&None::<Vec<u8>>, &params.options)?;
    let seeds: &[&[u8]] = &[STORE_SEED, &[a.store.bump]];
    oapp::endpoint_cpi::send(
        ENDPOINT_ID,
        a.store.key(),
        ctx.remaining_accounts,
        seeds,
        SendParams {
            dst_eid: params.dst_eid,
            receiver: a.peer.peer_address,
            message,
            options,
            native_fee: params.native_fee,
            lz_token_fee: params.lz_token_fee,
        },
    )?;
    Ok(())
}

/// Chainlink leg. The empty payer PDA signs. Account order is the router's `ccip_send` layout;
/// the data bytes come from `ccip_send_instruction_data`.
fn send_chainlink(ctx: &Context<SendPositionSnapshotViaChainlinkAndLz>, body: &[u8]) -> Result<()> {
    let a = &ctx.accounts;
    let route = &a.ccip_route;
    let data = ccip_send_instruction_data(route.dest_chain_selector, &route.receiver, body, route.gas_limit, &[], &[]);
    let metas = vec![
        AccountMeta::new_readonly(a.config.key(), false),
        AccountMeta::new(a.dest_chain_state.key(), false),
        AccountMeta::new(a.nonce.key(), false),
        AccountMeta::new(a.ccip_payer.key(), true),
        AccountMeta::new_readonly(a.system_program.key(), false),
        AccountMeta::new_readonly(a.fee_token_program.key(), false),
        AccountMeta::new_readonly(a.fee_token_mint.key(), false),
        AccountMeta::new_readonly(a.fee_token_user.key(), false),
        AccountMeta::new(a.fee_token_receiver.key(), false),
        AccountMeta::new_readonly(a.fee_billing_signer.key(), false),
        AccountMeta::new_readonly(a.fee_quoter.key(), false),
        AccountMeta::new_readonly(a.fee_quoter_config.key(), false),
        AccountMeta::new_readonly(a.fee_quoter_dest_chain.key(), false),
        AccountMeta::new_readonly(a.fee_quoter_billing_token_config.key(), false),
        AccountMeta::new_readonly(a.fee_quoter_link_token_config.key(), false),
        AccountMeta::new_readonly(a.rmn_remote.key(), false),
        AccountMeta::new_readonly(a.rmn_remote_curses.key(), false),
        AccountMeta::new_readonly(a.rmn_remote_config.key(), false),
        AccountMeta::new(a.token_pools_signer.key(), false),
    ];
    let infos = vec![
        a.config.to_account_info(),
        a.dest_chain_state.to_account_info(),
        a.nonce.to_account_info(),
        a.ccip_payer.to_account_info(),
        a.system_program.to_account_info(),
        a.fee_token_program.to_account_info(),
        a.fee_token_mint.to_account_info(),
        a.fee_token_user.to_account_info(),
        a.fee_token_receiver.to_account_info(),
        a.fee_billing_signer.to_account_info(),
        a.fee_quoter.to_account_info(),
        a.fee_quoter_config.to_account_info(),
        a.fee_quoter_dest_chain.to_account_info(),
        a.fee_quoter_billing_token_config.to_account_info(),
        a.fee_quoter_link_token_config.to_account_info(),
        a.rmn_remote.to_account_info(),
        a.rmn_remote_curses.to_account_info(),
        a.rmn_remote_config.to_account_info(),
        a.token_pools_signer.to_account_info(),
        a.ccip_router.to_account_info(),
    ];
    let payer_seeds: &[&[u8]] = &[CCIP_PAYER_SEED, &[ctx.bumps.ccip_payer]];
    invoke_signed(
        &Instruction { program_id: route.router, accounts: metas, data },
        &infos,
        &[payer_seeds],
    )?;
    Ok(())
}
