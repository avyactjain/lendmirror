/**
 * Print every mainnet account a Jupiter `operate` on one vault touches, as
 * `--clone` / `--clone-upgradeable-program` flags for solana-test-validator.
 *
 * Read-only. Usage (needs RPC_URL_SOLANA_MAINNET in .env):
 *   npx ts-node tests/fork/dump-accounts.ts [vaultId] [nftId] [fundedProbeSigner] > tests/fork/clone-flags.txt
 *
 * The fork test (`tests/fork/custody.fork.test.ts`) starts a validator with these flags,
 * so it sees a copy of the real vault: config, state, liquidity reserves, rate models,
 * oracle and its sources, token mints, and Jupiter's lookup tables.
 */
import 'dotenv/config'

import BN from 'bn.js'
import { Connection, PublicKey } from '@solana/web3.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loadEsm = new Function('s', 'return import(s)') as (s: string) => Promise<any>

async function main() {
    const vaultId = Number(process.argv[2] ?? 1)
    const nftId = Number(process.argv[3] ?? 1)
    // Public RPC is enough for ~50 reads. A paid RPC is faster and is used when set.
    const url = process.env.RPC_URL_SOLANA_MAINNET || 'https://api.mainnet-beta.solana.com'
    const connection = new Connection(url, 'confirmed')
    const { getOperateIx, getInitPositionIx, getVaultsProgramId, getLiquidityProgramId, getOracleProgramId } =
        await loadEsm('@jup-ag/lend/borrow')

    // The SDK simulates a price read with `signer` as fee payer, so the probe must be a
    // funded mainnet account. Nothing is signed or sent. Default: our mainnet admin.
    const probe = new PublicKey(process.argv[4] ?? 'B8HnbEgetyiAdvkbgZR7LsChh93KR3jWuSw6xSQxt1hL')
    const r = await getOperateIx({
        vaultId,
        positionId: nftId,
        colAmount: new BN(1),
        debtAmount: new BN(0),
        connection,
        signer: probe,
        includeATASetup: false,
        includeWrapSol: false,
    })

    const programs = new Set<string>([
        String(getVaultsProgramId('main')),
        String(getLiquidityProgramId('main')),
        String(getOracleProgramId('main')),
    ])
    const accounts = new Set<string>()
    const skip = new Set<string>([
        probe.toBase58(),
        '11111111111111111111111111111111',
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
        'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    ])
    for (const key of Object.values(r.accounts)) {
        if (key && !skip.has(key.toBase58()) && !programs.has(key.toBase58())) accounts.add(key.toBase58())
    }
    // init_position needs vault_admin and friends, which operate does not touch.
    const init = await getInitPositionIx({ vaultId, connection, signer: probe })
    for (const meta of init.ix.keys) {
        const key = meta.pubkey.toBase58()
        if (!skip.has(key) && !programs.has(key)) accounts.add(key)
    }
    for (const m of r.remainingAccounts) accounts.add(m.pubkey.toBase58())
    for (const t of r.addressLookupTableAddresses) accounts.add(t.toBase58())
    // Accounts the SDK reads but no instruction lists, plus what a brand-new position (tick
    // = INIT) touches. The existence filter below drops any that are not on chain.
    const vaults = getVaultsProgramId('main')
    const vaultLe = Buffer.alloc(2)
    vaultLe.writeUInt16LE(vaultId)
    const initTickSeed = Buffer.alloc(4)
    initTickSeed.writeUInt32LE(0) // normalized INIT tick (-16383) + 16383
    for (const seeds of [
        [Buffer.from('vault_metadata'), vaultLe],
        [Buffer.from('vault_admin'), vaultLe],
        [Buffer.from('tick'), vaultLe, initTickSeed],
    ]) {
        accounts.add(PublicKey.findProgramAddressSync(seeds, vaults)[0].toBase58())
    }
    // Jupiter keeps "which ticks have debt" bitmaps in TickHasDebtArray accounts indexed by
    // tick range. An operate touches the array for its final tick, which depends on amounts we
    // cannot predict here, so take every array that exists (the existence filter drops the rest).
    // Seeds from the IDL: ["tick_has_debt", vault_id u16 le, index u8].
    for (let index = 0; index < 256; index++) {
        accounts.add(
            PublicKey.findProgramAddressSync([Buffer.from('tick_has_debt'), vaultLe, Buffer.from([index])], vaults)[0].toBase58()
        )
    }
    // Accounts derived from the probe signer do not exist on chain; drop them.
    const existing: string[] = []
    const keys = [...accounts].map((k) => new PublicKey(k))
    for (let i = 0; i < keys.length; i += 100) {
        const infos = await connection.getMultipleAccountsInfo(keys.slice(i, i + 100))
        infos.forEach((info, j) => {
            if (info) existing.push(keys[i + j].toBase58())
        })
    }

    for (const p of programs) console.log(`--clone-upgradeable-program ${p}`)
    for (const a of existing.sort()) console.log(`--clone ${a}`)
    console.error(`vault ${vaultId} nft ${nftId}: ${programs.size} programs, ${existing.length} accounts`)
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
