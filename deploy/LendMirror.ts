import assert from 'assert'

import { type DeployFunction } from 'hardhat-deploy/types'

const contractName = 'LendMirror'

const deploy: DeployFunction = async (hre) => {
    const { getNamedAccounts, deployments } = hre

    const { deploy } = deployments
    const { deployer } = await getNamedAccounts()

    assert(deployer, 'Missing named deployer account')

    console.log(`Network: ${hre.network.name}`)
    console.log(`Deployer: ${deployer}`)

    const endpointV2Deployment = await hre.deployments.get('EndpointV2')

    const { address } = await deploy(contractName, {
        from: deployer,
        args: [endpointV2Deployment.address],
        proxy: {
            owner: deployer,
            proxyContract: 'UUPS',
            execute: {
                init: {
                    methodName: 'initialize',
                    args: [deployer],
                },
            },
        },
        log: true,
        skipIfAlreadyDeployed: false,
    })

    console.log(`Deployed contract: ${contractName}, network: ${hre.network.name}, address: ${address}`)
    console.log('This address is the proxy. Keep it as the LayerZero peer. Owner upgrades via upgradeToAndCall.')
}

deploy.tags = [contractName]

export default deploy
