/**
 * `bridge_tokens_lz` against a local fork of mainnet: our release instruction paired with
 * USD.AI's real `send` (the cloned console_oft program and the whole LayerZero stack), in one
 * transaction. Started by tests/fork/run.cjs, after the custody suite, on the same validator.
 * Read-only against mainnet; every transaction here hits the local validator.
 *
 * Flow: wrap a fresh position → level 1 → fund the wrapper's USDai account → admin sets the
 * route → the paired transaction sends 10 USDai to the treasury (burned locally, the message
 * queued) → every tampered pairing is refused: send missing, wrong amount, wrong receiver,
 * caller options, a second release, over the cap, level 0, route disabled.
 */
import { readFileSync } from 'node:fs'

import { mplToolbox } from '@metaplex-foundation/mpl-toolbox'
import { WrappedInstruction, createSignerFromKeypair, publicKey, signerIdentity } from '@metaplex-foundation/umi'
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import { toWeb3JsInstruction } from '@metaplex-foundation/umi-web3js-adapters'
import {
    TOKEN_2022_PROGRAM_ID,
    createAssociatedTokenAccountIdempotentInstruction,
    createTransferCheckedInstruction,
    getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import {
    AddressLookupTableAccount,
    ComputeBudgetProgram,
    Connection,
    Keypair,
    PublicKey,
    Transaction,
    TransactionInstruction,
    TransactionMessage,
    VersionedTransaction,
    sendAndConfirmTransaction,
} from '@solana/web3.js'
import { expect } from 'chai'

import mainnet from '../../config/mainnet'
import { lendmirror } from '../../lib/client'
import { PROVIDER_LZ_OFT, bridgeTokensLz, setBridgeRoute } from '../../lib/client/bridge'
import { buildIssuerSend, tokenSourceIndex } from '../../lib/client/lzSend'

const PROGRAM_ID = 'GQDxkWJhMGppaXExXBC8hGWmfaUv9igo4PKdaLyc53T1'
const VAULT_ID = 95
const TREASURY = '0x736AAC431E66de7D07eb61738CA3598a53a24Ca0'
const CHAIN_ID = 42161n
const FUNDING = 100_000_000n // 100 USDai into the wrapper authority's account
const AMOUNT = 10_000_000n // 10 USDai bridged
const CAP = 50_000_000n

const usdai = mainnet.lzTokens.find((t) => t.symbol === 'USDai')!
const MINT = new PublicKey(usdai.mint)

const loadEsm = new Function('s', 'return import(s)') as (s: string) => Promise<{
    getInitPositionIx: (p: {
        vaultId: number
        connection: Connection
        signer: PublicKey
    }) => Promise<{ ix: TransactionInstruction; nftId: number }>
}>

describe('bridge_tokens_lz on a mainnet fork (USDai over the cloned LayerZero stack)', function () {
    this.timeout(600_000)
    const url = process.env.ANCHOR_PROVIDER_URL ?? 'http://127.0.0.1:8899'
    const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.ANCHOR_WALLET!, 'utf8'))))
    const connection = new Connection(url, 'confirmed')
    const umi = createUmi(url).use(mplToolbox())
    const signer = createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(wallet.secretKey))
    umi.use(signerIdentity(signer))
    const instance = new lendmirror.LendMirror(publicKey(PROGRAM_ID))
    const walletUsdai = getAssociatedTokenAddressSync(MINT, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID)
    const receiver32 = Uint8Array.from([...new Uint8Array(12), ...Buffer.from(TREASURY.slice(2), 'hex')])
    let nftId = 0
    let authorityPda: PublicKey
    let wrapperUsdai: PublicKey
    let alt: AddressLookupTableAccount

    before(async () => {
        // The custody suite ran first on this validator and already created the store.
        expect(await instance.getStore(umi.rpc), 'store exists (custody suite ran)').to.not.equal(null)
        const bal = await connection.getTokenAccountBalance(walletUsdai)
        expect(BigInt(bal.value.amount) >= FUNDING, 'the runner gave the wallet USDai at genesis').to.equal(true)
        const table = await connection.getAddressLookupTable(new PublicKey(usdai.lookupTable))
        expect(table.value, 'the issuer lookup table is cloned').to.not.equal(null)
        alt = table.value!
    })

    it('wrap a fresh position, level 1, fund the wrapper authority with USDai', async () => {
        const { getInitPositionIx } = await loadEsm('@jup-ag/lend/borrow')
        const { ix, nftId: id } = await getInitPositionIx({ vaultId: VAULT_ID, connection, signer: wallet.publicKey })
        nftId = id
        await sendAndConfirmTransaction(connection, new Transaction().add(ix), [wallet])
        await send([instance.wrapPosition(signer, VAULT_ID, nftId)])
        await send([instance.setWrapperLevel(signer, VAULT_ID, nftId, 1)])
        authorityPda = new PublicKey(String(instance.pda.wrapperAuthority(instance.pda.wrapper(VAULT_ID, nftId)[0])[0]))
        wrapperUsdai = getAssociatedTokenAddressSync(MINT, authorityPda, true, TOKEN_2022_PROGRAM_ID)
        await sendAndConfirmTransaction(
            connection,
            new Transaction()
                .add(
                    createAssociatedTokenAccountIdempotentInstruction(
                        wallet.publicKey,
                        wrapperUsdai,
                        authorityPda,
                        MINT,
                        TOKEN_2022_PROGRAM_ID
                    )
                )
                .add(
                    createTransferCheckedInstruction(
                        walletUsdai,
                        MINT,
                        wrapperUsdai,
                        wallet.publicKey,
                        FUNDING,
                        6,
                        [],
                        TOKEN_2022_PROGRAM_ID
                    )
                ),
            [wallet]
        )
        expect(await balance(wrapperUsdai)).to.equal(FUNDING)
    })

    it('admin sets the USDai route: LayerZero, receiver fixed to the treasury', async () => {
        await send([
            setBridgeRoute(instance, signer, {
                mint: usdai.mint,
                dstChainId: CHAIN_ID,
                provider: PROVIDER_LZ_OFT,
                providerProgram: usdai.issuerProgram,
                receiver: TREASURY,
                destinationCaller: '',
                domainOrSelector: 30110n,
                gasLimit: BigInt(tokenSourceIndex(usdai)),
                enabled: true,
                maxAmountPerTx: CAP,
            }),
        ])
    })

    it('release + issuer send in one transaction: burned on Solana, headed to the treasury', async () => {
        const supplyBefore = BigInt((await connection.getTokenSupply(MINT)).value.amount)
        const walletBefore = await balance(walletUsdai)
        const signature = await send([ourIx(AMOUNT)], [await sendIx({})])
        const tx = await connection.getTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
        })
        const depth = Math.max(
            ...(tx?.meta?.logMessages ?? []).map((l) => Number((l.match(/invoke \[(\d+)\]/) ?? [])[1] ?? 0))
        )
        console.log(`      (bridge: ${tx?.meta?.computeUnitsConsumed} compute units, call depth ${depth})`)
        expect(depth, 'the issuer send stays within the call-depth limit').to.be.lessThanOrEqual(5)
        expect(await balance(wrapperUsdai), 'the wrapper paid').to.equal(FUNDING - AMOUNT)
        expect(await balance(walletUsdai), 'the wallet kept nothing').to.equal(walletBefore)
        const supplyAfter = BigInt((await connection.getTokenSupply(MINT)).value.amount)
        expect(supplyBefore - supplyAfter, 'the issuer burned exactly the amount').to.equal(AMOUNT)
    })

    it('a release with no send in the transaction is refused', async () => {
        await expectError(send([ourIx(AMOUNT)]), 'MissingBridgeSend')
    })

    it('a send of a different amount is refused', async () => {
        await expectError(send([ourIx(AMOUNT)], [await sendIx({ amount: AMOUNT - 1n })]), 'MissingBridgeSend')
    })

    it('a send to a different receiver is refused', async () => {
        const wrong = Uint8Array.from(receiver32)
        wrong[31] ^= 1
        await expectError(send([ourIx(AMOUNT)], [await sendIx({ receiver: wrong })]), 'MissingBridgeSend')
    })

    it('a send with caller options is refused', async () => {
        await expectError(
            send(
                [ourIx(AMOUNT)],
                [await sendIx({ options: [0, 3, 1, 0, 17, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 134, 160] })]
            ),
            'MissingBridgeSend'
        )
    })

    it('two releases around one send are refused', async () => {
        await expectError(send([ourIx(AMOUNT), ourIx(AMOUNT)], [await sendIx({})]), 'MissingBridgeSend')
    })

    it('an amount over the route cap is refused', async () => {
        await expectError(send([ourIx(CAP + 1n)], [await sendIx({ amount: CAP + 1n })]), 'AmountTooLarge')
    })

    it('level 0 is refused, level 1 allowed again', async () => {
        await send([instance.setWrapperLevel(signer, VAULT_ID, nftId, 0)])
        await expectError(send([ourIx(AMOUNT)], [await sendIx({})]), 'LevelDenied')
        await send([instance.setWrapperLevel(signer, VAULT_ID, nftId, 1)])
    })

    it('a disabled route is refused', async () => {
        await setRoute(false)
        await expectError(send([ourIx(AMOUNT)], [await sendIx({})]), 'RouteDisabled')
        await setRoute(true)
        const signature = await send([ourIx(AMOUNT)], [await sendIx({})])
        expect(signature).to.be.a('string')
        expect(await balance(wrapperUsdai)).to.equal(FUNDING - 2n * AMOUNT)
    })

    function ourIx(amount: bigint): WrappedInstruction {
        return bridgeTokensLz(
            instance,
            signer,
            {
                vaultId: VAULT_ID,
                nftId,
                mint: usdai.mint,
                dstChainId: CHAIN_ID,
                amount,
                tokenProgram: String(TOKEN_2022_PROGRAM_ID),
            },
            undefined
        )
    }

    /** USD.AI's send for this wallet. LayerZero's accounts are read from the fork itself. */
    function sendIx(over: {
        amount?: bigint
        receiver?: Uint8Array
        options?: number[]
    }): Promise<TransactionInstruction> {
        return buildIssuerSend({
            rpc: umi.rpc,
            token: over.options ? { ...usdai, options: over.options } : usdai,
            signer: wallet.publicKey,
            tokenSource: walletUsdai,
            receiver: over.receiver ?? receiver32,
            amount: over.amount ?? AMOUNT,
        })
    }

    async function setRoute(enabled: boolean) {
        await send([
            setBridgeRoute(instance, signer, {
                mint: usdai.mint,
                dstChainId: CHAIN_ID,
                provider: PROVIDER_LZ_OFT,
                providerProgram: usdai.issuerProgram,
                receiver: TREASURY,
                destinationCaller: '',
                domainOrSelector: 30110n,
                gasLimit: BigInt(tokenSourceIndex(usdai)),
                enabled,
                maxAmountPerTx: CAP,
            }),
        ])
    }

    async function balance(account: PublicKey): Promise<bigint> {
        return BigInt((await connection.getTokenAccountBalance(account, 'confirmed')).value.amount)
    }

    async function expectError(run: Promise<string>, name: string) {
        try {
            await run
        } catch (err) {
            expect((err as Error).message).to.contain(name)
            return
        }
        throw new Error(`expected ${name}, but the transaction landed`)
    }

    /** Our umi-built instructions, then raw web3 ones, as one v0 transaction the wallet signs. */
    async function send(ours: WrappedInstruction[], raw: TransactionInstruction[] = []): Promise<string> {
        const instructions = [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 900_000 }),
            ...ours.map((w) => toWeb3JsInstruction(w.instruction)),
            ...raw,
        ]
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
        const message = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: blockhash, instructions })
        const tx = new VersionedTransaction(message.compileToV0Message(raw.length && alt ? [alt] : []))
        tx.sign([wallet])
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
