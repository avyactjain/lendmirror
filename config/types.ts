/** One live path: Solana source → EVM destination. */
export type DeploymentType = 'devnet' | 'mainnet'

/** Chainlink route for this path. Null when this path has no CCIP wiring. */
export type CcipProfile = {
    /** Solana CCIP router program. */
    router: string
    feeQuoter: string
    rmnRemote: string
    /** LINK mint on this Solana cluster. Used to price the fee. Fee is paid in SOL. */
    linkMint: string
    /** Destination chain selector (Sepolia). */
    destChainSelector: bigint
    /** Source chain selector (Solana Devnet), checked on Ethereum. */
    sourceChainSelector: bigint
    /** EVM CCIP router address. */
    evmRouter: string
    /** Gas for ccipReceive. */
    gasLimit: number
    /** Empty Solana account that signs ccip_send. This is ccipSender on Ethereum. */
    payer: string
}

/** Circle CCTP v2 for this path. Null when USDC bridging is not wired. */
export type CctpProfile = {
    /** TokenMessengerMinterV2 on Solana. Same id on Devnet and mainnet. */
    tokenMessengerMinter: string
    /** MessageTransmitterV2 on Solana. */
    messageTransmitter: string
    /** USDC mint on this Solana cluster. */
    usdcMint: string
    /** Circle domain of the EVM destination (Ethereum/Sepolia 0, Arbitrum 3, Base 6, Polygon 7). */
    evmDomain: number
    /** Circle domain of Solana. Always 5. */
    solanaDomain: number
    /** MessageTransmitterV2 on the EVM chain, for the treasury's claimCctp. */
    evmMessageTransmitter: string
    /** Circle attestation API base: sandbox for testnets, production for mainnet. */
    attestationApi: string
}

export type DeploymentProfile = {
    type: DeploymentType
    /** LayerZero Solana eid. */
    solanaEid: number
    /** LayerZero EVM eid. */
    evmEid: number
    /** Hardhat network name and deployments/<name>/ folder. */
    evmNetwork: string
    programId: string
    /** Store PDA. LayerZero sender. */
    store: string
    /** UUPS proxy. Peer and CCIP receiver. */
    evmProxy: string
    /** Current implementation behind the proxy. Informational. */
    evmImplementation: string
    /** LayerZero EndpointV2 on the EVM chain. Constructor arg for new implementations. */
    lzEndpoint: string
    ccip: CcipProfile | null
    cctp: CctpProfile | null
    /** UUPS proxy of LendMirrorTreasury on the EVM chain. Empty until deployed. */
    treasury: string
    /** Env var names. Secrets stay in .env. */
    env: {
        solanaKeypairPath: string
        evmPrivateKey: string
        solanaRpc: string
        evmRpc: string
    }
}
