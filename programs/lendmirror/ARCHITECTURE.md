# lendmirror (Solana program)

Mirrors Jupiter Lend positions to an EVM chain, holds their position NFTs, operates them within
an admin-set access level, and bridges tokens only to a fixed EVM treasury.

## Files

| file | responsibility | called by |
|---|---|---|
| `src/lib.rs` | program id, PDA seeds, the `#[program]` entry points (one line each) | Solana runtime |
| `src/state/store.rs` | `Store` PDA: admin, allowlists (snapshotters read, senders operate), Jupiter program id | every instruction |
| `src/state/wrapper.rs` | `PositionWrapper` per position, `OnDemandStrategy` caller list, `level_allows`, send guard | wrap, refresh, send, custody, operate, bridge |
| `src/state/jupiter_position.rs` | decoders for Jupiter accounts, the 225-byte `PositionSnapshot` and its wire codec | refresh, send, EVM codec (mirror) |
| `src/state/ccip_route.rs`, `src/state/bridge_route.rs` | admin-set destinations: where snapshots go (CCIP) and where tokens go (per mint + chain) | send, bridge |
| `src/instructions/init_store.rs`, `set_peer_config.rs`, `set_allowlists.rs`, `set_ccip_route.rs` | admin setup | hardhat tasks |
| `src/instructions/wrap_position.rs` | `wrap_position`, `attach_ondemand`, `set_ondemand_callers` | hardhat tasks |
| `src/instructions/get_jupiter_position.rs` | `compute_position_snapshot`: read Position, Tick, VaultState/Config, walk liquidation branches | refresh, legacy `get_jupiter_position` |
| `src/instructions/refresh_wrapper.rs` | fill `wrapper.snapshot` | tasks, `sync-all-positions` |
| `src/instructions/send_position_snapshot.rs` | LayerZero CPI (Store signs) + Chainlink CPI (payer PDA signs), once per refresh | tasks, `sync-all-positions` |
| `src/instructions/custody.rs` | `set_wrapper_level`, `deposit_position_nft`, `release_position_nft` | tasks |
| `src/instructions/operate_position.rs` | Jupiter `operate` CPI signed by the wrapper authority PDA, gated by level | task `operate-position` |
| `src/instructions/bridge_tokens.rs` | `set_bridge_route`, `bridge_tokens_cctp`, `bridge_tokens_ccip` | task `bridge-tokens` |
| `src/instructions/send_ccip.rs`, `src/bridges.rs` | pure byte builders for Chainlink `ccip_send` and Circle `deposit_for_burn` | send, bridge |
| `src/live_position.rs`, `src/tick_math.rs` | liquidation branch walk and tick ratio math | `compute_position_snapshot` |
| `src/msg_codec.rs` | 32-byte LayerZero length header around the snapshot body | snapshot codec |

## Data flow

```
wrap_position ─► PositionWrapper (level 0)
deposit_position_nft ─► NFT in ATA(wrapper authority PDA)      admin: set_wrapper_level 1 | 2
operate_position ─► Jupiter operate, signer = wrapper authority PDA, recipient = same PDA
refresh_wrapper ─► wrapper.snapshot (clock-stamped)
send_position_snapshot_via_chainlink_and_lz ─► Endpoint (LayerZero) + Router (CCIP) ─► EVM LendMirror
bridge_tokens_* ─► ATA(wrapper authority) → ATA(bridge signer PDA) → CCTP / CCIP ─► EVM LendMirrorTreasury
```

## To change X, touch Y

- New field on the wrapper: `state/wrapper.rs` (bump `WRAPPER_SEED` if it grows past `reserved`), `wrap_position.rs` init, `lib/client` regen.
- New access rule: `level_allows` in `state/wrapper.rs` only. Instructions call it; nothing else encodes levels.
- New bridge provider: constant in `state/bridge_route.rs`, byte builder in `bridges.rs`, one instruction in `bridge_tokens.rs` reusing `BridgeCommon`.
- New snapshot field: `PositionSnapshot` + `encode_body`/`decode` in `state/jupiter_position.rs`, `contracts/libs/PositionSnapshotMsgCodec.sol`, `lib/client/lendmirror.ts` encoder. The body length test pins 225.

## Invariants that span files

- Only `set_bridge_route` writes an EVM destination; `bridge_tokens_*` read it. No instruction takes a destination parameter.
- Every token account the program controls is an ATA of the wrapper authority PDA or of the bridge signer PDA. Both PDAs hold no data, so the System program can debit them for fees; the wrapper account itself can never be a payer.
- `refresh_wrapper` stamps `snapshot_time` from the clock; `send_*` refuses a time ≤ `last_sent_snapshot_time`. One send per refresh.
- `level_allows(1, col, debt)` is true only for `col >= 0 && debt <= 0`.

## Anchor primer (for a Rust developer new to Solana)

- **Accounts are the only state.** A program has no storage of its own. Every read or write goes through an account passed in the transaction. `#[derive(Accounts)]` declares the list one instruction needs, and the attribute on each field is the check Anchor runs before `apply`.
- **PDA (program derived address).** `Pubkey::find_program_address(seeds, program_id)` gives an address with no private key. Only the program that owns the seeds can "sign" for it, using `invoke_signed(ix, accounts, &[seeds_with_bump])`. `seeds = [...]` + `bump` on a field means "this account must be that PDA".
- **Discriminator.** `#[account]` prefixes each account's data with 8 bytes derived from the type name. Passing the wrong account type fails deserialization, not silently.
- **`init` / `init_if_needed` / `mut`.** `init` creates the account (fails if it exists), `init_if_needed` creates or accepts, `mut` is required for any write. Rent is paid by `payer = ...`. Accounts cannot grow, which is why layout changes bump the seed.
- **`constraint = expr @ Error`.** Arbitrary boolean checked after ALL accounts are loaded. A missing account fails earlier with `AccountNotInitialized`, before any constraint runs.
- **`Option<Account<..>>`.** The client passes the program id in that slot to mean "absent".
- **`UncheckedAccount` + `/// CHECK:`.** Anchor does no type check; the comment states what the program verifies instead (or that the callee does).
- **CPI (cross-program invocation).** Build an `Instruction { program_id, accounts, data }` and call `invoke` (caller signs) or `invoke_signed` (a PDA signs). The callee's account order and Borsh data layout must match its IDL exactly.
- **`remaining_accounts`.** Extra accounts the client appends after the named ones, for lists whose length varies (liquidation branches, LayerZero endpoint accounts, CCIP per-token accounts).
- **Compute and size limits.** ~1.4M compute units per transaction and 1232 bytes per transaction; address lookup tables shrink account lists (Jupiter `operate` needs them).
