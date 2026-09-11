import { publicKey, transactionBuilder } from '@metaplex-foundation/umi'
import bs58 from 'bs58'
import { task, types } from 'hardhat/config'
import { ActionType, HardhatRuntimeEnvironment } from 'hardhat/types'

import { EndpointId } from '@layerzerolabs/lz-definitions'

import { lendmirror } from '../../lib/client'

import { deriveConnection, getExplorerTxLink, saveSolanaDeployment } from '.'

interface Args {
    programId: string
    /**
     * The endpoint ID for the Solana network.
     */
    eid: EndpointId
    /**
     * Optional Address Lookup Table (ALT) address.
     */
    alt?: string
}

const action: ActionType<Args> = async ({ programId, eid, alt }, hre: HardhatRuntimeEnvironment) => {
    const isTestnet = eid == EndpointId.SOLANA_V2_TESTNET

    const lendmirrorInstance: lendmirror.LendMirror = new lendmirror.LendMirror(publicKey(programId))
    const [oapp] = lendmirrorInstance.pda.oapp()
    const { umi, umiWalletSigner } = await deriveConnection(eid)
    const altPubkey = alt ? publicKey(alt) : undefined
    const txBuilder = transactionBuilder().add(
        lendmirrorInstance.initStore(umiWalletSigner, umiWalletSigner.publicKey, altPubkey)
    )
    const tx = await txBuilder.sendAndConfirm(umi)
    console.log(`createTx: ${getExplorerTxLink(bs58.encode(tx.signature), isTestnet)}`)
    saveSolanaDeployment(eid, programId, oapp)
}

task('lz:oapp:solana:create', 'inits the oapp account', action)
    .addParam('programId', 'The program ID of the OApp', undefined, types.string, false)
    .addParam('eid', 'The endpoint ID for the Solana network.', undefined, types.int, false)
    .addOptionalParam('alt', 'Address Lookup Table (ALT) address', undefined, types.string)
