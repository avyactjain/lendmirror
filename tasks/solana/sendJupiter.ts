import { publicKey, transactionBuilder, unwrapOption } from '@metaplex-foundation/umi'
import bs58 from 'bs58'
import { task, types } from 'hardhat/config'

import { Options } from '@layerzerolabs/lz-v2-utilities'

import { lendmirror } from '../../lib/client'
import { resolveEvmEid, resolveSolanaEid } from '../common/deployment'
import { TransactionType, addComputeUnitInstructions, deriveConnection, getSolanaDeployment } from '.'
import { getLayerZeroScanLink, isV2Testnet } from '../utils'

task('lz:oapp:solana:send-jupiter', 'Sends the last Store Jupiter snapshot to Ethereum.')
    .addOptionalParam('fromEid', 'Solana endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .addOptionalParam('dstEid', 'Destination endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .addOptionalParam('computeUnitPriceScaleFactor', 'Compute unit price scale factor', 4, types.float)
    .setAction(async ({ fromEid: fromArg, dstEid: dstArg, computeUnitPriceScaleFactor }) => {
        const fromEid = resolveSolanaEid(fromArg)
        const dstEid = resolveEvmEid(dstArg)
        const solanaDeployment = getSolanaDeployment(fromEid)
        const { connection, umi, umiWalletSigner } = await deriveConnection(fromEid)
        const instance = new lendmirror.LendMirror(publicKey(solanaDeployment.programId))

        const store = await instance.getStore(umi.rpc)
        const snap = store ? unwrapOption(store.lastPosition) : null
        if (!store || !snap) {
            throw new Error('Store has no Jupiter snapshot. Run lz:oapp:solana:get-jupiter-position first.')
        }

        const options = Options.newOptions().addExecutorLzReceiveOption(400000, 0).toBytes()

        const { nativeFee } = await instance.quotePayload(umi.rpc, umiWalletSigner.publicKey, {
            dstEid,
            options,
            payInLzToken: false,
        })
        console.log('Native fee quoted:', nativeFee.toString())

        let txBuilder = transactionBuilder().add(
            await instance.sendPayload(umi.rpc, umiWalletSigner, {
                dstEid,
                options,
                nativeFee,
            })
        )
        txBuilder = await addComputeUnitInstructions(
            connection,
            umi,
            fromEid,
            txBuilder,
            umiWalletSigner,
            computeUnitPriceScaleFactor,
            TransactionType.SendMessage
        )
        const tx = await txBuilder.sendAndConfirm(umi)
        const txHash = bs58.encode(tx.signature)
        console.log('Transaction hash:', txHash)
        console.log('Track:', getLayerZeroScanLink(txHash, isV2Testnet(dstEid)))
    })
