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
    // Tokens that leave over LayerZero, one entry per token and destination. Each entry says
    // which issuer program to call and how; the client works out the send's ~40-50 accounts
    // from it (lib/client/lzSend.ts). Real sends used as the reference are in
    // tests/fixtures/lz-sends.ts, and the builder is tested against them.
    lzTokens: [
        {
            symbol: 'USDai',
            mint: 'USDai5XCUzNebYzUk6EuRiFCvnyoyEdj7VSyijYcz2A',
            decimals: 6,
            issuerProgram: 'BQ7nDFGKN4cYqmBkMXFCEzk3zPJhR6bNK9Maf8sQXrQm', // USD.AI "console_oft"
            dstEid: 30110,
            tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
            minUnderBps: 0, // no bridge fee, shared decimals == local, nothing is dropped
            options: [],
            nativeFeeCapLamports: 15_000_000n, // observed ~0.00086 SOL; cap well above
            lookupTable: 'FqntHN1ZimKh1aKtmuFMuaxa9E9d4cPxbH3PWKQsdRQf',
            issuer: {
                kind: 'usdai',
                store: '5JZFgHYyVYuNk3BXYbKHiSzrk6EEVV9FLFPJmYvuPfis',
                pauseConfig: '9bud53CNkxxpWkveVJzCZxUxhASSWGAsLjFsZXivndGh',
                feeConfig: 'G4LEeN7fsJjTL9Q8GDGrZ9PhKnSQTjHJnVJr41qvd1Ls',
                defaultRateLimit: 'FX56iS2Yve2bnweDNrx6F6Fo2DCg2hGCtxzRSwPtDZBn',
                rateLimit: '8Ec2R3rRMZcSCMFosgKDtt6nd7SDduzF4hrBKbAw8bRB',
                feeDeposit: '2nybkuuvEyMwUJHt5GZmHGFjVJm4b95enLey1SRX2hsP',
            },
            evmToken: '0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF', // USDai on Arbitrum, 18 decimals
        },
        {
            symbol: 'sUSDai',
            mint: 'sUSDai6Y3GxysDEtA9BVcEFTaog6UZpYUVxJiMhAKYE',
            decimals: 6,
            issuerProgram: 'BQ7nDFGKN4cYqmBkMXFCEzk3zPJhR6bNK9Maf8sQXrQm',
            dstEid: 30110,
            tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
            minUnderBps: 0,
            options: [],
            nativeFeeCapLamports: 15_000_000n,
            lookupTable: '3heFusMjjqc511jibU9XC1UVbsjwCePmB8mSedsMULpA',
            issuer: {
                kind: 'usdai',
                store: '2xVEUsPGGv9Fe3NFc4UmhWd7Y2Ni7MjiSCL8oQJ9bzLZ',
                pauseConfig: 'DsSvSyrYW2sKKr6GVtbEkUYnQ2YyLngeFa9kUJdjo9bL',
                feeConfig: 'DLiMd356ecgLNPDdnHwu5vFTQTQhFi7d17sB9iieZwwg',
                defaultRateLimit: 'HS7VYsHA3EwxP7SZPmGsq9zkBozKUF2pdQ5ddPhkHac4',
                rateLimit: '9eeKTte8JXy17tRkVQaQWKMiKZnkt2GT69h9jfhtF9CG',
                feeDeposit: '256VLEmcW5UnjG2xt9arXYFNSRv7CTkULwbNTPuyjFDe',
            },
            evmToken: '0x0B2b2B2076d95dda7817e785989fE353fe955ef9', // sUSDai on Arbitrum, 18 decimals
        },
        {
            symbol: 'USDT',
            mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // Tether's native USDT
            decimals: 6,
            issuerProgram: 'Fuww9mfc8ntAwxPUzFia7VJFAdvLppyZwhPJoXySZXf7', // USDT0 Legacy Mesh
            dstEid: 30110,
            tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            minUnderBps: 40, // USDT0 takes 0.03% on arrival; leave headroom under the program's 0.5%
            options: [0, 3], // the bare v2 options header, exactly what USDT0's own app sends
            nativeFeeCapLamports: 15_000_000n,
            lookupTable: '6zcTrmdkiQp6dZHYUxVr6A2XVDSYi44X1rcPtvwNcrXi',
            issuer: { kind: 'usdt0', escrow: 'F1YkdxaiLA1eJt12y3uMAQef48Td3zdJfYhzjphma8hG' },
            evmToken: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', // USD\u20ae0 on Arbitrum, 6 decimals
        },
    ],
    env: {
        solanaKeypairPath: 'SOLANA_KEYPAIR_PATH_MAINNET',
        evmPrivateKey: 'EVM_PRIVATE_KEY_MAINNET',
        solanaRpc: 'RPC_URL_SOLANA_MAINNET',
        evmRpc: 'RPC_URL_EVM_MAINNET',
    },
}

export default profile
