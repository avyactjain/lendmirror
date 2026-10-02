# Deployment instructions

Every command below was run end to end on Devnet → Sepolia on 2026-09-29. Mainnet → Arbitrum uses the same commands with `DEPLOYMENT_TYPE=mainnet`.

Run everything from the repo root, in order. Each task reads the network, keys, RPCs and addresses from `DEPLOYMENT_TYPE` in `.env` and `config/<devnet|mainnet>.ts`.

## 0. Once per terminal

```bash
nvm use 18                                                               # Hardhat and the tasks need Node 18
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH" # Anchor needs the Solana CLI on PATH
set -a && source .env && set +a                                          # only needed for the bare `cast` lines below
```

`.env` needs `DEPLOYMENT_TYPE=devnet` or `mainnet`, plus for that network: `SOLANA_KEYPAIR_PATH_*`, `EVM_PRIVATE_KEY_*`, `RPC_URL_SOLANA_*`, `RPC_URL_EVM_*`. The Solana key must be the program's upgrade authority. To run one command against the other network without editing the file, put `DEPLOYMENT_TYPE=devnet` (or `mainnet`) in front of it; a variable already set in the shell wins over `.env`. Hardhat also insists that the Arbitrum network has a URL, so with mainnet lines removed, pass a placeholder `RPC_URL_EVM_MAINNET=https://arb1.arbitrum.io/rpc` the same way.

## 1. Estimate the cost

```bash
npx lm solana rent $(wc -c < target/deploy/lendmirror.so)   # SOL the program account must hold (run after step 2)
npx lm solana program show <PROGRAM_ID>                     # current size and balance; an upgrade only pays for growth
npx lm solana balance                                       # your SOL
```

On 2026-09-29 the program was 730,272 bytes: 3.71 SOL of rent. The mainnet program account holds 1.71 SOL, so the upgrade costs about 2.0 SOL, and the deploy parks another 3.71 SOL in a temporary buffer that is refunded at the end. Hold about 6 SOL.

```bash
cast gas-price --rpc-url $RPC_URL_EVM_MAINNET               # wei per gas on Arbitrum
```

EVM gas measured on Sepolia: `LendMirror` implementation 3.2M, treasury implementation 1.3M, each proxy 0.3M, each configuration call under 0.1M. Multiply by the gas price.

## 2. Build and test

```bash
npx lm build -- --features no-log-ix-name   # compile the Solana program for this network's program id
npm run gen:api                             # regenerate the TypeScript client from the new IDL (always after a build)
npx hardhat compile                         # compile the EVM contracts
cargo test -p lendmirror                    # 49 Rust unit tests
forge test                                  # 21 Solidity tests
npx lm anchor test --skip-build             # 30 tests on a local validator
npx hardhat test tests/lz-send.test.ts      # 8 tests: the LayerZero send builders against real mainnet and devnet sends
```

Optional, slower: `SOLANA_TEST_VALIDATOR=<agave 4.2+>/bin/solana-test-validator npm run test:fork` runs 23 tests: custody, supply, borrow, payback, withdraw and release on smart vault 95, then the LayerZero pairing (our release + USD.AI's real send, and eight refused tamperings) against cloned mainnet accounts. It funds the test wallet at genesis, so it needs no faucet. It needs a build stamped with the local test id: `LENDMIRROR_ID=GQDxkWJhMGppaXExXBC8hGWmfaUv9igo4PKdaLyc53T1 anchor build -p lendmirror -- --features no-log-ix-name`, then rebuild for your network before deploying.

## 3. Deploy or upgrade the Solana program

```bash
npx lm solana program extend <PROGRAM_ID> 500000     # only if step 1 showed the new .so is bigger than the account
npx lm solana program deploy --program-id <PROGRAM_ID> target/deploy/lendmirror.so --use-rpc --max-sign-attempts 100 --with-compute-unit-price 300000   # upgrade the existing program in place
```

Pass the program id as an address, never `target/deploy/lendmirror-keypair.json`. That keypair is the Devnet program's; on mainnet it would create a second program at the Devnet address instead of upgrading yours. Mainnet drops uploads sent with a low priority fee ("Max retries exceeded"); if a deploy stops halfway, `npx lm solana program close --buffers` refunds the SOL parked in the half-written buffer, then rerun.

`<PROGRAM_ID>`: Devnet `GQDxkWJhMGppaXExXBC8hGWmfaUv9igo4PKdaLyc53T1`, mainnet `9oySM9Jo4ZEXFcWYFbuPK1FeqwrDr6wmnAmenAybzHqQ`.

Publish the IDL so explorers decode the program's accounts and instructions. `anchor build` writes the `address` field as the `declare_id!` expression text, so upload a copy with the real id:

```bash
node -e "const i=require('./target/idl/lendmirror.json');i.address='<PROGRAM_ID>';require('fs').writeFileSync('target/idl/lendmirror.onchain.json',JSON.stringify(i))"   # copy with the real program id
npx lm anchor idl init <PROGRAM_ID> --filepath target/idl/lendmirror.onchain.json --priority-fee 300000 --provider.cluster "$RPC_URL_SOLANA_MAINNET" --provider.wallet "$SOLANA_KEYPAIR_PATH_MAINNET"   # first time
npx lm anchor idl upgrade <PROGRAM_ID> --filepath target/idl/lendmirror.onchain.json --priority-fee 300000 --provider.cluster "$RPC_URL_SOLANA_MAINNET" --provider.wallet "$SOLANA_KEYPAIR_PATH_MAINNET"   # after every later program upgrade
npx lm anchor idl fetch <PROGRAM_ID> --provider.cluster "$RPC_URL_SOLANA_MAINNET" | head -c 200   # check: starts with the program id
```

The upgrade authority pays: rent for the compressed IDL (a fraction of a SOL) plus one transaction per 600-byte chunk. Use the Devnet variables for Devnet.

## 4. Deploy or upgrade the EVM contracts

The `LendMirror` proxy already exists on both networks (Sepolia `0xbE4c…`, Arbitrum `0xb42E…`), so upgrade it:

```bash
npx lm forge create contracts/LendMirror.sol:LendMirror --broadcast --constructor-args <LZ_ENDPOINT>   # deploy the new implementation; copy "Deployed to"
npx lm cast send <PROXY> "upgradeToAndCall(address,bytes)" <NEW_IMPLEMENTATION> 0x                     # point the proxy at it
cast storage <PROXY> 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc --rpc-url $RPC_URL_EVM_MAINNET   # must print the new implementation
```

`<LZ_ENDPOINT>`: Sepolia `0x6EDCE65403992e310A62460808c4b910D972f10f`, Arbitrum `0x1a44076050125825900e736c501f859c50fE728c`. Put the new implementation into `config/<type>.ts` → `evmImplementation`.

The treasury does not exist on Arbitrum yet:

```bash
npx hardhat deploy --tags LendMirrorTreasury   # deploy the treasury proxy; put the printed address into config/<type>.ts → treasury
```

Verify the source on the explorer so its pages decode calls and show the code. Needs `ETHERSCAN_API_KEY` in `.env` (one Etherscan key covers Arbiscan and Sepolia) and the Hardhat 2 line of the plugin, `npm install --save-dev @nomicfoundation/hardhat-verify@^2` (version 3 is for Hardhat 3 and fails with an ESM error). If the command stalls after "Successfully submitted", the source matched; rerun it or check the explorer page. Manual fallback: upload `artifacts/<Contract>.standard-input.json`, written from `artifacts/contracts/<Contract>.sol/<Contract>.dbg.json`'s build info, as "Solidity (Standard-Json-Input)".

```bash
npx hardhat verify --network arbitrum <LENDMIRROR_IMPLEMENTATION> <LZ_ENDPOINT>   # LendMirror implementation; the constructor arg is the LayerZero endpoint
npx hardhat verify --network arbitrum <TREASURY_IMPLEMENTATION>                  # treasury implementation, no constructor args
```

The proxies are OpenZeppelin's `ERC1967Proxy`, which the explorer matches on its own. On each proxy's page use "More Options → Is this a proxy?" so "Read/Write as Proxy" shows the implementation's functions.

Do not use `lz:deploy` on a network that already has the proxy. It trusts its local records, deploys an implementation, skips the upgrade, and still prints success.

## 5. Initialize

```bash
npx hardhat lz:oapp:solana:create                                                     # create the Store PDA and register it with LayerZero
npx hardhat lz:oapp:solana:init-config --ci --oapp-config layerzero.config.ts          # create LayerZero's send-library accounts for the EVM chain
npx hardhat lz:oapp:solana:set-peer                                                   # Solana: the EVM proxy is our peer
npx hardhat lz:oapp:evm:set-peer                                                      # EVM: the new Store is our peer
npx hardhat lz:oapp:solana:get-peer                                                   # check: prints the EVM proxy
npx hardhat lz:oapp:solana:set-snapshotters --keys <PUBKEY>                           # wallets allowed to wrap and refresh (comma-separated, up to 8)
npx hardhat lz:oapp:solana:set-senders --keys <PUBKEY>                                # wallets allowed to send and bridge (comma-separated, up to 8)
npx hardhat lz:oapp:solana:set-ccip-route                                             # Solana: Chainlink router and EVM receiver for snapshots
npx hardhat lz:oapp:evm:set-ccip-route                                                # EVM: accept Chainlink snapshots from our bridge signer
npx hardhat lz:oapp:evm:treasury:set-ccip-route                                       # treasury: accept Chainlink tokens from our bridge signer
npx hardhat lz:oapp:evm:treasury:set-cctp-transmitter                                 # treasury: Circle's contract for USDC claims
npx hardhat lz:oapp:evm:treasury:set-strategy --token <ERC20> --strategy <ADDRESS>    # treasury: where each token is forwarded (one per token)
npx hardhat lz:oapp:solana:set-bridge-route --mint usdc --provider cctp               # USDC goes over Circle to the treasury
npx hardhat lz:oapp:solana:set-bridge-route --mint <MINT> --provider ccip             # a Chainlink token (CCIP-BnM on Devnet)
npx hardhat lz:oapp:solana:set-bridge-route --mint USDai --provider oft --max-amount 1000000    # a LayerZero token; the lane comes from config lzTokens (also: sUSDai, USDT)
npx hardhat lz:oapp:solana:create-lookup-table                                        # pack the fixed accounts so sends fit in one transaction
```

`lz:oapp:solana:create` also writes `deployments/solana-<net>/OApp.json`; commit it. `set-bridge-route` defaults to the treasury as receiver and to Sepolia or Arbitrum as destination.

## 6. Verify

```bash
npx hardhat lz:oapp:solana:wrap-position --vault-id <V> --nft-id <N>                                   # create the wrapper for one Jupiter position
npx hardhat lz:oapp:solana:refresh-wrapper --vault-id <V> --nft-id <N>                                 # read the position from Jupiter
npx hardhat lz:oapp:solana:send-position-snapshot-via-chainlink-and-lz --vault-id <V> --nft-id <N>     # send it over LayerZero and Chainlink
npx hardhat lz:oapp:evm:match --all                                                                    # after a few minutes: both copies arrived and match
npx hardhat lz:oapp:solana:set-wrapper-level --vault-id <V> --nft-id <N> --level 1                     # allow deposit, payback, and bridging
npx hardhat lz:oapp:solana:fund-authority-token --vault-id <V> --nft-id <N> --mint <MINT> --amount <BASE_UNITS>   # put test tokens in the wrapper
npx hardhat lz:oapp:solana:bridge-tokens --vault-id <V> --nft-id <N> --mint <MINT> --amount <BASE_UNITS>          # bridge them to the treasury
npx hardhat lz:oapp:evm:treasury:claim-cctp --tx-hash <SOLANA_SIGNATURE>                              # USDC only, about 15 minutes later
npx hardhat lz:oapp:evm:treasury:forward --token <ERC20>                                               # move the treasury balance to the strategy
```

A LayerZero token (USDT, USDai, sUSDai): same `bridge-tokens` call. The task sends two
instructions — our release, then the issuer's own send — and the wallet pays the LayerZero fee
(~0.001 SOL). Always dry-run first; it builds and simulates everything and sends nothing:

```bash
npx hardhat lz:oapp:solana:bridge-tokens --vault-id <V> --nft-id <N> --mint USDai --amount 1000000 --dry-run   # simulate: logs, size, compute
npx hardhat lz:oapp:solana:bridge-tokens --vault-id <V> --nft-id <N> --mint USDai --amount 1000000             # the real send; watch it on layerzeroscan.com
npx hardhat lz:oapp:evm:treasury:forward --token <ERC20_ON_ARBITRUM>                                           # after delivery (minutes)
```

The treasury needs a strategy per arriving token first (`treasury:set-strategy`); the Arbitrum
addresses are in `config/mainnet.ts` under `lzTokens[].evmToken`. USDai and sUSDai arrive with
18 decimals there, USD₮0 with 6.

PST: swap it into USDC inside the program (admin/sender only), then bridge the USDC as usual:

```bash
npx hardhat lz:oapp:solana:swap-to-usdc --vault-id <V> --nft-id <N> --mint PST --amount 1000000 --dry-run   # quote + simulate, nothing sent
npx hardhat lz:oapp:solana:swap-to-usdc --vault-id <V> --nft-id <N> --mint PST --amount 1000000             # the swap; USDC lands in the wrapper
npx hardhat lz:oapp:solana:bridge-tokens --vault-id <V> --nft-id <N> --mint usdc --amount <USDC_OUT>        # Circle, as in the Test Run
```

Mainnet only, with a small position (Jupiter on Devnet is an old build the SDK cannot read):

```bash
npx hardhat lz:oapp:solana:deposit-position-nft --vault-id <V> --nft-id <N>                             # the NFT holder hands the position to the program
npx hardhat lz:oapp:solana:set-wrapper-level --vault-id <V> --nft-id <N> --level 1                     # allow supply and payback
npx hardhat lz:oapp:solana:fund-authority-token --vault-id <V> --nft-id <N> --mint <MINT> --amount <BASE_UNITS>   # tokens to supply
npx hardhat lz:oapp:solana:operate-position --vault-id <V> --nft-id <N> --col-action supply --col-token1 <BASE_UNITS>   # supply pool token1 as smart collateral
npx hardhat lz:oapp:solana:set-wrapper-level --vault-id <V> --nft-id <N> --level 2                     # allow withdraw and borrow
npx hardhat lz:oapp:solana:operate-position --vault-id <V> --nft-id <N> --debt-action borrow --debt-amount <BASE_UNITS>  # borrow into the wrapper's own account
npx hardhat lz:oapp:solana:release-position-nft --vault-id <V> --nft-id <N>                            # admin: NFT back to the wrapper owner
```

`operate-position` works on smart vaults only (Jupiter T2, T3, T4). Smart legs take `--col-token0/1` or `--debt-token0/1`, normal legs `--col-amount` or `--debt-amount`. It sends two transactions: Jupiter's setup, then the operate.

## Devnet state after the 2026-09-29 run

| Item                                | Value                                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------- |
| Store                               | `4ENeFwbyLWTVs6ikTsi7u3JBw2t6zt9dp8U8XQHArTsz`                                               |
| Bridge signer                       | `ERZkW7D7pL1FfgRgTYaaYpWZFapq7RBc2d2NGxK4VBxR`                                               |
| Sepolia `LendMirror` implementation | `0xBE499Eb4C9231d308De0C5b4A96225cd984a5BC6`                                                 |
| Wrapper vault 1 / nft 29            | `YAmfx4EXUg6geGkGALEWMxrDWtiDNWafuHSZprzabBr`, level 1 since 2026-10-02                      |
| PYUSD route (LayerZero → Sepolia)   | `FDQpQiT8bKgYkpm2MzxH9rTUYeTTbZP7X5GiZcDW7ybk`, cap 2 PYUSD, receiver = the Sepolia treasury |
| Sepolia treasury strategy for PYUSD | `0x9Dee2100Cb47734A7a629Db0a1B061Df865a9c87` (tx `0x133dce7d…`)                              |

Wrappers created before the seed module (under `LendMirrorWrapperV1`) are left behind. The same vault and nft now get a fresh wrapper under `LendMirrorPositionWrapperV1`.

### Devnet LayerZero rehearsal (2026-10-02)

The two-instruction bridge ran for real on devnet with PayPal's test PYUSD (public faucet at
faucet.paxos.com; mint `CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM`, Token-2022), through
Paxos's standard-OFT program to the Sepolia treasury. In order, after the program upgrade
(slot 506593883) and a fresh IDL (`anchor idl close` then `init`: the old IDL account was too
small and Anchor 0.31 has no resize):

```bash
npx hardhat lz:oapp:solana:set-bridge-route --mint PYUSD --provider oft --max-amount 2000000                          # route FDQpQiT8…
npx hardhat lz:oapp:solana:fund-authority-token --vault-id 1 --nft-id 29 --mint CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM --amount 2000000
npx hardhat lz:oapp:solana:set-wrapper-level --vault-id 1 --nft-id 29 --level 1
npx hardhat lz:oapp:solana:bridge-tokens --vault-id 1 --nft-id 29 --mint PYUSD --amount 1000000 --dry-run   # 1,085 bytes, 351k CU, every step ok
npx hardhat lz:oapp:solana:bridge-tokens --vault-id 1 --nft-id 29 --mint PYUSD --amount 1000000             # tx 4sqEyPrn…: wrapper 2 → 1, wallet unchanged, depth 5
npx hardhat lz:oapp:evm:treasury:set-strategy --network sepolia --token 0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9 --strategy 0x9Dee2100Cb47734A7a629Db0a1B061Df865a9c87
npx hardhat lz:oapp:evm:treasury:forward --network sepolia --token 0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9             # after delivery (~10 min, Sepolia tx 0x3da16658…): tx 0xaa578945…
```

The guard was then shown refusing on the live network, with the wrapper's balance untouched
(`--tamper amount|receiver|no-send` builds a deliberately wrong pairing; the program answers
`MissingBridgeSend`, error 6023, and the transaction never lands):

```bash
npx hardhat lz:oapp:solana:bridge-tokens --vault-id 1 --nft-id 29 --mint PYUSD --amount 1000000 --tamper amount      # send one unit less than released
npx hardhat lz:oapp:solana:bridge-tokens --vault-id 1 --nft-id 29 --mint PYUSD --amount 1000000 --tamper receiver    # send somewhere else
npx hardhat lz:oapp:solana:bridge-tokens --vault-id 1 --nft-id 29 --mint PYUSD --amount 1000000 --tamper no-send     # release with no send
```

`.env` here held only devnet credentials with `DEPLOYMENT_TYPE=mainnet`; every command ran with
`DEPLOYMENT_TYPE=devnet` in front (dotenv never overrides a set variable). Hardhat still wants
the Arbitrum network URL defined, so a placeholder `RPC_URL_EVM_MAINNET` was passed.

## Do not

- Run bare `solana`, `forge` or `cast send`; they ignore `DEPLOYMENT_TYPE`. Bare `cast storage` and `cast gas-price` are fine because they only read.
- Skip `npm run gen:api` after a build.
- Edit a seed in `programs/lendmirror/src/seeds.rs` once an account exists under it on mainnet; add a `V2` seed.
