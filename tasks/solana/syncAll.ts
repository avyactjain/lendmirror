import { publicKey, transactionBuilder, unwrapOption } from '@metaplex-foundation/umi'
import bs58 from 'bs58'
import { task, types } from 'hardhat/config'

import { lendmirror } from '../../lib/client'
import { resolveEvmEid, resolveSolanaEid, requireCcip } from '../common/deployment'
import { TransactionType, addComputeUnitInstructions, deriveConnection, getExplorerTxLink, getSolanaDeployment } from '.'

/**
 * Refresh and send every wrapped position, one position at a time.
 *
 * Two transactions per wrapper: `refresh_wrapper` (Jupiter accounts + liquidation branches)
 * and `send_position_snapshot_via_chainlink_and_lz` (27 named accounts + the LayerZero
 * remaining accounts). They do not fit in one transaction.
 *
 * The signer must be on `store.senders` (the operator list) or on each wrapper's OnDemand
 * list for the send, and be the owner or a snapshotter for the refresh.
 */
task('lz:oapp:solana:sync-all-positions', 'Refresh and send every PositionWrapper over LayerZero and Chainlink')
    .addOptionalParam('fromEid', 'Solana endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .addOptionalParam('dstEid', 'Destination endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .addOptionalParam('fundLamports', 'SOL lamports moved onto the CCIP payer per send', 50_000_000, types.int)
    .addOptionalParam('only', 'Limit to one position as vault:nft, e.g. 1:29', '', types.string)
    .addFlag('skipRefresh', 'Send what is already in wrapper.snapshot without reading Jupiter again')
    .addFlag('force', 'Send even when the numbers did not change since the last send')
    .addFlag('dryRun', 'List what would be sent and stop')
    .addOptionalParam('computeUnitPriceScaleFactor', 'Compute unit price scale factor', 4, types.float)
    .setAction(async (args) => {
        const { Options } = await import('@layerzerolabs/lz-v2-utilities')
        const { getLayerZeroScanLink, isV2Testnet } = await import('../utils')
        const { ccipRouteAddress, decodeCcipRoute } = await import('../../lib/client/ccip')
        const { PublicKey } = await import('@solana/web3.js')
        requireCcip()
        const fromEid = resolveSolanaEid(args.fromEid)
        const dstEid = resolveEvmEid(args.dstEid)
        const solanaDeployment = getSolanaDeployment(fromEid)
        const { connection, umi, umiWalletSigner } = await deriveConnection(fromEid)
        const instance = new lendmirror.LendMirror(publicKey(solanaDeployment.programId))
        const store = await instance.getStore(umi.rpc)
        if (!store) throw new Error(`No Store at ${solanaDeployment.oapp}. Run lz:oapp:solana:create first.`)
        const routeInfo = await connection.getAccountInfo(new PublicKey(ccipRouteAddress(solanaDeployment.programId)))
        if (!routeInfo) throw new Error('No CCIP route. Run lz:oapp:solana:set-ccip-route first.')
        const route = decodeCcipRoute(routeInfo.data)

        let wrappers = await instance.listWrappers(umi.rpc)
        if (args.only) {
            const [vault, nft] = String(args.only).split(':').map(Number)
            wrappers = wrappers.filter((w) => w.vaultId === vault && w.nftId === nft)
        }
        console.log(`${wrappers.length} wrapper(s) found`)
        if (args.dryRun) {
            for (const w of wrappers) console.log(describe(w))
            return
        }

        const options = Options.newOptions().addExecutorLzReceiveOption(400000, 0).toBytes()
        for (const before of wrappers) {
            const { vaultId, nftId } = before
            const label = `vault ${vaultId} nft ${nftId}`
            try {
                if (!args.skipRefresh) {
                    const refreshTx = await sendOne(
                        await instance.refreshWrapper(umi.rpc, umiWalletSigner, vaultId, nftId, store.vaultsProgram)
                    )
                    console.log(`${label} refresh ${getExplorerTxLink(refreshTx, fromEid === 40168)}`)
                }
                const after = await instance.getWrapper(umi.rpc, vaultId, nftId)
                const snap = after ? unwrapOption(after.snapshot) : null
                if (!after || !snap) {
                    console.log(`${label} skip: no snapshot`)
                    continue
                }
                if (!args.force && !changed(before, after)) {
                    console.log(`${label} skip: unchanged since last send (use --force to resend)`)
                    continue
                }
                const { nativeFee } = await instance.quotePayload(umi.rpc, umiWalletSigner.publicKey, {
                    dstEid,
                    options,
                    payInLzToken: false,
                    vaultId,
                    nftId,
                })
                const sendTx = await sendOne(
                    await instance.sendPayload(umi.rpc, umiWalletSigner, {
                        dstEid,
                        options,
                        nativeFee,
                        vaultId,
                        nftId,
                        ccipFeeLamports: BigInt(args.fundLamports),
                        route,
                    })
                )
                console.log(
                    `${label} sent col ${snap.colRaw} debt ${snap.debtRaw} ${getExplorerTxLink(sendTx, fromEid === 40168)} ${getLayerZeroScanLink(sendTx, isV2Testnet(dstEid))}`
                )
            } catch (err) {
                // One bad position must not stop the loop for the others.
                console.error(`${label} failed:`, err instanceof Error ? err.message : err)
            }
        }

        async function sendOne(ix: Awaited<ReturnType<typeof instance.refreshWrapper>>): Promise<string> {
            let txBuilder = transactionBuilder().add(ix)
            txBuilder = await addComputeUnitInstructions(
                connection,
                umi,
                fromEid,
                txBuilder,
                umiWalletSigner,
                args.computeUnitPriceScaleFactor,
                TransactionType.SendMessage
            )
            const tx = await txBuilder.sendAndConfirm(umi)
            return bs58.encode(tx.signature)
        }
    })

type Wrapper = lendmirror.accounts.PositionWrapper

function describe(w: Wrapper): string {
    const snap = unwrapOption(w.snapshot)
    const numbers = snap ? `col ${snap.colRaw} debt ${snap.debtRaw} time ${snap.snapshotTime}` : 'no snapshot'
    return `vault ${w.vaultId} nft ${w.nftId} level ${w.level} lastSent ${w.lastSentSnapshotTime} ${numbers}`
}

/**
 * Did the refresh change anything worth sending? Compares the numbers the EVM side reads.
 * A wrapper that was never sent counts as changed.
 */
function changed(before: Wrapper, after: Wrapper): boolean {
    if (after.lastSentSnapshotTime === 0n) return true
    const a = unwrapOption(before.snapshot)
    const b = unwrapOption(after.snapshot)
    if (!a || !b) return true
    return a.colRaw !== b.colRaw || a.debtRaw !== b.debtRaw || a.tick !== b.tick || a.isLiquidated !== b.isLiquidated
}
