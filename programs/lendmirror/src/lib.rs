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

const STORE_SEED: &[u8] = b"LendMirrorStore";
const PEER_SEED: &[u8] = b"LendMirrorPeer";
const JUP_POSITION_SEED: &[u8] = b"JupPosition";
const CCIP_SEED: &[u8] = b"LendMirrorCcip";

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
/// Flow: get_jupiter_position → send (LayerZero) and send_ccip (Chainlink).
/// Ethereum stores both and marks the position matched when the bodies are equal.
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

    // Admin only. Replace wallets allowed to call send.
    pub fn set_senders(mut ctx: Context<SetSenders>, params: SetAllowlistParams) -> Result<()> {
        SetSenders::apply(&mut ctx, &params)
    }

    // How much SOL to attach to send(). Does not send. Quotes from store.last_position.
    pub fn quote_send(ctx: Context<QuoteSend>, params: QuoteSendParams) -> Result<MessagingFee> {
        QuoteSend::apply(&ctx, &params)
    }

    // Encode store.last_position and CPI into the Solana Endpoint.
    // Authority must be on the senders allowlist. DVNs still have to verify after.
    pub fn send(mut ctx: Context<Send>, params: SendMessageParams) -> Result<()> {
        Send::apply(&mut ctx, &params)
    }

    // Admin only. Router, destination chain, and Ethereum receiver for send_ccip.
    pub fn set_ccip_route(mut ctx: Context<SetCcipRoute>, params: SetCcipRouteParams) -> Result<()> {
        SetCcipRoute::apply(&mut ctx, &params)
    }

    // Encode the same snapshot body and CPI into the Chainlink CCIP router.
    // Authority must be on the senders allowlist. The Store pays the SOL fee.
    pub fn send_ccip(mut ctx: Context<SendCcip>) -> Result<()> {
        SendCcip::apply(&mut ctx)
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
}
