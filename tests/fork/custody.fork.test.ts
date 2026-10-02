/**
 * Custody, levels and Jupiter smart-vault operations against a local fork of Jupiter Lend
 * mainnet. Vault 95: USDG/USDC smart collateral, USDC debt (a T2 vault), operated through our
 * program's `operate_position`, which calls Jupiter's `operate_dex`. Started by
 * tests/fork/run.cjs. Read-only against mainnet; every transaction here hits the local validator.
 *
 * Flow: init_store → Jupiter init_position (wallet gets the NFT) → wallet hands the NFT to a
 * second wallet, the "holder" → wallet (a snapshotter) wraps → holder deposits the NFT and
 * becomes the wrapper owner → holder puts the wallet on the OnDemand list → level 1 → supply
 * USDC as smart collateral (allowed) → borrow (denied) → level 2 → a borrow paying into the
 * wallet (refused) → borrow (USDC lands in the wrapper authority's account) → level 1 → pay
 * back (allowed) → withdraw (denied) → level 2 → withdraw → refresh → admin releases the NFT.
 */
import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { mplToolbox } from '@metaplex-foundation/mpl-toolbox'
import {
    WrappedInstruction,
    createSignerFromKeypair,
    publicKey,
    signerIdentity,
    unwrapOption,
} from '@metaplex-foundation/umi'
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import { fromWeb3JsPublicKey, toWeb3JsInstruction, toWeb3JsPublicKey } from '@metaplex-foundation/umi-web3js-adapters'
import {
    createAssociatedTokenAccountIdempotentInstruction,
    createTransferCheckedInstruction,
    getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import {
    AddressLookupTableAccount,
    ComputeBudgetProgram,
    Connection,
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    SystemProgram,
    Transaction,
    TransactionMessage,
    VersionedTransaction,
    sendAndConfirmTransaction,
} from '@solana/web3.js'

import { lendmirror } from '../../lib/client'
import { decodeJupiterPositionFields, jupiterPositionMintPda, jupiterPositionPda } from '../../lib/client/jupiter'
import { DexLeg, buildOperatePosition } from '../../lib/client/jupiterOperate'

const PROGRAM_ID = 'GQDxkWJhMGppaXExXBC8hGWmfaUv9igo4PKdaLyc53T1'
const VAULT_ID = 95
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
const PDA_FUNDING = 30_000_000n // 30 USDC moved into the wrapper authority's account
const SUPPLY = 20_000_000n // 20 USDC supplied as smart collateral (pool token1)
const BORROW = 5_000_000n // 5 USDC
const PAYBACK = 2_000_000n // 2 USDC
const WITHDRAW = 5_000_000n // 5 USDC of collateral

const loadEsm = new Function('s', 'return import(s)') as (s: string) => Promise<{
    getInitPositionIx: (p: {
        vaultId: number
        connection: Connection
        signer: PublicKey
    }) => Promise<{ ix: any; nftId: number }>
    getCurrentPosition: (p: {
        vaultId: number
        positionId: number
        connection: Connection
        market: string
    }) => Promise<{ colRaw: { toString(): string }; debtRaw: { toString(): string } }>
}>

describe('custody and smart-vault operate on a Jupiter mainnet fork', function () {
    this.timeout(600_000)
    const url = process.env.ANCHOR_PROVIDER_URL ?? 'http://127.0.0.1:8899'
    const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.ANCHOR_WALLET!, 'utf8'))))
    const connection = new Connection(url, 'confirmed')
    const umi = createUmi(url).use(mplToolbox())
    const signer = createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(wallet.secretKey))
    umi.use(signerIdentity(signer))
    // A second wallet that holds the position NFT but is on no allowlist. It must be able to
    // deposit the NFT into a wrapper the ops wallet created, and then own that wrapper.
    const holder = Keypair.generate()
    const holderSigner = createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(holder.secretKey))
    const instance = new lendmirror.LendMirror(publicKey(PROGRAM_ID))
    const vaultsProgram = lendmirror.JUPITER_VAULTS_MAINNET
    const walletUsdc = getAssociatedTokenAddressSync(USDC, wallet.publicKey)
    let nftId = 0
    let positionMint: PublicKey
    let authorityPda: PublicKey

    before(async () => {
        // The runner gives the wallet SOL at genesis; the holder gets some from the wallet.
        // (No faucet: on some macOS setups the validator's faucet is unreachable.)
        await sendAndConfirmTransaction(
            connection,
            new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: wallet.publicKey,
                    toPubkey: holder.publicKey,
                    lamports: 2 * LAMPORTS_PER_SOL,
                })
            ),
            [wallet]
        )
        const balance = await connection.getBalance(wallet.publicKey, 'confirmed')
        expect(balance).to.be.greaterThan(10 * LAMPORTS_PER_SOL)
        expect(String(signer.publicKey)).to.equal(wallet.publicKey.toBase58(), 'umi signer is the wallet')
        const usdc = await connection.getTokenAccountBalance(walletUsdc)
        expect(usdc.value.amount).to.equal('1000000000', 'the runner gave the wallet 1,000 USDC')
    })

    it('init_store on the fork with the mainnet Vaults program', async () => {
        await send(instance.initStore(signer, signer.publicKey, vaultsProgram))
        const store = await instance.getStore(umi.rpc)
        expect(store?.vaultsProgram).to.equal(vaultsProgram)
    })

    it('wallet opens a Jupiter position in the smart vault (gets the NFT)', async () => {
        const { getInitPositionIx } = await loadEsm('@jup-ag/lend/borrow')
        const { ix, nftId: id } = await getInitPositionIx({ vaultId: VAULT_ID, connection, signer: wallet.publicKey })
        nftId = id
        await sendAndConfirmTransaction(connection, new Transaction().add(ix), [wallet])
        positionMint = toWeb3JsPublicKey(jupiterPositionMintPda(vaultsProgram, VAULT_ID, nftId)[0])
        const nftAta = getAssociatedTokenAddressSync(positionMint, wallet.publicKey)
        const bal = await connection.getTokenAccountBalance(nftAta)
        expect(bal.value.amount).to.equal('1')
    })

    it('the NFT holder, not the wrapper creator, deposits the NFT and becomes owner', async () => {
        // Hand the NFT to the holder with a plain token transfer.
        const holderAta = getAssociatedTokenAddressSync(positionMint, holder.publicKey)
        await sendAndConfirmTransaction(
            connection,
            new Transaction()
                .add(
                    createAssociatedTokenAccountIdempotentInstruction(
                        wallet.publicKey,
                        holderAta,
                        holder.publicKey,
                        positionMint
                    )
                )
                .add(
                    createTransferCheckedInstruction(
                        getAssociatedTokenAddressSync(positionMint, wallet.publicKey),
                        positionMint,
                        holderAta,
                        wallet.publicKey,
                        1,
                        0
                    )
                ),
            [wallet]
        )
        // The ops wallet (a snapshotter) creates the wrapper. It is the owner for now.
        await send(instance.wrapPosition(signer, VAULT_ID, nftId))
        await waitVisible(toWeb3JsPublicKey(instance.pda.wrapper(VAULT_ID, nftId)[0]))
        expect(String((await instance.getWrapper(umi.rpc, VAULT_ID, nftId))?.owner)).to.equal(
            wallet.publicKey.toBase58()
        )

        // The ops wallet cannot deposit: it does not hold the NFT.
        try {
            await send(instance.depositPositionNft(signer, VAULT_ID, nftId, vaultsProgram))
            expect.fail('expected a token account failure')
        } catch (err) {
            // Its ATA for the mint may exist with balance 0 (InvalidTokenAccount) or not at all.
            expect(String(err)).to.match(
                /InvalidTokenAccount|AccountNotInitialized|3012|ConstraintTokenOwner|2015/,
                String(err).slice(0, 2000)
            )
        }

        // The holder deposits and takes ownership.
        await send(instance.depositPositionNft(holderSigner, VAULT_ID, nftId, vaultsProgram), [], 400_000, [holder])
        await waitVisible(
            getAssociatedTokenAddressSync(
                positionMint,
                toWeb3JsPublicKey(instance.pda.wrapperAuthority(instance.pda.wrapper(VAULT_ID, nftId)[0])[0]),
                true
            )
        )
        let wrapper = await instance.getWrapper(umi.rpc, VAULT_ID, nftId)
        expect(wrapper?.custody).to.equal(true)
        expect(String(wrapper?.owner)).to.equal(holder.publicKey.toBase58(), 'depositor owns the wrapper')

        // The holder lets the ops wallet operate this one wrapper through the OnDemand list.
        await send(instance.attachOndemand(holderSigner, VAULT_ID, nftId), [], 400_000, [holder])
        await send(
            instance.setOndemandCallers(holderSigner, VAULT_ID, nftId, [holderSigner.publicKey, signer.publicKey]),
            [],
            400_000,
            [holder]
        )
        await waitVisible(toWeb3JsPublicKey(instance.pda.ondemand(instance.pda.wrapper(VAULT_ID, nftId)[0])[0]))
    })

    it('admin sets level 1', async () => {
        await send(instance.setWrapperLevel(signer, VAULT_ID, nftId, 1))
        const wrapper = await instance.getWrapper(umi.rpc, VAULT_ID, nftId)
        expect(wrapper?.custody).to.equal(true)
        expect(wrapper?.level).to.equal(1)
        expect(String(wrapper?.positionMint)).to.equal(positionMint.toBase58())
        authorityPda = toWeb3JsPublicKey(instance.pda.wrapperAuthority(instance.pda.wrapper(VAULT_ID, nftId)[0])[0])
        const bal = await connection.getTokenAccountBalance(
            getAssociatedTokenAddressSync(positionMint, authorityPda, true)
        )
        expect(bal.value.amount).to.equal('1', 'NFT sits in the authority ATA')

        // The Jupiter SDK simulates a price read with the operate signer as fee payer, and
        // Jupiter may create accounts paid by its signer. Give the PDA some SOL. Then move USDC
        // into the PDA's account: the wallet funds it; only the program can move it out.
        const pdaUsdcAccount = getAssociatedTokenAddressSync(USDC, authorityPda, true)
        await sendAndConfirmTransaction(
            connection,
            new Transaction()
                .add(
                    SystemProgram.transfer({
                        fromPubkey: wallet.publicKey,
                        toPubkey: authorityPda,
                        lamports: 50_000_000,
                    })
                )
                .add(
                    createAssociatedTokenAccountIdempotentInstruction(
                        wallet.publicKey,
                        pdaUsdcAccount,
                        authorityPda,
                        USDC
                    )
                )
                .add(
                    createTransferCheckedInstruction(walletUsdc, USDC, pdaUsdcAccount, wallet.publicKey, PDA_FUNDING, 6)
                ),
            [wallet]
        )
        expect(await pdaUsdc()).to.equal(PDA_FUNDING)
        await waitVisible(toWeb3JsPublicKey(jupiterPositionPda(vaultsProgram, VAULT_ID, nftId)[0]))
    })

    it('level 1 supplies USDC as smart collateral', async () => {
        await operate({ col: { action: 'supply', token1: SUPPLY } })
        const position = await connection.getAccountInfo(
            toWeb3JsPublicKey(jupiterPositionPda(vaultsProgram, VAULT_ID, nftId)[0])
        )
        const fields = decodeJupiterPositionFields(position!.data)
        expect(fields.supplyAmount > 0n).to.equal(true, 'pool shares recorded on the Jupiter position')
        expect(await pdaUsdc()).to.equal(PDA_FUNDING - SUPPLY)
    })

    it('level 1 cannot borrow', async () => {
        try {
            await operate({ debt: { action: 'borrow', amount: BORROW } })
            expect.fail('expected LevelDenied')
        } catch (err) {
            expect(String(err)).to.match(/LevelDenied|6014|0x177e/)
        }
    })

    it('level 2: a borrow that would pay into the wallet is refused', async () => {
        await send(instance.setWrapperLevel(signer, VAULT_ID, nftId, 2))
        // Our six named accounts come first, then Jupiter's list; slot 2 is Jupiter's
        // signer_borrow_token_account, one of the accounts Jupiter pays borrowed tokens into.
        const redirect = (ix: WrappedInstruction): WrappedInstruction => {
            const keys = ix.instruction.keys.map((k, i) =>
                i === 6 + 2 ? { ...k, pubkey: fromWeb3JsPublicKey(walletUsdc) } : k
            )
            return { ...ix, instruction: { ...ix.instruction, keys } }
        }
        try {
            await operate({ debt: { action: 'borrow', amount: BORROW } }, redirect)
            expect.fail('expected InvalidTokenAccount')
        } catch (err) {
            expect(String(err)).to.match(/InvalidTokenAccount|6018|0x1782/, String(err).slice(0, 2000))
        }
    })

    it('level 2 borrows and the USDC lands in the authority account', async () => {
        const before = await pdaUsdc()
        await operate({ debt: { action: 'borrow', amount: BORROW } })
        expect(await pdaUsdc()).to.equal(before + BORROW)
    })

    it('level 1 can pay back, cannot withdraw', async () => {
        await send(instance.setWrapperLevel(signer, VAULT_ID, nftId, 1))
        const before = await pdaUsdc()
        await operate({ debt: { action: 'payback', amount: PAYBACK } })
        // Jupiter rounds a payback up by at most one base unit, in the protocol's favour.
        const spent = before - (await pdaUsdc())
        expect(spent >= PAYBACK && spent <= PAYBACK + 1n).to.equal(true, `payback spent ${spent}`)
        try {
            await operate({ col: { action: 'withdraw', token1: WITHDRAW, shares: await positionShares() } })
            expect.fail('expected LevelDenied')
        } catch (err) {
            expect(String(err)).to.match(/LevelDenied|6014|0x177e/)
        }
    })

    it('level 2 withdraws collateral into the authority account', async () => {
        await send(instance.setWrapperLevel(signer, VAULT_ID, nftId, 2))
        const before = await pdaUsdc()
        await operate({ col: { action: 'withdraw', token1: WITHDRAW, shares: await positionShares() } })
        expect(await pdaUsdc()).to.equal(before + WITHDRAW)
    })

    it('refresh_wrapper reads the position back into the wrapper', async () => {
        const position = toWeb3JsPublicKey(jupiterPositionPda(vaultsProgram, VAULT_ID, nftId)[0])
        await waitVisible(position)
        // The refresh derives Jupiter's tick account from the position's current tick. umi's
        // view can trail the last operate by seconds; wait until it matches the web3 view.
        await waitPositionSynced(position)
        const store = await instance.getStore(umi.rpc)
        await send(await instance.refreshWrapper(umi.rpc, signer, VAULT_ID, nftId, store!.vaultsProgram))
        const wrapper = await instance.getWrapper(umi.rpc, VAULT_ID, nftId)
        const snap = unwrapOption(wrapper!.snapshot)
        expect(snap).to.not.equal(null)
        expect(snap!.colRaw > 0n).to.equal(true, 'collateral shares are in the snapshot')
        expect(snap!.debtRaw > 0n).to.equal(true, 'the remaining debt is in the snapshot')
    })

    it('admin releases the NFT back to the wrapper owner', async () => {
        await send(
            instance.releasePositionNft(
                signer,
                VAULT_ID,
                nftId,
                holderSigner.publicKey,
                fromWeb3JsPublicKey(positionMint)
            )
        )
        const bal = await connection.getTokenAccountBalance(
            getAssociatedTokenAddressSync(positionMint, holder.publicKey),
            'confirmed'
        )
        expect(bal.value.amount).to.equal('1', 'the holder has the NFT again')
        const wrapper = await instance.getWrapper(umi.rpc, VAULT_ID, nftId)
        expect(wrapper?.custody).to.equal(false)
    })

    /** All of the position's collateral shares: a loose upper bound for a withdraw. */
    async function positionShares(): Promise<bigint> {
        const { getCurrentPosition } = await loadEsm('@jup-ag/lend/borrow')
        const current = await getCurrentPosition({ vaultId: VAULT_ID, positionId: nftId, connection, market: 'main' })
        return BigInt(current.colRaw.toString())
    }

    /**
     * umi reads through its own view of the RPC; on a fresh local validator it can trail the
     * web3 connection by a few seconds. Wait until umi sees the account, and say how long it took.
     */
    async function waitVisible(key: PublicKey): Promise<void> {
        const started = Date.now()
        for (let i = 0; i < 40; i++) {
            const viaUmi = await umi.rpc.getAccount(fromWeb3JsPublicKey(key))
            if (viaUmi.exists) {
                if (i > 0) console.log(`      (umi saw ${key.toBase58().slice(0, 8)} after ${Date.now() - started} ms)`)
                return
            }
            await new Promise((r) => setTimeout(r, 500))
        }
        const viaWeb3 = await connection.getAccountInfo(key, 'confirmed')
        throw new Error(`umi never saw ${key.toBase58()} (web3 sees it: ${viaWeb3 !== null})`)
    }

    async function waitPositionSynced(position: PublicKey): Promise<void> {
        const latest = decodeJupiterPositionFields((await connection.getAccountInfo(position, 'confirmed'))!.data)
        for (let i = 0; i < 40; i++) {
            const viaUmi = await umi.rpc.getAccount(fromWeb3JsPublicKey(position))
            if (viaUmi.exists) {
                const seen = decodeJupiterPositionFields(viaUmi.data)
                if (seen.tick === latest.tick && seen.supplyAmount === latest.supplyAmount) return
            }
            await new Promise((r) => setTimeout(r, 500))
        }
        throw new Error('umi never caught up with the position after the borrow')
    }

    /**
     * Build and send one operate_position: Jupiter's setup instructions and the PDA's token
     * accounts in a first transaction, the operate itself in a second one (both need Jupiter's
     * lookup tables; together they can exceed the transaction size limit).
     * `tamper` edits our instruction before sending, to prove the program's checks.
     */
    async function operate(
        legs: { col?: DexLeg; debt?: DexLeg },
        tamper?: (ix: WrappedInstruction) => WrappedInstruction
    ) {
        const build = await buildOperatePosition({
            connection,
            rpc: umi.rpc,
            instance,
            authority: signer,
            vaultId: VAULT_ID,
            nftId,
            vaultsProgram,
            positionMint: fromWeb3JsPublicKey(positionMint),
            ...legs,
        })
        if (build.setupIxs.length) await send(build.setupIxs, build.lookupTables, 1_400_000)
        const signature = await send(tamper ? tamper(build.operateIx) : build.operateIx, build.lookupTables, 1_400_000)
        const tx = await connection.getTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
        })
        const depth = Math.max(
            ...(tx?.meta?.logMessages ?? []).map((l) => Number((l.match(/invoke \[(\d+)\]/) ?? [])[1] ?? 0))
        )
        console.log(`      (operate: ${tx?.meta?.computeUnitsConsumed} compute units, call depth ${depth})`)
        return build
    }

    async function pdaUsdc(): Promise<bigint> {
        return BigInt(
            (
                await connection.getTokenAccountBalance(
                    getAssociatedTokenAddressSync(USDC, authorityPda, true),
                    'confirmed'
                )
            ).value.amount
        )
    }

    /**
     * Send umi-built instructions as one v0 transaction signed by the wallet.
     * Throws with the program logs in the message so tests can match error names.
     */
    async function send(
        ixs: WrappedInstruction | WrappedInstruction[],
        tables: AddressLookupTableAccount[] = [],
        computeUnits = 400_000,
        extraSigners: Keypair[] = []
    ): Promise<string> {
        const list = Array.isArray(ixs) ? ixs : [ixs]
        const instructions = [
            ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
            ...list.map((w) => toWeb3JsInstruction(w.instruction)),
        ]
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
        const message = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: blockhash, instructions })
        const tx = new VersionedTransaction(message.compileToV0Message(tables))
        tx.sign([wallet, ...extraSigners])
        try {
            const signature = await connection.sendTransaction(tx, { skipPreflight: false })
            await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
            return signature
        } catch (err) {
            const logs = (err as { logs?: string[] }).logs ?? []
            throw new Error(`${(err as Error).message}\n${logs.join('\n')}`)
        }
    }
})
