import assert from 'assert'

import { type DeployFunction } from 'hardhat-deploy/types'

/**
 * Deploys the token treasury behind a UUPS proxy. The proxy address is what every Solana
 * BridgeRoute must name as `receiver`. Owner = deployer; change with transferOwnership.
 */
const contractName = 'LendMirrorTreasury'

const deploy: DeployFunction = async (hre) => {
    const { getNamedAccounts, deployments } = hre
    const { deploy } = deployments
    const { deployer } = await getNamedAccounts()
    assert(deployer, 'Missing named deployer account')

    console.log(`Network: ${hre.network.name}`)
    console.log(`Deployer: ${deployer}`)

    const { address } = await deploy(contractName, {
        from: deployer,
        args: [],
        proxy: {
            owner: deployer,
            proxyContract: 'UUPS',
            // OpenZeppelin v5 UUPS has no `upgradeTo`, only `upgradeToAndCall(impl, data)`.
            // hardhat-deploy defaults to `upgradeTo`, so an upgrade of an existing proxy fails.
            upgradeFunction: {
                methodName: 'upgradeToAndCall',
                upgradeArgs: ['{implementation}', '0x'],
            },
            execute: {
                init: {
                    methodName: 'initialize',
                    args: [deployer],
                },
            },
        },
        log: true,
        skipIfAlreadyDeployed: true,
    })

    console.log(`Deployed ${contractName} proxy at ${address} on ${hre.network.name}`)
    console.log('Put this address (left-padded to 32 bytes) into every Solana BridgeRoute receiver.')
}

deploy.tags = [contractName]

export default deploy
