import bs58 from 'bs58'
import { task, types } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'

import {
    CCIP_FEE_QUOTER_DEVNET,
    CCIP_RMN_REMOTE_DEVNET,
    CCIP_ROUTER_DEVNET,
    CCIP_SEPOLIA_SELECTOR,
    ccipTransaction,
    setCcipRouteInstruction,
} from '../../lib/client/ccip'
import { deriveConnection, getExplorerTxLink, getSolanaDeployment } from '.'

task('lz:oapp:solana:set-ccip-route', 'Admin: set the Chainlink router, destination, and Ethereum receiver')
    .addParam('eid', 'Solana endpoint ID (40168 = Devnet)', undefined, types.int)
    .addParam('linkMint', 'LINK mint on this Solana cluster', undefined, types.string)
    .addOptionalParam('router', 'CCIP router program', CCIP_ROUTER_DEVNET, types.string)
    .addOptionalParam('feeQuoter', 'CCIP fee quoter program', CCIP_FEE_QUOTER_DEVNET, types.string)
    .addOptionalParam('rmnRemote', 'CCIP RMN remote program', CCIP_RMN_REMOTE_DEVNET, types.string)
    .addOptionalParam('destSelector', 'Destination CCIP chain selector', CCIP_SEPOLIA_SELECTOR.toString(), types.string)
    .addOptionalParam('receiver', 'Ethereum LendMirror address', '', types.string)
    .addOptionalParam('gasLimit', 'Gas for ccipReceive', '400000', types.string)
    .setAction(async ({ eid, linkMint, router, feeQuoter, rmnRemote, destSelector, receiver, gasLimit }, hre: HardhatRuntimeEnvironment) => {
        const { programId, oapp } = getSolanaDeployment(eid)
        const { umi, umiWalletSigner } = await deriveConnection(eid)
        const evm = receiver || (await hre.deployments.get('LendMirror')).address
        const ix = setCcipRouteInstruction({
            programId,
            admin: umiWalletSigner.publicKey,
            store: oapp,
            router,
            feeQuoter,
            rmnRemote,
            linkMint,
            destChainSelector: BigInt(destSelector),
            receiver: hexTo20(evm),
            gasLimit: BigInt(gasLimit),
        })
        const tx = await ccipTransaction(ix, umiWalletSigner).sendAndConfirm(umi)
        console.log(`setCcipRoute: ${getExplorerTxLink(bs58.encode(tx.signature), eid === 40168)}`)
        console.log('receiver', evm)
        console.log('store pays CCIP fees', oapp)
    })

function hexTo20(hex: string): Uint8Array {
    const raw = hex.startsWith('0x') ? hex.slice(2) : hex
    if (raw.length !== 40) throw new Error(`Expected a 20-byte hex address, got ${hex}`)
    return Uint8Array.from(Buffer.from(raw, 'hex'))
}
