# Code review findings

Both sides (Solana program, EVM contracts) were read end to end. This file lists what was found, what was fixed, and what is still open. The readme links here instead of carrying the full list.

## Fixed

| Where | Problem | Fix |
| --- | --- | --- |
| `operate_position` | Jupiter accepts a "claim" transfer type. A caller could withdraw or borrow into a Liquidity claim account that no instruction here can spend, stranding the funds. | Only `transfer_type` `None` or `1` (direct) is accepted. Since the move to `operate_dex` (29 Sep 2026), every account Jupiter can pay into must also be absent or owned by the wrapper authority. |
| `operate_position`, `bridge_tokens_*` | Store snapshotters, meant to be a read role, could operate any custodied wrapper and bridge from any wrapper. | Operate: owner or OnDemand caller only. Bridge: owner, OnDemand caller, or sender. Docs and `Store` comments match the code. |
| `bridge_tokens_*` | The level gate was `level >= 1`, so the reserved levels 3 and 4 could bridge while they cannot operate. | Levels 1 and 2 only. |
| `bridge_tokens_oft` | The LayerZero fee is paid from the shared bridge-signer PDA. A caller could quote a high `native_fee`, bring little `fee_lamports`, and drain that PDA's SOL; caller-supplied executor options could turn it into a native drop to their own EVM address. | `fee_lamports >= native_fee` and `options` must be empty. Gas comes from the peer's enforced options, set by the admin. |
| `bridge_tokens_ccip` | The route's `provider_program` was never compared to the Chainlink router the CCIP accounts were validated against. | It must equal `ccip_route.router`. |
| `bridge_tokens_ccip` | The router was given a `token_pools_signer` account it does not list, and nothing let the router pull the tokens: its on-chain transfer failed with `owner does not match`. | The router's `ccip_send` names 18 accounts. The pull is signed by the router's `fee_billing_signer` PDA, so the bridge signer approves that PDA for exactly `amount` before the call. |
| `bridge_tokens_cctp` | `max_fee` (the Circle fast-transfer fee) had no bound. | Capped at 1% of the amount. |
| `set_bridge_route` | A 32-byte receiver that is not a left-padded EVM address would be read differently by CCIP (last 20 bytes) than by CCTP and OFT (all 32). A CCTP domain or LayerZero eid larger than `u32` was silently truncated. | Receiver must have 12 zero bytes in front. Domains and eids must fit a `u32`. |
| `PeerConfig::SIZE` | Sized with `size_of::<Self>()`, which counts the two `Vec` headers, not the up to 1536 bytes of enforced options Borsh writes. Any real enforced options overflowed the account. | Sized from `EnforcedOptions::INIT_SPACE`; `set_peer_config` grows an old peer account before writing. |
| Wrapper seed | The wrapper seed already ended in `V1` before the seed module, so the V1 rename left it unchanged and old wrappers kept an authority bump from an old seed. | Seed is `LendMirrorPositionWrapperV1`; every position gets a fresh wrapper. `listWrappers` skips accounts under older seeds. |
| `lib/client/bridge.ts` | The CCIP pool chain-config PDA was derived under the wrong program and passed read-only; the pool writes its rate-limit bucket there. | Derived under the pool program, marked writable. |
| `tasks/solana/syncAll.ts` | A refresh whose numbers did not change was reported as "unchanged" and skipped, even though `snapshot_time` moved. | "Changed" also means a newer snapshot time. |
| `tasks/evm/setPeer.ts` | An uninitialised proxy would be initialised by whichever key ran `set-peer`. | The task refuses and says to fix the deployment. |
| `tasks/solana/custody.ts` (`operate-position`) | The compute-unit simulation ran without Jupiter's lookup tables, so an `operate_dex` transaction could not even be encoded; and right after the setup transaction an RPC node could still miss the accounts it created. | The tables go into the simulation; the task waits after the setup and retries the operate twice on "account missing" errors. |
| Deploy scripts | OpenZeppelin v5 UUPS has no `upgradeTo`, which hardhat-deploy calls by default. | `upgradeFunction: upgradeToAndCall`. Upgrades of existing proxies go through `cast` (see `deployment-instructions.md`). |
| Chainlink snapshot gas | `400 000` was too little headroom for `lzReceive` / `ccipReceive`. | `600 000` in the profiles and the LayerZero executor option; the V1 routes were set with it. |

## Open, decided not to change now

| Where | Note |
| --- | --- |
| `operate_position` | Smart vaults only (Jupiter types T2, T3, T4). Plain vaults such as vault 1 accept only `operate`, which the program no longer builds. |
| `operate_position` | No "withdraw everything" or "pay back everything": that needs Jupiter's `operate_perfect_dex`. The exit today is `release_position_nft`, then closing the position on jup.ag. |
| `operate_position` | A smart-collateral withdraw through the program reaches Solana's maximum call depth of 5 (our program → Vaults → DEX → Liquidity → token program). Any future hop in Jupiter's path would break it. |
| `wrap_position` | Does not check that the Jupiter position exists. Harmless (level 0, cannot refresh), but a typo in `nft_id` gives a dead wrapper that cannot be closed. Consider an admin `close_wrapper`. |
| Wrapper ownership | There is no `set_wrapper_owner`; if the owner key is lost, the admin can only `release_position_nft` back to that lost key. |
| Bridge signer / wrapper authority SOL | SOL on these PDAs (fee top-ups, rent money) has no withdraw instruction. Mainnet after the test: 0.0476 SOL on the bridge signer, 0.05 SOL on the 95/34 wrapper authority. An admin sweep to a fixed wallet would need a program upgrade. |
| `send-position-snapshot` task | Tops up the bridge signer with 0.05 SOL on every call without checking its balance; Chainlink's real fee is about 0.0017 SOL. Pass `--fund-lamports 0` while the balance covers it. Topping up only the shortfall is a task change. |
| `LendMirror.sol` | Single-step ownership; `lzReceive` is `payable` (LayerZero standard). The decoder accepts any payload of the right length without a version byte. |
| `LendMirrorTreasury.ccipReceive` | Chainlink does not call the receiver when a route's `gasLimit` is 0; the treasury still receives the tokens, it just does not log the delivery. |
| `deployments/arbitrum/LendMirror*.json` | Still records the retired implementation `0xdAAE…`, because the upgrade was done with `cast`. The proxy address in it is right, and the tasks read the ABI from the compiled contract. |
| `foundry.toml` | Uses `optimize` and `solc-version`, which Foundry ignores (it expects `optimizer` and `solc_version`), so `forge create` would build with different settings. Deploy implementations from the Hardhat artifact instead (see `deployment-instructions.md`). |
| LayerZero OFT token path | Built and unit-tested, never run on a network: there is no OFT test token on Devnet, and the USDT0, USDai and sUSDai Solana program ids and escrows are still needed for routes. |
