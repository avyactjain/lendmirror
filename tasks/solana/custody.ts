import { transferSol } from '@metaplex-foundation/mpl-toolbox'
import { WrappedInstruction, publicKey, sol, transactionBuilder, unwrapOption } from '@metaplex-foundation/umi'
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
import { DexLeg, buildOperatePosition } from '../../lib/client/jupiterOperate'
import { resolveSolanaEid } from '../common/deployment'
import { TransactionType, addComputeUnitInstructions, deriveConnection, getExplorerTxLink, getSolanaDeployment, useWeb3Js } from '.'

/**
 * Custody and access-level tasks. Order of use for one position:
 *   wrap-position → deposit-position-nft → set-wrapper-level 1 → operate-position (supply / payback)
 *   → set-wrapper-level 2 → operate-position (withdraw / borrow) → refresh-wrapper.
 * operate-position works on smart vaults only (Jupiter operate_dex).
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

task('lz:oapp:solana:operate-position', 'Smart vaults (Jupiter operate_dex): supply or withdraw collateral, borrow or pay back debt, within the wrapper level')
    .addOptionalParam('eid', 'Solana endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .addParam('vaultId', 'Jupiter vault id (a smart vault: T2, T3 or T4)', undefined, types.int)
    .addParam('nftId', 'Jupiter position nft id', undefined, types.int)
    .addOptionalParam('colAction', 'Collateral: supply or withdraw', '', types.string)
    .addOptionalParam('colToken0', 'Smart collateral: pool token0 amount, base units', '', types.string)
    .addOptionalParam('colToken1', 'Smart collateral: pool token1 amount, base units', '', types.string)
    .addOptionalParam('colAmount', 'Normal collateral (T3 vaults): amount, base units', '', types.string)
    .addOptionalParam('colShares', 'Share bound: minimum on supply, maximum on withdraw. Withdraw default: all of the position\'s shares', '', types.string)
    .addOptionalParam('debtAction', 'Debt: borrow or payback', '', types.string)
    .addOptionalParam('debtToken0', 'Smart debt (T3/T4): pool token0 amount, base units', '', types.string)
    .addOptionalParam('debtToken1', 'Smart debt (T3/T4): pool token1 amount, base units', '', types.string)
    .addOptionalParam('debtAmount', 'Normal debt (T2 vaults): amount, base units', '', types.string)
    .addOptionalParam('debtShares', 'Share bound: minimum on borrow, maximum on payback', '', types.string)
    .addOptionalParam('market', 'Jupiter market: main, ethena, galaxy', 'main', types.string)
    .addOptionalParam('computeUnitPriceScaleFactor', 'Compute unit price scale factor', 4, types.float)
    .setAction(async (args) => {
        const { vaultId, nftId, market, computeUnitPriceScaleFactor } = args
        const eid = resolveSolanaEid(args.eid)
        const { connection, umi, umiWalletSigner } = await deriveConnection(eid)
        const instance = new lendmirror.LendMirror(publicKey(getSolanaDeployment(eid).programId))
        const store = await instance.getStore(umi.rpc)
        if (!store) throw new Error('No Store. Run lz:oapp:solana:create first.')
        const wrapper = await instance.getWrapper(umi.rpc, vaultId, nftId)
        if (!wrapper) throw new Error('No wrapper. Run wrap-position first.')
        if (!wrapper.custody) throw new Error('NFT not in custody. Run deposit-position-nft first.')

        const col = legFrom('collateral', ['supply', 'withdraw'], args.colAction, args.colToken0, args.colToken1, args.colAmount, args.colShares)
        const debt = legFrom('debt', ['borrow', 'payback'], args.debtAction, args.debtToken0, args.debtToken1, args.debtAmount, args.debtShares)
        if (!col && !debt) throw new Error('Nothing to do: pass --col-action and/or --debt-action with amounts.')
        // A smart-collateral withdraw needs a share bound. Default: at most all of the position's shares.
        if (col?.action === 'withdraw' && col.shares === undefined && (col.token0 !== undefined || col.token1 !== undefined)) {
            const { getCurrentPosition } = await loadJupiterBorrow('@jup-ag/lend/borrow')
            const current = await getCurrentPosition({ vaultId, positionId: nftId, connection, market })
            col.shares = BigInt(current.colRaw.toString())
            console.log(`share bound for the withdraw: at most ${col.shares} shares (all of the position's)`)
        }

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
            col,
            debt,
            market,
        })

        // Two transactions: Jupiter's setup plus the PDA's token accounts, then the operate. Each
        // uses Jupiter's lookup tables plus our own; together they can exceed the size limit.
        // The tables go into the compute-unit helper so its measuring simulation uses them too:
        // without them the operate's ~80 accounts do not fit in a transaction at all.
        const jupiterTables = build.lookupTables.map((t) => fromWeb3JsPublicKey(t.key))
        const sendWithTables = async (ixs: WrappedInstruction[], label: string) => {
            let txBuilder = transactionBuilder().add(ixs)
            txBuilder = await addComputeUnitInstructions(connection, umi, eid, txBuilder, umiWalletSigner, computeUnitPriceScaleFactor, TransactionType.SendMessage, jupiterTables)
            const tx = await txBuilder.sendAndConfirm(umi)
            console.log(`${label}: ${getExplorerTxLink(bs58.encode(tx.signature), eid === 40168)}`)
        }
        if (build.setupIxs.length) {
            await sendWithTables(build.setupIxs, 'setup')
            // The setup creates accounts the operate needs (e.g. Jupiter's tick record). An RPC
            // pool can answer the operate's checks from a node that has not seen them yet.
            await new Promise((resolve) => setTimeout(resolve, 2000))
        }
        for (let attempt = 1; ; attempt++) {
            try {
                await sendWithTables([build.operateIx], 'operatePosition')
                break
            } catch (err) {
                const lagging = /AccountOwnedByWrongProgram|AccountNotInitialized/.test(String(err))
                if (!lagging || attempt === 3) throw err
                console.log(`operate saw an account the setup just created as missing (RPC lag); retrying (${attempt}/2)`)
                await new Promise((resolve) => setTimeout(resolve, 3000))
            }
        }
        for (const { label, address } of build.authorityAccounts) {
            console.log(`${label} account ${address.toBase58()} balance ${await readBalance(connection, address)}`)
        }
        const after = await instance.getWrapper(umi.rpc, vaultId, nftId)
        const snap = after ? unwrapOption(after.snapshot) : null
        console.log('wrapper.snapshot is from the last refresh; run refresh-wrapper to read the new numbers', snap ? `(last col ${snap.colRaw} debt ${snap.debtRaw})` : '')
    })

/** One side of an operate call from the task flags. Amounts are positive; the action gives the direction. */
function legFrom(
    side: string,
    actions: string[],
    action: string,
    token0: string,
    token1: string,
    amount: string,
    shares: string
): DexLeg | undefined {
    const values = { token0, token1, amount, shares }
    if (!action) {
        if (Object.values(values).some((v) => v !== '')) throw new Error(`Amounts for the ${side} need --${side === 'debt' ? 'debt' : 'col'}-action.`)
        return undefined
    }
    if (!actions.includes(action)) throw new Error(`${side} action must be ${actions.join(' or ')}, got "${action}".`)
    const parse = (label: string, v: string) => {
        if (v === '') return undefined
        const n = BigInt(v)
        if (n < 0n) throw new Error(`${side} ${label} must be a positive amount; the action gives the direction.`)
        return n
    }
    return {
        action: action as DexLeg['action'],
        token0: parse('token0', token0),
        token1: parse('token1', token1),
        amount: parse('amount', amount),
        shares: parse('shares', shares),
    }
}

/** ESM-only Jupiter SDK, loaded the way tests/fork does it. */
const loadJupiterBorrow = new Function('s', 'return import(s)') as (s: string) => Promise<{
    getInitPositionIx: (p: { vaultId: number; connection: Connection; signer: PublicKey; market?: string }) => Promise<{ ix: TransactionInstruction; nftId: number }>
    getCurrentPosition: (p: { vaultId: number; positionId: number; connection: Connection; market: string }) => Promise<{ colRaw: { toString(): string } }>
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
        console.log(`authority WSOL ATA ${ata.toBase58()} balance ${await readBalance(connection, ata)}`)
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
        console.log(`authority token account ${to.toBase58()} balance ${await readBalance(connection, to)}`)
    })

/**
 * Token balance, retried for a few seconds. The transaction is already confirmed when this runs,
 * but an RPC pool can answer from a node that has not seen a brand-new account yet
 * ("could not find account"). That is a display problem, not a failed transfer.
 */
async function readBalance(connection: Connection, account: PublicKey): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt++) {
        try {
            return (await connection.getTokenAccountBalance(account, 'confirmed')).value.amount
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 1000))
        }
    }
    return 'not visible on this RPC yet; the transaction above is confirmed, check it on Solscan'
}
