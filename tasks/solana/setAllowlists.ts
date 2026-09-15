import { publicKey, transactionBuilder } from '@metaplex-foundation/umi'
import bs58 from 'bs58'
import { task, types } from 'hardhat/config'

import { lendmirror } from '../../lib/client'
import { TransactionType, addComputeUnitInstructions, deriveConnection, getExplorerTxLink, getSolanaDeployment } from '.'

interface Args {
    eid: number
    keys: string
    computeUnitPriceScaleFactor: number
}

task('lz:oapp:solana:set-snapshotters', 'Admin: replace wallets allowed to call get_jupiter_position')
    .addParam('eid', 'Solana endpoint ID', undefined, types.int)
    .addParam('keys', 'Comma-separated pubkeys (max 8)', undefined, types.string)
    .addOptionalParam('computeUnitPriceScaleFactor', 'Compute unit price scale factor', 4, types.float)
    .setAction(async ({ eid, keys, computeUnitPriceScaleFactor }: Args) => {
        const solanaDeployment = getSolanaDeployment(eid)
        const { connection, umi, umiWalletSigner } = await deriveConnection(eid)
        const instance = new lendmirror.LendMirror(publicKey(solanaDeployment.programId))
        const list = keys
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean)
            .map((k) => publicKey(k))
        if (list.length === 0 || list.length > 8) {
            throw new Error('Provide 1–8 comma-separated pubkeys')
        }

        let txBuilder = transactionBuilder().add(instance.setSnapshotters(umiWalletSigner, list))
        txBuilder = await addComputeUnitInstructions(
            connection,
            umi,
            eid,
            txBuilder,
            umiWalletSigner,
            computeUnitPriceScaleFactor,
            TransactionType.SetAuthority
        )
        const tx = await txBuilder.sendAndConfirm(umi)
        console.log(`setSnapshotters: ${getExplorerTxLink(bs58.encode(tx.signature), eid === 40168)}`)
        console.log(
            'snapshotters:',
            list.map((k) => k.toString())
        )
    })

task('lz:oapp:solana:set-senders', 'Admin: replace wallets allowed to call send')
    .addParam('eid', 'Solana endpoint ID', undefined, types.int)
    .addParam('keys', 'Comma-separated pubkeys (max 8)', undefined, types.string)
    .addOptionalParam('computeUnitPriceScaleFactor', 'Compute unit price scale factor', 4, types.float)
    .setAction(async ({ eid, keys, computeUnitPriceScaleFactor }: Args) => {
        const solanaDeployment = getSolanaDeployment(eid)
        const { connection, umi, umiWalletSigner } = await deriveConnection(eid)
        const instance = new lendmirror.LendMirror(publicKey(solanaDeployment.programId))
        const list = keys
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean)
            .map((k) => publicKey(k))
        if (list.length === 0 || list.length > 8) {
            throw new Error('Provide 1–8 comma-separated pubkeys')
        }

        let txBuilder = transactionBuilder().add(instance.setSenders(umiWalletSigner, list))
        txBuilder = await addComputeUnitInstructions(
            connection,
            umi,
            eid,
            txBuilder,
            umiWalletSigner,
            computeUnitPriceScaleFactor,
            TransactionType.SetAuthority
        )
        const tx = await txBuilder.sendAndConfirm(umi)
        console.log(`setSenders: ${getExplorerTxLink(bs58.encode(tx.signature), eid === 40168)}`)
        console.log(
            'senders:',
            list.map((k) => k.toString())
        )
    })
