/**
 * Jupiter side: `getPositionByVaultIdV2`.
 * Our side: the Rust program (`cargo run --bin live-position`).
 *
 * Needs `RPC_URL_SOLANA`. Optional: `JUP_VAULT_ID` (default 1), `JUP_NFT_ID` (default 1).
 *
 *   npm run test:jup-live
 */
import 'dotenv/config'

import { execFileSync } from 'child_process'
import path from 'path'
import { expect } from 'chai'

const rpcUrl = process.env.RPC_URL_SOLANA
const vaultId = Number(process.env.JUP_VAULT_ID ?? 1)
const nftId = Number(process.env.JUP_NFT_ID ?? 1)

type Amount = { toString(): string }

type SdkPosition = {
    supply: Amount
    borrow: Amount
    dustBorrow: Amount
    tick: number
    isSupplyPosition: boolean
    isLiquidated: boolean
    vault: {
        exchangePricesAndRates: {
            vaultSupplyExchangePrice: Amount
            vaultBorrowExchangePrice: Amount
        }
    }
}

async function readFromJupiterSdk(vault: number, nft: number): Promise<SdkPosition> {
    const loadSdk = new Function('s', 'return import(s)') as (
        s: string
    ) => Promise<typeof import('@jup-ag/lend-read')>
    const { Client } = await loadSdk('@jup-ag/lend-read')
    const client = new Client(rpcUrl!)
    return client.vault.getPositionByVaultIdV2(vault, nft)
}

type Ours = {
    tick: number
    colRaw: string
    debtRaw: string
    dustDebt: string
    isSupplyOnly: boolean
    isLiquidated: boolean
}

function readFromOurLogic(vault: number, nft: number): Ours {
    const out = execFileSync(
        'cargo',
        ['run', '--quiet', '--bin', 'live-position', '--', String(vault), String(nft)],
        {
            cwd: path.join(__dirname, '..', 'crates', 'jup-tick-parity'),
            encoding: 'utf8',
            env: process.env,
            timeout: 240_000,
        }
    )
    return JSON.parse(out.trim())
}

describe('live position vs Jupiter read SDK', function () {
    this.timeout(300_000)

    before(function () {
        if (!rpcUrl) {
            this.skip()
        }
    })

    it('matches getPositionByVaultIdV2 for the same vault + nft', async () => {
        const fromSdk = await readFromJupiterSdk(vaultId, nftId)
        const fromOurs = await readFromOurLogic(vaultId, nftId)

        const prices = fromSdk.vault.exchangePricesAndRates
        const scale = 10n ** 12n
        const supplyPx = BigInt(prices.vaultSupplyExchangePrice.toString())
        const borrowPx = BigInt(prices.vaultBorrowExchangePrice.toString())
        const colRaw = BigInt(fromOurs.colRaw)
        let debt = BigInt(fromOurs.debtRaw)
        let dust = BigInt(fromOurs.dustDebt)
        // Jupiter subtracts dust from borrow, and reports both as 0 when dust covers the debt.
        if (debt > dust) {
            debt -= dust
        } else {
            debt = 0n
            dust = 0n
        }

        expect((colRaw * supplyPx) / scale).to.equal(BigInt(fromSdk.supply.toString()))
        expect((dust * borrowPx) / scale).to.equal(BigInt(fromSdk.dustBorrow.toString()))
        expect((debt * borrowPx) / scale).to.equal(BigInt(fromSdk.borrow.toString()))
        expect(fromOurs.isSupplyOnly).to.equal(Boolean(fromSdk.isSupplyPosition))
        if (!fromOurs.isSupplyOnly) {
            expect(fromOurs.tick).to.equal(fromSdk.tick)
        }
        expect(fromOurs.isLiquidated).to.equal(Boolean(fromSdk.isLiquidated))

        console.log(
            `vault ${vaultId} nft ${nftId}: tick=${fromOurs.tick} col=${fromOurs.colRaw} debt=${fromOurs.debtRaw} liquidated=${fromOurs.isLiquidated}`
        )
    })
})
