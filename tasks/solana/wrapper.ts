import { publicKey, transactionBuilder, unwrapOption } from '@metaplex-foundation/umi'
import bs58 from 'bs58'
import { task, types } from 'hardhat/config'

import { lendmirror } from '../../lib/client'
import { resolveSolanaEid } from '../common/deployment'
import { TransactionType, addComputeUnitInstructions, deriveConnection, getExplorerTxLink, getSolanaDeployment } from '.'

task('lz:oapp:solana:wrap-position', 'Create a PositionWrapper PDA for a Jupiter position')
    .addOptionalParam('eid', 'Solana endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .addOptionalParam('vaultId', 'Jupiter vault id', 1, types.int)
    .addOptionalParam('nftId', 'Jupiter position nft id', 29, types.int)
    .addOptionalParam('computeUnitPriceScaleFactor', 'Compute unit price scale factor', 4, types.float)
    .setAction(async ({ eid: eidArg, vaultId, nftId, computeUnitPriceScaleFactor }) => {
        const eid = resolveSolanaEid(eidArg)
        const solanaDeployment = getSolanaDeployment(eid)
        const { connection, umi, umiWalletSigner } = await deriveConnection(eid)
        const instance = new lendmirror.LendMirror(publicKey(solanaDeployment.programId))
        const [wrapper] = instance.pda.wrapper(vaultId, nftId)

        let txBuilder = transactionBuilder().add(instance.wrapPosition(umiWalletSigner, vaultId, nftId))
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
        console.log(`wrapPosition: ${getExplorerTxLink(bs58.encode(tx.signature), eid === 40168)}`)
        console.log('wrapper', wrapper)
    })

task('lz:oapp:solana:attach-ondemand', 'Attach OnDemand strategy PDA to a wrapper (callers starts as owner)')
    .addOptionalParam('eid', 'Solana endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .addOptionalParam('vaultId', 'Jupiter vault id', 1, types.int)
    .addOptionalParam('nftId', 'Jupiter position nft id', 29, types.int)
    .addOptionalParam('computeUnitPriceScaleFactor', 'Compute unit price scale factor', 4, types.float)
    .setAction(async ({ eid: eidArg, vaultId, nftId, computeUnitPriceScaleFactor }) => {
        const eid = resolveSolanaEid(eidArg)
        const solanaDeployment = getSolanaDeployment(eid)
        const { connection, umi, umiWalletSigner } = await deriveConnection(eid)
        const instance = new lendmirror.LendMirror(publicKey(solanaDeployment.programId))
        const [wrapper] = instance.pda.wrapper(vaultId, nftId)
        const [ondemand] = instance.pda.ondemand(wrapper)

        let txBuilder = transactionBuilder().add(instance.attachOndemand(umiWalletSigner, vaultId, nftId))
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
        console.log(`attachOndemand: ${getExplorerTxLink(bs58.encode(tx.signature), eid === 40168)}`)
        console.log('ondemand', ondemand)
    })

task('lz:oapp:solana:set-ondemand-callers', 'Replace OnDemand callers (comma-separated base58 pubkeys)')
    .addOptionalParam('eid', 'Solana endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .addOptionalParam('vaultId', 'Jupiter vault id', 1, types.int)
    .addOptionalParam('nftId', 'Jupiter position nft id', 29, types.int)
    .addParam('callers', 'Comma-separated Solana pubkeys (max 8)')
    .addOptionalParam('computeUnitPriceScaleFactor', 'Compute unit price scale factor', 4, types.float)
    .setAction(async ({ eid: eidArg, vaultId, nftId, callers, computeUnitPriceScaleFactor }) => {
        const eid = resolveSolanaEid(eidArg)
        const solanaDeployment = getSolanaDeployment(eid)
        const { connection, umi, umiWalletSigner } = await deriveConnection(eid)
        const instance = new lendmirror.LendMirror(publicKey(solanaDeployment.programId))
        const keys = String(callers)
            .split(',')
            .map((s: string) => s.trim())
            .filter(Boolean)
            .map((s: string) => publicKey(s))
        if (keys.length === 0 || keys.length > 8) {
            throw new Error('callers must be 1–8 comma-separated pubkeys')
        }

        let txBuilder = transactionBuilder().add(
            instance.setOndemandCallers(umiWalletSigner, vaultId, nftId, keys)
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
        console.log(`setOndemandCallers: ${getExplorerTxLink(bs58.encode(tx.signature), eid === 40168)}`)
        console.log('callers', keys.map(String))
    })

task('lz:oapp:solana:refresh-wrapper', 'Read Jupiter into wrapper.snapshot')
    .addOptionalParam('eid', 'Solana endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .addOptionalParam('vaultId', 'Jupiter vault id', 1, types.int)
    .addOptionalParam('nftId', 'Jupiter position nft id', 29, types.int)
    .addOptionalParam('computeUnitPriceScaleFactor', 'Compute unit price scale factor', 4, types.float)
    .setAction(async ({ eid: eidArg, vaultId, nftId, computeUnitPriceScaleFactor }) => {
        const eid = resolveSolanaEid(eidArg)
        const solanaDeployment = getSolanaDeployment(eid)
        const { connection, umi, umiWalletSigner } = await deriveConnection(eid)
        const instance = new lendmirror.LendMirror(publicKey(solanaDeployment.programId))
        const store = await instance.getStore(umi.rpc)
        if (!store) {
            throw new Error(`No Store at ${solanaDeployment.oapp}. Run lz:oapp:solana:create first.`)
        }

        let txBuilder = transactionBuilder().add(
            await instance.refreshWrapper(umi.rpc, umiWalletSigner, vaultId, nftId, store.vaultsProgram)
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
        console.log(`refreshWrapper: ${getExplorerTxLink(bs58.encode(tx.signature), eid === 40168)}`)

        const wrapper = await instance.getWrapper(umi.rpc, vaultId, nftId)
        const snap = wrapper ? unwrapOption(wrapper.snapshot) : null
        if (!snap) throw new Error('wrapper.snapshot empty after refresh')
        console.log({
            vaultId: snap.vaultId,
            nftId: snap.nftId,
            colRaw: snap.colRaw.toString(),
            debtRaw: snap.debtRaw.toString(),
        })
    })

task(
    'lz:oapp:solana:send-position-snapshot-via-chainlink-and-lz',
    'OnDemand caller sends wrapper.snapshot on LayerZero and Chainlink'
)
    .addOptionalParam('fromEid', 'Solana endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .addOptionalParam('dstEid', 'Destination endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .addOptionalParam('vaultId', 'Jupiter vault id', 1, types.int)
    .addOptionalParam('nftId', 'Jupiter position nft id', 29, types.int)
    .addOptionalParam('fundLamports', 'SOL lamports moved onto the CCIP payer in this call', 50_000_000, types.int)
    .addOptionalParam('computeUnitPriceScaleFactor', 'Compute unit price scale factor', 4, types.float)
    .setAction(async ({ fromEid: fromArg, dstEid: dstArg, vaultId, nftId, fundLamports, computeUnitPriceScaleFactor }) => {
        const { resolveEvmEid, requireCcip } = await import('../common/deployment')
        const { Options } = await import('@layerzerolabs/lz-v2-utilities')
        const { getLayerZeroScanLink, isV2Testnet } = await import('../utils')
        const { ccipRouteAddress, decodeCcipRoute } = await import('../../lib/client/ccip')
        const { PublicKey } = await import('@solana/web3.js')
        requireCcip()
        const fromEid = resolveSolanaEid(fromArg)
        const dstEid = resolveEvmEid(dstArg)
        const solanaDeployment = getSolanaDeployment(fromEid)
        const { connection, umi, umiWalletSigner } = await deriveConnection(fromEid)
        const instance = new lendmirror.LendMirror(publicKey(solanaDeployment.programId))
        const wrapper = await instance.getWrapper(umi.rpc, vaultId, nftId)
        const snap = wrapper ? unwrapOption(wrapper.snapshot) : null
        if (!wrapper || !snap) {
            throw new Error('No wrapper snapshot. Run wrap-position, attach-ondemand, then refresh-wrapper.')
        }
        const routeInfo = await connection.getAccountInfo(new PublicKey(ccipRouteAddress(solanaDeployment.programId)))
        if (!routeInfo) throw new Error('No CCIP route. Run lz:oapp:solana:set-ccip-route first.')
        const route = decodeCcipRoute(routeInfo.data)
        const options = Options.newOptions().addExecutorLzReceiveOption(400000, 0).toBytes()
        const { nativeFee } = await instance.quotePayload(umi.rpc, umiWalletSigner.publicKey, {
            dstEid,
            options,
            payInLzToken: false,
            vaultId,
            nftId,
        })
        console.log('LayerZero fee:', nativeFee.toString())
        let txBuilder = transactionBuilder().add(
            await instance.sendPayload(umi.rpc, umiWalletSigner, {
                dstEid,
                options,
                nativeFee,
                vaultId,
                nftId,
                ccipFeeLamports: BigInt(fundLamports),
                route,
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
        console.log(getExplorerTxLink(txHash, fromEid === 40168))
        console.log('LayerZero:', getLayerZeroScanLink(txHash, isV2Testnet(dstEid)))
    })
