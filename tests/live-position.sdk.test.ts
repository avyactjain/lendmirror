/**
 * Jupiter side: `getPositionByVaultIdV2`.
 * Our side: the Rust program (`cargo run --bin live-position`).
 *
 * Needs `RPC_URL_SOLANA_MAINNET`. Optional: `JUP_VAULT_ID` (default 1), `JUP_NFT_ID` (default 1).
 *
 *   npm run test:jup-live
 */
import 'dotenv/config'

import { execFileSync } from 'child_process'
import path from 'path'
import { expect } from 'chai'

const rpcUrl = process.env.RPC_URL_SOLANA_MAINNET
const vaultId = Number(process.env.JUP_VAULT_ID ?? 1)
const nftId = Number(process.env.JUP_NFT_ID ?? 1)

type SdkBranch = {
    branchId: number
    status: number
    minimaTick: number
    minimaTickPartials: number
    debtFactor: string
    connectedBranchId: number
}

type SdkRead = {
    supply: string
    borrow: string
    dustBorrow: string
    beforeSupply: string
    beforeBorrow: string
    beforeDustBorrow: string
    storedTick: number
    storedColRaw: string
    storedDustDebt: string
    tick: number
    tickId: number
    isSupplyPosition: boolean
    isLiquidated: boolean
    supplyPx: string
    borrowPx: string
    tickTotalIds: number
    tickIsLiquidated: boolean
    recordOnTick: boolean
    startBranchId: number
    connectionFactor: string
    isFullyLiquidated: boolean
    branches: SdkBranch[]
}

function text(value: { toString(): string } | number | string | undefined): string {
    return value == null ? '' : value.toString()
}

async function readFromJupiterSdk(vault: number, nft: number): Promise<SdkRead> {
    const loadSdk = new Function('s', 'return import(s)') as (
        s: string
    ) => Promise<typeof import('@jup-ag/lend-read')>
    const { Client } = await loadSdk('@jup-ag/lend-read')
    const client = new Client(rpcUrl!)
    const position = await client.vault.getPositionByVaultIdV2(vault, nft)
    const raw = await client.vault.getUserPosition({ vaultId: vault, positionId: nft })
    if (!raw) {
        throw new Error(`no position ${vault}/${nft}`)
    }
    const storedTick = Number(raw.tick) === -2147483648 ? -16383 : Number(raw.tick)
    const tickId = Number(raw.tickId)
    const tickData = await client.vault.getTick({ vaultId: vault, tick: storedTick })
    if (!tickData) {
        throw new Error(`no tick ${storedTick}`)
    }
    const totalIds = Number(tickData.totalIds)
    let recordOnTick = true
    let startBranchId = Number(tickData.liquidationBranchId)
    let connectionFactor = text(tickData.debtFactor)
    let isFullyLiquidated = Number(tickData.isFullyLiquidated) === 1
    if (totalIds !== tickId) {
        recordOnTick = false
        const liq = await client.vault.getTickIdLiquidation({
            vaultId: vault,
            tick: storedTick,
            totalIds: tickId,
        })
        const slot = ((tickId + 2) % 3) + 1
        startBranchId = Number(liq[`liquidationBranchId${slot}`])
        connectionFactor = text(liq[`debtFactor${slot}`])
        isFullyLiquidated = Number(liq[`isFullyLiquidated${slot}`]) === 1
    }
    const branches: SdkBranch[] = []
    if (position.isLiquidated && !isFullyLiquidated) {
        let next = startBranchId
        for (let hop = 0; hop < 32; hop++) {
            const branch = await client.vault.getBranch({ vaultId: vault, branchId: next })
            if (!branch) break
            branches.push({
                branchId: Number(branch.branchId),
                status: Number(branch.status),
                minimaTick: Number(branch.minimaTick),
                minimaTickPartials: Number(branch.minimaTickPartials),
                debtFactor: text(branch.debtFactor),
                connectedBranchId: Number(branch.connectedBranchId),
            })
            if (Number(branch.status) !== 2) break
            next = Number(branch.connectedBranchId)
        }
    }
    const prices = position.vault.exchangePricesAndRates
    return {
        supply: text(position.supply),
        borrow: text(position.borrow),
        dustBorrow: text(position.dustBorrow),
        beforeSupply: text(position.beforeSupply),
        beforeBorrow: text(position.beforeBorrow),
        beforeDustBorrow: text(position.beforeDustBorrow),
        storedTick,
        storedColRaw: text(raw.supplyAmount),
        storedDustDebt: text(raw.dustDebtAmount),
        tick: position.tick,
        tickId,
        isSupplyPosition: Boolean(position.isSupplyPosition),
        isLiquidated: Boolean(position.isLiquidated),
        supplyPx: text(prices.vaultSupplyExchangePrice),
        borrowPx: text(prices.vaultBorrowExchangePrice),
        tickTotalIds: totalIds,
        tickIsLiquidated: Number(tickData.isLiquidated) === 1,
        recordOnTick,
        startBranchId,
        connectionFactor,
        isFullyLiquidated,
        branches,
    }
}

type Ours = {
    storedTick: number
    storedColRaw: string
    storedDebtRaw: string
    tickId: number
    tickTotalIds: number
    tickIsLiquidated: boolean
    recordOnTick: boolean
    startBranchId: number
    connectionFactor: string
    branches: {
        branchId: number
        status: number
        minimaTick: number
        minimaTickPartials: number
        debtFactor: string
        connectedBranchId: number
    }[]
    tick: number
    colRaw: string
    debtRaw: string
    dustDebt: string
    isSupplyOnly: boolean
    isLiquidated: boolean
    isFullyLiquidated: boolean
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

        const scale = 10n ** 12n
        const supplyPx = BigInt(fromSdk.supplyPx)
        const borrowPx = BigInt(fromSdk.borrowPx)
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
        const priced = {
            supply: ((colRaw * supplyPx) / scale).toString(),
            borrow: ((debt * borrowPx) / scale).toString(),
            dustBorrow: ((dust * borrowPx) / scale).toString(),
        }

        console.log(`\nvault ${vaultId} nft ${nftId}`)
        console.log('jupiter', JSON.stringify(fromSdk, null, 2))
        console.log('ours', JSON.stringify({ ...fromOurs, priced }, null, 2))

        expect(priced.supply).to.equal(fromSdk.supply)
        expect(priced.dustBorrow).to.equal(fromSdk.dustBorrow)
        expect(priced.borrow).to.equal(fromSdk.borrow)
        expect(fromOurs.isSupplyOnly).to.equal(fromSdk.isSupplyPosition)
        if (!fromOurs.isSupplyOnly) {
            expect(fromOurs.tick).to.equal(fromSdk.tick)
        }
        expect(fromOurs.isLiquidated).to.equal(fromSdk.isLiquidated)
    })
})
