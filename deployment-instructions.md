# Deployment instructions

Every command below was run end to end on Devnet → Sepolia on 2026-09-29. Mainnet → Arbitrum uses the same commands with `DEPLOYMENT_TYPE=mainnet`.

Run everything from the repo root, in order. Each task reads the network, keys, RPCs and addresses from `DEPLOYMENT_TYPE` in `.env` and `config/<devnet|mainnet>.ts`.

## 0. Once per terminal

```bash
nvm use 18                                                               # Hardhat and the tasks need Node 18
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH" # Anchor needs the Solana CLI on PATH
set -a && source .env && set +a                                          # only needed for the bare `cast` lines below
```

`.env` needs `DEPLOYMENT_TYPE=devnet` or `mainnet`, plus for that network: `SOLANA_KEYPAIR_PATH_*`, `EVM_PRIVATE_KEY_*`, `RPC_URL_SOLANA_*`, `RPC_URL_EVM_*`. The Solana key must be the program's upgrade authority.

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
cargo test -p lendmirror                    # 39 Rust unit tests
forge test                                  # 21 Solidity tests
npx lm anchor test --skip-build             # 23 tests on a local validator
```

Optional, slower: `SOLANA_TEST_VALIDATOR=<agave 4.2+>/bin/solana-test-validator npm run test:fork` runs custody and a level 2 borrow against cloned Jupiter mainnet accounts.

## 3. Deploy or upgrade the Solana program

```bash
npx lm solana program extend <PROGRAM_ID> 500000     # only if step 1 showed the new .so is bigger than the account
npx lm solana program deploy --program-id target/deploy/lendmirror-keypair.json target/deploy/lendmirror.so --use-rpc --max-sign-attempts 20 --with-compute-unit-price 50000   # upload the program
```

`<PROGRAM_ID>`: Devnet `GQDxkWJhMGppaXExXBC8hGWmfaUv9igo4PKdaLyc53T1`, mainnet `9oySM9Jo4ZEXFcWYFbuPK1FeqwrDr6wmnAmenAybzHqQ`.

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
npx hardhat lz:oapp:solana:set-bridge-route --mint <MINT> --provider ccip             # a Chainlink token (PST on mainnet, CCIP-BnM on Devnet)
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

Mainnet only, with a small position (Jupiter on Devnet is an old build the SDK cannot read):

```bash
npx hardhat lz:oapp:solana:deposit-position-nft --vault-id <V> --nft-id <N>                             # the NFT holder hands the position to the program
npx hardhat lz:oapp:solana:set-wrapper-level --vault-id <V> --nft-id <N> --level 2                     # allow withdraw and borrow
npx hardhat lz:oapp:solana:operate-position --vault-id <V> --nft-id <N> --col 0 --debt <BASE_UNITS>    # borrow into the wrapper's own account
```

## Devnet state after the 2026-09-29 run

| Item | Value |
| --- | --- |
| Store | `4ENeFwbyLWTVs6ikTsi7u3JBw2t6zt9dp8U8XQHArTsz` |
| Bridge signer | `ERZkW7D7pL1FfgRgTYaaYpWZFapq7RBc2d2NGxK4VBxR` |
| Sepolia `LendMirror` implementation | `0xBE499Eb4C9231d308De0C5b4A96225cd984a5BC6` |
| Test wrapper | vault 1 / nft 1, level 1 |

Wrappers created before the V1 seeds (for example vault 1 / nft 29) still refresh and send, but custody, operate and bridge fail on them: they store a signing bump from the old authority seed. Use a new position on Devnet. Mainnet has none of these.

## Do not

- Run bare `solana`, `forge` or `cast send`; they ignore `DEPLOYMENT_TYPE`. Bare `cast storage` and `cast gas-price` are fine because they only read.
- Skip `npm run gen:api` after a build.
- Edit a seed in `programs/lendmirror/src/seeds.rs` once an account exists under it on mainnet; add a `V2` seed.
