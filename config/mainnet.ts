import { EndpointId } from '@layerzerolabs/lz-definitions'

import type { DeploymentProfile } from './types'

/** Solana mainnet (30168) → Arbitrum One (30110). Chainlink and Circle values checked 2026-09-29. */
const profile: DeploymentProfile = {
    type: 'mainnet',
    solanaEid: EndpointId.SOLANA_V2_MAINNET, // 30168
    evmEid: EndpointId.ARBITRUM_V2_MAINNET, // 30110
    evmNetwork: 'arbitrum',
    programId: '9oySM9Jo4ZEXFcWYFbuPK1FeqwrDr6wmnAmenAybzHqQ',
    // PDA ["LendMirrorStoreV1"], created by init-store after the mainnet upgrade.
    // The old program's Store was BLoEaf2L5rZvEwZuVfFjAabHW4woM9Mr1XknBQCZkyf4.
    store: '4FUxAXWrm124DfXw3J8J1uQWhueygVvuuhTQgKNGKZRV',
    evmProxy: '0xb42E98c712B5CAf1e55dB8106262077515879EA2',
    // Upgraded 2026-09-29 (tx 0x4e751484…). Previous: 0xdAAE65Df8B96e9eE45eb756441B7942e5E128924.
    evmImplementation: '0xe9E61B9aC26ED2CEBC2F21fbD76F7e6cfDa43032',
    lzEndpoint: '0x1a44076050125825900e736c501f859c50fE728c',
    // Chainlink directory (docs.chain.link/ccip/directory/mainnet), checked 2026-09-29.
    // Solana → Arbitrum One lane is listed.
    ccip: {
        router: 'Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C',
        feeQuoter: 'FeeQPGkKDeRV1MgoYfMH6L8o3KeuYjwUZrgn4LRKfjHi',
        rmnRemote: 'RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7',
        linkMint: 'LinkhB3afbBKb2EQQu7s7umdZceV3wcvAUJhQAfQ23L',
        destChainSelector: 4949039107694359620n, // Arbitrum One
        sourceChainSelector: 124615329519749607n, // Solana mainnet
        evmRouter: '0x141fa059441E0ca23ce184B6A78bafD2A517DdE8', // Arbitrum One router
        gasLimit: 600_000,
        // PDA ["LendMirrorCcipPayerV1"] under the mainnet program id.
        payer: 'D6RLag1KgbK8Fe8URR2zXFaZXKBnnx6tLPuL1sUuaLNG',
    },
    // Circle CCTP v2 (developers.circle.com/cctp), checked 2026-09-29.
    cctp: {
        tokenMessengerMinter: 'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe',
        messageTransmitter: 'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC',
        usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        evmDomain: 3, // Arbitrum
        solanaDomain: 5,
        evmMessageTransmitter: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64', // MessageTransmitterV2 on Arbitrum
        attestationApi: 'https://iris-api.circle.com',
    },
    // LendMirrorTreasury proxy on Arbitrum, deployed 2026-09-29. Implementation 0xBED1911918D70c2E88b83f2C75b1763e2c49A795.
    treasury: '0x736AAC431E66de7D07eb61738CA3598a53a24Ca0',
    env: {
        solanaKeypairPath: 'SOLANA_KEYPAIR_PATH_MAINNET',
        evmPrivateKey: 'EVM_PRIVATE_KEY_MAINNET',
        solanaRpc: 'RPC_URL_SOLANA_MAINNET',
        evmRpc: 'RPC_URL_EVM_MAINNET',
    },
}

export default profile
