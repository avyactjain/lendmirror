import { publicKey, transactionBuilder } from '@metaplex-foundation/umi'
import bs58 from 'bs58'
import { task, types } from 'hardhat/config'
import { ActionType, HardhatRuntimeEnvironment } from 'hardhat/types'

import { EndpointId } from '@layerzerolabs/lz-definitions'

import { lendmirror } from '../../lib/client'
import { getProfile, resolveSolanaEid } from '../common/deployment'

import { deriveConnection, getExplorerTxLink, saveSolanaDeployment } from '.'

interface Args {
    programId?: string
    eid?: EndpointId
}

const action: ActionType<Args> = async ({ programId: programIdArg, eid: eidArg }, hre: HardhatRuntimeEnvironment) => {
    const eid = resolveSolanaEid(eidArg) as EndpointId
    const profile = getProfile()
    const programId = programIdArg || profile.programId
    if (programId !== profile.programId) {
        throw new Error(
            `programId ${programId} does not match DEPLOYMENT_TYPE=${profile.type} (expected ${profile.programId}).`
        )
    }
    const isTestnet = eid == EndpointId.SOLANA_V2_TESTNET

    // Payer must be this program's upgrade authority. A random wallet cannot create the Store.
    const lendmirrorInstance: lendmirror.LendMirror = new lendmirror.LendMirror(publicKey(programId))
    const [oapp] = lendmirrorInstance.pda.oapp()
    const { umi, umiWalletSigner } = await deriveConnection(eid)
    const vaultsProgram = isTestnet ? lendmirror.JUPITER_VAULTS_DEVNET : lendmirror.JUPITER_VAULTS_MAINNET
    const txBuilder = transactionBuilder().add(
        lendmirrorInstance.initStore(umiWalletSigner, umiWalletSigner.publicKey, vaultsProgram)
    )
    const tx = await txBuilder.sendAndConfirm(umi)
    console.log(`createTx: ${getExplorerTxLink(bs58.encode(tx.signature), isTestnet)}`)
    saveSolanaDeployment(eid, programId, oapp)
}

task('lz:oapp:solana:create', 'inits the oapp account', action)
    .addOptionalParam('programId', 'The program ID of the OApp. Default: DEPLOYMENT_TYPE profile.', undefined, types.string)
    .addOptionalParam('eid', 'The endpoint ID for the Solana network. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
