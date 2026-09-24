import { Instruction, PublicKey as UmiPublicKey, Signer, publicKey, transactionBuilder } from '@metaplex-foundation/umi'
import { PublicKey } from '@solana/web3.js'

/** Solana Devnet CCIP programs. https://docs.chain.link/ccip/directory/testnet/chain/solana-devnet */
export const CCIP_ROUTER_DEVNET = 'Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C'
export const CCIP_FEE_QUOTER_DEVNET = 'FeeQPGkKDeRV1MgoYfMH6L8o3KeuYjwUZrgn4LRKfjHi'
export const CCIP_RMN_REMOTE_DEVNET = 'RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7'
/** Sepolia as a CCIP destination. */
export const CCIP_SEPOLIA_SELECTOR = 16015286601757825753n
/** Solana Devnet as a CCIP source, seen by Ethereum `ccipReceive`. */
export const CCIP_SOLANA_DEVNET_SELECTOR = 16423721717087811551n
/** Sepolia CCIP router. */
export const CCIP_SEPOLIA_ROUTER = '0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59'

const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112')
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const TOKEN_PROGRAM_ID = publicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const SYSTEM_PROGRAM = publicKey('11111111111111111111111111111111')
const ZERO = publicKey('11111111111111111111111111111111')

const SET_CCIP_ROUTE_DISCRIMINATOR = Uint8Array.from([224, 164, 215, 196, 56, 195, 20, 30])
const SEND_CCIP_DISCRIMINATOR = Uint8Array.from([252, 232, 200, 9, 53, 141, 69, 60])
const CCIP_ROUTE_DISCRIMINATOR = Uint8Array.from([61, 87, 7, 199, 227, 253, 152, 120])

export type CcipRouteAccount = {
    router: string
    feeQuoter: string
    rmnRemote: string
    linkMint: string
    destChainSelector: bigint
    receiver: string
    gasLimit: bigint
}

export function ccipRouteAddress(programId: string): string {
    return findPda(programId, [Buffer.from('LendMirrorCcip')])
}

export function ccipPayerAddress(programId: string): string {
    return findPda(programId, [Buffer.from('LendMirrorCcipPayer')])
}

export function decodeCcipRoute(data: Uint8Array): CcipRouteAccount {
    if (data.length < 8 + 32 * 4 + 8 + 20 + 8 + 1) {
        throw new Error('CcipRoute account is too short. Run set-ccip-route first.')
    }
    const disc = data.subarray(0, 8)
    if (!disc.every((byte, i) => byte === CCIP_ROUTE_DISCRIMINATOR[i])) {
        throw new Error('Account is not a CcipRoute.')
    }
    let offset = 8
    const router = readPubkey(data, offset)
    offset += 32
    const feeQuoter = readPubkey(data, offset)
    offset += 32
    const rmnRemote = readPubkey(data, offset)
    offset += 32
    const linkMint = readPubkey(data, offset)
    offset += 32
    const destChainSelector = Buffer.from(data.subarray(offset, offset + 8)).readBigUInt64LE()
    offset += 8
    const receiver = '0x' + Buffer.from(data.subarray(offset, offset + 20)).toString('hex')
    offset += 20
    const gasLimit = Buffer.from(data.subarray(offset, offset + 8)).readBigUInt64LE()
    return { router, feeQuoter, rmnRemote, linkMint, destChainSelector, receiver, gasLimit }
}

export function ccipSendAccounts(route: CcipRouteAccount, payer: string) {
    const selector = u64le(route.destChainSelector)
    const feeBillingSigner = findPda(route.router, [Buffer.from('fee_billing_signer')])
    const feeTokenReceiver = findPda(ASSOCIATED_TOKEN_PROGRAM.toBase58(), [
        new PublicKey(feeBillingSigner).toBuffer(),
        TOKEN_PROGRAM.toBuffer(),
        NATIVE_MINT.toBuffer(),
    ])
    return {
        config: findPda(route.router, [Buffer.from('config')]),
        destChainState: findPda(route.router, [Buffer.from('dest_chain_state'), selector]),
        nonce: findPda(route.router, [Buffer.from('nonce'), selector, new PublicKey(payer).toBuffer()]),
        feeTokenMint: NATIVE_MINT.toBase58(),
        feeTokenUser: ZERO,
        feeTokenReceiver,
        feeBillingSigner,
        feeQuoterConfig: findPda(route.feeQuoter, [Buffer.from('config')]),
        feeQuoterDestChain: findPda(route.feeQuoter, [Buffer.from('dest_chain'), selector]),
        feeQuoterBillingTokenConfig: findPda(route.feeQuoter, [
            Buffer.from('fee_billing_token_config'),
            NATIVE_MINT.toBuffer(),
        ]),
        feeQuoterLinkTokenConfig: findPda(route.feeQuoter, [
            Buffer.from('fee_billing_token_config'),
            new PublicKey(route.linkMint).toBuffer(),
        ]),
        rmnRemoteCurses: findPda(route.rmnRemote, [Buffer.from('curses')]),
        rmnRemoteConfig: findPda(route.rmnRemote, [Buffer.from('config')]),
        tokenPoolsSigner: findPda(route.router, [Buffer.from('external_token_pools_signer')]),
    }
}

export function setCcipRouteInstruction(args: {
    programId: string
    admin: UmiPublicKey
    store: string
    router: string
    feeQuoter: string
    rmnRemote: string
    linkMint: string
    destChainSelector: bigint
    receiver: Uint8Array
    gasLimit: bigint
}): Instruction {
    if (args.receiver.length !== 20) throw new Error('Ethereum receiver must be 20 bytes.')
    const data = Buffer.concat([
        Buffer.from(SET_CCIP_ROUTE_DISCRIMINATOR),
        new PublicKey(args.router).toBuffer(),
        new PublicKey(args.feeQuoter).toBuffer(),
        new PublicKey(args.rmnRemote).toBuffer(),
        new PublicKey(args.linkMint).toBuffer(),
        u64le(args.destChainSelector),
        Buffer.from(args.receiver),
        u64le(args.gasLimit),
    ])
    const route = ccipRouteAddress(args.programId)
    return {
        programId: publicKey(args.programId),
        data: new Uint8Array(data),
        keys: [
            { pubkey: args.admin, isSigner: true, isWritable: true },
            { pubkey: publicKey(route), isSigner: false, isWritable: true },
            { pubkey: publicKey(args.store), isSigner: false, isWritable: false },
            { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
        ],
    }
}

export function sendCcipInstruction(args: {
    programId: string
    authority: UmiPublicKey
    store: string
    route: CcipRouteAccount
}): Instruction {
    const payer = ccipPayerAddress(args.programId)
    const accounts = ccipSendAccounts(args.route, payer)
    return {
        programId: publicKey(args.programId),
        data: SEND_CCIP_DISCRIMINATOR,
        keys: [
            { pubkey: args.authority, isSigner: true, isWritable: false },
            { pubkey: publicKey(args.store), isSigner: false, isWritable: false },
            { pubkey: publicKey(payer), isSigner: false, isWritable: true },
            { pubkey: publicKey(ccipRouteAddress(args.programId)), isSigner: false, isWritable: false },
            { pubkey: publicKey(accounts.config), isSigner: false, isWritable: false },
            { pubkey: publicKey(accounts.destChainState), isSigner: false, isWritable: true },
            { pubkey: publicKey(accounts.nonce), isSigner: false, isWritable: true },
            { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: publicKey(accounts.feeTokenMint), isSigner: false, isWritable: false },
            { pubkey: accounts.feeTokenUser, isSigner: false, isWritable: false },
            { pubkey: publicKey(accounts.feeTokenReceiver), isSigner: false, isWritable: true },
            { pubkey: publicKey(accounts.feeBillingSigner), isSigner: false, isWritable: false },
            { pubkey: publicKey(args.route.feeQuoter), isSigner: false, isWritable: false },
            { pubkey: publicKey(accounts.feeQuoterConfig), isSigner: false, isWritable: false },
            { pubkey: publicKey(accounts.feeQuoterDestChain), isSigner: false, isWritable: false },
            { pubkey: publicKey(accounts.feeQuoterBillingTokenConfig), isSigner: false, isWritable: false },
            { pubkey: publicKey(accounts.feeQuoterLinkTokenConfig), isSigner: false, isWritable: false },
            { pubkey: publicKey(args.route.rmnRemote), isSigner: false, isWritable: false },
            { pubkey: publicKey(accounts.rmnRemoteCurses), isSigner: false, isWritable: false },
            { pubkey: publicKey(accounts.rmnRemoteConfig), isSigner: false, isWritable: false },
            { pubkey: publicKey(accounts.tokenPoolsSigner), isSigner: false, isWritable: true },
            { pubkey: publicKey(args.route.router), isSigner: false, isWritable: false },
        ],
    }
}

export function fundStoreInstruction(payer: UmiPublicKey, store: string, lamports: bigint): Instruction {
    const data = Buffer.alloc(12)
    data.writeUInt32LE(2, 0)
    data.writeBigUInt64LE(lamports, 4)
    return {
        programId: SYSTEM_PROGRAM,
        data: new Uint8Array(data),
        keys: [
            { pubkey: payer, isSigner: true, isWritable: true },
            { pubkey: publicKey(store), isSigner: false, isWritable: true },
        ],
    }
}

export function ccipTransaction(instruction: Instruction, signer: Signer) {
    return transactionBuilder().add({ instruction, signers: [signer], bytesCreatedOnChain: 0 })
}

function findPda(programId: string, seeds: Buffer[]): string {
    return PublicKey.findProgramAddressSync(seeds, new PublicKey(programId))[0].toBase58()
}

function readPubkey(data: Uint8Array, offset: number): string {
    return new PublicKey(data.subarray(offset, offset + 32)).toBase58()
}

function u64le(value: bigint): Buffer {
    const buf = Buffer.alloc(8)
    buf.writeBigUInt64LE(value)
    return buf
}
