# Bridge providers: Solana → EVM

What carries each token from the Solana program to the EVM treasury, and what is verified.

Every provider's Solana-side send takes a 32-byte destination and a source token account.
The program never lets the caller choose either: the destination comes from an admin-set
`BridgeRoute` account and the source is a program-owned token account. See
`programs/lendmirror/src/instructions/bridge_tokens.rs`.

Status legend: **built** = instruction exists and is unit-tested; **devnet** = exercised on Devnet;
**matrix** = researched, no code yet; **unknown** = needs an answer from the team.

## Tokens

Token list confirmed on 2026-09-28: **USDC, USDT, USDai, sUSDai, PST**. Chainlink listing checked
against the CCIP directory data (`smartcontractkit/documentation`, `ccip/v1_2_0/mainnet/tokens.json`
and `lanes.json`), not against search summaries.

| Token | Solana mint | Chainlink CCIP on Solana? | Rail to EVM | Destinations from Solana | Status |
|---|---|---|---|---|---|
| USDC | mainnet `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, devnet `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | **Yes** (pool type `usdc`, which is Chainlink's CCTP-backed pool) | Circle CCTP v2 directly, or CCIP | CCTP: Ethereum, Arbitrum, Base, Optimism, Avalanche, Polygon and more. CCIP lanes: Ethereum, Arbitrum, Base, Optimism, Unichain, Avalanche, Polygon | **built** both ways (`bridge_tokens_cctp`, `bridge_tokens_ccip`) |
| USDT | mainnet `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | **No.** CCIP lists USDT on Ethereum, Base, Optimism, Sonic and a few others, but has no Solana entry | USDT0 (LayerZero OFT) | per USDT0's Solana pathways (verify) | **built** (`bridge_tokens_oft`); needs the USDT0 Solana OFT program id and escrow for the route |
| USDai | `USDai5XCUzNebYzUk6EuRiFCvnyoyEdj7VSyijYcz2A` (LayerZero OFT spoke) | **No** (not in the directory) | LayerZero OFT. Hub: Arbitrum. Spokes: Ethereum, Base, Plasma, Solana | Arbitrum hub, and whichever spoke pathways USD.AI enabled (the meeting note "only Arbitrum" matches the hub) | **built** (`bridge_tokens_oft`); needs USD.AI's Solana OFT program id and escrow for the route |
| sUSDai | `sUSDai6Y3GxysDEtA9BVcEFTaog6UZpYUVxJiMhAKYE` (LayerZero OFT spoke) | **No** | LayerZero OFT, same layout as USDai | same as USDai | **built** (`bridge_tokens_oft`), same inputs as USDai |
| PST (PayFi Strategy Token) | `59obFNBzyTBGowrkif5uK7ojS58vsuWz3ZCvg6tfZAGw` (6 decimals, `lockRelease` pool) | **Yes** | CCIP | Ethereum mainnet and Arc mainnet. The directory shows **no Polygon lane for PST**; the meeting note said "PST only to Polygon", so confirm the intended destination | **built** (`bridge_tokens_ccip`, `--provider ccip`) |

Devnet: CCIP-BnM `3PjyGzj1jGVgHSKS4VR1Hr1memm63PmN8L9rtPDKwzZ6` is the only burn-mint test token with a Solana Devnet lane; USDC also has a Devnet `usdc` pool.

Summary: two of the five tokens go over Chainlink from Solana (USDC, PST). The other three (USDT as USDT0, USDai, sUSDai) are LayerZero OFTs and go through `bridge_tokens_oft`. For each OFT route the admin needs the token's OFT program id and its escrow account (the OFT store and peer derive from the escrow); `set-bridge-route --provider oft --oft-program … --escrow … --dst-eid 30110`.

## Circle CCTP or Chainlink for USDC?

Chainlink's Solana USDC pool is itself built on Circle CCTP (pool type `usdc`), so going through CCIP means CCTP plus Chainlink's routing, fee, and risk management on top. Using CCTP directly means fewer parties, no LINK/SOL CCIP fee, and Circle's own attestation, at the cost of claiming on the EVM side ourselves (`claimCctp`) unless the route leaves `destination_caller` empty. Both are built; the route's `provider` field picks one per token. Recommendation: CCTP directly for USDC (it is the canonical rail and the cheapest), CCIP for PST (its only rail), OFT for the rest. Either way Circle can freeze USDC at the mint; that is true of USDC on any bridge.

## Providers

| Provider | Solana program | Instruction | Sender model | Fee | EVM receive |
|---|---|---|---|---|---|
| Circle CCTP v2 | TokenMessengerMinterV2 `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe`, MessageTransmitterV2 `CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC` (same ids on Devnet and mainnet) | `deposit_for_burn { amount, destination_domain, mint_recipient, destination_caller, max_fee, min_finality_threshold }` | Token account owner signs; our bridge signer PDA via `invoke_signed`. A fresh keypair signs as `message_sent_event_data`. | none (standard) or `max_fee` (fast) | USDC minted straight to `mint_recipient`. `LendMirrorTreasury.claimCctp(message, attestation)` calls `receiveMessage` when the route names the treasury as `destination_caller`. Attestation: `https://iris-api-sandbox.circle.com/v2/messages/5?transactionHash=…` (production: `iris-api.circle.com`). |
| Chainlink CCIP | Router `Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C` (Devnet), fee quoter `FeeQPGkKDeRV1MgoYfMH6L8o3KeuYjwUZrgn4LRKfjHi`, RMN `RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7` | `ccip_send(dest_chain_selector, SVM2AnyMessage { receiver, data, token_amounts, fee_token, extra_args }, token_indexes)` | `authority` signs and pays; our bridge signer PDA (must hold no data). Per-token accounts come from the token admin registry and its lookup table. | SOL (native) | Router transfers tokens to the receiver contract, then calls `ccipReceive` with `destTokenAmounts`. `LendMirrorTreasury.ccipReceive` checks router, source selector, and sender. |
| LayerZero OFT | per token: the issuer's OFT program; store PDA `["OFT", escrow]`, peer PDA `["Peer", store, dst_eid be]` | `send { dst_eid, to, amount_ld, min_amount_ld, options, compose_msg, native_fee, lz_token_fee }` | token source owner signs and pays the fee; our bridge signer PDA | SOL (quoted by the OFT's `quote_send`) | tokens credited to `to` on the destination; no compose | **built** (`bridge_tokens_oft`) |
| Wormhole NTT | per token | `transfer` | token owner signs | SOL | NTT manager mints to recipient | reserved |

## Chain ids and selectors used by routes

| Destination | EVM chain id (route key) | CCTP domain | CCIP selector |
|---|---|---|---|
| Ethereum Sepolia | 11155111 | 0 | 16015286601757825753 |
| Ethereum | 1 | 0 | 5009297550715157269 |
| Arbitrum | 42161 | 3 | 4949039107694359620 |
| Base | 8453 | 6 | 15971525489660198786 |
| Polygon | 137 | 7 | 4051577828743386545 |

Selectors for mainnet chains are from Chainlink's directory and should be re-checked there before a route is set.

## Devnet experiment (planned order)

1. Deploy `LendMirrorTreasury` on Sepolia (`npx hardhat deploy --tags LendMirrorTreasury`), set `profile.treasury`.
2. `lz:oapp:solana:set-bridge-route --mint usdc --provider cctp` (receiver = treasury, destination caller = treasury).
3. Fund the wrapper authority's USDC ATA on Devnet (Circle faucet USDC to the wallet, then a plain SPL transfer).
4. `lz:oapp:solana:bridge-tokens --mint usdc --amount 1000000`.
5. Wait for the sandbox attestation, then `lz:oapp:evm:treasury:claim-cctp --tx-hash <sig>`.
6. `lz:oapp:evm:treasury:set-strategy --token <sepolia USDC> --strategy <addr>` and `lz:oapp:evm:treasury:forward --token <sepolia USDC>`.
