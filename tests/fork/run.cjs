/**
 * Custody and smart-vault test on a local fork of Jupiter Lend mainnet (vault 95).
 *
 * 1. Starts solana-test-validator with our program loaded as upgradeable (test wallet is the
 *    upgrade authority, which init_store requires), the LayerZero Endpoint program and its
 *    settings PDA cloned from mainnet, every Jupiter account from tests/fork/clone-flags.txt,
 *    and a USDC token account holding 1,000 USDC for the test wallet (written straight into the
 *    ledger: nobody can mint USDC on a fork). Regenerate the clone list with
 *    tests/fork/dump-accounts.ts.
 * 2. Runs tests/fork/custody.fork.test.ts against it with the Anchor provider env vars set.
 * 3. Stops the validator.
 *
 * Read-only against mainnet (cloning reads accounts). Nothing is sent to mainnet.
 *
 * The fork starts at mainnet's current slot (`--warp-slot`). Jupiter's oracle compares the
 * clock slot with the slot stored in the cloned price accounts, so a chain that starts at slot
 * 0 rejects every operation that needs a price (borrow). Agave 2.1's test validator never
 * opens its RPC after a warp; Agave 4.2 does. Point SOLANA_TEST_VALIDATOR at a 4.2+ binary
 * (download solana-release-aarch64-apple-darwin.tar.bz2 from github.com/anza-xyz/agave/releases)
 * to run the borrow step; with the 2.1 binary the runner skips the warp and the borrow step
 * skips itself with a note.
 *
 *   npm run test:fork            (needs `npx lm build` first; uses ~/.config/solana/id.json)
 */
const { spawn, spawnSync } = require('node:child_process')
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
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

/** A 4.2+ test validator warps; the 2.1 one hangs after a warp, so it runs unwarped. */
const VALIDATOR = process.env.SOLANA_TEST_VALIDATOR || 'solana-test-validator'
const validatorVersion = spawnSync(VALIDATOR, ['--version'], { encoding: 'utf8' }).stdout.trim()
const canWarp = /^solana-test-validator ([4-9]|[1-9]\d)\./.test(validatorVersion)

function mainnetSlot() {
    const out = spawnSync('solana', ['slot', '-u', RPC], { encoding: 'utf8' })
    const slot = out.stdout.trim()
    if (out.status !== 0 || !/^\d+$/.test(slot)) throw new Error(`cannot read mainnet slot: ${out.stderr}`)
    return slot
}

const so = path.join(__dirname, '../../target/deploy/lendmirror.so')
if (!existsSync(so)) throw new Error(`Missing ${so}. Run: npx lm build -- --features no-log-ix-name`)
const walletPubkey = spawnSync('solana-keygen', ['pubkey', WALLET], { encoding: 'utf8' }).stdout.trim()
if (!walletPubkey) throw new Error(`Cannot read wallet ${WALLET}`)

/**
 * `--account` flag that puts a USDC token account for `owner` into the ledger at genesis.
 * SPL token account layout (165 bytes): mint 0..32, owner 32..64, amount 64..72, delegate
 * 72..108, state 108, is_native 109..121, delegated_amount 121..129, close_authority 129..165.
 */
function usdcAccountFlag(owner) {
    const { PublicKey } = require('@solana/web3.js')
    const mint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
    const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
    const ataProgram = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
    const ownerKey = new PublicKey(owner)
    const [ata] = PublicKey.findProgramAddressSync([ownerKey.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ataProgram)
    const data = Buffer.alloc(165)
    mint.toBuffer().copy(data, 0)
    ownerKey.toBuffer().copy(data, 32)
    data.writeBigUInt64LE(1_000_000_000n, 64) // 1,000 USDC
    data[108] = 1 // AccountState::Initialized
    const file = path.join(os.tmpdir(), 'lendmirror-fork-wallet-usdc.json')
    const account = { lamports: 2039280, data: [data.toString('base64'), 'base64'], owner: tokenProgram.toBase58(), executable: false, rentEpoch: 0, space: 165 }
    writeFileSync(file, JSON.stringify({ pubkey: ata.toBase58(), account }))
    return ['--account', ata.toBase58(), file]
}

const cloneFlags = readFileSync(path.join(__dirname, 'clone-flags.txt'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => line.trim().split(/\s+/))
// The USDai LayerZero lane (issuer program, message library, executor, verifiers, price feed,
// lane accounts, lookup table). Regenerate with tests/fork/dump-lz-accounts.ts.
const lzCloneFlags = readFileSync(path.join(__dirname, 'lz-clone-flags.txt'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => line.trim().split(/\s+/))

/**
 * `--account` flag that gives `owner` a funded USDai (Token-2022) account at genesis. Built
 * from a real mainnet account's bytes (tests/fork/usdai-account.json) so the extension TLV the
 * mint demands (transfer hook state, etc.) is present; only the owner and amount bytes change.
 */
function usdaiAccountFlag(owner) {
    const { PublicKey } = require('@solana/web3.js')
    const mint = new PublicKey('USDai5XCUzNebYzUk6EuRiFCvnyoyEdj7VSyijYcz2A')
    const token2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
    const ataProgram = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
    const ownerKey = new PublicKey(owner)
    const [ata] = PublicKey.findProgramAddressSync([ownerKey.toBuffer(), token2022.toBuffer(), mint.toBuffer()], ataProgram)
    const fixture = JSON.parse(readFileSync(path.join(__dirname, 'usdai-account.json'), 'utf8'))
    const data = Buffer.from(fixture.data, 'base64')
    ownerKey.toBuffer().copy(data, 32)
    data.writeBigUInt64LE(1_000_000_000n, 64) // 1,000 USDai
    const file = path.join(os.tmpdir(), 'lendmirror-fork-wallet-usdai.json')
    const account = { lamports: 3_000_000, data: [data.toString('base64'), 'base64'], owner: token2022.toBase58(), executable: false, rentEpoch: 0, space: data.length }
    writeFileSync(file, JSON.stringify({ pubkey: ata.toBase58(), account }))
    return ['--account', ata.toBase58(), file]
}

const args = [
    '--reset',
    '--quiet',
    '--ledger', LEDGER,
    '--url', RPC,
    ...(canWarp ? ['--warp-slot', mainnetSlot()] : []),
    '--upgradeable-program', PROGRAM_ID, so, walletPubkey,
    '--clone-upgradeable-program', LZ_ENDPOINT,
    '--clone', LZ_ENDPOINT_SETTINGS,
    '--clone-upgradeable-program', MPL_TOKEN_METADATA,
    ...cloneFlags,
    ...lzCloneFlags,
    ...usdcAccountFlag(walletPubkey),
    ...usdaiAccountFlag(walletPubkey),
]
console.log(`starting ${validatorVersion} with ${cloneFlags.length / 2} cloned Jupiter entries${canWarp ? ', warped to mainnet slot' : ' (no warp: borrow step will skip)'}`)
const validator = spawn(VALIDATOR, args, { stdio: ['ignore', 'inherit', 'inherit'] })
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
            ['ts-mocha', '-p', './tsconfig.json', '-t', '600000', 'tests/fork/custody.fork.test.ts', 'tests/fork/bridge-lz.fork.test.ts'],
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
