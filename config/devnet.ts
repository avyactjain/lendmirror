import { EndpointId } from '@layerzerolabs/lz-definitions'

import type { DeploymentProfile } from './types'

/** Solana Devnet (40168) → Ethereum Sepolia (40161). */
const profile: DeploymentProfile = {
    type: 'devnet',
    solanaEid: EndpointId.SOLANA_V2_TESTNET, // 40168
    evmEid: EndpointId.SEPOLIA_V2_TESTNET, // 40161
    evmNetwork: 'sepolia',
    programId: 'GQDxkWJhMGppaXExXBC8hGWmfaUv9igo4PKdaLyc53T1',
    // PDA ["LendMirrorStoreV1"]. Not initialized yet: run init-store after deploying the V1-seed build.
    // The pre-V1 Store was BqsqziQ9VsD3o81zPCQuMfZebdn4eQUAtMjJxZLYhXdM.
    store: '4ENeFwbyLWTVs6ikTsi7u3JBw2t6zt9dp8U8XQHArTsz',
    evmProxy: '0xbE4c9C5DB8E2747C545B2591B3937764f1A2d514',
    evmImplementation: '0x0011b8DE09Cee9d0eba8afaa26643623e511D93F',
    lzEndpoint: '0x6EDCE65403992e310A62460808c4b910D972f10f',
    ccip: {
        router: 'Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C',
        feeQuoter: 'FeeQPGkKDeRV1MgoYfMH6L8o3KeuYjwUZrgn4LRKfjHi',
        rmnRemote: 'RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7',
        linkMint: 'LinkhB3afbBKb2EQQu7s7umdZceV3wcvAUJhQAfQ23L',
        destChainSelector: 16015286601757825753n,
        sourceChainSelector: 16423721717087811551n,
        evmRouter: '0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59',
        gasLimit: 600_000,
        // PDA ["LendMirrorCcipPayerV1"]. Pre-V1: 53ZqmxXwJhXxgLBFXpM1mZUDZ4AZwXaVhpnktxusQn6m.
        payer: 'ERZkW7D7pL1FfgRgTYaaYpWZFapq7RBc2d2NGxK4VBxR',
    },
    cctp: {
        tokenMessengerMinter: 'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe',
        messageTransmitter: 'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC',
        usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        evmDomain: 0,
        solanaDomain: 5,
        // Sepolia MessageTransmitterV2. Verify at developers.circle.com/cctp/evm-smart-contracts before use.
        evmMessageTransmitter: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
        attestationApi: 'https://iris-api-sandbox.circle.com',
    },
    treasury: '0x4d4016ab3b238ee8F7146E141F9bBe9b144d3b0C',
    env: {
        solanaKeypairPath: 'SOLANA_KEYPAIR_PATH_DEVNET',
        evmPrivateKey: 'EVM_PRIVATE_KEY_DEVNET',
        solanaRpc: 'RPC_URL_SOLANA_DEVNET',
        evmRpc: 'RPC_URL_EVM_DEVNET',
    },
}

export default profile
