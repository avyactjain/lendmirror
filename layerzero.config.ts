import { EndpointId } from '@layerzerolabs/lz-definitions'
import { ExecutorOptionType } from '@layerzerolabs/lz-v2-utilities'
import { TwoWayConfig, generateConnectionsConfig } from '@layerzerolabs/metadata-tools'
import { OAppEnforcedOption, OmniPointHardhat } from '@layerzerolabs/toolbox-hardhat'

import { getSolanaOAppAddress } from './tasks/solana'

const arbitrumContract: OmniPointHardhat = {
    eid: EndpointId.ARBITRUM_V2_MAINNET, // 30110
    contractName: 'LendMirror',
}

const solanaContract: OmniPointHardhat = {
    eid: EndpointId.SOLANA_V2_MAINNET, // 30168
    address: getSolanaOAppAddress(EndpointId.SOLANA_V2_MAINNET),
}

const EVM_ENFORCED_OPTIONS: OAppEnforcedOption[] = [
    {
        msgType: 1,
        optionType: ExecutorOptionType.LZ_RECEIVE,
        gas: 400_000,
    },
]

const SOLANA_ENFORCED_OPTIONS: OAppEnforcedOption[] = [
    {
        msgType: 1,
        optionType: ExecutorOptionType.LZ_RECEIVE,
        gas: 100_000,
    },
]

const pathways: TwoWayConfig[] = [
    [
        arbitrumContract,
        solanaContract,
        [['LayerZero Labs'], []],
        [20, 32],
        [SOLANA_ENFORCED_OPTIONS, EVM_ENFORCED_OPTIONS],
    ],
]

export default async function () {
    const connections = await generateConnectionsConfig(pathways)
    return {
        contracts: [{ contract: arbitrumContract }, { contract: solanaContract }],
        connections,
    }
}