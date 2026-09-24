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
import { TransactionType, addComputeUnitInstructions, deriveConnection, getExplorerTxLink, getSolanaDeployment } from '.'

task('lz:oapp:solana:send-ccip', 'Sends the last Store snapshot body through Chainlink CCIP')
    .addParam('eid', 'Solana endpoint ID (40168 = Devnet)', undefined, types.int)
    .addOptionalParam('fundLamports', 'SOL lamports to move onto the Store for the CCIP fee', 50_000_000, types.int)
    .addOptionalParam('computeUnitPriceScaleFactor', 'Compute unit price scale factor', 4, types.float)
    .setAction(async ({ eid, fundLamports, computeUnitPriceScaleFactor }) => {
        const { programId, oapp } = getSolanaDeployment(eid)
        const { connection, umi, umiWalletSigner } = await deriveConnection(eid)
        const instance = new lendmirror.LendMirror(publicKey(programId))
        const store = await instance.getStore(umi.rpc)
        const snap = store ? unwrapOption(store.lastPosition) : null
        if (!store || !snap) {
            throw new Error('Store has no Jupiter snapshot. Run lz:oapp:solana:get-jupiter-position first.')
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
