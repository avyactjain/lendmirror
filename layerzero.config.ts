import { EndpointId } from '@layerzerolabs/lz-definitions'
import { ExecutorOptionType } from '@layerzerolabs/lz-v2-utilities'
import { TwoWayConfig, generateConnectionsConfig } from '@layerzerolabs/metadata-tools'
import { OAppEnforcedOption, OmniPointHardhat } from '@layerzerolabs/toolbox-hardhat'

import { getProfile } from './lib/deployment'
import { getSolanaOAppAddress } from './tasks/solana'

const profile = getProfile()

const evmContract: OmniPointHardhat = {
    eid: profile.evmEid as EndpointId,
    contractName: 'LendMirror',
}

const solanaContract: OmniPointHardhat = {
    eid: profile.solanaEid as EndpointId,
    address: getSolanaOAppAddress(profile.solanaEid as EndpointId),
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
        evmContract,
        solanaContract,
        [['LayerZero Labs'], []],
        [20, 32],
        [SOLANA_ENFORCED_OPTIONS, EVM_ENFORCED_OPTIONS],
    ],
]

export default async function () {
    const connections = await generateConnectionsConfig(pathways)
    return {
        contracts: [{ contract: evmContract }, { contract: solanaContract }],
        connections,
    }
}
