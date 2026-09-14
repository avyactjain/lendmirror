import { task, types } from 'hardhat/config'
import { ActionType, HardhatRuntimeEnvironment } from 'hardhat/types'

import { DebugLogger } from '../common/utils'

interface DebugTaskArgs {
    contractName: string
}

type LastPrice = {
    pythAccount: string
    feedId: string
    price: { toString(): string }
    conf: { toString(): string }
    exponent: { toString(): string }
    publishTime: { toString(): string }
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
    isSupplyOnly: boolean
    isLiquidated: boolean
    vaultSupplyExchangePrice: { toString(): string }
    vaultBorrowExchangePrice: { toString(): string }
    snapshotTime: { toString(): string }
}

const action: ActionType<DebugTaskArgs> = async ({ contractName }, hre: HardhatRuntimeEnvironment) => {
    const contract = await hre.ethers.getContract(contractName)
    const evm = contract as unknown as {
        lastPrice: () => Promise<LastPrice>
        lastPosition: () => Promise<LastPosition>
    }

    const last = (await evm.lastPrice()) as LastPrice
    DebugLogger.header('EVM OApp last Pyth snapshot')
    DebugLogger.keyValue('Network', hre.network.name)
    DebugLogger.keyValue('Contract Name', contractName)
    DebugLogger.keyValue('Contract Address', contract.address)
    DebugLogger.keyValue('pythAccount', last.pythAccount)
    DebugLogger.keyValue('feedId', last.feedId)
    DebugLogger.keyValue('price', last.price.toString())
    DebugLogger.keyValue('conf', last.conf.toString())
    DebugLogger.keyValue('exponent', last.exponent.toString())
    DebugLogger.keyValue('publishTime', last.publishTime.toString())
    DebugLogger.separator()

    const pos = (await evm.lastPosition()) as LastPosition
    DebugLogger.header('EVM OApp last Jupiter snapshot')
    DebugLogger.keyValue('position', pos.position)
    DebugLogger.keyValue('vaultId', pos.vaultId.toString())
    DebugLogger.keyValue('nftId', pos.nftId.toString())
    DebugLogger.keyValue('colRaw', pos.colRaw.toString())
    DebugLogger.keyValue('debtRaw', pos.debtRaw.toString())
    DebugLogger.keyValue('netDebt', pos.netDebt.toString())
    DebugLogger.keyValue('tick', pos.tick.toString())
    DebugLogger.keyValue('isSupplyOnly', String(pos.isSupplyOnly))
    DebugLogger.keyValue('isLiquidated', String(pos.isLiquidated))
    DebugLogger.keyValue('supplyToken', pos.supplyToken)
    DebugLogger.keyValue('borrowToken', pos.borrowToken)
    DebugLogger.keyValue('snapshotTime', pos.snapshotTime.toString())
    DebugLogger.separator()
}

task('lz:oapp:evm:debug', 'Reads lastPrice and lastPosition on the EVM OApp', action).addOptionalParam(
    'contractName',
    'Name of the deployed EVM OApp contract (default: LendMirror)',
    'LendMirror',
    types.string
)
