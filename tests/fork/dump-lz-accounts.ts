/**
 * Print every mainnet account the USDai LayerZero send touches, as `--clone` /
 * `--clone-upgradeable-program` flags for solana-test-validator, and save a real USDai
 * token account's raw data as a fixture (`tests/fork/usdai-account.json`) so the fork can
 * give the test wallet a funded USDai account at genesis (nobody can mint USDai on a fork;
 * a hand-built account would miss the Token-2022 extension TLV the mint demands).
 *
 * Read-only. Usage (RPC_URL_SOLANA_MAINNET in .env, or the public endpoint):
 *   npx ts-node tests/fork/dump-lz-accounts.ts > tests/fork/lz-clone-flags.txt
 */
import 'dotenv/config'

import { writeFileSync } from 'node:fs'

import { Connection, PublicKey } from '@solana/web3.js'

import mainnet from '../../config/mainnet'

const SKIP = new Set([
    '11111111111111111111111111111111',
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    'ComputeBudget111111111111111111111111111111',
    // Cloned by tests/fork/run.cjs itself.
    '76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6',
    '2uk9pQh3tB5ErV7LGQJcbWjb4KeJ2UJki5qJZ8QG56G3',
])

async function main() {
    const url = process.env.RPC_URL_SOLANA_MAINNET || 'https://api.mainnet-beta.solana.com'
    const connection = new Connection(url, 'confirmed')
    const token = mainnet.lzTokens.find((t) => t.symbol === 'USDai')
    if (!token) throw new Error('USDai missing from config')

    const keys = new Set<string>([token.mint, token.lookupTable, token.issuerProgram])
    for (const a of token.accounts) {
        // The template signer's slots are replaced by the test wallet; skip them.
        if (a.key !== token.templateSigner) keys.add(a.key)
    }

    const programs: string[] = []
    const accounts: string[] = []
    const list = [...keys].map((k) => new PublicKey(k))
    for (let i = 0; i < list.length; i += 100) {
        const infos = await connection.getMultipleAccountsInfo(list.slice(i, i + 100))
        infos.forEach((info, j) => {
            const key = list[i + j].toBase58()
            if (SKIP.has(key) || !info) return // a missing account (e.g. an exemption PDA) stays missing on the fork
            if (info.executable) programs.push(key)
            else accounts.push(key)
        })
    }
    for (const p of programs) console.log(`--clone-upgradeable-program ${p}`)
    for (const a of accounts.sort()) console.log(`--clone ${a}`)

    // A funded USDai token account to use as the genesis fixture. The holder found by the
    // largest-accounts scan; any token account of this mint works, the runner patches the
    // owner and amount bytes.
    const largest = await connection.getTokenLargestAccounts(new PublicKey(token.mint))
    const source = largest.value.find((v) => BigInt(v.amount) > 0n)
    if (!source) throw new Error('no funded USDai account found')
    const info = await connection.getAccountInfo(source.address)
    if (!info) throw new Error('holder account vanished')
    writeFileSync(
        'tests/fork/usdai-account.json',
        JSON.stringify({ space: info.data.length, data: info.data.toString('base64') }) + '\n'
    )
    console.error(
        `${programs.length} programs, ${accounts.length} accounts; fixture from ${source.address.toBase58()} (${info.data.length} bytes)`
    )
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
