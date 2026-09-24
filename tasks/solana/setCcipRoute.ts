import bs58 from 'bs58'
import { task, types } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'

import { ccipTransaction, setCcipRouteInstruction } from '../../lib/client/ccip'
import { getProfile, requireCcip, resolveEvmNetwork, resolveSolanaEid } from '../common/deployment'
import { deriveConnection, getExplorerTxLink, getSolanaDeployment } from '.'

task('lz:oapp:solana:set-ccip-route', 'Admin: set the Chainlink router, destination, and Ethereum receiver')
    .addOptionalParam('eid', 'Solana endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .addOptionalParam('linkMint', 'LINK mint. Default: DEPLOYMENT_TYPE profile.', '', types.string)
    .addOptionalParam('router', 'CCIP router program. Default: profile.', '', types.string)
    .addOptionalParam('feeQuoter', 'CCIP fee quoter program. Default: profile.', '', types.string)
    .addOptionalParam('rmnRemote', 'CCIP RMN remote program. Default: profile.', '', types.string)
    .addOptionalParam('destSelector', 'Destination CCIP chain selector. Default: profile.', '', types.string)
    .addOptionalParam('receiver', 'Ethereum LendMirror address. Default: deployments or profile.', '', types.string)
    .addOptionalParam('gasLimit', 'Gas for ccipReceive. Default: profile.', '', types.string)
    .setAction(async (args, hre: HardhatRuntimeEnvironment) => {
        const ccip = requireCcip()
        const eid = resolveSolanaEid(args.eid)
        const profile = getProfile()
        const { programId, oapp } = getSolanaDeployment(eid)
        const { umi, umiWalletSigner } = await deriveConnection(eid)
        const evm =
            args.receiver ||
            (await hre.deployments.get('LendMirror').catch(() => null))?.address ||
            profile.evmProxy
        const ix = setCcipRouteInstruction({
            programId,
            admin: umiWalletSigner.publicKey,
            store: oapp,
            router: args.router || ccip.router,
            feeQuoter: args.feeQuoter || ccip.feeQuoter,
            rmnRemote: args.rmnRemote || ccip.rmnRemote,
            linkMint: args.linkMint || ccip.linkMint,
            destChainSelector: BigInt(args.destSelector || ccip.destChainSelector.toString()),
            receiver: hexTo20(evm),
            gasLimit: BigInt(args.gasLimit || ccip.gasLimit),
        })
        const tx = await ccipTransaction(ix, umiWalletSigner).sendAndConfirm(umi)
        console.log(`setCcipRoute: ${getExplorerTxLink(bs58.encode(tx.signature), eid === 40168)}`)
        console.log('receiver', evm)
        console.log('ccip payer (Sepolia sender)', ccip.payer)
        console.log('evm network', resolveEvmNetwork())
    })

function hexTo20(hex: string): Uint8Array {
    const raw = hex.startsWith('0x') ? hex.slice(2) : hex
    if (raw.length !== 40) throw new Error(`Expected a 20-byte hex address, got ${hex}`)
    return Uint8Array.from(Buffer.from(raw, 'hex'))
}
