import { publicKey } from '@metaplex-foundation/umi'
import { task, types } from 'hardhat/config'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { lendmirror } from '../../lib/client'
import { ccipPayerAddress, ccipRouteAddress, ccipSendAccounts, decodeCcipRoute } from '../../lib/client/ccip'
import { CCTP_MESSAGE_TRANSMITTER_V2, CCTP_TOKEN_MESSENGER_MINTER_V2, cctpAccounts } from '../../lib/client/bridge'
import { getProfile, resolveEvmEid, resolveSolanaEid } from '../common/deployment'
import { deriveConnection, getExplorerTxLink, getSolanaDeployment, useWeb3Js } from '.'

/**
 * Create (or extend) our address lookup table with every fixed account the sends and bridges
 * use: Store, routes, payer, LayerZero peer and endpoint settings, all Chainlink router / fee
 * quoter / RMN accounts, Circle's CCTP accounts, and the token programs. The address is saved
 * in deployments/<network>/OApp.json and picked up by every task automatically.
 *
 * Why: a transaction names each account with 32 bytes unless a lookup table holds it, in which
 * case 1 byte is enough. The combined LayerZero + Chainlink send has ~41 accounts and does not
 * fit in Solana's 1232-byte limit without this.
 */
task('lz:oapp:solana:create-lookup-table', 'Create or extend our address lookup table for the send and bridge transactions')
    .addOptionalParam('eid', 'Solana endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .setAction(async ({ eid: eidArg }) => {
        const { AddressLookupTableProgram, PublicKey, Transaction, sendAndConfirmTransaction, SystemProgram } = await import('@solana/web3.js')
        const { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT } = await import('@solana/spl-token')
        const eid = resolveSolanaEid(eidArg)
        const dstEid = resolveEvmEid()
        const profile = getProfile()
        const deployment = getSolanaDeployment(eid)
        const { connection, umi } = await deriveConnection(eid)
        const { web3JsKeypair: wallet } = await useWeb3Js()
        const instance = new lendmirror.LendMirror(publicKey(deployment.programId))

        const addresses = new Set<string>()
        const add = (...keys: (string | { toString(): string })[]) => keys.forEach((k) => addresses.add(String(k)))
        add(deployment.programId, deployment.oapp, instance.pda.peer(dstEid)[0], instance.endpointSDK.pda.setting()[0])
        add(ccipRouteAddress(deployment.programId), ccipPayerAddress(deployment.programId))
        add(TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, SystemProgram.programId)
        const routeInfo = await connection.getAccountInfo(new PublicKey(ccipRouteAddress(deployment.programId)))
        if (routeInfo) {
            const route = decodeCcipRoute(routeInfo.data)
            const payer = ccipPayerAddress(deployment.programId)
            add(route.router, route.feeQuoter, route.rmnRemote, route.linkMint)
            for (const v of Object.values(ccipSendAccounts(route, payer))) add(v)
        }
        if (profile.cctp) {
            const c = cctpAccounts(profile.cctp.usdcMint, ccipPayerAddress(deployment.programId), profile.cctp.evmDomain)
            add(CCTP_TOKEN_MESSENGER_MINTER_V2, CCTP_MESSAGE_TRANSMITTER_V2, profile.cctp.usdcMint)
            for (const v of Object.values(c)) add(v)
        }
        const wanted = [...addresses].map((k) => new PublicKey(k))

        let table: InstanceType<typeof PublicKey>
        let existing: string[] = []
        if (deployment.lookupTable) {
            table = new PublicKey(deployment.lookupTable)
            const { value } = await connection.getAddressLookupTable(table)
            if (!value) throw new Error(`Lookup table ${deployment.lookupTable} not found on chain`)
            existing = value.state.addresses.map((a) => a.toBase58())
            console.log('extending existing table', table.toBase58(), 'with', existing.length, 'entries')
        } else {
            const slot = await connection.getSlot('finalized')
            const [ix, address] = AddressLookupTableProgram.createLookupTable({
                authority: wallet.publicKey,
                payer: wallet.publicKey,
                recentSlot: slot,
            })
            const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [wallet], { commitment: 'confirmed' })
            table = address
            console.log('created table', table.toBase58(), getExplorerTxLink(sig, eid === 40168))
        }

        const missing = wanted.filter((k) => !existing.includes(k.toBase58()))
        for (let i = 0; i < missing.length; i += 20) {
            const chunk = missing.slice(i, i + 20)
            const ix = AddressLookupTableProgram.extendLookupTable({
                lookupTable: table,
                authority: wallet.publicKey,
                payer: wallet.publicKey,
                addresses: chunk,
            })
            const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [wallet], { commitment: 'confirmed' })
            console.log(`added ${chunk.length} addresses`, getExplorerTxLink(sig, eid === 40168))
        }
        console.log(`table ${table.toBase58()} now covers ${existing.length + missing.length} addresses`)

        const file = path.join('deployments', getNetworkDir(eid), 'OApp.json')
        if (!existsSync(file)) throw new Error(`Missing ${file}`)
        const json = JSON.parse(readFileSync(file, 'utf8'))
        json.lookupTable = table.toBase58()
        writeFileSync(file, JSON.stringify(json, null, 4) + '\n')
        console.log('saved to', file, '(commit it). Tables become usable one slot after extension.')
        void umi
    })

function getNetworkDir(eid: number): string {
    return eid === 40168 ? 'solana-testnet' : 'solana-mainnet'
}
