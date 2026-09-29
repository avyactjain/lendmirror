/**
 * Bridge between the Jupiter Lend write SDK (`@jup-ag/lend`, ESM only) and our
 * `operate_position` instruction, which calls Jupiter's `operate_dex` (smart vaults only).
 *
 * The SDK resolves Jupiter's 73 `operate_dex` accounts, its extra oracle/branch/tick accounts,
 * the lookup tables, the setup instructions (init tick, init branch) and the signed amounts.
 * We ask it twice:
 *   1. with the WALLET as signer, to get the setup instructions. Those create Jupiter-side
 *      accounts and the payer must sign, which only a wallet can do.
 *   2. with the wrapper AUTHORITY PDA as signer, owner and recipient, to get the account list
 *      and the amounts our program passes through. That PDA signs inside the program.
 *
 * Our instruction's arguments have the same Borsh layout as Jupiter's, so the amounts are taken
 * from the SDK's own instruction bytes: what the program checks is exactly what Jupiter gets.
 */
import { AccountMeta, PublicKey as UmiPublicKey, RpcInterface, Signer as UmiSigner, WrappedInstruction, publicKey } from '@metaplex-foundation/umi'
import { fromWeb3JsInstruction, toWeb3JsPublicKey } from '@metaplex-foundation/umi-web3js-adapters'
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { AddressLookupTableAccount, Connection, PublicKey, TransactionInstruction } from '@solana/web3.js'
import BN from 'bn.js'

import { getOperatePositionInstructionDataSerializer } from './generated/lendmirror/instructions/operatePosition'
import { LendMirror, instructions } from './lendmirror'

/** One side of the operation. Amounts are positive; `action` gives the direction. */
export type DexLeg = {
    /** Collateral: 'supply' | 'withdraw'. Debt: 'borrow' | 'payback'. */
    action: 'supply' | 'withdraw' | 'borrow' | 'payback'
    /** Smart (pool) leg: token amounts in each token's base units. */
    token0?: bigint
    token1?: bigint
    /** Normal leg: amount in the token's base units. */
    amount?: bigint
    /** Share bound for a smart leg: minimum on supply/borrow, maximum on withdraw/payback. */
    shares?: bigint
}

type SdkSide = { amount?: BN; token0?: BN; token1?: BN; minShares?: BN; maxShares?: BN }
type SdkResult = {
    accounts: Record<string, PublicKey | null> & {
        supplyDex: Record<string, PublicKey | null>
        borrowDex: Record<string, PublicKey | null>
    }
    ixs: TransactionInstruction[]
    addressLookupTableAccounts: AddressLookupTableAccount[]
}
type DexSdk = {
    getOperateDexIx: (params: {
        vaultId: number
        positionId: number
        connection: Connection
        signer: PublicKey
        positionOwner?: PublicKey
        recipient?: PublicKey
        market?: string
        includeATASetup?: boolean
        includeWrapSol?: boolean
        col?: { action: string; input: SdkSide } | null
        debt?: { action: string; input: SdkSide } | null
    }) => Promise<SdkResult>
}

/** `import()` that ts-node (CommonJS) does not rewrite into `require()`. The SDK is ESM only. */
const loadEsm = new Function('s', 'return import(s)') as (s: string) => Promise<DexSdk>

export type OperateBuild = {
    /** Jupiter setup instructions plus token-account creation for the authority PDA. Wallet signs. */
    setupIxs: WrappedInstruction[]
    /** Our `operate_position` instruction. */
    operateIx: WrappedInstruction
    /** Lookup tables Jupiter uses; the transaction must be v0 and reference them. */
    lookupTables: AddressLookupTableAccount[]
    /** The authority PDA's token accounts in this call, for logging balances afterwards. */
    authorityAccounts: { label: string; address: PublicKey }[]
}

export async function buildOperatePosition(args: {
    connection: Connection
    rpc: RpcInterface
    instance: LendMirror
    authority: UmiSigner
    vaultId: number
    nftId: number
    /** `store.vaults_program`: the Jupiter Vaults program this deployment reads. */
    vaultsProgram: UmiPublicKey
    positionMint: UmiPublicKey
    col?: DexLeg
    debt?: DexLeg
    market?: string
}): Promise<OperateBuild> {
    const { getOperateDexIx } = await loadEsm('@jup-ag/lend/borrow')
    const { connection, rpc, instance, authority, vaultId, nftId, market = 'main' } = args
    const wallet = toWeb3JsPublicKey(authority.publicKey)
    const [wrapper] = instance.pda.wrapper(vaultId, nftId)
    const [wrapperAuthority] = instance.pda.wrapperAuthority(wrapper)
    const pda = toWeb3JsPublicKey(wrapperAuthority)
    const common = { vaultId, positionId: nftId, connection, market, includeATASetup: false, includeWrapSol: false }
    const legs = { col: sdkLeg(args.col), debt: sdkLeg(args.debt) }

    // 1. Setup instructions with the wallet as payer. Drop the last one: the SDK's own operate.
    const forWallet = await withSimulationDetails('wallet', () => getOperateDexIx({ ...common, ...legs, signer: wallet }))
    const jupiterSetup = forWallet.ixs.slice(0, -1)

    // 2. Accounts and amounts with the PDA as signer, owner, and recipient. The SDK simulates a
    //    price read with `signer` as fee payer, so the PDA must hold a little SOL (the task funds it).
    const forPda = await withSimulationDetails('authority PDA', () =>
        getOperateDexIx({ ...common, ...legs, signer: pda, positionOwner: pda, recipient: pda })
    )
    const jupiterOperate = forPda.ixs[forPda.ixs.length - 1]

    // 3. The PDA's token accounts, created by the wallet if missing.
    const tokenAccounts = pdaTokenAccounts(forPda.accounts)
    const nftAta = getAssociatedTokenAddressSync(toWeb3JsPublicKey(args.positionMint), pda, true)
    const ataIxs = [
        ...tokenAccounts.map((t) => createAssociatedTokenAccountIdempotentInstruction(wallet, t.address, pda, t.mint, t.program)),
        createAssociatedTokenAccountIdempotentInstruction(wallet, nftAta, pda, toWeb3JsPublicKey(args.positionMint)),
    ]

    // 4. Our instruction: our six accounts, then Jupiter's accounts in Jupiter's order. The
    //    arguments are Jupiter's own bytes, decoded with our (identical) layout.
    const [params] = getOperatePositionInstructionDataSerializer().deserialize(
        Uint8Array.from([...new Uint8Array(8), ...jupiterOperate.data.subarray(8)])
    )
    const remaining: AccountMeta[] = jupiterOperate.keys.map((m) => ({
        pubkey: publicKey(m.pubkey.toBase58()),
        isSigner: false, // the PDA signs inside the program; nothing else signs for Jupiter
        isWritable: m.isWritable,
    }))
    const operateIx = instructions
        .operatePosition(
            { identity: authority, programs: instance.programRepo },
            {
                authority,
                store: instance.pda.oapp()[0],
                wrapper,
                ondemand: await instance.ondemandIfAttached(rpc, wrapper),
                wrapperAuthority,
                vaultsProgram: args.vaultsProgram,
                colAmounts: params.colAmounts,
                debtAmounts: params.debtAmounts,
                transferType: params.transferType,
                remainingAccountsIndices: params.remainingAccountsIndices,
            }
        )
        .addRemainingAccounts(remaining).items[0]

    const wrap = (ix: TransactionInstruction): WrappedInstruction => ({
        instruction: fromWeb3JsInstruction(ix),
        signers: [authority],
        bytesCreatedOnChain: 0,
    })
    return {
        setupIxs: [...jupiterSetup, ...ataIxs].map(wrap),
        operateIx,
        lookupTables: forPda.addressLookupTableAccounts,
        authorityAccounts: [...tokenAccounts.map((t) => ({ label: t.label, address: t.address })), { label: 'position NFT', address: nftAta }],
    }
}

/** Our leg → the SDK's `{ action, input }`. The share bound goes where the SDK expects it. */
function sdkLeg(leg?: DexLeg): { action: string; input: SdkSide } | null {
    if (!leg) return null
    const bn = (v?: bigint) => (v === undefined ? undefined : new BN(v.toString()))
    const positive = leg.action === 'supply' || leg.action === 'borrow'
    return {
        action: leg.action,
        input: {
            amount: bn(leg.amount),
            token0: bn(leg.token0),
            token1: bn(leg.token1),
            minShares: positive ? bn(leg.shares) : undefined,
            maxShares: positive ? undefined : bn(leg.shares),
        },
    }
}

/**
 * Every token account of the PDA that Jupiter may pull from or pay into, with the mint and token
 * program needed to create it. Normal legs use the vault's supply/borrow token; smart legs use
 * the pool's token0/token1. Duplicates (e.g. the USDC account shared by a pool leg and the debt)
 * appear once.
 */
function pdaTokenAccounts(a: SdkResult['accounts']): { label: string; address: PublicKey; mint: PublicKey; program: PublicKey }[] {
    const candidates: [string, PublicKey | null, PublicKey | null, PublicKey | null][] = [
        ['supply token', a.signerSupplyTokenAccount, a.supplyToken, a.supplyTokenProgram],
        ['borrow token', a.signerBorrowTokenAccount, a.borrowToken, a.borrowTokenProgram],
        ['supply token (recipient)', a.recipientSupplyTokenAccount, a.supplyToken, a.supplyTokenProgram],
        ['borrow token (recipient)', a.recipientBorrowTokenAccount, a.borrowToken, a.borrowTokenProgram],
    ]
    for (const [group, dex] of [['collateral pool', a.supplyDex], ['debt pool', a.borrowDex]] as const) {
        candidates.push(
            [`${group} token0`, dex.dexUserToken0Account, dex.dexToken0, dex.dexToken0Program],
            [`${group} token1`, dex.dexUserToken1Account, dex.dexToken1, dex.dexToken1Program],
            [`${group} token0 (recipient)`, dex.dexRecipientToken0Account, dex.dexToken0, dex.dexToken0Program],
            [`${group} token1 (recipient)`, dex.dexRecipientToken1Account, dex.dexToken1, dex.dexToken1Program]
        )
    }
    const seen = new Set<string>()
    const out: { label: string; address: PublicKey; mint: PublicKey; program: PublicKey }[] = []
    for (const [label, address, mint, program] of candidates) {
        if (!address || !mint || !program || seen.has(address.toBase58())) continue
        seen.add(address.toBase58())
        out.push({ label, address, mint, program })
    }
    return out
}

/** The SDK hides simulation failures behind "No return data found in logs"; show the details. */
async function withSimulationDetails<T>(label: string, run: () => Promise<T>): Promise<T> {
    try {
        return await run()
    } catch (err) {
        const sim = (err as { simulation?: { err?: unknown; logs?: string[] } }).simulation
        if (!sim) throw err
        throw new Error(
            `Jupiter SDK simulation failed (signer = ${label}): ${JSON.stringify(sim.err)}\n${(sim.logs ?? []).join('\n')}`
        )
    }
}
