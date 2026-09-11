mod errors;
mod instructions;
mod msg_codec;
mod state;

use anchor_lang::prelude::*;
use instructions::*;
use oapp::{
    endpoint::MessagingFee,
    LzReceiveParams,
    lz_receive_types_v2::{LzReceiveTypesV2Accounts, LzReceiveTypesV2Result}
};
use solana_helper::program_id_from_env;
use state::*;

// to build in verifiable mode and using environment variable (what the README instructs), run:
// anchor build -v -e LENDMIRROR_ID=<OAPP_PROGRAM_ID>
// to build in normal mode and using environment, run:
// LENDMIRROR_ID=$PROGRAM_ID anchor build 
declare_id!(anchor_lang::solana_program::pubkey::Pubkey::new_from_array(program_id_from_env!(
    "LENDMIRROR_ID",
    "H84BoBhYfCsLofgrAwQWt9YmFZRPKLkNznzfmeJS1xj1" // It's not necessary to change the ID here if you are building using environment variable
)));

const LZ_RECEIVE_TYPES_SEED: &[u8] = b"LzReceiveTypes"; // The Executor relies on this exact seed to derive the LzReceiveTypes PDA. Keep it the same.
const STORE_SEED: &[u8] = b"Store"; // You are free to edit this seed.
const PEER_SEED: &[u8] = b"Peer"; // Not used by the Executor.

/// LendMirror Piece 2 — Solana side of a LayerZero OApp.
///
/// This program is the SENDER for LendMirror (Solana → Ethereum).
/// The Ethereum contract in contracts/LendMirror.sol is the RECEIVER.
///
/// Program id vs Store (easy to mix up):
///   program id — this code, at declare_id! below.
///   Store PDA  — the OApp identity. LayerZero records Store as the sender.
///                Ethereum's setPeer must be this Store, not the program id.
///
/// LendMirror uses: init_store, set_peer_config, quote_send, send.
/// lz_receive* exists because the starter is two-way. We do not send the
/// loan snapshot TO Solana.
#[program]
pub mod lendmirror {
    use super::*;

    // Create the Store PDA and register it with LayerZero's Endpoint.
    // Call once. First caller sets admin. Anyone can call in this example.
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

    // How much SOL to attach to send(). Does not send.
    pub fn quote_send(ctx: Context<QuoteSend>, params: QuoteSendParams) -> Result<MessagingFee> {
        QuoteSend::apply(&ctx, &params)
    }

    // LendMirror path: pack bytes and CPI into the Solana Endpoint.
    // After this returns, Ethereum has not updated yet. DVNs still have to verify.
    pub fn send(mut ctx: Context<Send>, params: SendMessageParams) -> Result<()> {
        Send::apply(&mut ctx, &params)
    }

    // Starter leftover: receive ON Solana. LendMirror does not use this for the loan.
    pub fn lz_receive(mut ctx: Context<LzReceive>, params: LzReceiveParams) -> Result<()> {
        LzReceive::apply(&mut ctx, &params)
    }

    pub fn lz_receive_types_v2(
        ctx: Context<LzReceiveTypesV2>,
        params: LzReceiveParams,
    ) -> Result<LzReceiveTypesV2Result> {
        LzReceiveTypesV2::apply(&ctx, &params)
    }

    // returns the version and the accounts required to execute lz_receive_types_v2
    pub fn lz_receive_types_info(
        ctx: Context<LzReceiveTypesInfo>,
        params: LzReceiveParams,
    ) -> Result<(u8, LzReceiveTypesV2Accounts)> {
        LzReceiveTypesInfo::apply(&ctx, &params)
    }

}
