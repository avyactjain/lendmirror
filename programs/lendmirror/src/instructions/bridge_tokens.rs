//! Token bridging out of a wrapper: `set_bridge_route` (admin) and the three provider
//! instructions `bridge_tokens_cctp` (Circle), `bridge_tokens_ccip` (Chainlink), and
//! `bridge_tokens_oft` (LayerZero).
//!
//! Owns: who may bridge, the amount cap, the move from the wrapper authority's token account to
//! the bridge signer's token account, and the provider CPIs. Does NOT own: the instruction bytes
//! (`bridges.rs`, `send_ccip.rs`) or the route layout (`state/bridge_route.rs`).
//!
//! Invariants (fund safety):
//!   - No instruction here takes a destination. The EVM receiver comes from `BridgeRoute`, which
//!     only the Store admin writes.
//!   - Tokens move wrapper-authority ATA → bridge-signer ATA → provider. Both ATAs belong to
//!     PDAs of this program. No wallet is ever a token owner in this path.
//!   - The bridge signer is the same empty PDA that pays Chainlink fees (`LendMirrorCcipPayer`).
//!     It must hold no data so the System program can debit it for fees.
//!
//! Who may call: the wrapper owner, an OnDemand caller of that wrapper, or a Store sender
//! (operator), and the wrapper's level must be 1 or 2. Bridging only ever sends funds to our own contract,
//! so it is the one "write" a level 1 wrapper may do besides deposit and payback.
//!
//! Typical call: hardhat `lz:oapp:solana:bridge-tokens --mint USDC --amount 1000000 --chain 11155111`.

use crate::bridges::{cctp_deposit_for_burn_data, oft_send_data};
use crate::errors::LendMirrorError;
use crate::instructions::send_ccip::{ccip_send_instruction_data, CcipTokenAmount};
use crate::*;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke_signed, pubkey};
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
    /// LayerZero: the OFT token escrow. Zero otherwise.
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
        // LayerZero needs the escrow to derive the OFT store; the other two must not carry one.
        require!(
            (p.provider == PROVIDER_LZ_OFT) == (p.provider_aux != Pubkey::default()),
            LendMirrorError::InvalidBridgeAccount
        );
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
    /// CCIP and OFT: SOL moved onto the bridge signer to pay the bridge fee. Ignored by CCTP.
    pub fee_lamports: u64,
    /// OFT only: least amount that may arrive (the OFT drops dust below its shared decimals).
    pub min_amount: u64,
    /// OFT only: LayerZero fee in lamports, from the OFT's quote. Must be <= `fee_lamports`
    /// plus whatever the bridge signer already holds.
    pub native_fee: u64,
    /// OFT only: executor options (destination gas). Empty means "use the peer's enforced options".
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

    #[account(seeds = [CCIP_SEED], bump = ccip_route.bump)]
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
// LayerZero OFT (USDT0, USDai, sUSDai)
// ----------------------------------------------------------------------------------------

/// Send an OFT token to `route.receiver` through the token's own LayerZero OFT program.
///
/// Account names and order follow LayerZero's OFT program (`send`): signer, peer, oft_store,
/// token_source, token_escrow, token_mint, token_program, event_authority, program, then the
/// LayerZero Endpoint accounts in `remaining_accounts` (the OFT SDK assembles them with the OFT
/// store as sender). The bridge signer is the OFT `signer`: it owns `token_source` and pays the
/// LayerZero fee in SOL, so `fee_lamports` must cover `native_fee`.
// `params` is declared on `BridgeCommon` only; see the note on `BridgeTokensCctp`.
#[derive(Accounts)]
pub struct BridgeTokensOft<'info> {
    pub common: BridgeCommon<'info>,

    /// CHECK: the token's OFT program. Must be the route's provider program.
    #[account(address = common.bridge_route.provider_program)]
    pub oft_program: UncheckedAccount<'info>,
    /// CHECK: OFT peer PDA ["Peer", oft_store, dst_eid be] under the OFT program (checked in apply).
    #[account(mut)]
    pub peer: UncheckedAccount<'info>,
    /// CHECK: OFT store PDA ["OFT", token_escrow] under the OFT program (checked in apply).
    #[account(mut)]
    pub oft_store: UncheckedAccount<'info>,
    /// CHECK: the OFT's escrow token account. Must be the route's `provider_aux`.
    #[account(mut, address = common.bridge_route.provider_aux)]
    pub token_escrow: UncheckedAccount<'info>,
    /// CHECK: OFT program's event authority PDA ["__event_authority"].
    pub event_authority: UncheckedAccount<'info>,
}

impl<'info> BridgeTokensOft<'info> {
    pub fn apply(
        ctx: &mut Context<'_, '_, '_, 'info, BridgeTokensOft<'info>>,
        params: &BridgeTokensParams,
    ) -> Result<()> {
        let c = &ctx.accounts.common;
        let a = &ctx.accounts;
        let route = &c.bridge_route;
        require!(route.provider == PROVIDER_LZ_OFT, LendMirrorError::WrongProvider);
        require!(c.bridge_signer.data_is_empty(), LendMirrorError::InvalidBridgeAccount);
        // The bridge signer is shared by every wrapper. A caller must bring the SOL their send
        // spends, and may not attach executor options (a native drop to their own EVM address
        // would turn the shared PDA's SOL into their ETH). The peer's enforced options carry gas.
        require!(params.fee_lamports >= params.native_fee, LendMirrorError::AmountTooLarge);
        require!(params.options.is_empty(), LendMirrorError::InvalidBridgeAccount);
        check_oft_pdas(a)?;

        c.pull_to_bridge_signer(params.amount)?;
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

        let data = oft_send_data(
            route.domain_or_selector as u32,
            route.receiver,
            params.amount,
            params.min_amount,
            &params.options,
            params.native_fee,
        );
        let mut metas = vec![
            AccountMeta::new(c.bridge_signer.key(), true), // signer: owns token_source, pays the fee
            AccountMeta::new(a.peer.key(), false),
            AccountMeta::new(a.oft_store.key(), false),
            AccountMeta::new(c.bridge_ata.key(), false), // token_source
            AccountMeta::new(a.token_escrow.key(), false),
            AccountMeta::new(c.mint.key(), false), // token_mint
            AccountMeta::new_readonly(c.token_program.key(), false),
            AccountMeta::new_readonly(a.event_authority.key(), false),
            AccountMeta::new_readonly(a.oft_program.key(), false), // program (event CPI)
        ];
        metas.extend(ctx.remaining_accounts.iter().map(|info| AccountMeta {
            pubkey: info.key(),
            is_signer: false,
            is_writable: info.is_writable,
        }));
        let mut infos = vec![
            c.bridge_signer.to_account_info(),
            a.peer.to_account_info(),
            a.oft_store.to_account_info(),
            c.bridge_ata.to_account_info(),
            a.token_escrow.to_account_info(),
            c.mint.to_account_info(),
            c.token_program.to_account_info(),
            a.event_authority.to_account_info(),
            a.oft_program.to_account_info(),
        ];
        infos.extend_from_slice(ctx.remaining_accounts);
        let signer_seeds: &[&[u8]] = &[CCIP_PAYER_SEED, &[ctx.bumps.common.bridge_signer]];
        invoke_signed(
            &Instruction { program_id: route.provider_program, accounts: metas, data },
            &infos,
            &[signer_seeds],
        )?;
        Ok(())
    }
}

/// The store and peer must be the OFT program's PDAs for this escrow and destination, so a
/// caller cannot point the send at a different OFT deployment or lane.
fn check_oft_pdas(a: &BridgeTokensOft) -> Result<()> {
    let route = &a.common.bridge_route;
    let (expected_store, _) =
        Pubkey::find_program_address(&[b"OFT", route.provider_aux.as_ref()], &route.provider_program);
    require_keys_eq!(a.oft_store.key(), expected_store, LendMirrorError::InvalidBridgeAccount);
    let dst_eid = route.domain_or_selector as u32;
    let (expected_peer, _) = Pubkey::find_program_address(
        &[b"Peer", expected_store.as_ref(), &dst_eid.to_be_bytes()],
        &route.provider_program,
    );
    require_keys_eq!(a.peer.key(), expected_peer, LendMirrorError::InvalidBridgeAccount);
    Ok(())
}
