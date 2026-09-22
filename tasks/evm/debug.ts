import { task, types } from 'hardhat/config'
import { ActionType, HardhatRuntimeEnvironment } from 'hardhat/types'

import { DebugLogger } from '../common/utils'

interface DebugTaskArgs {
    contractName: string
}

type LastPosition = {
    position: string
    vaultId: { toString(): string }
    nftId: { toString(): string }
    positionMint: string
    supplyToken: string
    borrowToken: string
    colRaw: { toString(): string }
    debtRaw: { toString(): string }
    dustDebt: { toString(): string }
    netDebt: { toString(): string }
    tick: { toString(): string }
    tickId: { toString(): string }
    storedColRaw: { toString(): string }
    storedDebtRaw: { toString(): string }
    storedTick: { toString(): string }
    isSupplyOnly: boolean
    isLiquidated: boolean
    isFullyLiquidated: boolean
    branchId: { toString(): string }
    vaultSupplyExchangePrice: { toString(): string }
    vaultBorrowExchangePrice: { toString(): string }
    snapshotTime: { toString(): string }
}

const action: ActionType<DebugTaskArgs> = async ({ contractName }, hre: HardhatRuntimeEnvironment) => {
    const contract = await hre.ethers.getContract(contractName)
    const evm = contract as unknown as {
        lastPosition: () => Promise<LastPosition>
        lastUpdatedTs: () => Promise<{ toString(): string }>
        lastUpdatedBlock: () => Promise<{ toString(): string }>
    }

    const pos = (await evm.lastPosition()) as LastPosition
    const priced = (await (
        contract as unknown as {
            pricedPosition: () => Promise<{
                supply: { toString(): string }
                borrow: { toString(): string }
                dustBorrow: { toString(): string }
            }>
        }
    ).pricedPosition())
    const lastUpdatedTs = await evm.lastUpdatedTs()
    const lastUpdatedBlock = await evm.lastUpdatedBlock()
    DebugLogger.header('EVM OApp last Jupiter snapshot')
    DebugLogger.keyValue('Network', hre.network.name)
    DebugLogger.keyValue('Contract Name', contractName)
    DebugLogger.keyValue('Contract Address', contract.address)
    DebugLogger.keyValue('lastUpdatedTs', lastUpdatedTs.toString())
    DebugLogger.keyValue('lastUpdatedBlock', lastUpdatedBlock.toString())
    DebugLogger.keyValue('position', pos.position)
    DebugLogger.keyValue('vaultId', pos.vaultId.toString())
    DebugLogger.keyValue('nftId', pos.nftId.toString())
    DebugLogger.keyValue('colRaw', pos.colRaw.toString())
    DebugLogger.keyValue('debtRaw', pos.debtRaw.toString())
    DebugLogger.keyValue('dustDebt', pos.dustDebt.toString())
    DebugLogger.keyValue('netDebt', pos.netDebt.toString())
    DebugLogger.keyValue('supply', priced.supply.toString())
    DebugLogger.keyValue('borrow', priced.borrow.toString())
    DebugLogger.keyValue('dustBorrow', priced.dustBorrow.toString())
    DebugLogger.keyValue('tick', pos.tick.toString())
    DebugLogger.keyValue('tickId', pos.tickId.toString())
    DebugLogger.keyValue('storedColRaw', pos.storedColRaw.toString())
    DebugLogger.keyValue('storedDebtRaw', pos.storedDebtRaw.toString())
    DebugLogger.keyValue('storedTick', pos.storedTick.toString())
    DebugLogger.keyValue('isSupplyOnly', String(pos.isSupplyOnly))
    DebugLogger.keyValue('isLiquidated', String(pos.isLiquidated))
    DebugLogger.keyValue('isFullyLiquidated', String(pos.isFullyLiquidated))
    DebugLogger.keyValue('branchId', pos.branchId.toString())
    DebugLogger.keyValue('supplyToken', pos.supplyToken)
    DebugLogger.keyValue('borrowToken', pos.borrowToken)
    DebugLogger.keyValue('vaultSupplyExchangePrice', pos.vaultSupplyExchangePrice.toString())
    DebugLogger.keyValue('vaultBorrowExchangePrice', pos.vaultBorrowExchangePrice.toString())
    DebugLogger.keyValue('snapshotTime', pos.snapshotTime.toString())
    DebugLogger.separator()
}

task('lz:oapp:evm:debug', 'Reads lastPosition on the EVM OApp', action).addOptionalParam(
    'contractName',
    'Name of the deployed EVM OApp contract (default: LendMirror)',
    'LendMirror',
    types.string
)
