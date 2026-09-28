# Bridge providers: Solana → EVM

What carries each token from the Solana program to the EVM treasury, and what is verified.

Every provider's Solana-side send takes a 32-byte destination and a source token account.
The program never lets the caller choose either: the destination comes from an admin-set
`BridgeRoute` account and the source is a program-owned token account. See
`programs/lendmirror/src/instructions/bridge_tokens.rs`.

Status legend: **built** = instruction exists and is unit-tested; **devnet** = exercised on Devnet;
**matrix** = researched, no code yet; **unknown** = needs an answer from the team.

## Tokens

| Token | Solana mint | Rail to EVM | Destinations | Status | Notes |
|---|---|---|---|---|---|
| USDC | mainnet `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, devnet `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | Circle CCTP v2 `deposit_for_burn` | Ethereum (domain 0), Avalanche 1, Optimism 2, Arbitrum 3, Base 6, Polygon 7 | **built** (`bridge_tokens_cctp`) | Native burn and mint, no wrapped asset. Standard finality is free; fast finality charges `max_fee`. The treasury claims when the route sets it as `destination_caller`. |
| USDC (alt) | same | Chainlink CCIP token transfer | Ethereum, Arbitrum, Base, BNB, Optimism, Sonic (mainnet lanes) | **built** (`bridge_tokens_ccip`) | Uses Chainlink's USDC pool on mainnet. Devnet lanes carry test tokens (CCIP-BnM `7AC59PVvR64EoMnLX45FHnJAYzPsxdViyYBsaGEQPFvh`); use BnM for the Devnet experiment. Gas limit 0, out-of-order execution required. |
| USDT | mainnet `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | USDT0 (LayerZero OFT) lists Solana since 2026 | Ethereum, Arbitrum, Optimism, Base, BNB, Avalanche, Polygon, Tron, ... | **matrix** (`PROVIDER_LZ_OFT` reserved) | Verify whether native Tether USDT on Solana is the OFT's mint or whether USDT0 has its own Solana mint. Fallbacks: Wormhole Portal, Allbridge (wrapped). |
| USDA | unknown on Solana | If Angle USDA or Avalon USDa: LayerZero OFT on EVM | "Arbitrum only" per the meeting | **unknown** | No Solana deployment found. Need the mint and issuer from the team. |
| sDAI | none found on Solana | Sky ships USDS and sUSDS on Solana via Wormhole NTT, not sDAI | Ethereum | **unknown** | Possibly sUSDS was meant. Need the mint from the team. |
| PST | unknown | unknown | "Polygon only" per the meeting | **unknown** | CCIP lists no Solana → Polygon lane; CCTP does have a Polygon domain (7). Need the mint and issuer. |

## Providers

| Provider | Solana program | Instruction | Sender model | Fee | EVM receive |
|---|---|---|---|---|---|
| Circle CCTP v2 | TokenMessengerMinterV2 `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe`, MessageTransmitterV2 `CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC` (same ids on Devnet and mainnet) | `deposit_for_burn { amount, destination_domain, mint_recipient, destination_caller, max_fee, min_finality_threshold }` | Token account owner signs; our bridge signer PDA via `invoke_signed`. A fresh keypair signs as `message_sent_event_data`. | none (standard) or `max_fee` (fast) | USDC minted straight to `mint_recipient`. `LendMirrorTreasury.claimCctp(message, attestation)` calls `receiveMessage` when the route names the treasury as `destination_caller`. Attestation: `https://iris-api-sandbox.circle.com/v2/messages/5?transactionHash=…` (production: `iris-api.circle.com`). |
| Chainlink CCIP | Router `Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C` (Devnet), fee quoter `FeeQPGkKDeRV1MgoYfMH6L8o3KeuYjwUZrgn4LRKfjHi`, RMN `RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7` | `ccip_send(dest_chain_selector, SVM2AnyMessage { receiver, data, token_amounts, fee_token, extra_args }, token_indexes)` | `authority` signs and pays; our bridge signer PDA (must hold no data). Per-token accounts come from the token admin registry and its lookup table. | SOL (native) | Router transfers tokens to the receiver contract, then calls `ccipReceive` with `destTokenAmounts`. `LendMirrorTreasury.ccipReceive` checks router, source selector, and sender. |
| LayerZero OFT | per token | `send { dst_eid, to, amount_ld, min_amount_ld, options, ... }` | token source owner signs | SOL | tokens credited to `to`; `lzCompose` optional | reserved |
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
