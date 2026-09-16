import { PublicKey } from '@solana/web3.js'
import { task, types } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'

import { getSolanaDeployment } from '../solana'

task('lz:oapp:evm:set-peer', 'Owner: set Solana Store as peer on the EVM LendMirror proxy')
    .addParam('srcEid', 'Solana endpoint ID (40168 = Devnet)', undefined, types.int)
    .addOptionalParam('contractName', 'Deployed EVM contract name', 'LendMirror', types.string)
    .addOptionalParam('solanaEid', 'Solana eid used to load deployments/solana-*/OApp.json', undefined, types.int)
    .setAction(
        async (
            {
                srcEid,
                contractName,
                solanaEid,
            }: {
                srcEid: number
                contractName: string
                solanaEid?: number
            },
            hre: HardhatRuntimeEnvironment
        ) => {
            const storeEid = solanaEid ?? srcEid
            const { oapp } = getSolanaDeployment(storeEid)
            const storeBytes = Buffer.from(new PublicKey(oapp).toBytes())
            const peer = '0x' + storeBytes.toString('hex')

            const contract = await hre.ethers.getContract(contractName)
            const signer = (await hre.ethers.getSigners())[0]
            const oappContract = contract as unknown as {
                address: string
                owner: () => Promise<string>
                initialize: (owner: string) => Promise<{ hash: string; wait: () => Promise<{ transactionHash: string }> }>
                setPeer: (
                    eid: number,
                    peer: string
                ) => Promise<{ hash: string; wait: () => Promise<{ transactionHash: string }> }>
            }

            const owner = await oappContract.owner()
            console.log('network', hre.network.name)
            console.log('proxy', oappContract.address)
            console.log('owner', owner)
            console.log('signer', signer.address)
            console.log(`setPeer eid ${srcEid} -> Store ${oapp}`)

            if (owner === '0x0000000000000000000000000000000000000000') {
                console.log('owner is unset; calling initialize(signer)')
                const initTx = await oappContract.initialize(signer.address)
                await initTx.wait()
                console.log('initialized')
            } else if (owner.toLowerCase() !== signer.address.toLowerCase()) {
                throw new Error(`Signer is not owner. Use the owner key in PRIVATE_KEY. owner=${owner}`)
            }

            const tx = await oappContract.setPeer(srcEid, peer)
            const receipt = await tx.wait()
            console.log('setPeer tx', receipt.transactionHash)
        }
    )
