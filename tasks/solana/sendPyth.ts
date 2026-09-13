import { publicKey, publicKeyBytes, transactionBuilder, unwrapOption } from '@metaplex-foundation/umi'
import bs58 from 'bs58'
import { task, types } from 'hardhat/config'

import { Options } from '@layerzerolabs/lz-v2-utilities'

import { lendmirror } from '../../lib/client'
import { TransactionType, addComputeUnitInstructions, deriveConnection, getSolanaDeployment } from '.'
import { getLayerZeroScanLink, isV2Testnet } from '../utils'

interface Args {
    fromEid: number
    dstEid: number
    computeUnitPriceScaleFactor: number
}

task('lz:oapp:solana:send-pyth', 'Sends the last Store Pyth snapshot to Ethereum. Do not use the old string contract.')
    .addParam('fromEid', 'Solana endpoint ID (40168 = Devnet)', undefined, types.int)
    .addParam('dstEid', 'Destination endpoint ID (40161 = Sepolia)', undefined, types.int)
    .addOptionalParam('computeUnitPriceScaleFactor', 'Compute unit price scale factor', 4, types.float)
    .setAction(async ({ fromEid, dstEid, computeUnitPriceScaleFactor }: Args) => {
        const solanaDeployment = getSolanaDeployment(fromEid)
        const { connection, umi, umiWalletSigner } = await deriveConnection(fromEid)
        const instance = new lendmirror.LendMirror(publicKey(solanaDeployment.programId))

        const store = await instance.getStore(umi.rpc)
        const snap = store ? unwrapOption(store.priceStore) : null
        if (!store || !snap) {
            throw new Error('Store has no Pyth snapshot. Run lz:oapp:solana:get-pyth-price first.')
        }

        const message = lendmirror.encodePythPrice({
            pythAccount: publicKeyBytes(snap.pythAccount),
            feedId: Uint8Array.from(snap.feedId),
            price: BigInt(snap.price),
            conf: BigInt(snap.conf),
            exponent: snap.exponent,
            publishTime: BigInt(snap.publishTime),
        })

        const options = Options.newOptions().addExecutorLzReceiveOption(200000, 0).toBytes()

        const { nativeFee } = await instance.quotePayload(umi.rpc, umiWalletSigner.publicKey, {
            dstEid,
            message,
            options,
            payInLzToken: false,
        })
        console.log('Native fee quoted:', nativeFee.toString())

        let txBuilder = transactionBuilder().add(
            await instance.sendPayload(umi.rpc, umiWalletSigner.publicKey, {
                dstEid,
                message,
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
