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
    /** Env var names. Secrets stay in .env. */
    env: {
        solanaKeypairPath: string
        evmPrivateKey: string
        solanaRpc: string
        evmRpc: string
    }
}
