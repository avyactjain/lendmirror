# Deployment instructions

One switch picks the whole path: Solana network, EVM network, program id, wallets, and RPCs.

## How `.env` wires up

Set this once:

```bash
DEPLOYMENT_TYPE=devnet   # or mainnet
```

That loads either `config/devnet.ts` or `config/mainnet.ts`. Secrets stay in `.env` under names ending in `_DEVNET` or `_MAINNET`. Only the active side is read.

| `.env` variable | Used when | Purpose |
|-----------------|-----------|---------|
| `DEPLOYMENT_TYPE` | always | `devnet` or `mainnet` |
| `SOLANA_KEYPAIR_PATH_DEVNET` | `devnet` | Solana wallet file for Devnet writes |
| `EVM_PRIVATE_KEY_DEVNET` | `devnet` | Sepolia owner key |
| `RPC_URL_SOLANA_DEVNET` | `devnet` | Solana Devnet RPC |
| `RPC_URL_EVM_DEVNET` | `devnet` | Sepolia RPC |
| `SOLANA_KEYPAIR_PATH_MAINNET` | `mainnet` | Solana wallet file for mainnet writes |
| `EVM_PRIVATE_KEY_MAINNET` | `mainnet` | Arbitrum owner key |
| `RPC_URL_SOLANA_MAINNET` | `mainnet` | Solana mainnet RPC |
| `RPC_URL_EVM_MAINNET` | `mainnet` | Arbitrum RPC |

Hardhat, `npx lm`, and `layerzero.config.ts` all call `lib/deployment.ts`, which:

1. Reads `DEPLOYMENT_TYPE`
2. Loads the matching profile (program id, Store, proxy, eids, Chainlink settings)
3. Resolves the matching key path and RPC URLs from `.env`
4. Prints one banner line: type, Solana pubkey, EVM address, program, RPC hosts

Old names (`PRIVATE_KEY`, `SOLANA_KEYPAIR_PATH`, `RPC_URL_SOLANA_TESTNET`, …) are ignored.

## Load `.env` into the current terminal

`npx lm` and Hardhat load `.env` themselves. Shell expansions like `$RPC_URL_EVM_DEVNET` do not, unless you export them:

```bash
set -a && source .env && set +a
```

- `set -a` — export every variable that gets set
- `source .env` — read the file into this shell
- `set +a` — stop auto-exporting

Check:

```bash
echo "$DEPLOYMENT_TYPE"
echo "$RPC_URL_EVM_DEVNET"
```

## Tools

```bash
nvm use 18
```

Use Node 18 for Hardhat. Use `npx lm` for Solana CLI, Forge, Cast, and Anchor build so the profile RPC and keys are injected. Bare `solana` / `forge` / `cast` bypass the switch.

## Upgrade an existing Devnet deploy

You already have Store `Bqsqzi…` and proxy `0xbE4c…`. Do **not** run `create` or `lz:deploy` again.

### 1. Build Solana

```bash
npx lm build -- --features no-log-ix-name
```

Builds the program with `LENDMIRROR_ID` set to the profile program id.

### 2. Upgrade Solana bytecode

```bash
npx lm solana program deploy \
  --program-id target/deploy/lendmirror-keypair.json \
  target/deploy/lendmirror.so \
  --use-rpc \
  --max-sign-attempts 20 \
  --with-compute-unit-price 50000
```

Uploads the new `.so` to the same program id. Raises resign attempts and CU price so Devnet congestion is less likely to stall the deploy.

### 3. Compile Hardhat artifacts

```bash
npx hardhat compile
```

Refreshes the EVM ABI so tasks see functions like `setCcipRoute`.

### 4. Deploy a new Sepolia implementation

```bash
npx lm forge create contracts/LendMirror.sol:LendMirror \
  --broadcast \
  --constructor-args 0x6EDCE65403992e310A62460808c4b910D972f10f
```

Deploys new logic with the Sepolia LayerZero endpoint baked in. Copy the **Deployed to** address.

### 5. Point the proxy at the new implementation

```bash
npx lm cast send 0xbE4c9C5DB8E2747C545B2591B3937764f1A2d514 \
  "upgradeToAndCall(address,bytes)" <NEW_IMPL_ADDRESS> 0x
```

UUPS upgrade on the existing proxy. Proxy address stays the same; peers stay valid.

### 6. Confirm Solana peer

```bash
npx hardhat lz:oapp:solana:get-peer
```

Prints the EVM peer stored on Solana (should be the Sepolia proxy).

### 7. Set Chainlink route on Solana

```bash
npx hardhat lz:oapp:solana:set-ccip-route
```

Writes router, destination, and receiver from the Devnet profile onto `CcipRoute`.

### 8. Set Chainlink route on Sepolia

```bash
npx hardhat lz:oapp:evm:set-ccip-route
```

Allows the Sepolia CCIP router and the empty Solana payer (`53Zqmx…`) to call `ccipReceive`.

### 9. Snapshot a Jupiter position

```bash
npx hardhat lz:oapp:solana:get-jupiter-position --vault-id 1 --nft-id 29
```

Reads the position on-chain and writes `Store.last_position`.

### 10. Send on LayerZero

```bash
npx hardhat lz:oapp:solana:send-jupiter
```

Sends the 257-byte LayerZero frame (length + 225-byte body). Caller pays the LayerZero fee; Store is the recorded sender.

### 11. Send on Chainlink

```bash
npx hardhat lz:oapp:solana:send-ccip
```

Sends the 225-byte body on CCIP. Funds the empty payer, which signs and pays the SOL fee.

### 12. Read Sepolia

```bash
npx hardhat lz:oapp:evm:debug
```

Prints `lastPosition` from the proxy (LayerZero path).

```bash
npx hardhat lz:oapp:evm:match --position <POSITION>
```

Prints LayerZero vs Chainlink copies and whether `matched` is true. Use the position pubkey printed by step 9.

## First-time deploy (empty program / no Store)

Only when this program id has never had a Store:

```bash
npx lm build -- --features no-log-ix-name
npx lm solana program deploy --program-id target/deploy/lendmirror-keypair.json target/deploy/lendmirror.so --use-rpc --max-sign-attempts 20 --with-compute-unit-price 50000
npx hardhat lz:oapp:solana:create
npx hardhat lz:deploy --ci
npx hardhat lz:oapp:solana:init-config --oapp-config layerzero.config.ts
npx hardhat lz:oapp:solana:set-peer
npx hardhat lz:oapp:evm:set-peer
```

Then continue from step 7 above for Chainlink (Devnet only), then snapshot and send.

| Command | One line |
|---------|----------|
| `lz:oapp:solana:create` | Creates the Store PDA once; signer must be the upgrade authority. |
| `lz:deploy --ci` | Deploys the UUPS proxy + implementation on the profile EVM network. |
| `lz:oapp:solana:init-config` | Creates LayerZero send-library accounts for the destination eid. |
| `lz:oapp:solana:set-peer` | Saves the EVM proxy as Solana’s peer. |
| `lz:oapp:evm:set-peer` | Saves the Solana Store as the EVM peer. |

## Mainnet

Set `DEPLOYMENT_TYPE=mainnet` and fill the `*_MAINNET` keys. Same commands. Chainlink tasks stop: mainnet has no CCIP route in the profile yet.

## Do not

- Run bare `solana`, `forge`, or `cast` for writes — they ignore `DEPLOYMENT_TYPE`.
- Run `create` or `lz:deploy` again on an already-live program/proxy unless you intend a new Store and new proxy.
- Pass `--eid` / `--network` that disagree with `DEPLOYMENT_TYPE` — the task will stop.
