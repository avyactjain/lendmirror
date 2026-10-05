# Bridge providers: Solana → EVM

What carries each token from the Solana program to the EVM treasury, and what is verified.
Everything here was checked on 2026-10-01/02: Chainlink's lanes API, the issuers' programs read
on mainnet, real sends decoded, our builders simulated against live mainnet (read-only), and a
real devnet run with PYUSD.

Every route is admin-set (`BridgeRoute`): the destination is never a caller parameter, and
tokens leave only from program-owned accounts. See
`programs/lendmirror/src/instructions/bridge_tokens.rs`.

## The map, verified

| Token  | Solana mint                                                           | Bridge                                                         | Arrives on Arbitrum as                                                    | Status                                                                                                |
| ------ | --------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| USDC   | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`                        | Circle CCTP v2 (`bridge_tokens_cctp`)                          | USDC                                                                      | **Proven on mainnet** (Test Run, 1 USDC)                                                              |
| USDT   | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` (Tether's native mint) | USDT0 "Legacy Mesh" over LayerZero, via `bridge_tokens_lz`     | USD₮0 `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9`, minus 0.03%           | Send simulated clean on live mainnet; fork-proven mechanism                                           |
| USDai  | `USDai5XCUzNebYzUk6EuRiFCvnyoyEdj7VSyijYcz2A` (Token-2022)            | USD.AI's `console_oft` over LayerZero, via `bridge_tokens_lz`  | USDai `0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF` (18 decimals), no fee  | **Fork-proven end to end** (burn + queue); send simulated clean on live mainnet                       |
| sUSDai | `sUSDai6Y3GxysDEtA9BVcEFTaog6UZpYUVxJiMhAKYE` (Token-2022)            | same program as USDai, via `bridge_tokens_lz`                  | sUSDai `0x0B2b2B2076d95dda7817e785989fE353fe955ef9` (18 decimals), no fee | Send simulated clean on live mainnet; same lane shape as USDai                                        |
| PST    | `59obFNBzyTBGowrkif5uK7ojS58vsuWz3ZCvg6tfZAGw`                        | Chainlink CCIP to **Ethereum** (`bridge_tokens_ccip`), planned | PST `0x22aE3D9a738471f405169Af055d31c687087d4c7` on Ethereum              | Needs an Ethereum treasury and a per-route selector in the tasks; the instruction is proven on Devnet |

Why not the obvious rails, checked three ways (Chainlink's APIs, the registries, the chain):

- **Chainlink does not carry USDT, USDai or sUSDai out of Solana at all.** Its Solana→Arbitrum
  lane exists but lists neither. PST it carries only to Ethereum and Arc; PST is on no
  Solana→Arbitrum lane, no LayerZero OFT, no Wormhole deployment, and has no contract on
  Arbitrum. So PST can reach Arbitrum only as USDC.
- **LayerZero carries the other three, but no issuer uses LayerZero's standard OFT program.**
  USDT0's Legacy Mesh and USD.AI's `console_oft` are custom programs with their own account
  lists (decoded from real sends; USD.AI also publishes an IDL on-chain).
- **Our program cannot CPI into them.** Their send already uses all five levels of Solana's
  call-depth budget (issuer → endpoint → message library → executor/verifiers → price feed,
  measured on real transactions). A CPI from us would be level six; Solana allows five.
  SIMD-0268 would raise the limit to 8 but is inactive on every cluster (checked 2026-09-30).

## The same-transaction guard (`bridge_tokens_lz`)

The issuer's send runs as its own instruction, right after ours, in one all-or-nothing
transaction. Our instruction reads the transaction through the instructions sysvar and releases
the tokens to the caller's token account only when the next instruction:

- is the route's issuer program, with the OFT `send` discriminator;
- sends exactly the released amount, to exactly the route's receiver, on the route's lane;
- pulls from the caller's token account, at the account position the route pins (`gas_limit`);
- carries no executor options (the two-byte `0x0003` header counts as none) and no compose;
- keeps `min_amount_ld` within 0.5% of the amount.

Plus: our program must be called top-level (not through another program), and only once per
transaction. If the send fails or is missing, the whole transaction reverts and nothing left
the wrapper; there is no transaction in which the tokens end anywhere but the treasury.
Flash-loan programs use the same sysvar pattern for "the repayment is later in this transaction".

The caller's wallet signs the issuer send and pays the LayerZero fee in SOL (~0.001 SOL
observed). Proven on a local fork of mainnet with the whole LayerZero stack cloned: the happy
path burns the exact amount at call depth 5, and eight tampered pairings are refused
(`tests/fork/bridge-lz.fork.test.ts`).

Each token and destination has a short entry in `config/mainnet.ts` (`lzTokens`): the issuer's
program, the destination id, and how that issuer's program is called. The client works out the
send's 40 to 50 accounts from it (`lib/client/lzSend.ts`): the issuer's own accounts by the rules
of its program (USD.AI's pause, fee and rate-limit records are listed, since USD.AI does not
publish their rule), and LayerZero's accounts with LayerZero's SDK, which reads the issuer's
verifiers and executor from chain. Real sends copied from chain sit in
`tests/fixtures/lz-sends.ts`, and the tests require the built list to equal them account for
account. A wrong entry can only make the send fail, never redirect it: the program re-checks
the program id, amount, destination and source account, and the issuers themselves refuse a
send whose peer, store, escrow or token does not match (checked by simulation on mainnet).

Issuer facts worth knowing (read from the mints and stores):

- USDai and sUSDai are Token-2022 mints whose issuer keeps a permanent delegate (it can move or
  burn tokens in any account), a pause switch, and a transfer-hook slot (currently unset).
  Route caps stay low on purpose. Outbound rate limit ~10M per hour per token, shared.
- USDT0 locks native USDT in its escrow; its per-lane credit ledger caps outbound volume
  (~294k USDT to Arbitrum at read time). The 0.03% fee is taken on Arbitrum at release.
- USDT0 publishes no IDL; its builder comes from a decoded real send and is pinned by tests and
  verified by live simulation. USDT goes last in testing for exactly this reason.

## PST: Chainlink to Ethereum

Chainlink carries PST from Solana to Ethereum and Arc only. The decision is to accept Ethereum: deploy a second `LendMirrorTreasury` there, wire it (`treasury:set-ccip-route`, `treasury:set-strategy`), and write a PST route with `dst_chain_id = 1`, Chainlink's Ethereum selector `5009297550715157269`, and that treasury as receiver. `bridge_tokens_ccip` needs no change; the tasks need to take the selector from the chosen chain instead of the profile's Arbitrum one. A swap-into-USDC path was built and removed: it would have let an operator sell any wrapper asset at a price of their choosing.

## Providers

| Provider                    | Solana program                                                                                              | How we drive it                                                                                   | Fee                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------- |
| Circle CCTP v2              | TokenMessengerMinterV2 `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe`                                       | CPI (`bridge_tokens_cctp`), bridge signer PDA signs                                               | none standard, `max_fee` fast |
| Chainlink CCIP              | Router `Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C`                                                       | CPI (`bridge_tokens_ccip`), bridge signer PDA signs and pays                                      | SOL                           |
| LayerZero (issuer programs) | USDT0 `Fuww9mfc8ntAwxPUzFia7VJFAdvLppyZwhPJoXySZXf7`, USD.AI `BQ7nDFGKN4cYqmBkMXFCEzk3zPJhR6bNK9Maf8sQXrQm` | same-transaction guard (`bridge_tokens_lz`); the caller's wallet signs the issuer's send and pays | SOL, ~0.001 observed          |
| Wormhole NTT                | —                                                                                                           | reserved (`PROVIDER_WORMHOLE_NTT = 4`), nothing implements it                                     | —                             |

## Chain ids and selectors used by routes

| Destination      | EVM chain id (route key) | CCTP domain | CCIP selector        | LayerZero eid |
| ---------------- | ------------------------ | ----------- | -------------------- | ------------- |
| Ethereum Sepolia | 11155111                 | 0           | 16015286601757825753 | 40161         |
| Ethereum         | 1                        | 0           | 5009297550715157269  | 30101         |
| Arbitrum One     | 42161                    | 3           | 4949039107694359620  | 30110         |
| Base             | 8453                     | 6           | 15971525489660198786 | 30184         |
| Polygon          | 137                      | 7           | 4051577828743386545  | 30109         |

For a LayerZero route, the route's `domain_or_selector` holds the eid and `gas_limit` holds the
token-source position in the issuer's send (USD.AI 9, USDT0 4).
