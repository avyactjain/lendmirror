/**
 * Bridge between the Jupiter Lend write SDK (`@jup-ag/lend`, ESM only) and our
 * `operate_position` instruction.
 *
 * The SDK resolves Jupiter's 35 `operate` accounts, the extra oracle/branch/tick accounts,
 * the address lookup tables, and the setup instructions (init tick, init branch) for a given
 * signer. We ask it twice:
 *   1. with the WALLET as signer, to get the setup instructions. Those create Jupiter-side
 *      accounts and the payer must sign, which only a wallet can do.
 *   2. with the wrapper AUTHORITY PDA as signer, owner and recipient, to get the account
 *      list our program passes through. That PDA signs inside the program via invoke_signed.
 *
 * Jupiter's `operate` needs a v0 transaction with lookup tables, and the wallet creates the
 * PDA's token accounts (idempotently) before the call.
 */
import { AccountMeta, PublicKey as UmiPublicKey, RpcInterface, Signer as UmiSigner, WrappedInstruction, publicKey } from '@metaplex-foundation/umi'
import { fromWeb3JsInstruction, toWeb3JsPublicKey } from '@metaplex-foundation/umi-web3js-adapters'
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { AddressLookupTableAccount, Connection, PublicKey, TransactionInstruction } from '@solana/web3.js'
import BN from 'bn.js'

import { LendMirror, instructions } from './lendmirror'

/** The part of the SDK's `getOperateIx` result this file uses. Keys match the Vaults IDL. */
type OperateSdkResult = {
    accounts: Record<string, PublicKey | null> & {
        signerSupplyTokenAccount: PublicKey
        signerBorrowTokenAccount: PublicKey
        supplyToken: PublicKey
        borrowToken: PublicKey
        supplyTokenProgram: PublicKey
        borrowTokenProgram: PublicKey
    }
    remainingAccounts: { pubkey: PublicKey; isWritable: boolean; isSigner: boolean }[]
    remainingAccountsIndices: number[]
    addressLookupTableAccounts: AddressLookupTableAccount[]
    ixs: TransactionInstruction[]
}
type OperateSdk = {
    getOperateIx: (params: {
        vaultId: number
        positionId: number
        colAmount: BN
        debtAmount: BN
        connection: Connection
        signer: PublicKey
        positionOwner?: PublicKey
        recipient?: PublicKey
        market?: 'main' | 'ethena' | 'galaxy'
        includeATASetup?: boolean
        includeWrapSol?: boolean
    }) => Promise<OperateSdkResult>
}

/** `import()` that ts-node (CommonJS) does not rewrite into `require()`. The SDK is ESM only. */
const loadEsm = new Function('s', 'return import(s)') as (s: string) => Promise<OperateSdk>

export type OperateBuild = {
    /** Jupiter setup instructions plus ATA creation for the authority PDA. Wallet signs. */
    setupIxs: WrappedInstruction[]
    /** Our `operate_position` instruction. */
    operateIx: WrappedInstruction
    /** Lookup tables Jupiter uses; the transaction must be v0 and reference them. */
    lookupTables: AddressLookupTableAccount[]
    /** The authority PDA's token accounts, for logging balances afterwards. */
    authorityAtas: { supply: PublicKey; borrow: PublicKey; nft: PublicKey }
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
    /** Signed base units. Positive deposits, negative withdraws. */
    newCol: bigint
    /** Signed base units. Positive borrows, negative pays back. */
    newDebt: bigint
    /** 'main' unless the vault lives in another Jupiter market. */
    market?: 'main' | 'ethena' | 'galaxy'
}): Promise<OperateBuild> {
    const { getOperateIx } = await loadEsm('@jup-ag/lend/borrow')
    const { connection, rpc, instance, authority, vaultId, nftId, market = 'main' } = args
    const wallet = toWeb3JsPublicKey(authority.publicKey)
    const [wrapper] = instance.pda.wrapper(vaultId, nftId)
    const [wrapperAuthority] = instance.pda.wrapperAuthority(wrapper)
    const pda = toWeb3JsPublicKey(wrapperAuthority)
    const colAmount = new BN(args.newCol.toString())
    const debtAmount = new BN(args.newDebt.toString())

    // 1. Setup instructions with the wallet as payer. Drop the last one: the SDK's own operate.
    const forWallet = await getOperateIx({
        vaultId,
        positionId: nftId,
        colAmount,
        debtAmount,
        connection,
        signer: wallet,
        market,
        includeATASetup: false,
        includeWrapSol: false,
    })
    const jupiterSetup = forWallet.ixs.slice(0, -1)

    // 2. Accounts with the PDA as signer, owner, and recipient.
    const forPda = await getOperateIx({
        vaultId,
        positionId: nftId,
        colAmount,
        debtAmount,
        connection,
        signer: pda,
        positionOwner: pda,
        recipient: pda,
        market,
        includeATASetup: false,
        includeWrapSol: false,
    })
    const a = forPda.accounts

    // 3. The PDA's token accounts, created by the wallet if missing.
    const positionMint = toWeb3JsPublicKey(args.positionMint)
    const nftAta = getAssociatedTokenAddressSync(positionMint, pda, true)
    const ataIxs: TransactionInstruction[] = [
        createAssociatedTokenAccountIdempotentInstruction(wallet, a.signerSupplyTokenAccount, pda, a.supplyToken, a.supplyTokenProgram),
        createAssociatedTokenAccountIdempotentInstruction(wallet, a.signerBorrowTokenAccount, pda, a.borrowToken, a.borrowTokenProgram),
        createAssociatedTokenAccountIdempotentInstruction(wallet, nftAta, pda, positionMint),
    ]

    const k = (key: PublicKey | null) => {
        if (!key) throw new Error('Jupiter SDK returned a null account the program requires')
        return publicKey(key.toBase58())
    }
    const remaining: AccountMeta[] = forPda.remainingAccounts.map((m) => ({
        pubkey: k(m.pubkey),
        isSigner: false,
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
                signerSupplyTokenAccount: k(a.signerSupplyTokenAccount),
                signerBorrowTokenAccount: k(a.signerBorrowTokenAccount),
                vaultConfig: k(a.vaultConfig),
                vaultState: k(a.vaultState),
                supplyToken: k(a.supplyToken),
                borrowToken: k(a.borrowToken),
                oracle: k(a.oracle),
                position: k(a.position),
                positionTokenAccount: k(nftAta),
                currentPositionTick: k(a.currentPositionTick),
                finalPositionTick: k(a.finalPositionTick),
                currentPositionTickId: k(a.currentPositionTickId),
                finalPositionTickId: k(a.finalPositionTickId),
                newBranch: k(a.newBranch),
                supplyTokenReservesLiquidity: k(a.supplyTokenReservesLiquidity),
                borrowTokenReservesLiquidity: k(a.borrowTokenReservesLiquidity),
                vaultSupplyPositionOnLiquidity: k(a.vaultSupplyPositionOnLiquidity),
                vaultBorrowPositionOnLiquidity: k(a.vaultBorrowPositionOnLiquidity),
                supplyRateModel: k(a.supplyRateModel),
                borrowRateModel: k(a.borrowRateModel),
                vaultSupplyTokenAccount: k(a.vaultSupplyTokenAccount),
                vaultBorrowTokenAccount: k(a.vaultBorrowTokenAccount),
                supplyTokenClaimAccount: a.supplyTokenClaimAccount ? k(a.supplyTokenClaimAccount) : undefined,
                borrowTokenClaimAccount: a.borrowTokenClaimAccount ? k(a.borrowTokenClaimAccount) : undefined,
                liquidity: k(a.liquidity),
                liquidityProgram: k(a.liquidityProgram),
                oracleProgram: k(a.oracleProgram),
                supplyTokenProgram: k(a.supplyTokenProgram),
                borrowTokenProgram: k(a.borrowTokenProgram),
                associatedTokenProgram: publicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
                newCol: args.newCol,
                newDebt: args.newDebt,
                transferType: null,
                remainingAccountsIndices: Uint8Array.from(forPda.remainingAccountsIndices),
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
        authorityAtas: { supply: a.signerSupplyTokenAccount, borrow: a.signerBorrowTokenAccount, nft: nftAta },
    }
}
