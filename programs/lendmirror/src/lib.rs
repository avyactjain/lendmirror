mod bridges;
mod errors;
mod instructions;
mod live_position;
mod msg_codec;
mod state;
pub mod tick_math;

use anchor_lang::prelude::*;
use instructions::*;
use oapp::endpoint::MessagingFee;
use solana_helper::program_id_from_env;
use state::*;

pub use live_position::{liquidation_record, walk_branches, Branch};
pub use state::{
    branch_address, decode_branch, decode_position, decode_tick, decode_tick_id_liquidation,
    tick_id_liquidation_address, JUPITER_VAULTS_MAINNET,
};

// to build in verifiable mode and using environment variable (what the README instructs), run:
// anchor build -v -e LENDMIRROR_ID=<OAPP_PROGRAM_ID>
// to build in normal mode and using environment, run:
// LENDMIRROR_ID=$PROGRAM_ID anchor build
declare_id!(anchor_lang::solana_program::pubkey::Pubkey::new_from_array(program_id_from_env!(
    "LENDMIRROR_ID",
    "9oySM9Jo4ZEXFcWYFbuPK1FeqwrDr6wmnAmenAybzHqQ"
)));

const STORE_SEED: &[u8] = b"LendMirrorStoreV0";
const PEER_SEED: &[u8] = b"LendMirrorPeer";
const JUP_POSITION_SEED: &[u8] = b"JupPosition";
const CCIP_SEED: &[u8] = b"LendMirrorCcip";
/// Empty account that signs `ccip_send` and pays the SOL fee. It must hold no data.
const CCIP_PAYER_SEED: &[u8] = b"LendMirrorCcipPayer";
/// One PDA per Jupiter position. Seeds: this + vault_id le + nft_id le.
/// "V1" because the layout grew (level, custody, send guard). Solana accounts cannot be
/// resized in place by `init`, so the old `LendMirrorWrapper` accounts on Devnet stay as they
/// are and every position is wrapped again under the new seed.
const WRAPPER_SEED: &[u8] = b"LendMirrorWrapperV1";
/// OnDemand strategy for one wrapper. Seeds: this + wrapper pubkey.
const ONDEMAND_SEED: &[u8] = b"LendMirrorOnDemand";
/// Empty PDA that owns a wrapper's token accounts and signs Jupiter `operate`.
/// Seeds: this + wrapper pubkey. See `state/wrapper.rs` for why it is separate from the wrapper.
const WRAPPER_AUTH_SEED: &[u8] = b"LendMirrorWrapperAuth";
/// One admin-set bridge destination per (mint, EVM chain id). Seeds: this + mint + chain id le.
const BRIDGE_ROUTE_SEED: &[u8] = b"LendMirrorBridgeRoute";

/// LendMirror — Solana side of a LayerZero OApp.
///
/// This program is the SENDER (Solana → Ethereum).
/// The Ethereum contract in contracts/LendMirror.sol is the RECEIVER.
///
/// Program id vs Store (easy to mix up):
///   program id — this code, at declare_id! below.
///   Store PDA  — the OApp identity. LayerZero records Store as the sender.
///                Ethereum's setPeer must be this Store, not the program id.
///
/// Flow: wrap_position → attach_ondemand → refresh_wrapper →
/// send_position_snapshot_via_chainlink_and_lz.
/// Store signs LayerZero. The empty CCIP payer signs Chainlink.
#[program]
pub mod lendmirror {
    use super::*;

    // Create the Store PDA and register it with LayerZero's Endpoint.
    // Call once. Payer must be this program's upgrade authority (not a
    // caller-chosen admin). Seeds params.admin onto both allowlists.
    pub fn init_store(mut ctx: Context<InitStore>, params: InitStoreParams) -> Result<()> {
        InitStore::apply(&mut ctx, &params)
    }

    // Admin only. Tells this program the Ethereum contract address for a dst eid.
    pub fn set_peer_config(
        mut ctx: Context<SetPeerConfig>,
        params: SetPeerConfigParams,
    ) -> Result<()> {
        SetPeerConfig::apply(&mut ctx, &params)
    }

    // Admin only. Replace wallets allowed to call get_jupiter_position.
    pub fn set_snapshotters(
        mut ctx: Context<SetSnapshotters>,
        params: SetAllowlistParams,
    ) -> Result<()> {
        SetSnapshotters::apply(&mut ctx, &params)
    }

    // Admin only. Replace wallets allowed to send any wrapper's snapshot.
    pub fn set_senders(mut ctx: Context<SetSenders>, params: SetAllowlistParams) -> Result<()> {
        SetSenders::apply(&mut ctx, &params)
    }

    // How much SOL the LayerZero leg of a send costs. Does not send. Quotes from wrapper.snapshot.
    pub fn quote_send(ctx: Context<QuoteSend>, params: QuoteSendParams) -> Result<MessagingFee> {
        QuoteSend::apply(&ctx, &params)
    }

    // Admin only. Router, destination chain, and Ethereum receiver for Chainlink.
    pub fn set_ccip_route(
        mut ctx: Context<SetCcipRoute>,
        params: SetCcipRouteParams,
    ) -> Result<()> {
        SetCcipRoute::apply(&mut ctx, &params)
    }

    // Read Jupiter Lend Position + Tick + VaultState/Config. If the tick was
    // liquidated, walk Branch accounts (remaining_accounts) and write the live
    // amounts, not the stale stored ones. Does not send.
    // Authority must be on the snapshotters allowlist.
    pub fn get_jupiter_position(
        mut ctx: Context<GetJupiterPosition>,
        params: GetJupiterPositionParams,
    ) -> Result<PositionSnapshot> {
        GetJupiterPosition::apply(&mut ctx, &params)
    }

    // Create a PositionWrapper PDA for (vault_id, nft_id).
    // Authority must be on Store snapshotters; becomes wrapper.owner.
    pub fn wrap_position(mut ctx: Context<WrapPosition>, params: WrapPositionParams) -> Result<()> {
        WrapPosition::apply(&mut ctx, &params)
    }

    // Wrapper owner creates the OnDemand strategy PDA; callers starts as [owner].
    pub fn attach_ondemand(mut ctx: Context<AttachOndemand>) -> Result<()> {
        AttachOndemand::apply(&mut ctx)
    }

    // Wrapper owner replaces the OnDemand caller allowlist (max 8).
    pub fn set_ondemand_callers(
        mut ctx: Context<SetOndemandCallers>,
        params: SetAllowlistParams,
    ) -> Result<()> {
        SetOndemandCallers::apply(&mut ctx, &params)
    }

    // Owner, Store snapshotter, or OnDemand caller: read Jupiter into wrapper.snapshot.
    pub fn refresh_wrapper(mut ctx: Context<RefreshWrapper>) -> Result<()> {
        RefreshWrapper::apply(&mut ctx)
    }

    // OnDemand caller or Store sender: Store signs LayerZero, empty payer signs Chainlink.
    pub fn send_position_snapshot_via_chainlink_and_lz(
        mut ctx: Context<SendPositionSnapshotViaChainlinkAndLz>,
        params: SendPositionSnapshotViaChainlinkAndLzParams,
    ) -> Result<()> {
        SendPositionSnapshotViaChainlinkAndLz::apply(&mut ctx, &params)
    }

    // Admin only. Set a wrapper's access level (0 mirror only, 1 deposit/payback,
    // 2 also withdraw/borrow, 3 and 4 reserved).
    pub fn set_wrapper_level(mut ctx: Context<SetWrapperLevel>, level: u8) -> Result<()> {
        SetWrapperLevel::apply(&mut ctx, level)
    }

    // Wrapper owner moves the Jupiter position NFT into the wrapper authority's token account.
    pub fn deposit_position_nft(mut ctx: Context<DepositPositionNft>) -> Result<()> {
        DepositPositionNft::apply(&mut ctx)
    }

    // Admin only. Escape hatch: move the position NFT back to the wrapper owner.
    pub fn release_position_nft(mut ctx: Context<ReleasePositionNft>) -> Result<()> {
        ReleasePositionNft::apply(&mut ctx)
    }

    // Owner, snapshotter, or OnDemand caller: deposit / withdraw / borrow / payback on the
    // custodied Jupiter position, within the wrapper's level. Tokens only move between
    // Jupiter and the wrapper authority's own token accounts.
    pub fn operate_position<'info>(
        mut ctx: Context<'_, '_, '_, 'info, OperatePosition<'info>>,
        params: OperatePositionParams,
    ) -> Result<()> {
        OperatePosition::apply(&mut ctx, &params)
    }

    // Admin only. Fix the EVM receiver and bridge provider for one (mint, chain id).
    pub fn set_bridge_route(mut ctx: Context<SetBridgeRoute>, params: SetBridgeRouteParams) -> Result<()> {
        SetBridgeRoute::apply(&mut ctx, &params)
    }

    // Level >= 1. Burn tokens through Circle CCTP v2 to the route's receiver.
    pub fn bridge_tokens_cctp(mut ctx: Context<BridgeTokensCctp>, params: BridgeTokensParams) -> Result<()> {
        BridgeTokensCctp::apply(&mut ctx, &params)
    }

    // Level >= 1. Send tokens through Chainlink CCIP to the route's receiver.
    pub fn bridge_tokens_ccip<'info>(
        mut ctx: Context<'_, '_, '_, 'info, BridgeTokensCcip<'info>>,
        params: BridgeTokensParams,
    ) -> Result<()> {
        BridgeTokensCcip::apply(&mut ctx, &params)
    }

    // Level >= 1. Send a LayerZero OFT token (USDT0, USDai, sUSDai) to the route's receiver.
    pub fn bridge_tokens_oft<'info>(
        mut ctx: Context<'_, '_, '_, 'info, BridgeTokensOft<'info>>,
        params: BridgeTokensParams,
    ) -> Result<()> {
        BridgeTokensOft::apply(&mut ctx, &params)
    }
}
