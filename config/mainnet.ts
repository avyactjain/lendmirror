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
    // LayerZero-bridged tokens. Each entry is a real mainnet send on that lane, captured
    // 2026-10-01 (USDai 4MH2cvvP…, sUSDai w9q6nMmp…, USDT 2u38YgKH…): the full account list,
    // the issuer's lookup table, and where the sender's token account sits. The signer and
    // token-source slots (plus USD.AI's per-sender rate-limit-exemption PDA) are swapped for
    // ours at build time; everything else is a lane constant.
    lzTokens: [
        {
            symbol: 'USDai',
            mint: 'USDai5XCUzNebYzUk6EuRiFCvnyoyEdj7VSyijYcz2A',
            decimals: 6,
            issuerProgram: 'BQ7nDFGKN4cYqmBkMXFCEzk3zPJhR6bNK9Maf8sQXrQm', // USD.AI "console_oft"
            tokenSourceIndex: 9,
            tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
            minUnderBps: 0, // no bridge fee, shared decimals == local, nothing is dropped
            options: [],
            nativeFeeCapLamports: 15_000_000n, // observed ~0.00086 SOL; cap well above
            lookupTable: 'FqntHN1ZimKh1aKtmuFMuaxa9E9d4cPxbH3PWKQsdRQf',
            templateSigner: 'YFTh5kYhf64N5Xd1oXBe4TKjdggEnE1cveT9vwqfH9w',
            // ["RateLimitExemption", store, sender] under the issuer program.
            senderPda: {
                index: 8,
                seedPrefix: 'RateLimitExemption',
                seedBase: '5JZFgHYyVYuNk3BXYbKHiSzrk6EEVV9FLFPJmYvuPfis',
            },
            accounts: [
                { key: 'YFTh5kYhf64N5Xd1oXBe4TKjdggEnE1cveT9vwqfH9w', w: true },
                { key: '5JZFgHYyVYuNk3BXYbKHiSzrk6EEVV9FLFPJmYvuPfis', w: false },
                { key: 'B4Ri6MzmKCTZE8ccJgE4vNASFKrxqf9KitPMNFGgiBaA', w: false },
                // The captured send carried a compose message, so it listed the compose-type
                // enforced-options PDA here. Our sends never compose: this is the send-type one
                // (["EnforcedOptions", store, 30110 be, u16 1]), as the program itself demands
                // (checked by simulation; the compose-type account made it fail ConstraintSeeds).
                { key: 'FFBcrBSRN9iC76Y3jd6bjJAy6CgGfycwZbLVihzsrYGr', w: false },
                { key: '9bud53CNkxxpWkveVJzCZxUxhASSWGAsLjFsZXivndGh', w: false },
                { key: 'G4LEeN7fsJjTL9Q8GDGrZ9PhKnSQTjHJnVJr41qvd1Ls', w: false },
                { key: 'FX56iS2Yve2bnweDNrx6F6Fo2DCg2hGCtxzRSwPtDZBn', w: true },
                { key: '8Ec2R3rRMZcSCMFosgKDtt6nd7SDduzF4hrBKbAw8bRB', w: true },
                { key: 'C9LqRyftAzWPEUNgfMsk1qQ3o1brgPgaYWfYVciB3pxU', w: false },
                { key: '842dNHeCfE7fiYexgBtj569VqkzdPNT9ngznr1jGAy3X', w: true },
                { key: '7FmLnvCSKstyVhEurD8c96Nwsg2Xv5NWMibMFWxbNgXQ', w: true },
                { key: '2nybkuuvEyMwUJHt5GZmHGFjVJm4b95enLey1SRX2hsP', w: true },
                { key: 'USDai5XCUzNebYzUk6EuRiFCvnyoyEdj7VSyijYcz2A', w: true },
                { key: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', w: false },
                { key: 'C6ii9GFKGkxERd7psQYbjhNHgiAVYohUuNPAn6WsBfEh', w: false },
                { key: 'BQ7nDFGKN4cYqmBkMXFCEzk3zPJhR6bNK9Maf8sQXrQm', w: false },
                { key: '76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6', w: false },
                { key: '5JZFgHYyVYuNk3BXYbKHiSzrk6EEVV9FLFPJmYvuPfis', w: false },
                { key: '7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH', w: false },
                { key: 'R4fKy54UAw4Xgtr8yaNBp5v5cS7iaFGu5CyUA1aS5s8', w: false },
                { key: '6eBJZSdwWri24KFWEGWX2WkWCCQCB89sTqi66MaBgnn5', w: false },
                { key: '526PeNZfw8kSnDU4nmzJFVJzJWNhwmZykEyJr5XWz5Fv', w: false },
                { key: '2uk9pQh3tB5ErV7LGQJcbWjb4KeJ2UJki5qJZ8QG56G3', w: false },
                { key: 'GtedCGE4bQsdt4cHH63ExBkhN7oigf8Bg8fXKyMb8oK2', w: true },
                { key: 'F8E8QGhKmHEx2esh5LpVizzcP4cHYhzXdXTwg9w3YYY2', w: false },
                { key: '76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6', w: false },
                { key: '2XgGZG4oP29U3w5h4nTk1V2LFHL23zKDPJjs3psGzLKQ', w: false },
                { key: '7Qq2XMqjzAKsMHrm2BX2oc3fX1xeE74U7VMfAFX1hDaw', w: false },
                { key: 'ArJGQF5NpgYLCXrLjmzJBPhh4p3vkdRRbWsr3CADRa2g', w: false },
                { key: 'YFTh5kYhf64N5Xd1oXBe4TKjdggEnE1cveT9vwqfH9w', w: true },
                { key: '7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH', w: false },
                { key: '11111111111111111111111111111111', w: false },
                { key: '7n1YeBMVEUCJ4DscKAcpVQd6KXU7VpcEcc15ZuMcL4U3', w: false },
                { key: '7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH', w: false },
                { key: '6doghB248px58JSSwG4qejQ46kFMW4AMj7vzJnWZHNZn', w: false },
                { key: 'AwrbHeCyniXaQhiJZkLhgWdUCteeWSGaSN1sTfLiY7xK', w: true },
                { key: '8ahPGPjEbpgGaZx2NV1iG5Shj7TDwvsjkEDcGWjt94TP', w: false },
                { key: 'CSFsUupvJEQQd1F4SsXGACJaxQX4eropQMkGV2696eeQ', w: false },
                { key: 'HtEYV4xB4wvsj5fgTkcfuChYpvGYzgzwvNhgDZQNh7wW', w: false },
                { key: '4VDjp6XQaxoZf5RGwiPU9NR1EXSZn2TP4ATMmiSzLfhb', w: true },
                { key: '8ahPGPjEbpgGaZx2NV1iG5Shj7TDwvsjkEDcGWjt94TP', w: false },
                { key: 'CSFsUupvJEQQd1F4SsXGACJaxQX4eropQMkGV2696eeQ', w: false },
                { key: '5KAALa8AEEKnW6p6AacdnqNDmGMpfhwR7AEyWs1gUvsT', w: false },
                { key: '7jMeX5mzXnSSKYd8DxBDP4xMnkNFZZZm5W28FWUTbwU3', w: true },
                { key: '8ahPGPjEbpgGaZx2NV1iG5Shj7TDwvsjkEDcGWjt94TP', w: false },
                { key: 'CSFsUupvJEQQd1F4SsXGACJaxQX4eropQMkGV2696eeQ', w: false },
                { key: '4fs6aL12L18K5giDy9Dgxgrb3aNRYiuRV2a7JPPj3e7F', w: false },
                { key: 'GPjyWr8vCotGuFubDpTxDxy9Vj1ZeEN4F2dwRmFiaGab', w: true },
                { key: '8ahPGPjEbpgGaZx2NV1iG5Shj7TDwvsjkEDcGWjt94TP', w: false },
                { key: 'CSFsUupvJEQQd1F4SsXGACJaxQX4eropQMkGV2696eeQ', w: false },
            ],
            evmToken: '0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF', // USDai on Arbitrum, 18 decimals
        },
        {
            symbol: 'sUSDai',
            mint: 'sUSDai6Y3GxysDEtA9BVcEFTaog6UZpYUVxJiMhAKYE',
            decimals: 6,
            issuerProgram: 'BQ7nDFGKN4cYqmBkMXFCEzk3zPJhR6bNK9Maf8sQXrQm',
            tokenSourceIndex: 9,
            tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
            minUnderBps: 0,
            options: [],
            nativeFeeCapLamports: 15_000_000n,
            lookupTable: '3heFusMjjqc511jibU9XC1UVbsjwCePmB8mSedsMULpA',
            templateSigner: 'CoAVUkNweegD1cDMDy31UY4tqnLEvmCFpDeQimFv2Lmk',
            senderPda: {
                index: 8,
                seedPrefix: 'RateLimitExemption',
                seedBase: '2xVEUsPGGv9Fe3NFc4UmhWd7Y2Ni7MjiSCL8oQJ9bzLZ',
            },
            accounts: [
                { key: 'CoAVUkNweegD1cDMDy31UY4tqnLEvmCFpDeQimFv2Lmk', w: true },
                { key: '2xVEUsPGGv9Fe3NFc4UmhWd7Y2Ni7MjiSCL8oQJ9bzLZ', w: false },
                { key: 'Gr6EbSFRjMrnhYQm91CcknwU6KcVz3QphcLd57VoGvGG', w: false },
                { key: '4pLfLzJ5o7yN8VAWLivXjtHS2WuXMyzV5mEXr2njL8vk', w: false },
                { key: 'DsSvSyrYW2sKKr6GVtbEkUYnQ2YyLngeFa9kUJdjo9bL', w: false },
                { key: 'DLiMd356ecgLNPDdnHwu5vFTQTQhFi7d17sB9iieZwwg', w: false },
                { key: 'HS7VYsHA3EwxP7SZPmGsq9zkBozKUF2pdQ5ddPhkHac4', w: true },
                { key: '9eeKTte8JXy17tRkVQaQWKMiKZnkt2GT69h9jfhtF9CG', w: true },
                { key: '8VKERLKhHHt4emJge8W6pyaqWQsJ3TT52uJud4gueEfv', w: false },
                { key: '8CTfqxkgcgXaAYCxrE7RK3ukQ2wPcyQRVXsxPWT6kyRG', w: true },
                { key: 'Au4orsSV8ZQiYzrVkh7Z36yyjyrePDe86AkCdGGEQ3YD', w: true },
                { key: '256VLEmcW5UnjG2xt9arXYFNSRv7CTkULwbNTPuyjFDe', w: true },
                { key: 'sUSDai6Y3GxysDEtA9BVcEFTaog6UZpYUVxJiMhAKYE', w: true },
                { key: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', w: false },
                { key: 'C6ii9GFKGkxERd7psQYbjhNHgiAVYohUuNPAn6WsBfEh', w: false },
                { key: 'BQ7nDFGKN4cYqmBkMXFCEzk3zPJhR6bNK9Maf8sQXrQm', w: false },
                { key: '76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6', w: false },
                { key: '2xVEUsPGGv9Fe3NFc4UmhWd7Y2Ni7MjiSCL8oQJ9bzLZ', w: false },
                { key: '7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH', w: false },
                { key: 'EAH9NfMLWDUwHCgGcm8RaCzYVjMbGP8UbEsRqdBMqZUB', w: false },
                { key: '6eBJZSdwWri24KFWEGWX2WkWCCQCB89sTqi66MaBgnn5', w: false },
                { key: '526PeNZfw8kSnDU4nmzJFVJzJWNhwmZykEyJr5XWz5Fv', w: false },
                { key: '2uk9pQh3tB5ErV7LGQJcbWjb4KeJ2UJki5qJZ8QG56G3', w: false },
                { key: 'HcqnDzKD3FscV8xDke13keGpkcsoPsjHvSh28oUrMdy', w: true },
                { key: 'F8E8QGhKmHEx2esh5LpVizzcP4cHYhzXdXTwg9w3YYY2', w: false },
                { key: '76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6', w: false },
                { key: '2XgGZG4oP29U3w5h4nTk1V2LFHL23zKDPJjs3psGzLKQ', w: false },
                { key: '7GbQTjgLtyXw2s4ovXf8JRWU2sbfuKEvVVFXJaAf1XBT', w: false },
                { key: 'ArJGQF5NpgYLCXrLjmzJBPhh4p3vkdRRbWsr3CADRa2g', w: false },
                { key: 'CoAVUkNweegD1cDMDy31UY4tqnLEvmCFpDeQimFv2Lmk', w: true },
                { key: '7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH', w: false },
                { key: '11111111111111111111111111111111', w: false },
                { key: '7n1YeBMVEUCJ4DscKAcpVQd6KXU7VpcEcc15ZuMcL4U3', w: false },
                { key: '7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH', w: false },
                { key: '6doghB248px58JSSwG4qejQ46kFMW4AMj7vzJnWZHNZn', w: false },
                { key: 'AwrbHeCyniXaQhiJZkLhgWdUCteeWSGaSN1sTfLiY7xK', w: true },
                { key: '8ahPGPjEbpgGaZx2NV1iG5Shj7TDwvsjkEDcGWjt94TP', w: false },
                { key: 'CSFsUupvJEQQd1F4SsXGACJaxQX4eropQMkGV2696eeQ', w: false },
                { key: 'HtEYV4xB4wvsj5fgTkcfuChYpvGYzgzwvNhgDZQNh7wW', w: false },
                { key: '4VDjp6XQaxoZf5RGwiPU9NR1EXSZn2TP4ATMmiSzLfhb', w: true },
                { key: '8ahPGPjEbpgGaZx2NV1iG5Shj7TDwvsjkEDcGWjt94TP', w: false },
                { key: 'CSFsUupvJEQQd1F4SsXGACJaxQX4eropQMkGV2696eeQ', w: false },
                { key: '5KAALa8AEEKnW6p6AacdnqNDmGMpfhwR7AEyWs1gUvsT', w: false },
                { key: '7jMeX5mzXnSSKYd8DxBDP4xMnkNFZZZm5W28FWUTbwU3', w: true },
                { key: '8ahPGPjEbpgGaZx2NV1iG5Shj7TDwvsjkEDcGWjt94TP', w: false },
                { key: 'CSFsUupvJEQQd1F4SsXGACJaxQX4eropQMkGV2696eeQ', w: false },
                { key: '4fs6aL12L18K5giDy9Dgxgrb3aNRYiuRV2a7JPPj3e7F', w: false },
                { key: 'GPjyWr8vCotGuFubDpTxDxy9Vj1ZeEN4F2dwRmFiaGab', w: true },
                { key: '8ahPGPjEbpgGaZx2NV1iG5Shj7TDwvsjkEDcGWjt94TP', w: false },
                { key: 'CSFsUupvJEQQd1F4SsXGACJaxQX4eropQMkGV2696eeQ', w: false },
            ],
            evmToken: '0x0B2b2B2076d95dda7817e785989fE353fe955ef9', // sUSDai on Arbitrum, 18 decimals
        },
        {
            symbol: 'USDT',
            mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // Tether's native USDT
            decimals: 6,
            issuerProgram: 'Fuww9mfc8ntAwxPUzFia7VJFAdvLppyZwhPJoXySZXf7', // USDT0 Legacy Mesh
            tokenSourceIndex: 4,
            tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            minUnderBps: 40, // USDT0 takes 0.03% on arrival; leave headroom under the program's 0.5%
            options: [0, 3], // the bare v2 options header, exactly what USDT0's own app sends
            nativeFeeCapLamports: 15_000_000n,
            lookupTable: '6zcTrmdkiQp6dZHYUxVr6A2XVDSYi44X1rcPtvwNcrXi',
            templateSigner: '8g129V8gSXYxVRgi7vQpxG9RPVWe1N1MNMdaFxXeXrsR',
            senderPda: null,
            accounts: [
                { key: '8g129V8gSXYxVRgi7vQpxG9RPVWe1N1MNMdaFxXeXrsR', w: true },
                { key: '5FEMXXjueR7y6Z1uVDxTm4ZZXFp6XnxR1Xu1WmvwjxBF', w: false },
                { key: 'HyXJcgYpURfDhgzuyRL7zxP4FhLg7LZQMeDrR4MXZcMN', w: true },
                { key: '6trV82jqtcqrsMd5ZXKvR6QzLX6bHstBK4wZFx1qrffC', w: true },
                { key: '13WoVy9evHX2E5KFtsWi8NCA4H1DKjgd9FTdEnWxjcWS', w: true },
                { key: 'F1YkdxaiLA1eJt12y3uMAQef48Td3zdJfYhzjphma8hG', w: true },
                { key: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', w: false },
                { key: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', w: false },
                { key: 'B981t4zrZf3HCgtFFcw32D7Ukoa6saGMomeJcYNRwsQd', w: false },
                { key: 'Fuww9mfc8ntAwxPUzFia7VJFAdvLppyZwhPJoXySZXf7', w: false },
                { key: '76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6', w: false },
                { key: 'HyXJcgYpURfDhgzuyRL7zxP4FhLg7LZQMeDrR4MXZcMN', w: true },
                { key: '7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH', w: false },
                { key: 'xrbATgBr5WadPQZBqeH1FkHrK44FrgoB7QGvqQazESh', w: false },
                { key: '6eBJZSdwWri24KFWEGWX2WkWCCQCB89sTqi66MaBgnn5', w: false },
                { key: '526PeNZfw8kSnDU4nmzJFVJzJWNhwmZykEyJr5XWz5Fv', w: false },
                { key: '2uk9pQh3tB5ErV7LGQJcbWjb4KeJ2UJki5qJZ8QG56G3', w: false },
                { key: 'uZ8xA3LGpAJ5GHkTLqyvvrBVZa5XjCCRwc2qNvZJKci', w: true },
                { key: 'F8E8QGhKmHEx2esh5LpVizzcP4cHYhzXdXTwg9w3YYY2', w: false },
                { key: '76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6', w: false },
                { key: '2XgGZG4oP29U3w5h4nTk1V2LFHL23zKDPJjs3psGzLKQ', w: false },
                { key: 'EDCciRXYGE9ZSCCr9SZFiGtwNLbLHnzzFmf3oCRthCfN', w: false },
                { key: 'ArJGQF5NpgYLCXrLjmzJBPhh4p3vkdRRbWsr3CADRa2g', w: false },
                { key: '8g129V8gSXYxVRgi7vQpxG9RPVWe1N1MNMdaFxXeXrsR', w: true },
                { key: '7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH', w: false },
                { key: '11111111111111111111111111111111', w: false },
                { key: '7n1YeBMVEUCJ4DscKAcpVQd6KXU7VpcEcc15ZuMcL4U3', w: false },
                { key: '7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH', w: false },
                { key: '6doghB248px58JSSwG4qejQ46kFMW4AMj7vzJnWZHNZn', w: false },
                { key: 'AwrbHeCyniXaQhiJZkLhgWdUCteeWSGaSN1sTfLiY7xK', w: true },
                { key: '8ahPGPjEbpgGaZx2NV1iG5Shj7TDwvsjkEDcGWjt94TP', w: false },
                { key: 'CSFsUupvJEQQd1F4SsXGACJaxQX4eropQMkGV2696eeQ', w: false },
                { key: 'HtEYV4xB4wvsj5fgTkcfuChYpvGYzgzwvNhgDZQNh7wW', w: false },
                { key: '4VDjp6XQaxoZf5RGwiPU9NR1EXSZn2TP4ATMmiSzLfhb', w: true },
                { key: '8ahPGPjEbpgGaZx2NV1iG5Shj7TDwvsjkEDcGWjt94TP', w: false },
                { key: 'CSFsUupvJEQQd1F4SsXGACJaxQX4eropQMkGV2696eeQ', w: false },
                { key: '3T7waVnx1W54ZA7XuRmXngoua4hEkRXciNL8stBJAUR4', w: false },
                { key: 'JBt34GkVns6VSoP2dCPpViW28eqE4GNgKaoZPRP63wZs', w: true },
                { key: '8ahPGPjEbpgGaZx2NV1iG5Shj7TDwvsjkEDcGWjt94TP', w: false },
                { key: 'CSFsUupvJEQQd1F4SsXGACJaxQX4eropQMkGV2696eeQ', w: false },
            ],
            evmToken: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', // USD\u20ae0 on Arbitrum, 6 decimals
        },
    ],
    jupiter: {
        program: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
        swapApi: 'https://lite-api.jup.ag/swap/v1',
    },
    env: {
        solanaKeypairPath: 'SOLANA_KEYPAIR_PATH_MAINNET',
        evmPrivateKey: 'EVM_PRIVATE_KEY_MAINNET',
        solanaRpc: 'RPC_URL_SOLANA_MAINNET',
        evmRpc: 'RPC_URL_EVM_MAINNET',
    },
}

export default profile
