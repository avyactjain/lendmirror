// Force ts-node to use CommonJS mode
// This must be set before any imports
process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({
    module: 'commonjs',
    esModuleInterop: true,
})

import 'dotenv/config'

import 'hardhat-deploy'
import '@nomicfoundation/hardhat-ethers'
import 'hardhat-contract-sizer'
import '@nomiclabs/hardhat-ethers'
import 'hardhat-deploy-ethers'
import '@layerzerolabs/toolbox-hardhat'
import { HardhatUserConfig, HttpNetworkAccountsUserConfig } from 'hardhat/types'

import { EndpointId } from '@layerzerolabs/lz-definitions'

import { getProfile } from './lib/deployment'

import './tasks/index'

const profile = getProfile()

function accountsFor(envName: string): HttpNetworkAccountsUserConfig | undefined {
    const key = process.env[envName]?.trim()
    if (!key) {
        console.warn(`Missing ${envName}. EVM writes for DEPLOYMENT_TYPE=${profile.type} will fail.`)
        return undefined
    }
    return [key]
}

const activeAccounts = accountsFor(profile.env.evmPrivateKey)
const activeEvmRpc = process.env[profile.env.evmRpc]?.trim()
if (!activeEvmRpc) {
    console.warn(`Missing ${profile.env.evmRpc}. EVM writes for DEPLOYMENT_TYPE=${profile.type} will fail.`)
}

const config: HardhatUserConfig = {
    paths: {
        cache: 'cache/hardhat',
    },
    solidity: {
        compilers: [
            {
                version: '0.8.22',
                settings: {
                    optimizer: {
                        enabled: true,
                        runs: 200,
                    },
                },
            },
        ],
    },
    defaultNetwork: profile.evmNetwork,
    networks: {
        sepolia: {
            eid: EndpointId.SEPOLIA_V2_TESTNET,
            url: profile.type === 'devnet' ? activeEvmRpc : process.env.RPC_URL_EVM_DEVNET,
            accounts: profile.type === 'devnet' ? activeAccounts : undefined,
        },
        arbitrum: {
            eid: EndpointId.ARBITRUM_V2_MAINNET,
            url: profile.type === 'mainnet' ? activeEvmRpc : process.env.RPC_URL_EVM_MAINNET,
            accounts: profile.type === 'mainnet' ? activeAccounts : undefined,
        },
        hardhat: {
            allowUnlimitedContractSize: true,
        },
    },
    namedAccounts: {
        deployer: {
            default: 0,
        },
    },
}

export default config
