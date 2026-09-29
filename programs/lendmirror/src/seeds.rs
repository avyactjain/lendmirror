//! Every PDA seed this program owns, in one place.
//!
//! Owns: the seed strings. Does NOT own: PDA derivation (each instruction's `#[account(seeds)]`
//! does that) or the seeds of other programs (Jupiter's `position`, `vault_state`, LayerZero's
//! `OFT`/`Peer`, Chainlink's `fee_billing_signer`; those stay next to the CPI that uses them).
//!
//! Invariants:
//!   - Every seed starts with `LendMirror` and ends with `V1` (checked by the test below).
//!   - No two seeds are equal.
//!   - A seed never changes once an account exists under it on mainnet. A layout change
//!     means a new seed (`V2`), not an edit here, because Solana accounts cannot be resized
//!     by `init` and a different seed is the only way to start a fresh account.
//!
//! Why `V1` on all of them: the mainnet program upgrade starts from empty state. Every account
//! (Store, peers, routes, wrappers) is created again under these seeds, so nothing the old
//! program wrote can be picked up by mistake.
//!
//! Anchor note: a PDA is `find_program_address(seeds, program_id)`. The same seed under a
//! different program id gives a different address, so these strings are safe to reuse across
//! Devnet and mainnet deployments.
//!
//! The TypeScript client keeps the same list in `lib/client/seeds.ts`. Change both together.

/// The one account that is "us" on LayerZero and holds the admin and allowlists.
/// Seeds: `[STORE_SEED]`.
pub const STORE_SEED: &[u8] = b"LendMirrorStoreV1";

/// The EVM contract we talk to, per LayerZero endpoint id.
/// Seeds: `[PEER_SEED, store, dst_eid be]`.
pub const PEER_SEED: &[u8] = b"LendMirrorPeerV1";

/// Legacy per-position snapshot written by `get_jupiter_position`.
/// Seeds: `[JUP_POSITION_SEED, vault_id le, nft_id le]`.
pub const JUP_POSITION_SEED: &[u8] = b"LendMirrorJupPositionV1";

/// Chainlink router, fee quoter, RMN and destination for snapshot messages.
/// Seeds: `[CCIP_ROUTE_SEED]`.
pub const CCIP_ROUTE_SEED: &[u8] = b"LendMirrorCcipRouteV1";

/// Empty account that signs `ccip_send` and every token bridge, and pays their SOL fees.
/// It must hold no data: Chainlink refuses a payer that is a data account.
/// Seeds: `[CCIP_PAYER_SEED]`.
pub const CCIP_PAYER_SEED: &[u8] = b"LendMirrorCcipPayerV1";

/// One PDA per Jupiter position. Seeds: `[WRAPPER_SEED, vault_id le, nft_id le]`.
pub const WRAPPER_SEED: &[u8] = b"LendMirrorWrapperV1";

/// Up to 8 wallets allowed to act on one wrapper. Seeds: `[ONDEMAND_SEED, wrapper]`.
pub const ONDEMAND_SEED: &[u8] = b"LendMirrorOnDemandV1";

/// Empty PDA that owns a wrapper's token accounts and signs Jupiter `operate`.
/// Seeds: `[WRAPPER_AUTH_SEED, wrapper]`. See `state/wrapper.rs` for why it is separate.
pub const WRAPPER_AUTH_SEED: &[u8] = b"LendMirrorWrapperAuthV1";

/// One admin-set bridge destination per (mint, EVM chain id).
/// Seeds: `[BRIDGE_ROUTE_SEED, mint, dst_chain_id le]`.
pub const BRIDGE_ROUTE_SEED: &[u8] = b"LendMirrorBridgeRouteV1";

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [&[u8]; 9] = [
        STORE_SEED,
        PEER_SEED,
        JUP_POSITION_SEED,
        CCIP_ROUTE_SEED,
        CCIP_PAYER_SEED,
        WRAPPER_SEED,
        ONDEMAND_SEED,
        WRAPPER_AUTH_SEED,
        BRIDGE_ROUTE_SEED,
    ];

    #[test]
    fn every_seed_is_a_lendmirror_v1_seed() {
        for seed in ALL {
            let text = std::str::from_utf8(seed).unwrap();
            assert!(text.starts_with("LendMirror"), "{text}");
            assert!(text.ends_with("V1"), "{text}");
            // Solana caps one seed at 32 bytes.
            assert!(seed.len() <= 32, "{text} is {} bytes", seed.len());
        }
    }

    #[test]
    fn no_two_seeds_are_equal() {
        for (i, a) in ALL.iter().enumerate() {
            for b in &ALL[i + 1..] {
                assert_ne!(a, b);
            }
        }
    }
}
