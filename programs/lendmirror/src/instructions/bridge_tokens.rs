//! Token bridging out of a wrapper: `set_bridge_route` (admin) and the three provider
//! instructions `bridge_tokens_cctp` (Circle), `bridge_tokens_ccip` (Chainlink), and
//! `bridge_tokens_lz` (LayerZero, via a same-transaction guard).
//!
//! Owns: who may bridge, the amount cap, the move out of the wrapper authority's token account,
//! the Circle/Chainlink CPIs, and the LayerZero guard. Does NOT own: the instruction bytes
//! (`bridges.rs`, `send_ccip.rs`) or the route layout (`state/bridge_route.rs`).
//!
//! Invariants (fund safety):
//!   - No instruction here takes a destination. The EVM receiver comes from `BridgeRoute`, which
//!     only the Store admin writes.
//!   - Circle/Chainlink: tokens move wrapper-authority ATA → bridge-signer ATA → provider. Both
//!     ATAs belong to PDAs of this program. No wallet is ever a token owner in this path.
//!   - LayerZero: our program cannot call the issuer's bridge (the call chain would be six
//!     programs deep; Solana allows five), so the issuer's `send` runs as its own instruction
//!     and `bridge_tokens_lz` releases the tokens only after verifying, through the
//!     instructions sysvar, that this same all-or-nothing transaction contains that exact send:
//!     right issuer program, right amount, destination fixed to the route's receiver. The
//!     caller's wallet account holds the tokens for zero observable time: if the send fails or
//!     is missing, the whole transaction reverts and nothing ever left the wrapper.
//!   - The bridge signer is the same empty PDA that pays Chainlink fees (`LendMirrorCcipPayerV1`).
//!     It must hold no data so the System program can debit it for fees.
//!
//! Who may call: the wrapper owner, an OnDemand caller of that wrapper, or a Store sender
//! (operator), and the wrapper's level must be 1 or 2. Bridging only ever sends funds to our own contract,
//! so it is the one "write" a level 1 wrapper may do besides deposit and payback.
//!
//! Typical call: hardhat `lz:oapp:solana:bridge-tokens --mint USDC --amount 1000000 --chain 11155111`.

use crate::bridges::{cctp_deposit_for_burn_data, decode_oft_send, OftSendParams};
use crate::errors::LendMirrorError;
use crate::instructions::send_ccip::{ccip_send_instruction_data, CcipTokenAmount};
use crate::seeds::{BRIDGE_ROUTE_SEED, CCIP_PAYER_SEED, CCIP_ROUTE_SEED, ONDEMAND_SEED, STORE_SEED, WRAPPER_AUTH_SEED, WRAPPER_SEED};
use crate::*;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{load_current_index_checked, load_instruction_at_checked};
use anchor_lang::solana_program::{instruction::Instruction, program::invoke_signed, pubkey, sysvar};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{approve_checked, transfer_checked, ApproveChecked, Mint, TokenAccount, TokenInterface, TransferChecked};

const NATIVE_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

/// Admin creates or updates the route for (mint, dst_chain_id).
#[derive(Accounts)]
#[instruction(params: SetBridgeRouteParams)]
pub struct SetBridgeRoute<'info> {
    #[account(mut, address = store.admin)]
    pub admin: Signer<'info>,

    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,

    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + BridgeRoute::INIT_SPACE,
        seeds = [BRIDGE_ROUTE_SEED, params.mint.as_ref(), &params.dst_chain_id.to_le_bytes()],
        bump
    )]
    pub bridge_route: Account<'info, BridgeRoute>,

    pub system_program: Program<'info, System>,
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct SetBridgeRouteParams {
    pub mint: Pubkey,
    pub dst_chain_id: u64,
    pub provider: u8,
    pub provider_program: Pubkey,
    /// Unused since `bridge_tokens_lz`. Must be zero.
    pub provider_aux: Pubkey,
    pub receiver: [u8; 32],
    pub destination_caller: [u8; 32],
    pub domain_or_selector: u64,
    pub gas_limit: u64,
    pub enabled: bool,
    pub max_amount_per_tx: u64,
}

impl SetBridgeRoute<'_> {
    pub fn apply(ctx: &mut Context<SetBridgeRoute>, p: &SetBridgeRouteParams) -> Result<()> {
        require!(
            p.provider == PROVIDER_CCTP || p.provider == PROVIDER_CCIP || p.provider == PROVIDER_LZ_OFT,
            LendMirrorError::WrongProvider
        );
        // No provider uses `provider_aux` any more (the LayerZero guard reads the issuer's own
        // send instruction instead of deriving its accounts). Kept zero so old routes decode.
        require!(p.provider_aux == Pubkey::default(), LendMirrorError::InvalidBridgeAccount);
        // LayerZero reuses `gas_limit` as the position of the token-source account in the
        // issuer's send instruction. Both known issuers put it past the signer and well inside
        // the named accounts, so a zero (forgotten flag) is refused.
        if p.provider == PROVIDER_LZ_OFT {
            require!((1..=63).contains(&p.gas_limit), LendMirrorError::InvalidBridgeAccount);
        }
        // A receiver of all zeros would burn the tokens on the far side, and an EVM address must
        // sit in the last 20 bytes: CCIP reads only those, CCTP and OFT read all 32.
        require!(p.receiver != [0u8; 32], LendMirrorError::InvalidBridgeAccount);
        require!(p.receiver[..12] == [0u8; 12], LendMirrorError::InvalidBridgeAccount);
        // CCTP domains and LayerZero endpoint ids are u32; refuse anything that would truncate.
        if p.provider == PROVIDER_CCTP || p.provider == PROVIDER_LZ_OFT {
            require!(u32::try_from(p.domain_or_selector).is_ok(), LendMirrorError::InvalidBridgeAccount);
        }
        let r = &mut ctx.accounts.bridge_route;
        r.mint = p.mint;
        r.dst_chain_id = p.dst_chain_id;
        r.provider = p.provider;
        r.provider_program = p.provider_program;
        r.provider_aux = p.provider_aux;
        r.receiver = p.receiver;
        r.destination_caller = p.destination_caller;
        r.domain_or_selector = p.domain_or_selector;
        r.gas_limit = p.gas_limit;
        r.enabled = p.enabled;
        r.max_amount_per_tx = p.max_amount_per_tx;
        r.bump = ctx.bumps.bridge_route;
        Ok(())
    }
}

/// Accounts every bridge instruction shares. Kept as one struct so the checks live in one place.
///
/// Anchor note: a struct field that is itself `#[derive(Accounts)]` is flattened into the outer
/// instruction's account list, in order.
#[derive(Accounts)]
#[instruction(params: BridgeTokensParams)]
pub struct BridgeCommon<'info> {
    /// Pays rent for any account the provider creates (CCTP event data, ATAs).
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Box<Account<'info, Store>>,

    #[account(
        seeds = [
            WRAPPER_SEED,
            &wrapper.vault_id.to_le_bytes(),
            &wrapper.nft_id.to_le_bytes()
        ],
        bump = wrapper.bump,
        constraint = (
            wrapper.is_owner(&authority.key())
            || store.is_sender(&authority.key())
            || ondemand.as_ref().is_some_and(|list| list.is_caller(&authority.key()))
        ) @ LendMirrorError::Unauthorized,
        // Levels 1 and 2 may bridge. 0 has no rights; 3 and 4 are reserved and reject everything.
        constraint = (
            wrapper.level == LEVEL_DEPOSIT_PAYBACK || wrapper.level == LEVEL_WITHDRAW_BORROW
        ) @ LendMirrorError::LevelDenied
    )]
    pub wrapper: Box<Account<'info, PositionWrapper>>,

    #[account(
        seeds = [ONDEMAND_SEED, wrapper.key().as_ref()],
        bump = ondemand.bump,
        constraint = ondemand.wrapper == wrapper.key() @ LendMirrorError::Unauthorized
    )]
    pub ondemand: Option<Box<Account<'info, OnDemandStrategy>>>,

    /// CHECK: empty PDA that owns `wrapper_ata`. Signs the transfer out via `invoke_signed`.
    #[account(seeds = [WRAPPER_AUTH_SEED, wrapper.key().as_ref()], bump = wrapper.authority_bump)]
    pub wrapper_authority: UncheckedAccount<'info>,

    /// CHECK: empty PDA. Owns `bridge_ata`, signs the provider CPI, pays provider fees in SOL.
    #[account(mut, seeds = [CCIP_PAYER_SEED], bump)]
    pub bridge_signer: UncheckedAccount<'info>,

    #[account(
        seeds = [BRIDGE_ROUTE_SEED, mint.key().as_ref(), &params.dst_chain_id.to_le_bytes()],
        bump = bridge_route.bump,
        constraint = bridge_route.enabled @ LendMirrorError::RouteDisabled,
        constraint = params.amount <= bridge_route.max_amount_per_tx @ LendMirrorError::AmountTooLarge
    )]
    pub bridge_route: Box<Account<'info, BridgeRoute>>,

    /// `mut` because Circle's `deposit_for_burn` burns from this mint (its IDL marks it writable).
    #[account(mut, mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    /// The wrapper authority's token account. Where borrowed or withdrawn tokens land.
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = wrapper_authority,
        associated_token::token_program = token_program
    )]
    pub wrapper_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The bridge signer's token account. The provider pulls or burns from here.
    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = mint,
        associated_token::authority = bridge_signer,
        associated_token::token_program = token_program
    )]
    pub bridge_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct BridgeTokensParams {
    /// Token base units to bridge.
    pub amount: u64,
    /// Picks the route together with `mint`.
    pub dst_chain_id: u64,
    /// CCTP only: fee cap for a fast transfer. 0 with standard finality.
    pub max_fee: u64,
    /// CCTP only: 1000 fast, 2000 standard. Ignored by CCIP.
    pub min_finality_threshold: u32,
    /// CCIP only: SOL moved onto the bridge signer to pay the bridge fee. Ignored by CCTP.
    /// LayerZero does not use it either: there the caller's wallet pays its own fee directly.
    pub fee_lamports: u64,
    /// Unused since `bridge_tokens_lz` (the guard reads these from the issuer's send instead).
    pub min_amount: u64,
    /// Unused since `bridge_tokens_lz`.
    pub native_fee: u64,
    /// Unused since `bridge_tokens_lz`.
    pub options: Vec<u8>,
}

impl BridgeCommon<'_> {
    /// Move `amount` from the wrapper authority's ATA to the bridge signer's ATA.
    fn pull_to_bridge_signer(&self, amount: u64) -> Result<()> {
        require!(self.bridge_route.mint == self.mint.key(), LendMirrorError::InvalidBridgeAccount);
        let wrapper_key = self.wrapper.key();
        let seeds: &[&[u8]] = &[WRAPPER_AUTH_SEED, wrapper_key.as_ref(), &[self.wrapper.authority_bump]];
        transfer_checked(
            CpiContext::new_with_signer(
                self.token_program.to_account_info(),
                TransferChecked {
                    from: self.wrapper_ata.to_account_info(),
                    mint: self.mint.to_account_info(),
                    to: self.bridge_ata.to_account_info(),
                    authority: self.wrapper_authority.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            self.mint.decimals,
        )
    }
}

// ----------------------------------------------------------------------------------------
// Circle CCTP v2
// ----------------------------------------------------------------------------------------

/// Burn USDC on Solana via CCTP v2; Circle mints it to `route.receiver` on the EVM chain.
///
/// Account names and order follow Circle's TokenMessengerMinterV2 IDL (`deposit_for_burn`).
/// The bridge signer is Circle's `owner` (token account owner) and the wallet is
/// `event_rent_payer`.
// No `#[instruction(...)]` here on purpose: an outer struct that declares it consumes the
// instruction bytes before handing them to the nested `BridgeCommon`, which needs them for
// its seeds and cap check (Anchor error 102, InstructionDidNotDeserialize, otherwise).
#[derive(Accounts)]
pub struct BridgeTokensCctp<'info> {
    pub common: BridgeCommon<'info>,

    /// CHECK: Circle PDA ["sender_authority"].
    pub sender_authority_pda: UncheckedAccount<'info>,
    /// CHECK: Circle PDA ["denylist_account", owner]. Exists only for denylisted owners.
    pub denylist_account: UncheckedAccount<'info>,
    /// CHECK: MessageTransmitterV2 state PDA.
    #[account(mut)]
    pub message_transmitter: UncheckedAccount<'info>,
    /// CHECK: Circle PDA ["token_messenger"].
    pub token_messenger: UncheckedAccount<'info>,
    /// CHECK: Circle PDA ["remote_token_messenger", destination domain as decimal string].
    pub remote_token_messenger: UncheckedAccount<'info>,
    /// CHECK: Circle PDA ["token_minter"].
    pub token_minter: UncheckedAccount<'info>,
    /// CHECK: Circle PDA ["local_token", mint].
    #[account(mut)]
    pub local_token: UncheckedAccount<'info>,
    /// Fresh keypair, signed by the wallet in the outer transaction. Circle writes the message here.
    #[account(mut)]
    pub message_sent_event_data: Signer<'info>,
    /// CHECK: MessageTransmitterV2 program.
    pub message_transmitter_program: UncheckedAccount<'info>,
    /// CHECK: TokenMessengerMinterV2 program. Must be the route's provider program.
    #[account(address = common.bridge_route.provider_program)]
    pub token_messenger_minter_program: UncheckedAccount<'info>,
    /// CHECK: Circle PDA ["__event_authority"].
    pub event_authority: UncheckedAccount<'info>,
}

impl<'info> BridgeTokensCctp<'info> {
    pub fn apply(ctx: &mut Context<BridgeTokensCctp>, params: &BridgeTokensParams) -> Result<()> {
        let c = &ctx.accounts.common;
        require!(c.bridge_route.provider == PROVIDER_CCTP, LendMirrorError::WrongProvider);
        // Circle deducts a fast-transfer fee from the amount. Cap what a caller may offer at 1%.
        require!(params.max_fee <= params.amount / 100, LendMirrorError::AmountTooLarge);
        c.pull_to_bridge_signer(params.amount)?;

        let route = &c.bridge_route;
        let data = cctp_deposit_for_burn_data(
            params.amount,
            route.domain_or_selector as u32,
            route.receiver,
            route.destination_caller,
            params.max_fee,
            params.min_finality_threshold,
        );
        let a = &ctx.accounts;
        let metas = vec![
            AccountMeta::new_readonly(c.bridge_signer.key(), true), // owner
            AccountMeta::new(c.authority.key(), true),               // event_rent_payer
            AccountMeta::new_readonly(a.sender_authority_pda.key(), false),
            AccountMeta::new(c.bridge_ata.key(), false), // burn_token_account
            AccountMeta::new_readonly(a.denylist_account.key(), false),
            AccountMeta::new(a.message_transmitter.key(), false),
            AccountMeta::new_readonly(a.token_messenger.key(), false),
            AccountMeta::new_readonly(a.remote_token_messenger.key(), false),
            AccountMeta::new_readonly(a.token_minter.key(), false),
            AccountMeta::new(a.local_token.key(), false),
            AccountMeta::new(c.mint.key(), false), // burn_token_mint
            AccountMeta::new(a.message_sent_event_data.key(), true),
            AccountMeta::new_readonly(a.message_transmitter_program.key(), false),
            AccountMeta::new_readonly(a.token_messenger_minter_program.key(), false),
            AccountMeta::new_readonly(c.token_program.key(), false),
            AccountMeta::new_readonly(c.system_program.key(), false),
            AccountMeta::new_readonly(a.event_authority.key(), false),
            AccountMeta::new_readonly(a.token_messenger_minter_program.key(), false), // program
        ];
        let infos = vec![
            c.bridge_signer.to_account_info(),
            c.authority.to_account_info(),
            a.sender_authority_pda.to_account_info(),
            c.bridge_ata.to_account_info(),
            a.denylist_account.to_account_info(),
            a.message_transmitter.to_account_info(),
            a.token_messenger.to_account_info(),
            a.remote_token_messenger.to_account_info(),
            a.token_minter.to_account_info(),
            a.local_token.to_account_info(),
            c.mint.to_account_info(),
            a.message_sent_event_data.to_account_info(),
            a.message_transmitter_program.to_account_info(),
            a.token_messenger_minter_program.to_account_info(),
            c.token_program.to_account_info(),
            c.system_program.to_account_info(),
            a.event_authority.to_account_info(),
        ];
        let signer_seeds: &[&[u8]] = &[CCIP_PAYER_SEED, &[ctx.bumps.common.bridge_signer]];
        invoke_signed(
            &Instruction { program_id: route.provider_program, accounts: metas, data },
            &infos,
            &[signer_seeds],
        )?;
        Ok(())
    }
}

// ----------------------------------------------------------------------------------------
// Chainlink CCIP token transfer
// ----------------------------------------------------------------------------------------

/// Send tokens over CCIP to `route.receiver`. Data is empty and gas limit is 0 (token-only).
///
/// The router accounts are the same 19 the data-only send uses (`send_position_snapshot.rs`);
/// the per-token accounts (user token account, billing configs, pool program and its PDAs,
/// lookup table, token admin registry, mint, ...) come in `remaining_accounts` in the order
/// Chainlink documents, and `token_indexes = [0]` tells the router the single token's slice
/// starts at index 0. The client derives them (`lib/client/ccipToken.ts`).
// See the note on `BridgeTokensCctp`: `params` is declared on `BridgeCommon` only.
#[derive(Accounts)]
pub struct BridgeTokensCcip<'info> {
    pub common: BridgeCommon<'info>,

    #[account(seeds = [CCIP_ROUTE_SEED], bump = ccip_route.bump)]
    pub ccip_route: Box<Account<'info, CcipRoute>>,
    /// CHECK: router config PDA. Owner must be the router (checked in apply).
    pub config: UncheckedAccount<'info>,
    /// CHECK: router dest chain state.
    #[account(mut)]
    pub dest_chain_state: UncheckedAccount<'info>,
    /// CHECK: nonce PDA for (bridge signer, dest chain).
    #[account(mut)]
    pub nonce: UncheckedAccount<'info>,
    /// CHECK: SPL token program for the fee (wrapped SOL).
    #[account(address = anchor_spl::token::ID)]
    pub fee_token_program: UncheckedAccount<'info>,
    /// CHECK: wrapped SOL mint (checked in apply).
    pub fee_token_mint: UncheckedAccount<'info>,
    /// CHECK: zero pubkey = native SOL fee (checked in apply).
    pub fee_token_user: UncheckedAccount<'info>,
    /// CHECK: fee receiver ATA.
    #[account(mut)]
    pub fee_token_receiver: UncheckedAccount<'info>,
    /// CHECK: router PDA ["fee_billing_signer"] (verified in apply). The router pulls the bridged
    /// tokens as this delegate (see `transfer_token` in its onramp), so the bridge signer approves
    /// it for `amount` before the CPI.
    pub fee_billing_signer: UncheckedAccount<'info>,
    /// CHECK: fee quoter program (checked in apply).
    pub fee_quoter: UncheckedAccount<'info>,
    /// CHECK: fee quoter config PDA.
    pub fee_quoter_config: UncheckedAccount<'info>,
    /// CHECK: fee quoter dest chain PDA.
    pub fee_quoter_dest_chain: UncheckedAccount<'info>,
    /// CHECK: wSOL billing config.
    pub fee_quoter_billing_token_config: UncheckedAccount<'info>,
    /// CHECK: LINK billing config.
    pub fee_quoter_link_token_config: UncheckedAccount<'info>,
    /// CHECK: RMN remote program (checked in apply).
    pub rmn_remote: UncheckedAccount<'info>,
    /// CHECK: RMN curses PDA.
    pub rmn_remote_curses: UncheckedAccount<'info>,
    /// CHECK: RMN config PDA.
    pub rmn_remote_config: UncheckedAccount<'info>,
    /// CHECK: CCIP router program. Must be the route's provider program.
    #[account(address = common.bridge_route.provider_program)]
    pub ccip_router: UncheckedAccount<'info>,
}

// The router's on-chain IDL (1.6.2) names 18 accounts for `ccip_send`, ending at
// `rmn_remote_config`; everything after that is the per-token slice. The router's
// "external_token_pools_signer" PDA only signs the pool's lock-or-burn call; the pull from the
// user's token account is signed by `fee_billing_signer`, so that is the delegate we approve.

impl<'info> BridgeTokensCcip<'info> {
    pub fn apply(
        ctx: &mut Context<'_, '_, '_, 'info, BridgeTokensCcip<'info>>,
        params: &BridgeTokensParams,
    ) -> Result<()> {
        let c = &ctx.accounts.common;
        let a = &ctx.accounts;
        require!(c.bridge_route.provider == PROVIDER_CCIP, LendMirrorError::WrongProvider);
        require_keys_eq!(c.bridge_route.provider_program, a.ccip_route.router, LendMirrorError::InvalidBridgeAccount);
        require_keys_eq!(*a.config.owner, a.ccip_route.router, LendMirrorError::InvalidCcipAccount);
        require_keys_eq!(a.fee_token_mint.key(), NATIVE_MINT, LendMirrorError::InvalidCcipAccount);
        require_keys_eq!(a.fee_token_user.key(), Pubkey::default(), LendMirrorError::InvalidCcipAccount);
        require_keys_eq!(a.fee_quoter.key(), a.ccip_route.fee_quoter, LendMirrorError::InvalidCcipAccount);
        require_keys_eq!(a.rmn_remote.key(), a.ccip_route.rmn_remote, LendMirrorError::InvalidCcipAccount);
        require!(c.bridge_signer.data_is_empty(), LendMirrorError::InvalidCcipAccount);
        require!(!ctx.remaining_accounts.is_empty(), LendMirrorError::InvalidBridgeAccount);
        // The first per-token account must be the bridge signer's ATA the router pulls from.
        require_keys_eq!(ctx.remaining_accounts[0].key(), c.bridge_ata.key(), LendMirrorError::InvalidBridgeAccount);
        let (expected_billing_signer, _) =
            Pubkey::find_program_address(&[b"fee_billing_signer"], &a.ccip_route.router);
        require_keys_eq!(a.fee_billing_signer.key(), expected_billing_signer, LendMirrorError::InvalidCcipAccount);

        c.pull_to_bridge_signer(params.amount)?;
        // Let the router's fee billing signer take exactly `amount` from the bridge signer's account.
        let signer_seeds: &[&[u8]] = &[CCIP_PAYER_SEED, &[ctx.bumps.common.bridge_signer]];
        approve_checked(
            CpiContext::new_with_signer(
                c.token_program.to_account_info(),
                ApproveChecked {
                    to: c.bridge_ata.to_account_info(),
                    delegate: a.fee_billing_signer.to_account_info(),
                    authority: c.bridge_signer.to_account_info(),
                    mint: c.mint.to_account_info(),
                },
                &[signer_seeds],
            ),
            params.amount,
            c.mint.decimals,
        )?;
        if params.fee_lamports > 0 {
            anchor_lang::solana_program::program::invoke(
                &anchor_lang::solana_program::system_instruction::transfer(
                    &c.authority.key(),
                    &c.bridge_signer.key(),
                    params.fee_lamports,
                ),
                &[
                    c.authority.to_account_info(),
                    c.bridge_signer.to_account_info(),
                    c.system_program.to_account_info(),
                ],
            )?;
        }

        let route = &c.bridge_route;
        let tokens = [CcipTokenAmount { token: c.mint.key(), amount: params.amount }];
        let data = ccip_send_instruction_data(
            route.domain_or_selector,
            &route.receiver_evm20(),
            &[],
            route.gas_limit,
            &tokens,
            &[0],
        );
        let mut metas = vec![
            AccountMeta::new_readonly(a.config.key(), false),
            AccountMeta::new(a.dest_chain_state.key(), false),
            AccountMeta::new(a.nonce.key(), false),
            AccountMeta::new(c.bridge_signer.key(), true), // authority
            AccountMeta::new_readonly(c.system_program.key(), false),
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
        ];
        metas.extend(ctx.remaining_accounts.iter().map(|info| AccountMeta {
            pubkey: info.key(),
            is_signer: false,
            is_writable: info.is_writable,
        }));
        let mut infos = vec![
            a.config.to_account_info(),
            a.dest_chain_state.to_account_info(),
            a.nonce.to_account_info(),
            c.bridge_signer.to_account_info(),
            c.system_program.to_account_info(),
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
            a.ccip_router.to_account_info(),
        ];
        infos.extend_from_slice(ctx.remaining_accounts);
        invoke_signed(
            &Instruction { program_id: route.provider_program, accounts: metas, data },
            &infos,
            &[signer_seeds],
        )?;
        Ok(())
    }
}

// ----------------------------------------------------------------------------------------
// LayerZero (USDT over USDT0, USDai, sUSDai) — same-transaction guard
// ----------------------------------------------------------------------------------------

/// Release tokens for a LayerZero send that sits in this very transaction.
///
/// Why not a CPI like Circle and Chainlink: each of these tokens is bridged by its issuer's own
/// program, and that program's send already uses all five levels of Solana's call-depth budget
/// (issuer → endpoint → message library → executor/verifiers → price feed). Our program on top
/// would be level six, which Solana refuses. So the transaction carries two instructions:
///
///   1. this one: the usual caller/level/route checks, then the guard below, then the move of
///      `amount` from the wrapper authority's token account to the CALLER's token account;
///   2. the issuer's `send`, signed by the caller's wallet, which pulls that exact amount and
///      carries it to the route's receiver. The wallet pays the LayerZero fee in SOL.
///
/// The guard reads the transaction through the instructions sysvar and only releases when the
/// NEXT instruction is the issuer program named by the route, is a `send` of exactly `amount`
/// from exactly the caller's token account to exactly the route's receiver, with no executor
/// options and no compose message. A transaction is all-or-nothing, so if the send fails, the
/// release is rolled back too: the wallet owns the tokens for zero observable time, and there is
/// no transaction in which they end up anywhere but the receiver. Flash-loan programs use the
/// same sysvar trick to demand "the repayment is later in this transaction".
// `params` is declared on no inner struct here; see the note on `BridgeTokensCctp`.
#[derive(Accounts)]
#[instruction(params: BridgeTokensParams)]
pub struct BridgeTokensLz<'info> {
    /// Signs the issuer's send and pays its LayerZero fee; also rent payer for `authority_ata`.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Box<Account<'info, Store>>,

    // Caller and level rules are the same as `BridgeCommon`'s.
    #[account(
        seeds = [
            WRAPPER_SEED,
            &wrapper.vault_id.to_le_bytes(),
            &wrapper.nft_id.to_le_bytes()
        ],
        bump = wrapper.bump,
        constraint = (
            wrapper.is_owner(&authority.key())
            || store.is_sender(&authority.key())
            || ondemand.as_ref().is_some_and(|list| list.is_caller(&authority.key()))
        ) @ LendMirrorError::Unauthorized,
        constraint = (
            wrapper.level == LEVEL_DEPOSIT_PAYBACK || wrapper.level == LEVEL_WITHDRAW_BORROW
        ) @ LendMirrorError::LevelDenied
    )]
    pub wrapper: Box<Account<'info, PositionWrapper>>,

    #[account(
        seeds = [ONDEMAND_SEED, wrapper.key().as_ref()],
        bump = ondemand.bump,
        constraint = ondemand.wrapper == wrapper.key() @ LendMirrorError::Unauthorized
    )]
    pub ondemand: Option<Box<Account<'info, OnDemandStrategy>>>,

    /// CHECK: empty PDA that owns `wrapper_ata`. Signs the release via `invoke_signed`.
    #[account(seeds = [WRAPPER_AUTH_SEED, wrapper.key().as_ref()], bump = wrapper.authority_bump)]
    pub wrapper_authority: UncheckedAccount<'info>,

    #[account(
        seeds = [BRIDGE_ROUTE_SEED, mint.key().as_ref(), &params.dst_chain_id.to_le_bytes()],
        bump = bridge_route.bump,
        constraint = bridge_route.enabled @ LendMirrorError::RouteDisabled,
        constraint = params.amount <= bridge_route.max_amount_per_tx @ LendMirrorError::AmountTooLarge
    )]
    pub bridge_route: Box<Account<'info, BridgeRoute>>,

    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    /// The wrapper authority's token account. Where borrowed or withdrawn tokens sit.
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = wrapper_authority,
        associated_token::token_program = token_program
    )]
    pub wrapper_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The caller's own token account: the issuer's send must pull from exactly here.
    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = mint,
        associated_token::authority = authority,
        associated_token::token_program = token_program
    )]
    pub authority_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: the instructions sysvar, fixed address. Lets the guard read this transaction.
    #[account(address = sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

impl BridgeTokensLz<'_> {
    pub fn apply(ctx: &mut Context<BridgeTokensLz>, params: &BridgeTokensParams) -> Result<()> {
        let a = &ctx.accounts;
        let route = &a.bridge_route;
        require!(route.provider == PROVIDER_LZ_OFT, LendMirrorError::WrongProvider);
        require!(route.mint == a.mint.key(), LendMirrorError::InvalidBridgeAccount);
        require!(params.amount > 0, LendMirrorError::AmountTooLarge);

        let sysvar_info = a.instructions_sysvar.to_account_info();
        let current = load_current_index_checked(&sysvar_info)? as usize;
        // Top-level only: if another program invoked us by CPI, the instruction at our index is
        // that program, not us, and a hidden wrapper could pair one send with many releases.
        let ours = load_instruction_at_checked(current, &sysvar_info)?;
        require_keys_eq!(ours.program_id, crate::ID, LendMirrorError::MissingBridgeSend);
        // One release per transaction, so one send can never cover two releases.
        let mut index = 0usize;
        while let Ok(ix) = load_instruction_at_checked(index, &sysvar_info) {
            require!(index == current || ix.program_id != crate::ID, LendMirrorError::MissingBridgeSend);
            index += 1;
        }

        // The very next instruction must be the issuer's send, exactly as the route fixes it.
        let send = load_instruction_at_checked(current + 1, &sysvar_info)
            .map_err(|_| LendMirrorError::MissingBridgeSend)?;
        require_keys_eq!(send.program_id, route.provider_program, LendMirrorError::MissingBridgeSend);
        let send_params = decode_oft_send(&send.data).ok_or(LendMirrorError::MissingBridgeSend)?;
        check_lz_send(route, params.amount, &send_params)?;
        // The send must pull from the caller's token account. Its position among the send's
        // accounts differs per issuer program, so the route stores it (in `gas_limit`).
        let source = send
            .accounts
            .get(route.gas_limit as usize)
            .ok_or(LendMirrorError::MissingBridgeSend)?;
        require_keys_eq!(source.pubkey, a.authority_ata.key(), LendMirrorError::MissingBridgeSend);

        // All checks passed: release. If the send later fails, this transfer unwinds with it.
        let wrapper_key = a.wrapper.key();
        let seeds: &[&[u8]] = &[WRAPPER_AUTH_SEED, wrapper_key.as_ref(), &[a.wrapper.authority_bump]];
        transfer_checked(
            CpiContext::new_with_signer(
                a.token_program.to_account_info(),
                TransferChecked {
                    from: a.wrapper_ata.to_account_info(),
                    mint: a.mint.to_account_info(),
                    to: a.authority_ata.to_account_info(),
                    authority: a.wrapper_authority.to_account_info(),
                },
                &[seeds],
            ),
            params.amount,
            a.mint.decimals,
        )
    }
}

/// The send's parameters against the route: destination, amount, and nothing extra.
///
/// `min_amount_ld` may sit up to 0.5% under `amount` (USDT0 charges 0.03% on arrival; the
/// others charge nothing today). Executor options and compose messages are refused: the peers'
/// enforced options already carry the destination gas, and the treasury composes nothing.
fn check_lz_send(route: &BridgeRoute, amount: u64, send: &OftSendParams) -> Result<()> {
    require!(u64::from(send.dst_eid) == route.domain_or_selector, LendMirrorError::MissingBridgeSend);
    require!(send.to == route.receiver, LendMirrorError::MissingBridgeSend);
    require!(send.amount_ld == amount, LendMirrorError::MissingBridgeSend);
    require!(send.min_amount_ld >= amount - amount / 200, LendMirrorError::MissingBridgeSend);
    require!(send.options.is_empty(), LendMirrorError::MissingBridgeSend);
    require!(send.compose_msg.is_none(), LendMirrorError::MissingBridgeSend);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route() -> BridgeRoute {
        let mut receiver = [0u8; 32];
        receiver[12..].copy_from_slice(&[0x73; 20]);
        BridgeRoute {
            mint: Pubkey::new_unique(),
            dst_chain_id: 42161,
            provider: PROVIDER_LZ_OFT,
            provider_program: Pubkey::new_unique(),
            provider_aux: Pubkey::default(),
            receiver,
            destination_caller: [0; 32],
            domain_or_selector: 30110,
            gas_limit: 9,
            enabled: true,
            max_amount_per_tx: 1_000_000,
            bump: 255,
        }
    }

    fn send(route: &BridgeRoute, amount: u64) -> OftSendParams {
        OftSendParams {
            dst_eid: route.domain_or_selector as u32,
            to: route.receiver,
            amount_ld: amount,
            min_amount_ld: amount,
            options: vec![],
            compose_msg: None,
            native_fee: 840_356,
            lz_token_fee: 0,
        }
    }

    #[test]
    fn lz_guard_accepts_the_exact_send() {
        let r = route();
        assert!(check_lz_send(&r, 1_000_000, &send(&r, 1_000_000)).is_ok());
    }

    #[test]
    fn lz_guard_allows_min_half_percent_under() {
        let r = route();
        let mut p = send(&r, 1_000_000);
        p.min_amount_ld = 995_000; // exactly 0.5% under
        assert!(check_lz_send(&r, 1_000_000, &p).is_ok());
        p.min_amount_ld = 994_999;
        assert!(check_lz_send(&r, 1_000_000, &p).is_err(), "more than 0.5% under");
    }

    #[test]
    fn lz_guard_rejects_every_mismatch() {
        let r = route();
        let good = send(&r, 1_000_000);

        let mut p = good.clone();
        p.dst_eid = 30101; // Ethereum instead of Arbitrum
        assert!(check_lz_send(&r, 1_000_000, &p).is_err(), "wrong lane");

        let mut p = good.clone();
        p.to[31] ^= 1;
        assert!(check_lz_send(&r, 1_000_000, &p).is_err(), "wrong receiver");

        let mut p = good.clone();
        p.amount_ld = 999_999;
        assert!(check_lz_send(&r, 1_000_000, &p).is_err(), "amount under the release");
        p.amount_ld = 1_000_001;
        assert!(check_lz_send(&r, 1_000_000, &p).is_err(), "amount over the release");

        let mut p = good.clone();
        p.options = vec![0, 3];
        assert!(check_lz_send(&r, 1_000_000, &p).is_err(), "caller options");

        let mut p = good;
        p.compose_msg = Some(vec![1]);
        assert!(check_lz_send(&r, 1_000_000, &p).is_err(), "compose message");
    }
}
