use crate::*;
use anchor_lang::prelude::*;
use oapp::endpoint::{
    instructions::SendParams, state::EndpointSettings, ENDPOINT_SEED, ID as ENDPOINT_ID,
};

/// Accounts send() needs from US. LayerZero also needs a long list of extra
/// accounts (send library, fee payers, DVN accounts). Those are passed as
/// remaining_accounts by the TypeScript client. We do not name them here.
#[derive(Accounts)]
#[instruction(params: SendMessageParams)]
pub struct Send<'info> {
    #[account(
        seeds = [
            PEER_SEED,
            &store.key().to_bytes(),
            &params.dst_eid.to_be_bytes()
        ],
        bump = peer.bump
    )]
    /// Who we send to on dst_eid (Ethereum contract, 32 bytes) plus gas options.
    pub peer: Account<'info, PeerConfig>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    /// Our OApp identity. This pubkey is the `sender` in PacketSent.
    /// The Store PDA also "signs" the CPI into the Endpoint (see seeds below).
    pub store: Account<'info, Store>,
    #[account(seeds = [ENDPOINT_SEED], bump = endpoint.bump, seeds::program = ENDPOINT_ID)]
    pub endpoint: Account<'info, EndpointSettings>,
}
impl<'info> Send<'info> {
    pub fn apply(ctx: &mut Context<Send>, params: &SendMessageParams) -> Result<()> {
        // Same byte layout as contracts/libs/StringMsgCodec.sol
        let message = msg_codec::encode(&params.message);
        // Store PDA signs the Endpoint CPI. Without this, Endpoint would reject us.
        let seeds: &[&[u8]] = &[STORE_SEED, &[ctx.accounts.store.bump]];

        let send_params = SendParams {
            dst_eid: params.dst_eid, // e.g. 40161 = Sepolia
            receiver: ctx.accounts.peer.peer_address,
            message,
            options: ctx
                .accounts
                .peer
                .enforced_options
                .combine_options( &None::<Vec<u8>>, &params.options)?,
            native_fee: params.native_fee, // SOL, from quote_send
            lz_token_fee: params.lz_token_fee,
        };
        // CPI = this program calls the Endpoint program in the same transaction.
        // After this, PacketSent is on Solana. Ethereum is not updated yet.
        oapp::endpoint_cpi::send(
            ENDPOINT_ID,
            ctx.accounts.store.key(),
            ctx.remaining_accounts,
            seeds,
            send_params,
        )?;
        Ok(())
    }
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct SendMessageParams {
    pub dst_eid: u32,
    pub message: String,
    pub options: Vec<u8>,
    pub native_fee: u64, // lamports. The tx fee-payer (your wallet) actually pays.
    pub lz_token_fee: u64,
}
