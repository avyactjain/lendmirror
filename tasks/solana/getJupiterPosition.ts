import { publicKey, transactionBuilder, unwrapOption } from '@metaplex-foundation/umi'
import bs58 from 'bs58'
import { task, types } from 'hardhat/config'

import { EndpointId } from '@layerzerolabs/lz-definitions'

import { lendmirror } from '../../lib/client'
import { resolveSolanaEid } from '../common/deployment'
import { TransactionType, addComputeUnitInstructions, deriveConnection, getExplorerTxLink, getSolanaDeployment } from '.'

task('lz:oapp:solana:get-jupiter-position', 'Reads a Jupiter Vaults position into Store.last_position')
    .addOptionalParam('eid', 'Solana endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .addOptionalParam('vaultId', 'Jupiter vault id', 1, types.int)
    .addOptionalParam('nftId', 'Jupiter position nft id', 29, types.int)
    .addOptionalParam('computeUnitPriceScaleFactor', 'Compute unit price scale factor', 4, types.float)
    .setAction(async ({ eid: eidArg, vaultId, nftId, computeUnitPriceScaleFactor }) => {
        const eid = resolveSolanaEid(eidArg) as EndpointId
        const isTestnet = eid == EndpointId.SOLANA_V2_TESTNET
        const solanaDeployment = getSolanaDeployment(eid)
        const { connection, umi, umiWalletSigner } = await deriveConnection(eid)
        const instance = new lendmirror.LendMirror(publicKey(solanaDeployment.programId))
        const store = await instance.getStore(umi.rpc)
        if (!store) {
            throw new Error(`No Store at ${solanaDeployment.oapp}. Run lz:oapp:solana:create first.`)
        }

        let txBuilder = transactionBuilder().add(
            await instance.getJupiterPosition(umi.rpc, umiWalletSigner, vaultId, nftId, store.vaultsProgram)
        )
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
        console.log(`getJupiterPosition: ${getExplorerTxLink(bs58.encode(tx.signature), isTestnet)}`)

        const updated = await instance.getStore(umi.rpc)
        const snapshot = updated ? unwrapOption(updated.lastPosition) : null
        if (!snapshot) {
            throw new Error('Store.last_position is empty after the tx')
        }
        console.log({
            position: snapshot.position,
            vaultId: snapshot.vaultId,
            nftId: snapshot.nftId,
            colRaw: snapshot.colRaw.toString(),
            debtRaw: snapshot.debtRaw.toString(),
            dustDebt: snapshot.dustDebt.toString(),
            netDebt: snapshot.netDebt.toString(),
            tick: snapshot.tick,
            tickId: snapshot.tickId,
            storedColRaw: snapshot.storedColRaw.toString(),
            storedDebtRaw: snapshot.storedDebtRaw.toString(),
            storedTick: snapshot.storedTick,
            isSupplyOnly: snapshot.isSupplyOnly,
            isLiquidated: snapshot.isLiquidated,
            isFullyLiquidated: snapshot.isFullyLiquidated,
            branchId: snapshot.branchId,
            supplyToken: snapshot.supplyToken,
            borrowToken: snapshot.borrowToken,
            snapshotTime: snapshot.snapshotTime.toString(),
        })
    })
