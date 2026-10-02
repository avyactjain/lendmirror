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

/** One LayerZero-bridged token: what `bridge_tokens_lz` and the issuer's send template need. */
export type LzTokenProfile = {
    symbol: string
    mint: string
    decimals: number
    /** The issuer's bridge program on Solana (LayerZero's standard OFT, or the issuer's own). */
    issuerProgram: string
    /** LayerZero endpoint id of the destination this lane goes to (Arbitrum 30110, Sepolia 40161).
     * Stored in the route and written into the send; the program checks they match. */
    dstEid: number
    /** Position of the sender's token account in the issuer's `send`. Stored as the route's
     * `gas_limit`; the program pins this slot to the caller's token account. */
    tokenSourceIndex: number
    /** Token program that owns the mint (classic Token or Token-2022). */
    tokenProgram: string
    /** min_amount_ld = amount - amount * minUnderBps / 10000. The program allows at most 50. */
    minUnderBps: number
    /** Options bytes for the send: [] or the bare v2 header [0,3]. Anything else is refused. */
    options: number[]
    /** Cap on the LayerZero fee in lamports. Only the real quoted fee is charged. */
    nativeFeeCapLamports: bigint
    /** The issuer's address lookup table, used by the template transaction. */
    lookupTable: string
    /** The template send's signer. Replaced by our wallet everywhere it appears. */
    templateSigner: string
    /** A slot derived from the sender, re-derived for our wallet: PDA([...seeds, signer]).
     * Null when no slot depends on who sends. */
    senderPda: { index: number; seedPrefix: string; seedBase: string } | null
    /** Full account list of a real mainnet send on this lane, address + writability. The
     * signer, token-source and sender-PDA slots are substituted at build time; the rest are
     * lane constants (store, peer, endpoint, message library, verifiers, price feed). */
    accounts: { key: string; w: boolean }[]
    /** ERC20 that arrives on the EVM chain, for the treasury's set-strategy. */
    evmToken: string
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
    /** Tokens bridged over LayerZero through their issuers' programs. Empty on Devnet. */
    lzTokens: LzTokenProfile[]
    /** Env var names. Secrets stay in .env. */
    env: {
        solanaKeypairPath: string
        evmPrivateKey: string
        solanaRpc: string
        evmRpc: string
    }
}
