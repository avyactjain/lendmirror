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

/**
 * How to call one issuer's bridge program. The client works out the full account list of the
 * issuer's `send` from this: the issuer's own accounts by the rules of its program, and the
 * LayerZero accounts with LayerZero's SDK, which reads them from chain.
 *
 * - `standard-oft`: LayerZero's standard program (Paxos's PYUSD deployment). Everything derives
 *   from the escrow account.
 * - `usdt0`: Tether's USDT0 program. Its store, peer and credits accounts sit at fixed addresses
 *   under the program; only the escrow is given here.
 * - `usdai`: USD.AI's program (USDai and sUSDai). Its pause, fee and rate-limit records follow
 *   rules USD.AI does not publish, so their addresses are listed. They were read from a real
 *   send and are the same for every sender.
 */
export type LzIssuer =
    | { kind: 'standard-oft'; escrow: string }
    | { kind: 'usdt0'; escrow: string }
    | {
          kind: 'usdai'
          store: string
          pauseConfig: string
          feeConfig: string
          defaultRateLimit: string
          rateLimit: string
          /** Where the issuer collects its fee, if it ever charges one. From its store. */
          feeDeposit: string
      }

/** One token that leaves Solana over LayerZero, to one destination chain. */
export type LzTokenProfile = {
    symbol: string
    /** The token's address on Solana (its "mint"). */
    mint: string
    decimals: number
    /** The issuer's bridge program on Solana. Written into the route; the send must call it. */
    issuerProgram: string
    /** LayerZero's id for the destination chain (Arbitrum 30110, Sepolia 40161). Written into
     * the route and into the send; the program checks they match. */
    dstEid: number
    /** Token program that owns the token (classic Token or Token-2022). */
    tokenProgram: string
    /** How the issuer's program wants to be called. */
    issuer: LzIssuer
    /** "Minimum that must arrive" = amount - amount * minUnderBps / 10000. The program allows at most 50. */
    minUnderBps: number
    /** Extra delivery options for the send: [] or the bare header [0,3]. Anything else is refused. */
    options: number[]
    /** The most SOL (in lamports) the sender agrees to pay LayerZero. Only the real fee is charged. */
    nativeFeeCapLamports: bigint
    /** The issuer's address lookup table: lets ~40 accounts fit in one transaction. */
    lookupTable: string
    /** The token that arrives on the EVM chain, for the treasury's set-strategy. */
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
