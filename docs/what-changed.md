# What changed in the LendMirror program

Plain-language summary of the work on branch `feat/position-wrapper-strategies` (10 commits).
For file-level detail see `programs/lendmirror/ARCHITECTURE.md`. For every command see `readme.md`.

---

## 1. The big picture

**Before the changes, the program does:**
It watches one Jupiter Lend position. Someone tells it "read this position", it reads the
collateral and debt from Jupiter, and it sends those numbers to Ethereum over LayerZero and
Chainlink. That is all. It never touches the position NFT and never moves a single token.

**After the changes, the program does:**
It **holds** Jupiter position NFTs, **operates** those positions (deposit, pay back, withdraw,
borrow) within an access level the admin sets, still **mirrors** the numbers to Ethereum for
every position it holds, and **bridges tokens** back to Ethereum. Money can only ever sit in
program-owned accounts or arrive at one fixed Ethereum contract we own. No caller can point the
money anywhere else.

---

## 2. Sending the snapshot to Ethereum

**Before:**
Three steps. `refresh_wrapper` read Jupiter and cleared two "allowed" flags. `request_bridge_ondemand`
set the flags. Then `send` (LayerZero) and `send_ccip` (Chainlink) each checked a flag, sent,
and cleared it. Anyone on the OnDemand list could re-arm and resend the same numbers as often
as they liked. On Ethereum, whichever copy arrived last overwrote the previous one, even if it
was older.

**After:**
One step. `send_position_snapshot_via_chainlink_and_lz` sends over both routers in one
transaction. A snapshot goes out **once**: sending it again fails with `SnapshotAlreadySent`
until you refresh. Ethereum drops a delivery that is older than what it already has, so the two
routers can arrive in any order. The `senders` list is now the "operator" list: one key on it
can send **any** wrapper, so one cron job can sync everything.

Commands:

```bash
npx hardhat lz:oapp:solana:wrap-position --vault-id 1 --nft-id 29        # once per position
npx hardhat lz:oapp:solana:refresh-wrapper --vault-id 1 --nft-id 29      # read Jupiter
npx hardhat lz:oapp:solana:send-position-snapshot-via-chainlink-and-lz --vault-id 1 --nft-id 29
npx hardhat lz:oapp:evm:match --position <POSITION>                      # see both copies on Sepolia
```

All positions at once (signer must be on `senders`):

```bash
npx hardhat lz:oapp:solana:sync-all-positions
npx hardhat lz:oapp:evm:match --all
```

---

## 3. The wrapper account

**Before:**
`PositionWrapper` stored: owner, vault id, nft id, the last snapshot, and two "send allowed"
flags. Address seed: `LendMirrorWrapper`.

**After:**
It also stores: `level` (0 to 4), `custody` (is the NFT inside), `position_mint`, the time of
the last snapshot that was sent, a send counter, and the bump of its **authority PDA**. Address
seed: `LendMirrorWrapperV1`. Solana accounts cannot grow, so the old Devnet wrappers are left
behind and every position is wrapped again.

The **authority PDA** is a second address per wrapper that holds no data. It owns every token
account the wrapper controls (the NFT, the collateral token, the debt token) and it signs
Jupiter calls. It is separate from the wrapper because Solana refuses to move SOL out of an
account that holds data, and Jupiter's signer must be able to pay.

---

## 4. Holding the NFT and operating the position (new)

**Before:**
Not possible. The program had no token code at all.

**After:**
Four new instructions.

| Instruction | Who | What |
|---|---|---|
| `set_wrapper_level` | admin | 0 = mirror only. 1 = deposit and pay back. 2 = also withdraw and borrow. 3 and 4 = stored but everything is rejected until defined. |
| `deposit_position_nft` | wrapper owner | moves the Jupiter position NFT from the owner's wallet into the authority PDA's token account |
| `release_position_nft` | admin | moves it back to the wrapper owner (escape hatch; never to anyone else) |
| `operate_position` | owner, snapshotter, or OnDemand caller | calls Jupiter `operate` with the authority PDA as signer **and** recipient, after checking the level |

Why this is safe: Jupiter sends withdrawn collateral and borrowed tokens to the `recipient`.
The program always passes its own PDA there, so those tokens can only land in a program-owned
account. Level 1 can only do things that lower the risk of the loan (deposit, pay back).

Commands:

```bash
npx hardhat lz:oapp:solana:deposit-position-nft --vault-id 1 --nft-id 29
npx hardhat lz:oapp:solana:set-wrapper-level --vault-id 1 --nft-id 29 --level 1
# put collateral in the authority PDA's token account first (the task prints the address)
npx hardhat lz:oapp:solana:operate-position --vault-id 1 --nft-id 29 --col 300000000 --debt 0   # deposit 0.3 WSOL
npx hardhat lz:oapp:solana:set-wrapper-level --vault-id 1 --nft-id 29 --level 2
npx hardhat lz:oapp:solana:operate-position --vault-id 1 --nft-id 29 --col 0 --debt 5000000     # borrow 5 USDC
npx hardhat lz:oapp:solana:refresh-wrapper --vault-id 1 --nft-id 29                            # read the new numbers
```

`--col min` or `--debt min` means "all" (withdraw everything / pay back everything).

Tested on a local copy of Jupiter mainnet (`npm run test:fork`): the NFT goes into custody, a
level 1 deposit goes through, a level 1 borrow is denied. The level 2 borrow needs a live price
oracle, which the local copy cannot provide, so that one is checked on Devnet.

---

## 5. Bridging tokens to Ethereum (new)

**Before:**
Not possible.

**After:**
The admin writes a `BridgeRoute` for each (token, destination chain): which bridge to use,
which Ethereum address receives, and a per-transaction cap. Then anyone with level 1 or higher
runs `bridge_tokens_cctp` (USDC through Circle CCTP) or `bridge_tokens_ccip` (any Chainlink-listed
token). Those instructions take an **amount only**. The destination comes from the route, so a
caller cannot redirect funds.

On Ethereum, a new contract `LendMirrorTreasury` receives the tokens. It can only pass them on
to the strategy address its owner set for that token. Anyone can trigger the pass-on.

Commands:

```bash
npx hardhat deploy --tags LendMirrorTreasury                                  # Sepolia, once; put the address in config/devnet.ts
npx hardhat lz:oapp:evm:treasury:set-cctp-transmitter
npx hardhat lz:oapp:evm:treasury:set-strategy --token <USDC on Sepolia> --strategy <address>
npx hardhat lz:oapp:solana:set-bridge-route --mint usdc --provider cctp      # admin, once per token
npx hardhat lz:oapp:solana:bridge-tokens --vault-id 1 --nft-id 29 --mint usdc --amount 1000000
npx hardhat lz:oapp:evm:treasury:claim-cctp --tx-hash <solana signature>     # after Circle attests (~15 min standard)
npx hardhat lz:oapp:evm:treasury:forward --token <USDC on Sepolia>
```

Token status: USDC is built (CCTP and CCIP). USDT, USDA, sDAI, PST are researched in
`docs/bridge-providers.md`; USDA, sDAI, and PST have no Solana deployment we could find and need
a mint address from the team.

---

## 6. Who can do what

**Before:**
Admin set lists. Snapshotters read Jupiter. OnDemand callers armed sends. Senders sent.

**After:**

| Role | Can do |
|---|---|
| Admin | set peers, lists, Chainlink route, bridge routes, wrapper levels; release an NFT to its owner |
| Snapshotter | wrap, refresh, operate, bridge |
| Sender (operator) | send any wrapper's snapshot, bridge |
| Wrapper owner | attach OnDemand, deposit the NFT, refresh, operate, bridge |
| OnDemand caller | refresh, send, operate, bridge for that wrapper |
| Ethereum owner | peers and upgrades on `LendMirror`; strategies, allowed senders, upgrades on `LendMirrorTreasury` |

---

## 7. Tests

**Before:** 28 Rust unit tests, 13 Foundry tests, an Anchor suite that could not pass
`init_store` on a local validator.

**After:** 36 Rust unit tests, 21 Foundry tests, 23 Anchor tests, and the Jupiter fork test.

```bash
cargo test -p lendmirror
forge test
npx lm build && RPC_URL_SOLANA_MAINNET= anchor test --skip-build     # Node 18
npm run test:fork                                                      # Node 18, a few minutes
```

---

## 8. Not done yet

- Nothing has been run on Devnet or mainnet. The readme's "Upgrade Devnet to this version" block is the next step.
- The Arbitrum (mainnet) contract is still the old format and would reject today's snapshot; it needs a redeploy and `upgradeToAndCall`.
- LayerZero OFT and Wormhole NTT are reserved bridge ids with no instruction yet.
