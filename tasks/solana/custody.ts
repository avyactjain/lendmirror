import { fetchAddressLookupTable, transferSol } from '@metaplex-foundation/mpl-toolbox'
import { publicKey, sol, transactionBuilder, unwrapOption } from '@metaplex-foundation/umi'
import { fromWeb3JsPublicKey, toWeb3JsPublicKey } from '@metaplex-foundation/umi-web3js-adapters'
import {
    NATIVE_MINT,
    createAssociatedTokenAccountIdempotentInstruction,
    createSyncNativeInstruction,
    getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { task, types } from 'hardhat/config'

import { lendmirror } from '../../lib/client'
import { buildOperatePosition } from '../../lib/client/jupiterOperate'
import { resolveSolanaEid } from '../common/deployment'
import { TransactionType, addComputeUnitInstructions, deriveConnection, getExplorerTxLink, getSolanaDeployment, useWeb3Js } from '.'

/**
 * Custody and access-level tasks. Order of use for one position:
 *   wrap-position → deposit-position-nft → set-wrapper-level 1 → operate-position (deposit / payback)
 *   → set-wrapper-level 2 → operate-position (withdraw / borrow) → refresh-wrapper.
 */

task('lz:oapp:solana:set-wrapper-level', 'Admin: set a wrapper access level (0 mirror, 1 deposit/payback, 2 + withdraw/borrow)')
    .addOptionalParam('eid', 'Solana endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .addOptionalParam('vaultId', 'Jupiter vault id', 1, types.int)
    .addOptionalParam('nftId', 'Jupiter position nft id', 29, types.int)
    .addParam('level', 'Access level 0..4', undefined, types.int)
    .addOptionalParam('computeUnitPriceScaleFactor', 'Compute unit price scale factor', 4, types.float)
    .setAction(async ({ eid: eidArg, vaultId, nftId, level, computeUnitPriceScaleFactor }) => {
        const eid = resolveSolanaEid(eidArg)
        const { connection, umi, umiWalletSigner } = await deriveConnection(eid)
        const instance = new lendmirror.LendMirror(publicKey(getSolanaDeployment(eid).programId))
        let txBuilder = transactionBuilder().add(instance.setWrapperLevel(umiWalletSigner, vaultId, nftId, level))
        txBuilder = await addComputeUnitInstructions(connection, umi, eid, txBuilder, umiWalletSigner, computeUnitPriceScaleFactor, TransactionType.SetAuthority)
        const tx = await txBuilder.sendAndConfirm(umi)
        console.log(`setWrapperLevel: ${getExplorerTxLink(bs58.encode(tx.signature), eid === 40168)}`)
        const wrapper = await instance.getWrapper(umi.rpc, vaultId, nftId)
        console.log({ level: wrapper?.level, custody: wrapper?.custody })
    })

task('lz:oapp:solana:deposit-position-nft', 'NFT holder: move the Jupiter position NFT into the wrapper authority and become the wrapper owner')
    .addOptionalParam('eid', 'Solana endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .addOptionalParam('vaultId', 'Jupiter vault id', 1, types.int)
    .addOptionalParam('nftId', 'Jupiter position nft id', 29, types.int)
    .addOptionalParam('computeUnitPriceScaleFactor', 'Compute unit price scale factor', 4, types.float)
    .setAction(async ({ eid: eidArg, vaultId, nftId, computeUnitPriceScaleFactor }) => {
        const eid = resolveSolanaEid(eidArg)
        const { connection, umi, umiWalletSigner } = await deriveConnection(eid)
        const instance = new lendmirror.LendMirror(publicKey(getSolanaDeployment(eid).programId))
        const store = await instance.getStore(umi.rpc)
        if (!store) throw new Error('No Store. Run lz:oapp:solana:create first.')
        let txBuilder = transactionBuilder().add(
            instance.depositPositionNft(umiWalletSigner, vaultId, nftId, store.vaultsProgram)
        )
        txBuilder = await addComputeUnitInstructions(connection, umi, eid, txBuilder, umiWalletSigner, computeUnitPriceScaleFactor, TransactionType.SendMessage)
        const tx = await txBuilder.sendAndConfirm(umi)
        console.log(`depositPositionNft: ${getExplorerTxLink(bs58.encode(tx.signature), eid === 40168)}`)
        const wrapper = await instance.getWrapper(umi.rpc, vaultId, nftId)
        console.log({ custody: wrapper?.custody, positionMint: wrapper?.positionMint })
    })

task('lz:oapp:solana:release-position-nft', 'Admin: return the position NFT to the wrapper owner')
    .addOptionalParam('eid', 'Solana endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .addOptionalParam('vaultId', 'Jupiter vault id', 1, types.int)
    .addOptionalParam('nftId', 'Jupiter position nft id', 29, types.int)
    .addOptionalParam('computeUnitPriceScaleFactor', 'Compute unit price scale factor', 4, types.float)
    .setAction(async ({ eid: eidArg, vaultId, nftId, computeUnitPriceScaleFactor }) => {
        const eid = resolveSolanaEid(eidArg)
        const { connection, umi, umiWalletSigner } = await deriveConnection(eid)
        const instance = new lendmirror.LendMirror(publicKey(getSolanaDeployment(eid).programId))
        const wrapper = await instance.getWrapper(umi.rpc, vaultId, nftId)
        if (!wrapper || !wrapper.custody) throw new Error('Wrapper has no NFT in custody.')
        let txBuilder = transactionBuilder().add(
            instance.releasePositionNft(umiWalletSigner, vaultId, nftId, wrapper.owner, wrapper.positionMint)
        )
        txBuilder = await addComputeUnitInstructions(connection, umi, eid, txBuilder, umiWalletSigner, computeUnitPriceScaleFactor, TransactionType.SendMessage)
        const tx = await txBuilder.sendAndConfirm(umi)
        console.log(`releasePositionNft: ${getExplorerTxLink(bs58.encode(tx.signature), eid === 40168)}`)
    })

task('lz:oapp:solana:operate-position', 'Deposit / withdraw / borrow / payback on a custodied position, within its level')
    .addOptionalParam('eid', 'Solana endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .addOptionalParam('vaultId', 'Jupiter vault id', 1, types.int)
    .addOptionalParam('nftId', 'Jupiter position nft id', 29, types.int)
    .addOptionalParam('col', 'Collateral change in base units. +deposit, -withdraw, "min" = withdraw all', '0', types.string)
    .addOptionalParam('debt', 'Debt change in base units. +borrow, -payback, "min" = payback all', '0', types.string)
    .addOptionalParam('market', 'Jupiter market: main, ethena, galaxy', 'main', types.string)
    .addOptionalParam('computeUnitPriceScaleFactor', 'Compute unit price scale factor', 4, types.float)
    .setAction(async ({ eid: eidArg, vaultId, nftId, col, debt, market, computeUnitPriceScaleFactor }) => {
        const eid = resolveSolanaEid(eidArg)
        const { connection, umi, umiWalletSigner } = await deriveConnection(eid)
        const instance = new lendmirror.LendMirror(publicKey(getSolanaDeployment(eid).programId))
        const store = await instance.getStore(umi.rpc)
        if (!store) throw new Error('No Store. Run lz:oapp:solana:create first.')
        const wrapper = await instance.getWrapper(umi.rpc, vaultId, nftId)
        if (!wrapper) throw new Error('No wrapper. Run wrap-position first.')
        if (!wrapper.custody) throw new Error('NFT not in custody. Run deposit-position-nft first.')

        // The Jupiter SDK simulates a price read with the operate signer (our authority PDA) as
        // fee payer, and Jupiter may create accounts paid by that signer. Keep 0.05 SOL on it.
        const authorityPda = toWeb3JsPublicKey(instance.pda.wrapperAuthority(instance.pda.wrapper(vaultId, nftId)[0])[0])
        const pdaBalance = await connection.getBalance(authorityPda)
        if (pdaBalance < 50_000_000) {
            const fund = await transactionBuilder()
                .add(transferSol(umi, { source: umiWalletSigner, destination: fromWeb3JsPublicKey(authorityPda), amount: sol(0.05) }))
                .sendAndConfirm(umi)
            console.log(`funded authority PDA ${authorityPda.toBase58()}: ${getExplorerTxLink(bs58.encode(fund.signature), eid === 40168)}`)
        }

        const build = await buildOperatePosition({
            connection,
            rpc: umi.rpc,
            instance,
            authority: umiWalletSigner,
            vaultId,
            nftId,
            vaultsProgram: store.vaultsProgram,
            positionMint: wrapper.positionMint,
            newCol: parseSigned(col),
            newDebt: parseSigned(debt),
            market,
        })

        // Jupiter's lookup tables plus the LayerZero one the helper adds.
        let txBuilder = transactionBuilder().add(build.setupIxs).add(build.operateIx)
        txBuilder = await addComputeUnitInstructions(connection, umi, eid, txBuilder, umiWalletSigner, computeUnitPriceScaleFactor, TransactionType.SendMessage)
        const tables = await Promise.all(
            build.lookupTables.map((t) => fetchAddressLookupTable(umi, fromWeb3JsPublicKey(t.key)))
        )
        txBuilder = txBuilder.setAddressLookupTables([...(txBuilder.options.addressLookupTables ?? []), ...tables])
        const tx = await txBuilder.sendAndConfirm(umi)
        console.log(`operatePosition: ${getExplorerTxLink(bs58.encode(tx.signature), eid === 40168)}`)
        for (const [name, ata] of Object.entries(build.authorityAtas)) {
            const bal = await connection.getTokenAccountBalance(ata).catch(() => null)
            console.log(`${name} ATA ${ata.toBase58()} balance ${bal?.value.amount ?? 'n/a'}`)
        }
        const after = await instance.getWrapper(umi.rpc, vaultId, nftId)
        const snap = after ? unwrapOption(after.snapshot) : null
        console.log('wrapper.snapshot is from the last refresh; run refresh-wrapper to read the new numbers', snap ? `(last col ${snap.colRaw} debt ${snap.debtRaw})` : '')
    })

/** "min" → i128::MIN (Jupiter's "all"). Anything else is a signed integer string. */
function parseSigned(value: string): bigint {
    if (value.trim().toLowerCase() === 'min') return -(1n << 127n)
    return BigInt(value)
}

/** ESM-only Jupiter SDK, loaded the way tests/fork does it. */
const loadJupiterBorrow = new Function('s', 'return import(s)') as (s: string) => Promise<{
    getInitPositionIx: (p: { vaultId: number; connection: Connection; signer: PublicKey; market?: string }) => Promise<{ ix: TransactionInstruction; nftId: number }>
}>

task('lz:oapp:solana:jupiter-init-position', 'Open a new Jupiter position in a vault; the wallet receives the position NFT')
    .addOptionalParam('eid', 'Solana endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .addOptionalParam('vaultId', 'Jupiter vault id', 1, types.int)
    .addOptionalParam('market', 'Jupiter market: main, ethena, galaxy', 'main', types.string)
    .setAction(async ({ eid: eidArg, vaultId, market }) => {
        const eid = resolveSolanaEid(eidArg)
        const { connection } = await deriveConnection(eid)
        const { web3JsKeypair } = await useWeb3Js()
        const { getInitPositionIx } = await loadJupiterBorrow('@jup-ag/lend/borrow')
        const { ix, nftId } = await getInitPositionIx({
            vaultId,
            connection,
            signer: web3JsKeypair.publicKey,
            market,
        })
        const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [web3JsKeypair])
        console.log(`initPosition: ${getExplorerTxLink(sig, eid === 40168)}`)
        console.log(`vault ${vaultId} nft ${nftId}. Next: wrap-position --nft-id ${nftId}, then deposit-position-nft.`)
    })

task('lz:oapp:solana:fund-authority-wsol', 'Wrap SOL into the wrapper authority\'s WSOL account, as collateral to deposit')
    .addOptionalParam('eid', 'Solana endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .addOptionalParam('vaultId', 'Jupiter vault id', 1, types.int)
    .addOptionalParam('nftId', 'Jupiter position nft id', 29, types.int)
    .addParam('lamports', 'Lamports of SOL to wrap', undefined, types.string)
    .setAction(async ({ eid: eidArg, vaultId, nftId, lamports }) => {
        const eid = resolveSolanaEid(eidArg)
        const { connection } = await deriveConnection(eid)
        const { web3JsKeypair } = await useWeb3Js()
        const instance = new lendmirror.LendMirror(publicKey(getSolanaDeployment(eid).programId))
        const authority = toWeb3JsPublicKey(instance.pda.wrapperAuthority(instance.pda.wrapper(vaultId, nftId)[0])[0])
        const ata = getAssociatedTokenAddressSync(NATIVE_MINT, authority, true)
        const tx = new Transaction()
            .add(createAssociatedTokenAccountIdempotentInstruction(web3JsKeypair.publicKey, ata, authority, NATIVE_MINT))
            .add(SystemProgram.transfer({ fromPubkey: web3JsKeypair.publicKey, toPubkey: ata, lamports: BigInt(lamports) }))
            .add(createSyncNativeInstruction(ata))
        const sig = await sendAndConfirmTransaction(connection, tx, [web3JsKeypair])
        console.log(`fundAuthorityWsol: ${getExplorerTxLink(sig, eid === 40168)}`)
        const bal = await connection.getTokenAccountBalance(ata)
        console.log(`authority WSOL ATA ${ata.toBase58()} balance ${bal.value.amount}`)
    })

task('lz:oapp:solana:fund-authority-token', 'Move SPL tokens from the wallet into the wrapper authority\'s token account (Token or Token-2022)')
    .addOptionalParam('eid', 'Solana endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .addOptionalParam('vaultId', 'Jupiter vault id', 1, types.int)
    .addOptionalParam('nftId', 'Jupiter position nft id', 29, types.int)
    .addParam('mint', 'Token mint', undefined, types.string)
    .addParam('amount', 'Base units to move', undefined, types.string)
    .setAction(async ({ eid: eidArg, vaultId, nftId, mint, amount }) => {
        const { createTransferCheckedInstruction, getMint } = await import('@solana/spl-token')
        const eid = resolveSolanaEid(eidArg)
        const { connection } = await deriveConnection(eid)
        const { web3JsKeypair } = await useWeb3Js()
        const instance = new lendmirror.LendMirror(publicKey(getSolanaDeployment(eid).programId))
        const authority = toWeb3JsPublicKey(instance.pda.wrapperAuthority(instance.pda.wrapper(vaultId, nftId)[0])[0])
        const mintKey = new PublicKey(mint)
        const tokenProgram = (await connection.getAccountInfo(mintKey))!.owner
        const decimals = (await getMint(connection, mintKey, 'confirmed', tokenProgram)).decimals
        const from = getAssociatedTokenAddressSync(mintKey, web3JsKeypair.publicKey, false, tokenProgram)
        const to = getAssociatedTokenAddressSync(mintKey, authority, true, tokenProgram)
        const tx = new Transaction()
            .add(createAssociatedTokenAccountIdempotentInstruction(web3JsKeypair.publicKey, to, authority, mintKey, tokenProgram))
            .add(createTransferCheckedInstruction(from, mintKey, to, web3JsKeypair.publicKey, BigInt(amount), decimals, [], tokenProgram))
        const sig = await sendAndConfirmTransaction(connection, tx, [web3JsKeypair])
        console.log(`fundAuthorityToken: ${getExplorerTxLink(sig, eid === 40168)}`)
        const bal = await connection.getTokenAccountBalance(to)
        console.log(`authority token account ${to.toBase58()} balance ${bal.value.amount}`)
    })
