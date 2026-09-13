import { publicKey, transactionBuilder } from '@metaplex-foundation/umi'
import bs58 from 'bs58'
import { task, types } from 'hardhat/config'

import { EndpointId } from '@layerzerolabs/lz-definitions'

import { lendmirror, pythPushFeedAccount } from '../../lib/client'
import { TransactionType, addComputeUnitInstructions, deriveConnection, getExplorerTxLink, getSolanaDeployment } from '.'

interface Args {
    eid: EndpointId
    feedId: string
    shard: number
    priceFeed?: string
    computeUnitPriceScaleFactor: number
}

task('lz:oapp:solana:get-pyth-price', 'Reads the Pyth shard-0 push feed into Store. Only feed id is required.')
    .addParam('eid', 'Solana endpoint ID (40168 = Devnet)', undefined, types.int)
    .addParam('feedId', 'Pyth feed id, 32-byte hex', undefined, types.string)
    .addOptionalParam('shard', 'Pyth push-feed shard (0 = sponsored public feed)', 0, types.int)
    .addOptionalParam('priceFeed', 'Override push-feed account. Default is derived from feed id + shard.', undefined, types.string)
    .addOptionalParam('computeUnitPriceScaleFactor', 'Compute unit price scale factor', 4, types.float)
    .setAction(async ({ eid, feedId, shard, priceFeed, computeUnitPriceScaleFactor }: Args) => {
        const isTestnet = eid == EndpointId.SOLANA_V2_TESTNET
        const solanaDeployment = getSolanaDeployment(eid)
        const { connection, umi, umiWalletSigner } = await deriveConnection(eid)
        const instance = new lendmirror.LendMirror(publicKey(solanaDeployment.programId))
        const parsedFeedId = lendmirror.parseFeedId(feedId)
        const [derived] = pythPushFeedAccount(parsedFeedId, shard)
        const feedAccount = priceFeed ? publicKey(priceFeed) : derived
        console.log('Pyth push feed account:', feedAccount.toString())

        let txBuilder = transactionBuilder().add(instance.getPythPrice(umiWalletSigner, parsedFeedId, feedAccount, shard))
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
        console.log(`getPythPrice: ${getExplorerTxLink(bs58.encode(tx.signature), isTestnet)}`)
    })
