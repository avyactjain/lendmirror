/**
 * Custody test on a local fork of Jupiter Lend mainnet.
 *
 * 1. Starts solana-test-validator with our program loaded as upgradeable (test wallet is the
 *    upgrade authority, which init_store requires), the LayerZero Endpoint program and its
 *    settings PDA cloned from mainnet, and every Jupiter account from tests/fork/clone-flags.txt.
 * 2. Runs tests/fork/custody.fork.test.ts against it with the Anchor provider env vars set.
 * 3. Stops the validator.
 *
 * Read-only against mainnet (cloning reads accounts). Nothing is sent to mainnet.
 *
 * Known limit: the fork starts at slot 0 (agave 2.1's --warp-slot never opens the RPC), so
 * Jupiter's oracle, which compares the clock slot with the slot in the cloned price accounts,
 * rejects operations that need a price (borrow). Deposits do not need one. The borrow step
 * therefore skips itself with a note; it is exercised on Devnet instead.
 *
 *   npm run test:fork            (needs `npx lm build` first; uses ~/.config/solana/id.json)
 */
const { spawn, spawnSync } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

require('dotenv').config()

const PROGRAM_ID = 'GQDxkWJhMGppaXExXBC8hGWmfaUv9igo4PKdaLyc53T1'
const LZ_ENDPOINT = '76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6'
const LZ_ENDPOINT_SETTINGS = '2uk9pQh3tB5ErV7LGQJcbWjb4KeJ2UJki5qJZ8QG56G3'
/** Metaplex Token Metadata: Jupiter's init_position mints the position NFT with metadata. */
const MPL_TOKEN_METADATA = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'
const RPC = process.env.RPC_URL_SOLANA_MAINNET || 'https://api.mainnet-beta.solana.com'
const WALLET = process.env.ANCHOR_WALLET || path.join(os.homedir(), '.config/solana/id.json')
const LEDGER = path.join(os.tmpdir(), 'lendmirror-fork-ledger')

const so = path.join(__dirname, '../../target/deploy/lendmirror.so')
if (!existsSync(so)) throw new Error(`Missing ${so}. Run: npx lm build -- --features no-log-ix-name`)
const walletPubkey = spawnSync('solana-keygen', ['pubkey', WALLET], { encoding: 'utf8' }).stdout.trim()
if (!walletPubkey) throw new Error(`Cannot read wallet ${WALLET}`)

const cloneFlags = readFileSync(path.join(__dirname, 'clone-flags.txt'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => line.trim().split(/\s+/))

const args = [
    '--reset',
    '--quiet',
    '--ledger', LEDGER,
    '--url', RPC,
    '--upgradeable-program', PROGRAM_ID, so, walletPubkey,
    '--clone-upgradeable-program', LZ_ENDPOINT,
    '--clone', LZ_ENDPOINT_SETTINGS,
    '--clone-upgradeable-program', MPL_TOKEN_METADATA,
    ...cloneFlags,
]
console.log(`starting solana-test-validator with ${cloneFlags.length / 2} cloned Jupiter entries`)
const validator = spawn('solana-test-validator', args, { stdio: ['ignore', 'inherit', 'inherit'] })
let validatorExit = null
validator.on('exit', (code) => {
    validatorExit = code
})

function waitForRpc(attempts = 300) {
    return new Promise((resolve, reject) => {
        const tick = () => {
            if (validatorExit !== null) return reject(new Error(`validator exited with code ${validatorExit}`))
            const probe = spawnSync('solana', ['cluster-version', '-u', 'http://127.0.0.1:8899'], { encoding: 'utf8' })
            if (probe.status === 0) return resolve()
            if (--attempts === 0) return reject(new Error('validator did not start'))
            setTimeout(tick, 1000)
        }
        tick()
    })
}

;(async () => {
    let code = 1
    try {
        await waitForRpc()
        // Cloned accounts land at genesis; give the validator a couple of slots.
        await new Promise((r) => setTimeout(r, 3000))
        const mocha = spawnSync(
            'npx',
            ['ts-mocha', '-p', './tsconfig.json', '-t', '600000', 'tests/fork/custody.fork.test.ts'],
            {
                stdio: 'inherit',
                env: {
                    ...process.env,
                    ANCHOR_PROVIDER_URL: 'http://127.0.0.1:8899',
                    ANCHOR_WALLET: WALLET,
                    TS_NODE_TRANSPILE_ONLY: 'true',
                    TS_NODE_COMPILER_OPTIONS: JSON.stringify({ module: 'commonjs', esModuleInterop: true, moduleResolution: 'node' }),
                },
            }
        )
        code = mocha.status ?? 1
    } catch (err) {
        console.error(err instanceof Error ? err.message : err)
    } finally {
        validator.kill('SIGINT')
        process.exit(code)
    }
})()
