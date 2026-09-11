import { EndpointId } from '@layerzerolabs/lz-definitions'
import { ExecutorOptionType } from '@layerzerolabs/lz-v2-utilities'
import { TwoWayConfig, generateConnectionsConfig } from '@layerzerolabs/metadata-tools'
import { OAppEnforcedOption, OmniPointHardhat } from '@layerzerolabs/toolbox-hardhat'

import { getSolanaOAppAddress } from './tasks/solana'

const sepoliaContract: OmniPointHardhat = {
    eid: EndpointId.SEPOLIA_V2_TESTNET, // 40161
    contractName: 'LendMirror',
}

const solanaContract: OmniPointHardhat = {
    eid: EndpointId.SOLANA_V2_TESTNET, // 40168 = Solana Devnet
    // This is the Store PDA, not the program id. Created by lz:oapp:solana:create.
    address: getSolanaOAppAddress(EndpointId.SOLANA_V2_TESTNET),
}

// For this example's simplicity, we will use the same enforced options values for sending to all chains
// For production, you should ensure `gas` is set to the correct value through profiling the gas usage of calling OApp._lzReceive(...) on the destination chain
// To learn more, read https://docs.layerzero.network/v2/concepts/applications/oapp-standard#execution-options-and-enforced-settings
const EVM_ENFORCED_OPTIONS: OAppEnforcedOption[] = [
    {
        msgType: 1,
        optionType: ExecutorOptionType.LZ_RECEIVE,
        gas: 100_000,
    },
]

const SOLANA_ENFORCED_OPTIONS: OAppEnforcedOption[] = [
    {
        msgType: 1,
        optionType: ExecutorOptionType.LZ_RECEIVE,
        gas: 100_000,
    },
]

// LendMirror path: Solana Devnet → Ethereum Sepolia.
// generateConnectionsConfig also wires the reverse path. We send on Solana only.
const pathways: TwoWayConfig[] = [
    [
        sepoliaContract,
        solanaContract,
        [['LayerZero Labs'], []], // Piece 8 adds Chainlink as a required DVN
        [20, 32], // [Sepolia → Solana confirmations, Solana → Sepolia confirmations]
        [SOLANA_ENFORCED_OPTIONS, EVM_ENFORCED_OPTIONS],
    ],
]

export default async function () {
    const connections = await generateConnectionsConfig(pathways)
    return {
        contracts: [{ contract: sepoliaContract }, { contract: solanaContract }],
        connections,
    }
}
