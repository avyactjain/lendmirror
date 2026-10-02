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
    evmImplementation: '0xBE499Eb4C9231d308De0C5b4A96225cd984a5BC6',
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
    // PayPal's test PYUSD: a public faucet, LayerZero's standard OFT program (Paxos's
    // deployment), peer to Sepolia. Captured from a real devnet send (Ub8L1qraJ3dk…,
    // 2026-05-28): the full account list, the lookup table, and where the sender's token
    // account sits. The signer and token-source slots are swapped for ours at build time.
    lzTokens: [
        {
            symbol: 'PYUSD',
            mint: 'CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM',
            decimals: 6,
            issuerProgram: 'paxosVkYuJBKUQoZGAidRA47Qt4uidqG5fAt5kmr1nR',
            dstEid: 40161, // Sepolia
            tokenSourceIndex: 3, // standard OFT: signer, peer, store, token_source, escrow, mint, ...
            tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
            minUnderBps: 0, // burn-and-mint, no fee, shared decimals == local
            options: [], // the peer's enforced options carry 183,500 gas on Sepolia
            nativeFeeCapLamports: 50_000_000n, // devnet fees are quoted higher; only the real fee is charged
            lookupTable: '9thqPdbR27A1yLWw2spwJLySemiGMXxPnEvfmXVk4KuK',
            templateSigner: '9WBhc3GQxwVYqGvsAjsF2XBmkeZqeG6AKBBd5hFnHEA4',
            senderPda: null,
            accounts: [
                { key: '9WBhc3GQxwVYqGvsAjsF2XBmkeZqeG6AKBBd5hFnHEA4', w: true },
                { key: 'CFKsqjcfikSM3wS1V1cXYLCgdVqZzjycPTE8gJkkMMFB', w: true },
                { key: 'M8YxJ7TSL9TgPxudiUQsDc8MkF9mYzRae3iHySZS9Ly', w: true },
                { key: 'Gn5KKNhqjKkP2Upzrho93ndHfJ3ujCbwXDFYADSxwAbT', w: true },
                { key: 'EXJZbFNmPhrNkJxJ3tq8RyGHzzxPcxNQxSgx6HUHoRfU', w: true },
                { key: 'CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM', w: true },
                { key: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', w: false },
                { key: 'AxW3SBxJUHeYFEd9KWPdqX1aBKUhgKZV9hLCC4oKfVzx', w: false },
                { key: 'paxosVkYuJBKUQoZGAidRA47Qt4uidqG5fAt5kmr1nR', w: false },
                { key: '76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6', w: false },
                { key: 'M8YxJ7TSL9TgPxudiUQsDc8MkF9mYzRae3iHySZS9Ly', w: true },
                { key: '7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH', w: false },
                { key: '4GN92jRi2FqxaJ7zg94emD2m5sNcJMKKCWcgfkDhGfct', w: false },
                { key: 'HpdCPY94sruXSQ2hXk42BtTPkAYLZamT8rmZtoTzdY4h', w: false },
                { key: '526PeNZfw8kSnDU4nmzJFVJzJWNhwmZykEyJr5XWz5Fv', w: false },
                { key: '2uk9pQh3tB5ErV7LGQJcbWjb4KeJ2UJki5qJZ8QG56G3', w: false },
                { key: 'Bk3qAx4245fMKgxde21GvUCQKRf9yayCqVZNuXFQ83Up', w: true },
                { key: 'F8E8QGhKmHEx2esh5LpVizzcP4cHYhzXdXTwg9w3YYY2', w: false },
                { key: '76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6', w: false },
                { key: '2XgGZG4oP29U3w5h4nTk1V2LFHL23zKDPJjs3psGzLKQ', w: false },
                { key: '2Z6GUMLNC7RXhnaeL7nTinSfkdtkH2EewmhrgwAPmipb', w: false },
                { key: '4ksWk8ssnGZgMo61LKddc6X2XzkJZVfFhP2C1z2CG5U2', w: false },
                { key: '9WBhc3GQxwVYqGvsAjsF2XBmkeZqeG6AKBBd5hFnHEA4', w: true },
                { key: '7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH', w: false },
                { key: '11111111111111111111111111111111', w: false },
                { key: '7n1YeBMVEUCJ4DscKAcpVQd6KXU7VpcEcc15ZuMcL4U3', w: false },
                { key: '7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH', w: false },
                { key: '6doghB248px58JSSwG4qejQ46kFMW4AMj7vzJnWZHNZn', w: false },
                { key: 'AwrbHeCyniXaQhiJZkLhgWdUCteeWSGaSN1sTfLiY7xK', w: true },
                { key: '8ahPGPjEbpgGaZx2NV1iG5Shj7TDwvsjkEDcGWjt94TP', w: false },
                { key: 'CSFsUupvJEQQd1F4SsXGACJaxQX4eropQMkGV2696eeQ', w: false },
                { key: '2riPXyzsFhSasZTxbEeWuuvHu4P5c49x4ARJQ4wgLiTF', w: false },
                { key: '4HxXbLv37XrivKukEbofybpHr7C8HUGJzd4B5T9USpGh', w: true },
                { key: '8ahPGPjEbpgGaZx2NV1iG5Shj7TDwvsjkEDcGWjt94TP', w: false },
                { key: 'CSFsUupvJEQQd1F4SsXGACJaxQX4eropQMkGV2696eeQ', w: false },
                { key: 'HtEYV4xB4wvsj5fgTkcfuChYpvGYzgzwvNhgDZQNh7wW', w: false },
                { key: '4VDjp6XQaxoZf5RGwiPU9NR1EXSZn2TP4ATMmiSzLfhb', w: true },
                { key: '8ahPGPjEbpgGaZx2NV1iG5Shj7TDwvsjkEDcGWjt94TP', w: false },
                { key: 'CSFsUupvJEQQd1F4SsXGACJaxQX4eropQMkGV2696eeQ', w: false },
            ],
            evmToken: '0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9', // PYUSD on Sepolia, 6 decimals
        },
    ],
    env: {
        solanaKeypairPath: 'SOLANA_KEYPAIR_PATH_DEVNET',
        evmPrivateKey: 'EVM_PRIVATE_KEY_DEVNET',
        solanaRpc: 'RPC_URL_SOLANA_DEVNET',
        evmRpc: 'RPC_URL_EVM_DEVNET',
    },
}

export default profile
