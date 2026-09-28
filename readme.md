# LendMirror

Run Jupiter Lend positions from an EVM chain. A Solana program holds the position NFT, operates the position within an admin-set access level, mirrors the position's collateral and debt to EVM over LayerZero and Chainlink, and bridges tokens only to a fixed EVM treasury contract.

- **Mainnet path:** Solana (eid `30168`) → Arbitrum (eid `30110`). Not yet upgraded to this version.
- **Testnet path:** Solana Devnet (eid `40168`) → Ethereum Sepolia (eid `40161`).

Example used below: Jupiter vault `1`, nft `29`, Devnet wallet `AF1uGS22J8KUQdM41x3x6FYg4uhgS8sdcHrNPVc3MDPo`.

## Money flow

1. Capital starts on EVM. It is bridged to Solana (existing leg, not in this repo).
2. The program deposits it as collateral into a Jupiter Lend position it holds (level 1).
3. The program borrows against that collateral (level 2).
4. Borrowed tokens are bridged back to the EVM treasury, which forwards them only to owner-set strategy addresses.
5. Collateral and debt of every wrapped position are mirrored to EVM so the EVM side can watch the loan's risk.

Deposit and payback lower the risk ratio, so they sit at level 1. Withdraw and borrow raise it, so they need level 2. Levels 3 and 4 are stored but rejected until they are defined.

## Fund safety in one paragraph

Every bridge takes a destination address as a parameter. This program never lets the caller supply it. The destination lives in an admin-set `BridgeRoute` account. Every token account the program controls belongs to a program PDA, never to a wallet. Jupiter's `operate` is called with the program's PDA as signer and recipient, so withdrawn collateral and borrowed tokens can only land in program-owned accounts. On the EVM side the treasury forwards only to strategy addresses its owner set. Anyone with level 1 can trigger a bridge. Nobody can redirect one.

## Accounts (Solana)

| Account | Address | Holds |
|---|---|---|
| **Store** | PDA `["LendMirrorStoreV0"]` | admin, `snapshotters` (may read and wrap), `senders` (operators: may send any wrapper's snapshot and bridge), Jupiter program id. LayerZero sender. |
| **PositionWrapper** | PDA `["LendMirrorWrapperV1", vault le, nft le]` | owner, level, custody flag, position mint, last snapshot, send guard |
| **Wrapper authority** | PDA `["LendMirrorWrapperAuth", wrapper]`, no data | owns the wrapper's token accounts (NFT, collateral, debt token); signs Jupiter `operate` |
| **OnDemandStrategy** | PDA `["LendMirrorOnDemand", wrapper]` | up to 8 wallets that may refresh, send, operate, bridge this wrapper |
| **CCIP payer / bridge signer** | PDA `["LendMirrorCcipPayer"]`, no data | signs Chainlink sends, pays their SOL fee, signs bridge CPIs |
| **CcipRoute** | PDA `["LendMirrorCcip"]` | Chainlink router, fee quoter, destination selector, EVM receiver for snapshots |
| **BridgeRoute** | PDA `["LendMirrorBridgeRoute", mint, chain id le]` | bridge provider, provider program, EVM treasury, cap per transaction |
| **PeerConfig** | PDA `["LendMirrorPeer", store, eid be]` | LayerZero peer (the EVM `LendMirror` proxy) |

`programs/lendmirror/ARCHITECTURE.md` maps every source file and has an Anchor primer.

## Who can do what

| Role | Can call |
|---|---|
| Upgrade authority | `init_store` (once) |
| Admin (set at `init_store`) | `set_peer_config`, `set_snapshotters`, `set_senders`, `set_ccip_route`, `set_bridge_route`, `set_wrapper_level`, `release_position_nft` |
| Snapshotter | `wrap_position`, `refresh_wrapper`, `operate_position`, `bridge_tokens_*`, legacy `get_jupiter_position` |
| Sender (operator) | `send_position_snapshot_via_chainlink_and_lz` for any wrapper, `bridge_tokens_*` |
| Wrapper owner (the snapshotter who wrapped) | `attach_ondemand`, `set_ondemand_callers`, `deposit_position_nft`, `refresh_wrapper`, `operate_position`, `bridge_tokens_*` |
| OnDemand caller | `refresh_wrapper`, `send_position_snapshot_via_chainlink_and_lz`, `operate_position`, `bridge_tokens_*` for that wrapper |
| EVM owner | `LendMirror`: peers, CCIP route, upgrade. `LendMirrorTreasury`: strategies, CCIP senders, CCTP transmitter, upgrade |

Level gate on `operate_position`: level 1 allows `new_col >= 0 && new_debt <= 0` (deposit, payback, payback-all); level 2 allows everything; 0, 3, 4 allow nothing. `bridge_tokens_*` needs level ≥ 1.

## Flows

### A. Mirror a position (data bridging)

```bash
npx hardhat lz:oapp:solana:wrap-position --vault-id 1 --nft-id 29        # once, snapshotter; becomes owner
npx hardhat lz:oapp:solana:attach-ondemand --vault-id 1 --nft-id 29      # optional, owner
npx hardhat lz:oapp:solana:refresh-wrapper --vault-id 1 --nft-id 29      # read Jupiter into wrapper.snapshot
npx hardhat lz:oapp:solana:send-position-snapshot-via-chainlink-and-lz --vault-id 1 --nft-id 29
npx hardhat lz:oapp:evm:match --position <POSITION>                      # both copies + matched
```

Rules: a snapshot goes out once. Sending the same snapshot again fails with `SnapshotAlreadySent`; refresh first. On Sepolia, a delivery older than the stored one is ignored (`StaleDeliveryIgnored`), so the two routers can arrive in any order.

All wrapped positions at once (signer must be on `senders`):

```bash
npx hardhat lz:oapp:solana:sync-all-positions            # refresh + send each; skips unchanged unless --force
npx hardhat lz:oapp:evm:match --all
```

### B. Custody and operate

```bash
npx hardhat lz:oapp:solana:deposit-position-nft --vault-id 1 --nft-id 29   # owner: NFT into the wrapper authority
npx hardhat lz:oapp:solana:set-wrapper-level --vault-id 1 --nft-id 29 --level 1   # admin
npx hardhat lz:oapp:solana:operate-position --vault-id 1 --nft-id 29 --col 300000000 --debt 0     # deposit 0.3 WSOL
npx hardhat lz:oapp:solana:set-wrapper-level --vault-id 1 --nft-id 29 --level 2
npx hardhat lz:oapp:solana:operate-position --vault-id 1 --nft-id 29 --col 0 --debt 5000000       # borrow 5 USDC
npx hardhat lz:oapp:solana:refresh-wrapper --vault-id 1 --nft-id 29
```

Collateral to deposit must already sit in the wrapper authority's token account (anyone can send tokens there with a plain SPL transfer; this is where the EVM → Solana leg should land). Borrowed tokens land in the authority's borrow-token account. `--col min` / `--debt min` mean "all" (withdraw all / pay back all). The task keeps 0.05 SOL on the authority PDA because Jupiter's SDK simulates with it as fee payer.

Escape hatch: `lz:oapp:solana:release-position-nft` (admin) returns the NFT to the wrapper owner.

### C. Bridge tokens to the EVM treasury

```bash
npx hardhat deploy --tags LendMirrorTreasury                              # Sepolia proxy; put it in config/devnet.ts treasury
npx hardhat lz:oapp:evm:treasury:set-cctp-transmitter
npx hardhat lz:oapp:evm:treasury:set-strategy --token <USDC on Sepolia> --strategy <addr>
npx hardhat lz:oapp:solana:set-bridge-route --mint usdc --provider cctp   # admin: receiver = treasury
npx hardhat lz:oapp:solana:bridge-tokens --vault-id 1 --nft-id 29 --mint usdc --amount 1000000
npx hardhat lz:oapp:evm:treasury:claim-cctp --tx-hash <solana signature>  # after Circle attests
npx hardhat lz:oapp:evm:treasury:forward --token <USDC on Sepolia>
```

**Only these five tokens are in scope: USDC, USDT, USDai, sUSDai, PST.** Each token's issuer decided which bridge company carries it, so the program has one send routine per bridge:

| Token | Bridge | Instruction |
|---|---|---|
| USDC | Circle CCTP (or Chainlink, which uses Circle underneath) | `bridge_tokens_cctp` / `bridge_tokens_ccip` |
| PST | Chainlink CCIP | `bridge_tokens_ccip` |
| USDT (as USDT0), USDai, sUSDai | LayerZero (the issuer registered the token with LayerZero; such a token is called an "OFT") | `bridge_tokens_oft` |

Wormhole NTT is a reserved provider id with no instruction and no token that needs it. `docs/bridge-providers.md` has the token by token matrix with mints, lanes, and status.

## What is built

| Piece | Status |
|---|---|
| Live Jupiter read (ticks, liquidation branches) | Built |
| LayerZero + Chainlink send in one instruction, once per refresh, newest wins on EVM | Built, Devnet |
| Sync every wrapped position | Built |
| NFT custody, access levels, Jupiter `operate` CPI | Built. On a local fork of Jupiter mainnet (`npm run test:fork`): NFT custody, level 1 deposit through the CPI, level 1 borrow denied. Level 2 borrow needs a live oracle, so it is exercised on Devnet. |
| Token bridge: Circle CCTP v2 (USDC), Chainlink CCIP (PST, USDC), LayerZero OFT (USDT0, USDai, sUSDai) | Built, unit-tested. Circle and Chainlink paths testable on Devnet. **LayerZero path not tested on any network**: no test token exists on Devnet, and the issuers' Solana program ids and escrows are still needed for mainnet. |
| EVM treasury with owner-set strategies | Built, Foundry-tested; not deployed yet |
| Mainnet (Arbitrum) upgrade | Pending: the Arbitrum contract still expects the old 200-byte snapshot |

Solana instructions: `init_store`, `set_peer_config`, `set_snapshotters`, `set_senders`, `quote_send`, `set_ccip_route`, `get_jupiter_position` (legacy), `wrap_position`, `attach_ondemand`, `set_ondemand_callers`, `refresh_wrapper`, `send_position_snapshot_via_chainlink_and_lz`, `set_wrapper_level`, `deposit_position_nft`, `release_position_nft`, `operate_position`, `set_bridge_route`, `bridge_tokens_cctp`, `bridge_tokens_ccip`, `bridge_tokens_oft`.

EVM: `LendMirror` (UUPS proxy, snapshot store) and `LendMirrorTreasury` (UUPS proxy, token receiver and forwarder). Peer address is the `LendMirror` **proxy**.

## One switch: `DEPLOYMENT_TYPE`

Set `DEPLOYMENT_TYPE=devnet` or `DEPLOYMENT_TYPE=mainnet` in `.env`. Hardhat, `npx lm`, and `layerzero.config.ts` read `config/devnet.ts` or `config/mainnet.ts` (program id, Store, proxy, eids, Chainlink, CCTP, treasury) and the matching `*_DEVNET` / `*_MAINNET` secrets. If you pass `--eid` or `--network` and it disagrees, the command stops.

```bash
nvm use 18
set -a && source .env && set +a
```

| Variable | Used for |
|---|---|
| `DEPLOYMENT_TYPE` | `devnet` or `mainnet` |
| `SOLANA_KEYPAIR_PATH_DEVNET` / `_MAINNET` | Wallet for that path |
| `EVM_PRIVATE_KEY_DEVNET` / `_MAINNET` | EVM owner key |
| `RPC_URL_SOLANA_DEVNET` / `_MAINNET` | Solana RPC (mainnet one is also used by `test:fork`; public RPC is the fallback) |
| `RPC_URL_EVM_DEVNET` / `_MAINNET` | Sepolia or Arbitrum RPC |

`lendmirror-keypair.json` is the **program id**. `SOLANA_KEYPAIR_PATH_*` is the **wallet**. `lz:oapp:wire` crashes; set peers with `set-peer`.

## Addresses

### Devnet / Sepolia (`DEPLOYMENT_TYPE=devnet`)

| Item | Value |
|---|---|
| Solana program id | `GQDxkWJhMGppaXExXBC8hGWmfaUv9igo4PKdaLyc53T1` |
| Solana Store (OApp) | `BqsqziQ9VsD3o81zPCQuMfZebdn4eQUAtMjJxZLYhXdM` |
| Solana CCIP payer / bridge signer | `53ZqmxXwJhXxgLBFXpM1mZUDZ4AZwXaVhpnktxusQn6m` |
| Solana admin, snapshotter, sender | `AF1uGS22J8KUQdM41x3x6FYg4uhgS8sdcHrNPVc3MDPo` |
| Sepolia LendMirror (proxy) | `0xbE4c9C5DB8E2747C545B2591B3937764f1A2d514` |
| Sepolia implementation | `0xC722956634AC775A05F78B50BC840d27614916fd` (must be redeployed for this version) |
| Sepolia LendMirrorTreasury | not deployed yet |
| Sepolia owner | `0x9Dee2100Cb47734A7a629Db0a1B061Df865a9c87` |
| Devnet USDC (CCTP) | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| Chainlink | Wired for snapshots. Devnet token lanes carry CCIP-BnM `7AC59PVvR64EoMnLX45FHnJAYzPsxdViyYBsaGEQPFvh` |

Wrapper, authority, OnDemand, and BridgeRoute accounts are per position or per token; the tasks print them. Old `LendMirrorWrapper` accounts from before the V1 layout are abandoned; wrap each position again.

### Mainnet (`DEPLOYMENT_TYPE=mainnet`)

| Item | Value |
|---|---|
| Solana program id | `9oySM9Jo4ZEXFcWYFbuPK1FeqwrDr6wmnAmenAybzHqQ` |
| Solana Store (OApp) | `BLoEaf2L5rZvEwZuVfFjAabHW4woM9Mr1XknBQCZkyf4` |
| Solana admin | `B8HnbEgetyiAdvkbgZR7LsChh93KR3jWuSw6xSQxt1hL` |
| Arbitrum LendMirror (proxy) | `0xb42E98c712B5CAf1e55dB8106262077515879EA2` |
| Arbitrum implementation | `0xdAAE65Df8B96e9eE45eb756441B7942e5E128924` (old format; upgrade needed) |
| Chainlink, CCTP, treasury | Not wired |

## Upgrade Devnet to this version

```bash
nvm use 18
set -a && source .env && set +a

npx lm build -- --features no-log-ix-name
# The program grew (token code): the on-chain account holds ~528 KB, the new binary is ~724 KB.
# Extend once (upgrade authority signs), then deploy as usual.
npx lm solana program extend GQDxkWJhMGppaXExXBC8hGWmfaUv9igo4PKdaLyc53T1 250000
npx lm solana program deploy --program-id target/deploy/lendmirror-keypair.json target/deploy/lendmirror.so \
  --use-rpc --max-sign-attempts 20 --with-compute-unit-price 50000
npm run gen:api

npx hardhat compile
npx lm forge create contracts/LendMirror.sol:LendMirror --broadcast --constructor-args 0x6EDCE65403992e310A62460808c4b910D972f10f
npx lm cast send 0xbE4c9C5DB8E2747C545B2591B3937764f1A2d514 "upgradeToAndCall(address,bytes)" <NEW_IMPL> 0x
npx hardhat deploy --tags LendMirrorTreasury
```

Then flow A (wrap again under the V1 seed), B, C. `deployment-instructions.md` has every step with explanations.

## Tools

Node **18** (`nvm use 18`), Rust 1.84 (pinned by `rust-toolchain.toml`), Solana CLI, Anchor **0.31.1**, Foundry, `npm install`.

## Tests

```bash
cargo test -p lendmirror        # 36 unit tests: codecs, level policy, send guard, CCTP/CCIP bytes
forge test                      # LendMirror + LendMirrorTreasury + codec
npx lm build && RPC_URL_SOLANA_MAINNET= anchor test --skip-build   # local validator, LayerZero endpoint cloned from Devnet
npm run test:fork               # local fork of Jupiter Lend mainnet: NFT custody, level 1 deposit via CPI, level gate
cd crates/jup-tick-parity && cargo test
npm run test:jup-live
```

`test:fork` clones Jupiter's programs and one vault's accounts from mainnet at genesis (read-only; the clone list is `tests/fork/clone-flags.txt`, regenerate with `tests/fork/dump-accounts.ts`). Nothing is sent to mainnet. The fork runs at slot 0, which Jupiter's oracle rejects, so the borrow step skips itself with a note; deposits do not need the oracle.

## Optional: IDL and verified build

After `npx lm build`, fix `target/idl/lendmirror.json` `address` to the program id, then `anchor idl init` / `anchor idl upgrade`. Verified builds use `solana-verify` against the public commit; a Mac `anchor build` hash will not match the Linux build. On Etherscan or Arbiscan, read the contracts **as proxy**.
