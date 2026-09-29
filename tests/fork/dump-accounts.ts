/**
 * Print every mainnet account a Jupiter `operate_dex` on one smart vault touches, as
 * `--clone` / `--clone-upgradeable-program` flags for solana-test-validator.
 *
 * Read-only. Usage (needs RPC_URL_SOLANA_MAINNET in .env):
 *   npx ts-node tests/fork/dump-accounts.ts [vaultId] [nftId] [fundedProbeSigner] > tests/fork/clone-flags.txt
 *
 * The fork test (`tests/fork/custody.fork.test.ts`) starts a validator with these flags, so it
 * sees a copy of the real vault: config, state, the collateral/debt pool (DEX) accounts,
 * liquidity reserves, rate models, oracle and its sources, token mints, and lookup tables.
 * Default vault 95: USDG/USDC smart collateral, USDC debt (a T2 vault).
 */
import 'dotenv/config'

import BN from 'bn.js'
import { Connection, PublicKey } from '@solana/web3.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loadEsm = new Function('s', 'return import(s)') as (s: string) => Promise<any>

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

async function main() {
    const vaultId = Number(process.argv[2] ?? 95)
    const nftId = Number(process.argv[3] ?? 34)
    const url = process.env.RPC_URL_SOLANA_MAINNET || 'https://api.mainnet-beta.solana.com'
    const connection = new Connection(url, 'confirmed')
    const sdk = await loadEsm('@jup-ag/lend/borrow')

    // The SDK simulates a price read with `signer` as fee payer, so the probe must be a funded
    // mainnet account; it should also own a position in this vault for the probes to build.
    // Nothing is signed or sent. Default: the owner of position 95/34.
    const probe = new PublicKey(process.argv[4] ?? 'HgyDJt5yGiPVUaTrfssF3VkdhRZ4BNdtnsCFE9pcPRHv')
    const dex = await sdk.resolveDexVault({ vaultId, program: sdk.getVaultsProgram({ connection, signer: probe }), connection })
    const usdcSide = dex.token0.toBase58() === USDC ? 'token0' : 'token1'
    const one = new BN(1_000_000)

    // Probe each kind of call, so the clone list covers every account any of them touches.
    const probes = [
        { col: { action: 'supply', input: { [usdcSide]: one } } },
        { debt: { action: 'borrow', input: { amount: one } } },
        { debt: { action: 'payback', input: { amount: one } } },
    ]
    const programs = new Set<string>([
        String(sdk.getVaultsProgramId('main')),
        String(sdk.getLiquidityProgramId('main')),
        String(sdk.getOracleProgramId('main')),
        String(sdk.getDexProgramId('main')),
    ])
    const skip = new Set<string>([
        probe.toBase58(),
        '11111111111111111111111111111111',
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
        'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
        'ComputeBudget111111111111111111111111111111',
        // Cloned by tests/fork/run.cjs itself.
        'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
    ])
    const accounts = new Set<string>()
    const add = (key: PublicKey | null | undefined) => {
        if (!key) return
        const k = key.toBase58()
        if (!skip.has(k) && !programs.has(k)) accounts.add(k)
    }
    for (const legs of probes) {
        const r = await sdk.getOperateDexIx({ vaultId, positionId: nftId, connection, signer: probe, includeATASetup: false, includeWrapSol: false, ...legs })
        for (const ix of r.ixs) for (const meta of ix.keys) add(meta.pubkey)
        for (const t of r.addressLookupTableAddresses) add(t)
    }
    for (const t of dex.dexLookupTables) add(t)
    // init_position needs vault_admin and friends, which operate does not touch.
    const init = await sdk.getInitPositionIx({ vaultId, connection, signer: probe })
    for (const meta of init.ix.keys) add(meta.pubkey)

    // Accounts the SDK reads but no instruction lists, plus what a brand-new position (tick =
    // INIT) touches. The existence filter below drops any that are not on chain.
    const vaults = sdk.getVaultsProgramId('main')
    const vaultLe = Buffer.alloc(2)
    vaultLe.writeUInt16LE(vaultId)
    const initTickSeed = Buffer.alloc(4)
    initTickSeed.writeUInt32LE(0) // normalized INIT tick (-16383) + 16383
    for (const seeds of [
        [Buffer.from('vault_metadata'), vaultLe],
        [Buffer.from('vault_admin'), vaultLe],
        [Buffer.from('tick'), vaultLe, initTickSeed],
    ]) {
        add(PublicKey.findProgramAddressSync(seeds, vaults)[0])
    }
    // "Which ticks have debt" bitmaps, indexed by tick range. An operate touches the array for
    // its final tick, which depends on amounts; take every array that exists.
    // Seeds from the IDL: ["tick_has_debt", vault_id u16 le, index u8].
    for (let index = 0; index < 256; index++) {
        add(PublicKey.findProgramAddressSync([Buffer.from('tick_has_debt'), vaultLe, Buffer.from([index])], vaults)[0])
    }
    // The DEX pool's metadata account holds its lookup table and is read by the SDK.
    if (dex.supplyDex) {
        const dexProgram = sdk.getDexProgramId('main')
        const dexIdLe = Buffer.alloc(2)
        const pool = await connection.getAccountInfo(dex.supplyDex)
        if (pool) {
            // Dex account: 8-byte discriminator, then dex_id u16 le.
            dexIdLe.writeUInt16LE(pool.data.readUInt16LE(8))
            add(PublicKey.findProgramAddressSync([Buffer.from('dex_metadata'), dexIdLe], dexProgram)[0])
        }
    }

    // Accounts derived from the probe signer's position do exist, but the fork opens its own.
    const existing: string[] = []
    const keys = [...accounts].map((k) => new PublicKey(k))
    for (let i = 0; i < keys.length; i += 100) {
        const infos = await connection.getMultipleAccountsInfo(keys.slice(i, i + 100))
        infos.forEach((info, j) => {
            if (!info) return
            // Programs found among the accounts (oracle source programs) are cloned as programs.
            if (info.executable) {
                if (!skip.has(keys[i + j].toBase58())) programs.add(keys[i + j].toBase58())
            } else existing.push(keys[i + j].toBase58())
        })
    }

    for (const p of programs) console.log(`--clone-upgradeable-program ${p}`)
    for (const a of existing.sort()) console.log(`--clone ${a}`)
    console.error(`vault ${vaultId} (type ${dex.vaultType}): ${programs.size} programs, ${existing.length} accounts`)
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
