import { PublicKey } from '@solana/web3.js'
import { task, types } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'

import { CCIP_SEPOLIA_ROUTER, CCIP_SOLANA_DEVNET_SELECTOR } from '../../lib/client/ccip'
import { getSolanaDeployment } from '../solana'

task('lz:oapp:evm:set-ccip-route', 'Owner: allow the CCIP router and the Solana Store to deliver snapshots')
    .addOptionalParam('router', 'CCIP router on this chain', CCIP_SEPOLIA_ROUTER, types.string)
    .addOptionalParam('sourceSelector', 'Source chain selector', CCIP_SOLANA_DEVNET_SELECTOR.toString(), types.string)
    .addOptionalParam('solanaEid', 'Solana eid whose Store is the CCIP sender', 40168, types.int)
    .addOptionalParam('contractName', 'Deployed EVM contract name', 'LendMirror', types.string)
    .setAction(async ({ router, sourceSelector, solanaEid, contractName }, hre: HardhatRuntimeEnvironment) => {
        const { oapp } = getSolanaDeployment(solanaEid)
        const sender = '0x' + Buffer.from(new PublicKey(oapp).toBytes()).toString('hex')
        const contract = await mirror(hre, contractName)
        console.log('proxy', contract.address)
        console.log('router', router)
        console.log('source selector', sourceSelector)
        console.log('sender store', oapp)
        const tx = await contract.setCcipRoute(router, sourceSelector, sender)
        const receipt = await tx.wait()
        console.log('setCcipRoute tx', receipt.transactionHash)
    })

async function mirror(hre: HardhatRuntimeEnvironment, contractName: string) {
    const signer = (await hre.ethers.getSigners())[0]
    const artifact = await hre.artifacts.readArtifact(contractName)
    const deployment = await hre.deployments.get(contractName)
    return new hre.ethers.Contract(deployment.address, artifact.abi, signer)
}
