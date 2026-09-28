import { PublicKey } from '@solana/web3.js'
import { task, types } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'

import { pubkeyBytes32 } from '../../lib/deployment'
import { requireCcip, resolveSolanaEid } from '../common/deployment'

task('lz:oapp:evm:set-ccip-route', 'Owner: allow the CCIP router and the Solana CCIP payer to deliver snapshots')
    .addOptionalParam('router', 'CCIP router on this chain. Default: DEPLOYMENT_TYPE profile.', '', types.string)
    .addOptionalParam('sourceSelector', 'Source chain selector. Default: profile.', '', types.string)
    .addOptionalParam('solanaEid', 'Solana eid. Default: profile.', undefined, types.int)
    .addOptionalParam('contractName', 'Deployed EVM contract name', 'LendMirror', types.string)
    .setAction(async ({ router, sourceSelector, solanaEid, contractName }, hre: HardhatRuntimeEnvironment) => {
        const ccip = requireCcip()
        resolveSolanaEid(solanaEid)
        const sender = pubkeyBytes32(ccip.payer)
        const contract = await mirror(hre, contractName)
        console.log('proxy', contract.address)
        console.log('router', router || ccip.evmRouter)
        console.log('source selector', sourceSelector || ccip.sourceChainSelector.toString())
        console.log('sender (ccip payer)', ccip.payer)
        const tx = await contract.setCcipRoute(
            router || ccip.evmRouter,
            sourceSelector || ccip.sourceChainSelector.toString(),
            sender
        )
        const receipt = await tx.wait()
        console.log('setCcipRoute tx', receipt.transactionHash)
    })

async function mirror(hre: HardhatRuntimeEnvironment, contractName: string) {
    const signer = (await hre.ethers.getSigners())[0]
    const artifact = await hre.artifacts.readArtifact(contractName)
    const deployment = await hre.deployments.get(contractName)
    return new hre.ethers.Contract(deployment.address, artifact.abi, signer)
}
