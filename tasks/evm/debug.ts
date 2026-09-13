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

const action: ActionType<DebugTaskArgs> = async ({ contractName }, hre: HardhatRuntimeEnvironment) => {
    const contract = await hre.ethers.getContract(contractName)

    const last = (await (contract as unknown as { lastPrice: () => Promise<LastPrice> }).lastPrice()) as LastPrice

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
}

task('lz:oapp:evm:debug', 'Reads the last Pyth snapshot on the EVM OApp', action).addOptionalParam(
    'contractName',
    'Name of the deployed EVM OApp contract (default: LendMirror)',
    'LendMirror',
    types.string
)
