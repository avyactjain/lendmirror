import bs58 from 'bs58'
import { task, types } from 'hardhat/config'
import { PublicKey } from '@solana/web3.js'

import { publicKey, transactionBuilder, unwrapOption } from '@metaplex-foundation/umi'

import { lendmirror } from '../../lib/client'
import {
    ccipRouteAddress,
    decodeCcipRoute,
    ccipPayerAddress,
    fundStoreInstruction,
    sendCcipInstruction,
} from '../../lib/client/ccip'
import { requireCcip, resolveSolanaEid } from '../common/deployment'
import { TransactionType, addComputeUnitInstructions, deriveConnection, getExplorerTxLink, getSolanaDeployment } from '.'

task('lz:oapp:solana:send-ccip', 'Sends wrapper.snapshot body through Chainlink CCIP (needs ccip_send_allowed)')
    .addOptionalParam('eid', 'Solana endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .addOptionalParam('vaultId', 'Jupiter vault id', 1, types.int)
    .addOptionalParam('nftId', 'Jupiter position nft id', 29, types.int)
    .addOptionalParam('fundLamports', 'SOL lamports to move onto the CCIP payer for the fee', 50_000_000, types.int)
    .addOptionalParam('computeUnitPriceScaleFactor', 'Compute unit price scale factor', 4, types.float)
    .setAction(async ({ eid: eidArg, vaultId, nftId, fundLamports, computeUnitPriceScaleFactor }) => {
        requireCcip()
        const eid = resolveSolanaEid(eidArg)
        const { programId, oapp } = getSolanaDeployment(eid)
        const { connection, umi, umiWalletSigner } = await deriveConnection(eid)
        const instance = new lendmirror.LendMirror(publicKey(programId))
        const [wrapperPda] = instance.pda.wrapper(vaultId, nftId)
        const wrapper = await instance.getWrapper(umi.rpc, vaultId, nftId)
        const snap = wrapper ? unwrapOption(wrapper.snapshot) : null
        if (!wrapper || !snap) {
            throw new Error('No wrapper snapshot. Run lz:oapp:solana:wrap-position then refresh-wrapper.')
        }
        if (!wrapper.ccipSendAllowed) {
            throw new Error('ccip_send_allowed is false. Run lz:oapp:solana:request-bridge first.')
        }

        const routeInfo = await connection.getAccountInfo(new PublicKey(ccipRouteAddress(programId)))
        if (!routeInfo) throw new Error('No CCIP route. Run lz:oapp:solana:set-ccip-route first.')
        const route = decodeCcipRoute(routeInfo.data)

        let txBuilder = transactionBuilder()
            .add({
                instruction: fundStoreInstruction(umiWalletSigner.publicKey, ccipPayerAddress(programId), BigInt(fundLamports)),
                signers: [umiWalletSigner],
                bytesCreatedOnChain: 0,
            })
            .add({
                instruction: sendCcipInstruction({
                    programId,
                    authority: umiWalletSigner.publicKey,
                    store: oapp,
                    wrapper: wrapperPda,
                    route,
                }),
                signers: [umiWalletSigner],
                bytesCreatedOnChain: 0,
            })
        txBuilder = await addComputeUnitInstructions(
            connection,
            umi,
            eid,
            txBuilder,
            umiWalletSigner,
            computeUnitPriceScaleFactor,
            TransactionType.SendMessage
        )
        const tx = await txBuilder.sendAndConfirm(umi)
        console.log(`sendCcip: ${getExplorerTxLink(bs58.encode(tx.signature), eid === 40168)}`)
        console.log('position', snap.position)
        console.log('receiver', route.receiver)
    })
