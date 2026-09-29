# Deployment instructions

From a clean checkout to a working deployment: build, test, deploy, initialize, verify. The same commands serve Devnet and mainnet; `DEPLOYMENT_TYPE` in `.env` picks the network, keys, RPCs, and addresses.

Every PDA seed ends in `V1` (`programs/lendmirror/src/seeds.rs`). A deployment on these seeds starts from empty state: the Store, peers, routes, and wrappers are all created by the steps below. Accounts written by earlier builds are ignored.

## 0. Setup

### Tools

| Tool | Version | Check |
| --- | --- | --- |
| Node | 18 (`nvm use 18`) | `node -v` |
| Rust | 1.84 (pinned; do not `cargo update`) | `rustc --version` |
| Anchor | 0.31.1 | `anchor --version` |
| Solana CLI | 2.1.x for building | `solana --version` |
| Foundry | any recent | `forge --version` |

Anchor needs the Solana toolchain on `PATH`, or it tries to download one and fails:

```bash
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
```

### `.env`

```bash
DEPLOYMENT_TYPE=devnet   # or mainnet
```

| Variable | Used when | Purpose |
| --- | --- | --- |
| `SOLANA_KEYPAIR_PATH_DEVNET` / `_MAINNET` | matching type | Solana wallet: upgrade authority, admin, snapshotter, sender |
| `EVM_PRIVATE_KEY_DEVNET` / `_MAINNET` | matching type | EVM owner of the proxy and the treasury |
| `RPC_URL_SOLANA_DEVNET` / `_MAINNET` | matching type | Solana RPC (mainnet also feeds the fork test) |
| `RPC_URL_EVM_DEVNET` / `_MAINNET` | matching type | Sepolia or Arbitrum RPC |

`npx lm` and Hardhat read `.env` themselves. For shell expansions (`$RPC_URL_EVM_DEVNET`), export it:

```bash
set -a && source .env && set +a
```

Use `npx lm <solana|forge|cast|anchor>` for anything that writes: it injects the profile's RPC and key. Bare `solana`, `forge`, `cast` ignore `DEPLOYMENT_TYPE`.

### Wallets and funds

- Solana wallet: enough SOL for the program deploy (see the estimate below) plus fees. It must be the program's upgrade authority.
- EVM wallet: ETH for two proxy deployments and a few configuration transactions.
- For the bridge checks: a little of the token you will bridge (Devnet: USDC from Circle's faucet, CCIP-BnM from Chainlink's faucet).

### Estimate the cost

Solana. The program lives in a data account that must hold rent for its size. Run after step 1 (the `.so` must exist):

```bash
SO=$(stat -f %z target/deploy/lendmirror.so)     # Linux: stat -c %s
npx lm solana rent $SO                            # rent the program account needs for this size
npx lm solana program show <PROGRAM_ID>           # upgrade only: current "Data Length" and "Balance"
```

- First deploy: the wallet pays that rent once. During the deploy the CLI also fills a buffer account of the same size, refunded when the deploy finishes, so hold about twice the rent at that moment.
- Upgrade: free if the new `.so` fits in "Data Length". If it is bigger, `extend` charges the difference between the rent for the new size and the current balance. The buffer is again temporary.
- Measured 2026-09-29: the `.so` is 730,272 bytes, rent 3.71 SOL. The mainnet program account holds 335,976 bytes and 1.71 SOL, so the upgrade needs about 2.0 SOL for `extend` plus 3.71 SOL parked in the buffer until it completes.

EVM. Gas for a contract creation, times the current gas price. `npx lm cast estimate` does not work (the wrapper puts `--rpc-url` after `--create`), so this one uses bare `cast` with the RPC from `.env`; it only reads.

```bash
set -a && source .env && set +a
RPC=$RPC_URL_EVM_DEVNET                           # or $RPC_URL_EVM_MAINNET
BYTECODE=$(forge inspect contracts/LendMirror.sol:LendMirror bytecode)
ARGS=$(cast abi-encode "constructor(address)" <LZ_ENDPOINT>)
cast estimate --rpc-url $RPC --create "${BYTECODE}${ARGS#0x}"                          # gas, LendMirror implementation
cast estimate --rpc-url $RPC --create "$(forge inspect contracts/LendMirrorTreasury.sol:LendMirrorTreasury bytecode)"   # gas, treasury implementation
cast gas-price --rpc-url $RPC                                                          # wei per gas
```

Cost in ETH = gas × price ÷ 10^18 (`cast --to-unit <gas*price> ether`). Each proxy is a separate creation on top of its implementation. Gas seen on Sepolia:

| Creation | Gas |
| --- | --- |
| `LendMirror` implementation | 3,200,050 (estimate for the current build; the earlier, smaller build used 2,021,446) |
| `LendMirror` proxy | 284,039 |
| `LendMirrorTreasury` implementation | 1,297,172 |
| `LendMirrorTreasury` proxy | 334,413 |

Configuration calls (peers, routes, strategies) are ordinary transactions, well under 100,000 gas each. Arbitrum gas prices are usually far below Ethereum's, so the full mainnet EVM side costs a fraction of an ETH; run the commands above on deploy day for the number.

## 1. Build

```bash
npx lm build -- --features no-log-ix-name
npm run gen:api
npx hardhat compile
```

`build` compiles the program with `LENDMIRROR_ID` set to the profile's program id. `gen:api` rewrites `lib/client/generated` from `target/idl/lendmirror.json`; run it after every build or the tasks send stale account lists. `compile` refreshes the EVM ABIs.

## 2. Tests

Run all of these before a deploy. Each one takes a few seconds unless noted.

```bash
cargo test -p lendmirror                                   # 39 unit tests: seeds, codecs, level policy, send guard, bridge bytes
cd crates/jup-tick-parity && cargo test && cd -            # tick math vs Jupiter's Rust SDK
forge test                                                 # 21: LendMirror, treasury, codec
RPC_URL_SOLANA_MAINNET= npx lm anchor test --skip-build    # 23: local validator, LayerZero endpoint cloned from Devnet (needs Devnet RPC access)
npm run test:jup-live                                      # live read vs Jupiter's SDK (needs RPC_URL_SOLANA_MAINNET)
```

Fork test, the only one that proves custody and a level 2 borrow against real Jupiter accounts. Needs an Agave 4.2+ `solana-test-validator` (download from github.com/anza-xyz/agave/releases) and takes several minutes to clone mainnet accounts:

```bash
SOLANA_TEST_VALIDATOR=/path/to/solana-release/bin/solana-test-validator npm run test:fork
```

`anchor test` loads the program as upgradeable with the test wallet as authority (`Anchor.toml [[test.genesis]]`), which `init_store` requires.

## 3. Deploy the Solana program

First deploy of a program id:

```bash
npx lm solana program deploy \
  --program-id target/deploy/lendmirror-keypair.json \
  target/deploy/lendmirror.so \
  --use-rpc --max-sign-attempts 20 --with-compute-unit-price 50000
```

Upgrade of an existing program id: the same command. If the new `.so` is larger than the on-chain account (`npx lm solana program show <id>` prints the length; the deploy fails with "account data too small"), extend first:

```bash
npx lm solana program extend <PROGRAM_ID> 250000
```

The wallet in `.env` must be the upgrade authority. The program id is `config/<type>.ts` → `programId`.

## 4. Deploy the EVM contracts

### LendMirror (snapshot receiver)

New proxy (no proxy on this network yet):

```bash
npx hardhat lz:deploy --ci
```

Writes `deployments/<evmNetwork>/LendMirror.json`. Put the proxy address into `config/<type>.ts` → `evmProxy`.

Upgrade of an existing proxy (Arbitrum today runs the old 200-byte format and must be upgraded before any send):

```bash
npx lm forge create contracts/LendMirror.sol:LendMirror --broadcast --constructor-args <LZ_ENDPOINT>
npx lm cast send <PROXY> "upgradeToAndCall(address,bytes)" <NEW_IMPLEMENTATION> 0x
```

`<LZ_ENDPOINT>` is `config/<type>.ts` → `lzEndpoint` (Sepolia `0x6EDCE65403992e310A62460808c4b910D972f10f`, Arbitrum `0x1a44076050125825900e736c501f859c50fE728c`). Record the implementation in `evmImplementation`.

### LendMirrorTreasury (token receiver)

```bash
npx hardhat deploy --tags LendMirrorTreasury
```

The network comes from the profile (`sepolia` or `arbitrum`). Put the printed proxy address into `config/<type>.ts` → `treasury`.

## 5. Initialize on the V1 seeds

Order matters: each step needs the account the previous one created.

### 5.1 Store

```bash
npx hardhat lz:oapp:solana:create
```

Creates the Store PDA (`["LendMirrorStoreV1"]`), registers it with the LayerZero endpoint, and writes `deployments/solana-<net>/OApp.json`. The signer must be the upgrade authority. The address is deterministic, and `config/<type>.ts` → `store` already holds it.

### 5.2 LayerZero wiring

```bash
npx hardhat lz:oapp:solana:init-config --oapp-config layerzero.config.ts
npx hardhat lz:oapp:solana:set-peer
npx hardhat lz:oapp:evm:set-peer
npx hardhat lz:oapp:solana:get-peer
```

`init-config` creates the send-library accounts for the destination eid. `set-peer` on Solana stores the EVM proxy; on EVM it stores the new Store. `get-peer` should print the proxy.

### 5.3 Allowlists

```bash
npx hardhat lz:oapp:solana:set-snapshotters --keys <pubkey,pubkey>
npx hardhat lz:oapp:solana:set-senders --keys <pubkey,pubkey>
```

Snapshotters read Jupiter and wrap positions. Senders send snapshots and bridge from any wrapper. Up to 8 each.

### 5.4 Chainlink snapshot route

```bash
npx hardhat lz:oapp:solana:set-ccip-route
npx hardhat lz:oapp:evm:set-ccip-route
```

Solana side: router, fee quoter, RMN, destination selector, and the EVM proxy as receiver, all from the profile. EVM side: allows the CCIP router and the bridge signer PDA (`["LendMirrorCcipPayerV1"]`, `config` → `ccip.payer`) to deliver.

### 5.5 Treasury

```bash
npx hardhat lz:oapp:evm:treasury:set-cctp-transmitter
npx hardhat lz:oapp:evm:treasury:set-ccip-route
npx hardhat lz:oapp:evm:treasury:set-strategy --token <ERC20> --strategy <address>
```

One `set-strategy` per token you will bridge. Forwarding is impossible for a token with no strategy, so nothing is lost if a step is skipped; the tokens wait in the treasury.

### 5.6 Bridge routes

```bash
npx hardhat lz:oapp:solana:set-bridge-route --mint usdc --provider cctp
npx hardhat lz:oapp:solana:set-bridge-route --mint <mint> --provider ccip
npx hardhat lz:oapp:solana:set-bridge-route --mint <mint> --provider oft --oft-program <id> --escrow <account> --dst-eid <eid>
```

One route per (token, chain). `--receiver` defaults to the profile treasury; `--max-amount` caps one transaction (default 1,000,000,000 base units). `docs/bridge-providers.md` says which provider each of the five tokens uses.

### 5.7 Lookup table

```bash
npx hardhat lz:oapp:solana:create-lookup-table
```

Collects every fixed account the sends use (Store, peer, LayerZero endpoint settings, the Chainlink route's programs and LINK mint) so the transactions fit. Rerun it after any wiring change; it extends the existing table. Token bridges add Chainlink's own per-token table at send time.

## 6. Verify

### 6.1 Mirror a position

```bash
npx hardhat lz:oapp:solana:wrap-position --vault-id <V> --nft-id <N>
npx hardhat lz:oapp:solana:refresh-wrapper --vault-id <V> --nft-id <N>
npx hardhat lz:oapp:solana:send-position-snapshot-via-chainlink-and-lz --vault-id <V> --nft-id <N>
npx hardhat lz:oapp:evm:match --position <POSITION>
```

`match` prints "match" once both LayerZero and Chainlink have delivered (LayerZero within a minute or two, Chainlink a few minutes). A second send without a refresh fails with `SnapshotAlreadySent`. For every wrapper at once: `lz:oapp:solana:sync-all-positions` (`--dry-run` first).

### 6.2 Custody and operate

```bash
npx hardhat lz:oapp:solana:deposit-position-nft --vault-id <V> --nft-id <N>
npx hardhat lz:oapp:solana:set-wrapper-level --vault-id <V> --nft-id <N> --level 1
npx hardhat lz:oapp:solana:fund-authority-token --vault-id <V> --nft-id <N> --mint <collateral mint> --amount <base units>
npx hardhat lz:oapp:solana:operate-position --vault-id <V> --nft-id <N> --col <base units> --debt 0
npx hardhat lz:oapp:solana:set-wrapper-level --vault-id <V> --nft-id <N> --level 2
npx hardhat lz:oapp:solana:operate-position --vault-id <V> --nft-id <N> --col 0 --debt <base units>
```

The NFT holder runs `deposit-position-nft` and becomes the wrapper owner. Collateral must sit in the wrapper authority's token account before a deposit. Jupiter on Devnet is an old build the SDK cannot decode, so `operate-position` only works on mainnet (proven on the fork test). Start with a small position.

### 6.3 Bridge tokens

```bash
npx hardhat lz:oapp:solana:bridge-tokens --vault-id <V> --nft-id <N> --mint usdc --amount 1000000
npx hardhat lz:oapp:evm:treasury:claim-cctp --tx-hash <solana signature>        # Circle only, after the attestation (~15 min standard)
npx hardhat lz:oapp:evm:treasury:forward --token <ERC20>
```

Chainlink and LayerZero routes need no claim: the tokens appear in the treasury when the network delivers. Check the treasury balance, then `forward`; the strategy address receives it.

## 7. Mainnet

Same commands with `DEPLOYMENT_TYPE=mainnet`. Before starting, fill `config/mainnet.ts`, which today has `ccip: null`, `cctp: null`, `treasury: ''`.

| Field | Value | Source |
| --- | --- | --- |
| `ccip.router` | `Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C` | Chainlink directory, Solana mainnet |
| `ccip.feeQuoter` | `FeeQPGkKDeRV1MgoYfMH6L8o3KeuYjwUZrgn4LRKfjHi` | same |
| `ccip.rmnRemote` | `RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7` | same |
| `ccip.linkMint` | `LinkhB3afbBKb2EQQu7s7umdZceV3wcvAUJhQAfQ23L` | Chainlink directory, LINK on Solana |
| `ccip.sourceChainSelector` | `124615329519749607` | Solana mainnet selector |
| `ccip.destChainSelector` | `4949039107694359620` | Arbitrum One selector |
| `ccip.evmRouter` | `0x141fa059441E0ca23ce184B6A78bafD2A517DdE8` | Chainlink directory, Arbitrum One |
| `ccip.gasLimit` | `600_000` | same as Devnet |
| `ccip.payer` | `D6RLag1KgbK8Fe8URR2zXFaZXKBnnx6tLPuL1sUuaLNG` | PDA `["LendMirrorCcipPayerV1"]` under the mainnet program |
| `cctp.tokenMessengerMinter` | `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe` | Circle, same on Devnet and mainnet |
| `cctp.messageTransmitter` | `CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC` | same |
| `cctp.usdcMint` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | USDC on Solana mainnet |
| `cctp.evmDomain` | `3` | Circle domain of Arbitrum |
| `cctp.solanaDomain` | `5` | Circle domain of Solana |
| `cctp.evmMessageTransmitter` | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` | Circle, MessageTransmitterV2 on Arbitrum |
| `cctp.attestationApi` | `https://iris-api.circle.com` | Circle production API |
| `treasury` | printed by step 4 | |

Check the Chainlink values against docs.chain.link/ccip/directory/mainnet on the day you deploy. The Solana → Arbitrum lane was listed there on 2026-09-29. Chainlink values for Ethereum mainnet, if the destination changes: router `0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D`, selector `5009297550715157269`.

Mainnet order:

1. Build and run every test (steps 1 and 2).
2. Upgrade the Solana program (step 3). The old Store `BLoEaf2L…` stays on chain, unused.
3. Upgrade the Arbitrum `LendMirror` proxy and deploy the treasury (step 4).
4. Initialize (step 5): the new Store `4FUxAXWr…`, peers on both sides, allowlists, the Chainlink route, the treasury, one bridge route per token, the lookup table.
5. Verify with one real position and small amounts (step 6): wrap, refresh, send, match; custody and a small level 2 borrow; bridge a few USDC and forward them.

## Do not

- Run bare `solana`, `forge`, or `cast` for writes; they ignore `DEPLOYMENT_TYPE`.
- Run `lz:oapp:solana:create` or `lz:deploy` twice on the same network unless you want a second Store or proxy.
- Pass `--eid` or `--network` values that disagree with `DEPLOYMENT_TYPE`; the tasks stop.
- Skip `npm run gen:api` after a build; the tasks would send the previous account layout.
- Edit a seed in `seeds.rs` once an account exists under it on mainnet; add a `V2` seed instead.
