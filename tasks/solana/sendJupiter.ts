import { publicKey, transactionBuilder, unwrapOption } from '@metaplex-foundation/umi'
import bs58 from 'bs58'
import { task, types } from 'hardhat/config'

import { Options } from '@layerzerolabs/lz-v2-utilities'

import { lendmirror } from '../../lib/client'
import { resolveEvmEid, resolveSolanaEid } from '../common/deployment'
import { TransactionType, addComputeUnitInstructions, deriveConnection, getSolanaDeployment } from '.'
import { getLayerZeroScanLink, isV2Testnet } from '../utils'

task('lz:oapp:solana:send-jupiter', 'Sends wrapper.snapshot to Ethereum via LayerZero (needs lz_send_allowed).')
    .addOptionalParam('fromEid', 'Solana endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .addOptionalParam('dstEid', 'Destination endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .addOptionalParam('vaultId', 'Jupiter vault id', 1, types.int)
    .addOptionalParam('nftId', 'Jupiter position nft id', 29, types.int)
    .addOptionalParam('computeUnitPriceScaleFactor', 'Compute unit price scale factor', 4, types.float)
    .setAction(async ({ fromEid: fromArg, dstEid: dstArg, vaultId, nftId, computeUnitPriceScaleFactor }) => {
        const fromEid = resolveSolanaEid(fromArg)
        const dstEid = resolveEvmEid(dstArg)
        const solanaDeployment = getSolanaDeployment(fromEid)
        const { connection, umi, umiWalletSigner } = await deriveConnection(fromEid)
        const instance = new lendmirror.LendMirror(publicKey(solanaDeployment.programId))

        const wrapper = await instance.getWrapper(umi.rpc, vaultId, nftId)
        const snap = wrapper ? unwrapOption(wrapper.snapshot) : null
        if (!wrapper || !snap) {
            throw new Error('No wrapper snapshot. Run lz:oapp:solana:wrap-position then refresh-wrapper.')
        }
        if (!wrapper.lzSendAllowed) {
            throw new Error('lz_send_allowed is false. Run lz:oapp:solana:request-bridge first.')
        }

        const options = Options.newOptions().addExecutorLzReceiveOption(400000, 0).toBytes()

        const { nativeFee } = await instance.quotePayload(umi.rpc, umiWalletSigner.publicKey, {
            dstEid,
            options,
            payInLzToken: false,
            vaultId,
            nftId,
        })
        console.log('Native fee quoted:', nativeFee.toString())

        let txBuilder = transactionBuilder().add(
            await instance.sendPayload(umi.rpc, umiWalletSigner, {
                dstEid,
                options,
                nativeFee,
                vaultId,
                nftId,
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
