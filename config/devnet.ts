import { EndpointId } from '@layerzerolabs/lz-definitions'

import type { DeploymentProfile } from './types'

/** Solana Devnet (40168) → Ethereum Sepolia (40161). */
const profile: DeploymentProfile = {
    type: 'devnet',
    solanaEid: EndpointId.SOLANA_V2_TESTNET, // 40168
    evmEid: EndpointId.SEPOLIA_V2_TESTNET, // 40161
    evmNetwork: 'sepolia',
    programId: 'GQDxkWJhMGppaXExXBC8hGWmfaUv9igo4PKdaLyc53T1',
    store: 'BqsqziQ9VsD3o81zPCQuMfZebdn4eQUAtMjJxZLYhXdM',
    evmProxy: '0xbE4c9C5DB8E2747C545B2591B3937764f1A2d514',
    evmImplementation: '0xC722956634AC775A05F78B50BC840d27614916fd',
    lzEndpoint: '0x6EDCE65403992e310A62460808c4b910D972f10f',
    ccip: {
        router: 'Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C',
        feeQuoter: 'FeeQPGkKDeRV1MgoYfMH6L8o3KeuYjwUZrgn4LRKfjHi',
        rmnRemote: 'RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7',
        linkMint: 'LinkhB3afbBKb2EQQu7s7umdZceV3wcvAUJhQAfQ23L',
        destChainSelector: 16015286601757825753n,
        sourceChainSelector: 16423721717087811551n,
        evmRouter: '0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59',
        gasLimit: 400_000,
        payer: '53ZqmxXwJhXxgLBFXpM1mZUDZ4AZwXaVhpnktxusQn6m',
    },
    env: {
        solanaKeypairPath: 'SOLANA_KEYPAIR_PATH_DEVNET',
        evmPrivateKey: 'EVM_PRIVATE_KEY_DEVNET',
        solanaRpc: 'RPC_URL_SOLANA_DEVNET',
        evmRpc: 'RPC_URL_EVM_DEVNET',
    },
}

export default profile
