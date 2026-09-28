//! `BridgeRoute`: one admin-set record per (token mint, destination chain) that fixes WHERE
//! bridged tokens may go and WHICH bridge carries them.
//!
//! Owns: the route layout and the provider enum. Does NOT own: the bridge calls themselves
//! (see `instructions/bridge_tokens.rs`).
//!
//! Invariants:
//!   - `receiver` is the only destination a bridge instruction will ever use. It is written by
//!     the Store admin and never read from instruction parameters. This is the "funds can only
//!     go to a hardcoded EVM contract" rule.
//!   - A route's address is fixed by `[BRIDGE_ROUTE_SEED, mint, dst_chain_id le]`, so there is
//!     exactly one route per (token, chain).
//!
//! Typical call: admin `set_bridge_route` once per token and chain → an allowed caller on a level 1 or 2 wrapper
//! runs `bridge_tokens_cctp` / `bridge_tokens_ccip` with just an amount.

use anchor_lang::prelude::*;

/// Circle CCTP v2 (`deposit_for_burn` on TokenMessengerMinterV2). USDC only.
pub const PROVIDER_CCTP: u8 = 1;
/// Chainlink CCIP token transfer (`ccip_send` with `token_amounts`).
pub const PROVIDER_CCIP: u8 = 2;
/// LayerZero OFT: a token whose issuer registered it with LayerZero (USDT0, USDai, sUSDai).
pub const PROVIDER_LZ_OFT: u8 = 3;
/// Wormhole NTT (USDS, sUSDS). Reserved: no instruction implements it yet.
#[allow(dead_code)]
pub const PROVIDER_WORMHOLE_NTT: u8 = 4;

/// Seeds: `["LendMirrorBridgeRoute", mint, dst_chain_id le]`.
#[account]
#[derive(InitSpace)]
pub struct BridgeRoute {
    pub mint: Pubkey,
    /// EVM chain id of the destination (Sepolia 11155111, Arbitrum 42161, Polygon 137).
    pub dst_chain_id: u64,
    /// One of the `PROVIDER_*` constants.
    pub provider: u8,
    /// The program the bridge instruction CPIs into (CCTP TokenMessengerMinterV2, CCIP router,
    /// or the token's own LayerZero OFT program).
    pub provider_program: Pubkey,
    /// Provider-specific account. LayerZero: the OFT token escrow, from which the OFT store and
    /// peer addresses derive. Zero for CCTP and CCIP.
    pub provider_aux: Pubkey,
    /// Destination on the EVM chain: our treasury contract, 20-byte address left-padded to 32.
    pub receiver: [u8; 32],
    /// CCTP only: who may call `receiveMessage` on the destination. Zero means anyone
    /// (Circle's relayers deliver automatically); our treasury address means we claim it.
    pub destination_caller: [u8; 32],
    /// CCTP destination domain (Ethereum 0, Arbitrum 3, Base 6, Polygon 7) or the CCIP
    /// destination chain selector, depending on `provider`.
    pub domain_or_selector: u64,
    /// CCIP only: gas for the destination `ccipReceive`. 0 for token-only transfers.
    pub gas_limit: u64,
    pub enabled: bool,
    /// Per-transaction cap in token base units. A wrong route can lose at most this much.
    pub max_amount_per_tx: u64,
    pub bump: u8,
}

impl BridgeRoute {
    /// The 20-byte EVM address inside `receiver`.
    ///
    /// `receiver = [0;12] ++ addr` → returns `addr`.
    pub fn receiver_evm20(&self) -> [u8; 20] {
        let mut out = [0u8; 20];
        out.copy_from_slice(&self.receiver[12..]);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receiver_evm20_drops_the_padding() {
        let mut receiver = [0u8; 32];
        receiver[12..].copy_from_slice(&[0xAB; 20]);
        let route = BridgeRoute {
            mint: Pubkey::default(),
            dst_chain_id: 11155111,
            provider: PROVIDER_CCTP,
            provider_program: Pubkey::default(),
            provider_aux: Pubkey::default(),
            receiver,
            destination_caller: [0; 32],
            domain_or_selector: 0,
            gas_limit: 0,
            enabled: true,
            max_amount_per_tx: 1,
            bump: 255,
        };
        assert_eq!(route.receiver_evm20(), [0xAB; 20]);
    }
}
