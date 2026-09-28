import { readFileSync } from 'node:fs'
import path from 'node:path'

import { publicKey, transactionBuilder } from '@metaplex-foundation/umi'
import bs58 from 'bs58'
import { task, types } from 'hardhat/config'

import { lendmirror } from '../../lib/client'
import { initOAppNonce } from '../../lib/client/lendmirror'
import { resolveEvmEid, resolveEvmNetwork, resolveSolanaEid } from '../common/deployment'

import {
    TransactionType,
    addComputeUnitInstructions,
    deriveConnection,
    getExplorerTxLink,
    getSolanaDeployment,
} from '.'

function evmAddressToBytes32(address: string): Uint8Array {
    const hex = address.replace(/^0x/i, '')
    if (hex.length !== 40) {
        throw new Error(`Expected a 20-byte EVM address, got ${address}`)
    }
    const out = Buffer.alloc(32)
    Buffer.from(hex, 'hex').copy(out, 12)
    return new Uint8Array(out)
}

function evmAddressFromDeployments(network: string, contractName: string): string {
    const filePath = path.join('deployments', network, `${contractName}.json`)
    const json = JSON.parse(readFileSync(filePath, 'utf8')) as { address?: string }
    if (!json.address) {
        throw new Error(`No address in ${filePath}`)
    }
    return json.address
}

task('lz:oapp:solana:set-peer', 'Admin: set EVM peer on Solana and init LayerZero nonce for that address')
    .addOptionalParam('eid', 'Solana endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .addOptionalParam('dstEid', 'Destination endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .addOptionalParam('peer', 'EVM proxy address. Default: deployments/<evm-network>/LendMirror.json', undefined, types.string)
    .addOptionalParam('evmNetwork', 'Hardhat network folder under deployments/. Default: profile.', undefined, types.string)
    .addOptionalParam('contractName', 'EVM deployment JSON name', 'LendMirror', types.string)
    .addOptionalParam('computeUnitPriceScaleFactor', 'Compute unit price scale factor', 4, types.float)
    .setAction(
        async ({
            eid: eidArg,
            dstEid: dstArg,
            peer,
            evmNetwork: networkArg,
            contractName,
            computeUnitPriceScaleFactor,
        }) => {
            const eid = resolveSolanaEid(eidArg)
            const dstEid = resolveEvmEid(dstArg)
            const evmNetwork = resolveEvmNetwork(networkArg)
            const evm = peer ?? evmAddressFromDeployments(evmNetwork, contractName)
            const remote = evmAddressToBytes32(evm)
            const solanaDeployment = getSolanaDeployment(eid)
            const { connection, umi, umiWalletSigner } = await deriveConnection(eid)
            const instance = new lendmirror.LendMirror(publicKey(solanaDeployment.programId))
            const [store] = instance.pda.oapp()

            let setPeerTx = transactionBuilder().add(
                instance.setPeerConfig(
                    { admin: umiWalletSigner },
                    { __kind: 'PeerAddress', peer: remote, remote: dstEid }
                )
            )
            setPeerTx = await addComputeUnitInstructions(
                connection,
                umi,
                eid,
                setPeerTx,
                umiWalletSigner,
                computeUnitPriceScaleFactor,
                TransactionType.SetAuthority
            )
            const peerSig = await setPeerTx.sendAndConfirm(umi)
            console.log(`solana setPeer: ${getExplorerTxLink(bs58.encode(peerSig.signature), eid === 40168)}`)
            console.log(`peer (${dstEid}): ${evm}`)

            try {
                let nonceTx = transactionBuilder().add(
                    initOAppNonce({ admin: umiWalletSigner, oapp: store }, dstEid, remote)
                )
                nonceTx = await addComputeUnitInstructions(
                    connection,
                    umi,
                    eid,
                    nonceTx,
                    umiWalletSigner,
                    computeUnitPriceScaleFactor,
                    TransactionType.InitConfig
                )
                const nonceSig = await nonceTx.sendAndConfirm(umi)
                console.log(`nonce init: ${getExplorerTxLink(bs58.encode(nonceSig.signature), eid === 40168)}`)
            } catch (err) {
                const text = err instanceof Error ? err.message : String(err)
                console.log(`nonce init skipped or failed: ${text}`)
            }
        }
    )

task('lz:oapp:solana:get-peer', 'Print the EVM address stored as peer on Solana (does not read DVNs)')
    .addOptionalParam('eid', 'Solana endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .addOptionalParam('dstEid', 'Destination endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .setAction(async ({ eid: eidArg, dstEid: dstArg }) => {
        const eid = resolveSolanaEid(eidArg)
        const dstEid = resolveEvmEid(dstArg)
        const solanaDeployment = getSolanaDeployment(eid)
        const { umi } = await deriveConnection(eid, true)
        const instance = new lendmirror.LendMirror(publicKey(solanaDeployment.programId))
        const [peerPda] = instance.pda.peer(dstEid)
        const info = await lendmirror.accounts.fetchPeerConfig(umi, peerPda)
        console.log('peer pda', peerPda)
        console.log('peer address', Buffer.from(info.peerAddress).toString('hex'))
    })
