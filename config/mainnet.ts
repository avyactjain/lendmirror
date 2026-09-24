import { EndpointId } from '@layerzerolabs/lz-definitions'

import type { DeploymentProfile } from './types'

/** Solana mainnet (30168) → Arbitrum (30110). No Chainlink route yet. */
const profile: DeploymentProfile = {
    type: 'mainnet',
    solanaEid: EndpointId.SOLANA_V2_MAINNET, // 30168
    evmEid: EndpointId.ARBITRUM_V2_MAINNET, // 30110
    evmNetwork: 'arbitrum',
    programId: '9oySM9Jo4ZEXFcWYFbuPK1FeqwrDr6wmnAmenAybzHqQ',
    store: 'BLoEaf2L5rZvEwZuVfFjAabHW4woM9Mr1XknBQCZkyf4',
    evmProxy: '0xb42E98c712B5CAf1e55dB8106262077515879EA2',
    evmImplementation: '0xdAAE65Df8B96e9eE45eb756441B7942e5E128924',
    lzEndpoint: '0x1a44076050125825900e736c501f859c50fE728c',
    ccip: null,
    env: {
        solanaKeypairPath: 'SOLANA_KEYPAIR_PATH_MAINNET',
        evmPrivateKey: 'EVM_PRIVATE_KEY_MAINNET',
        solanaRpc: 'RPC_URL_SOLANA_MAINNET',
        evmRpc: 'RPC_URL_EVM_MAINNET',
    },
}

export default profile
