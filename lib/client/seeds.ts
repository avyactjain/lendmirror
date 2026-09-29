/**
 * Every PDA seed the LendMirror program owns. Mirrors `programs/lendmirror/src/seeds.rs`;
 * change both files together. All seeds end in `V1`: the mainnet upgrade starts from empty
 * state, so nothing the old program wrote is picked up by mistake.
 */
export const SEEDS = {
    /** The one account that is "us" on LayerZero; holds the admin and allowlists. */
    STORE: 'LendMirrorStoreV1',
    /** The EVM contract we talk to, per LayerZero endpoint id: [PEER, store, dst_eid be]. */
    PEER: 'LendMirrorPeerV1',
    /** Legacy per-position snapshot: [JUP_POSITION, vault_id le, nft_id le]. */
    JUP_POSITION: 'LendMirrorJupPositionV1',
    /** Chainlink router, fee quoter, RMN and destination for snapshot messages. */
    CCIP_ROUTE: 'LendMirrorCcipRouteV1',
    /** Empty PDA that signs Chainlink sends and every token bridge, and pays their fees. */
    CCIP_PAYER: 'LendMirrorCcipPayerV1',
    /** One PDA per Jupiter position: [WRAPPER, vault_id le, nft_id le]. */
    WRAPPER: 'LendMirrorPositionWrapperV1',
    /** Up to 8 wallets allowed to act on one wrapper: [ONDEMAND, wrapper]. */
    ONDEMAND: 'LendMirrorOnDemandV1',
    /** Empty PDA that owns a wrapper's token accounts and signs Jupiter operate: [WRAPPER_AUTH, wrapper]. */
    WRAPPER_AUTH: 'LendMirrorWrapperAuthV1',
    /** One admin-set bridge destination per (mint, EVM chain id): [BRIDGE_ROUTE, mint, chain id le]. */
    BRIDGE_ROUTE: 'LendMirrorBridgeRouteV1',
} as const
