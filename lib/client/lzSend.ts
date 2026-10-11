/**
 * The issuer-side half of `bridge_tokens_lz`: build the token issuer's own `send` instruction,
 * so it can run right after ours in the same transaction.
 *
 * A Solana instruction must name every account its program will touch, in the order the
 * program expects. An issuer's send needs 40 to 50 of them. They come from two places:
 *
 *   1. The issuer's own accounts (9 to 16): its store, its record for the destination chain,
 *      its escrow, the token, and so on. Each issuer program has its own order and its own
 *      rules for where these live; `issuerAccounts` below spells them out per issuer.
 *   2. LayerZero's accounts (about 30): the endpoint, the message library, the executor, each
 *      verifier, their fee vaults, the price feed. LayerZero's SDK works these out by reading
 *      the issuer's LayerZero settings from chain, so a change of verifier is followed without
 *      any change here. `layerZeroAccounts` below.
 *
 * Nothing here decides where money goes. The destination is in the send's data and the program
 * compares it with the admin's route; a wrong account can only make the send fail. The builder
 * is tested against real sends copied from chain (`tests/fixtures/lz-sends.ts`).
 */
import { RpcInterface, publicKey } from '@metaplex-foundation/umi'
import { AccountMeta, PublicKey, TransactionInstruction } from '@solana/web3.js'

import { EndpointProgram, UlnProgram } from '@layerzerolabs/lz-solana-sdk-v2/umi'

import type { LzIssuer, LzTokenProfile } from '../../config/types'

/** `sha256("global:send")[..8]`: every issuer here uses the standard instruction id and arguments. */
export const OFT_SEND_DISCRIMINATOR = Buffer.from([102, 251, 20, 187, 65, 75, 12, 69])

/**
 * Where each issuer's send lists the sender's token balance account, counting from 0. The admin
 * writes this number into the route (`gas_limit`), and the program checks that this entry of
 * the send is the caller's own account.
 */
const TOKEN_SOURCE_INDEX: Record<LzIssuer['kind'], number> = {
    'standard-oft': 3,
    usdt0: 4,
    usdai: 9,
}

export function tokenSourceIndex(token: LzTokenProfile): number {
    return TOKEN_SOURCE_INDEX[token.issuer.kind]
}

/** The issuer `send` arguments, Borsh-encoded. Mirrors `oft_send_data` in `bridges.rs`. */
export function oftSendData(args: {
    dstEid: number
    /** 32 bytes: the EVM receiver, left padded. */
    to: Uint8Array
    amountLd: bigint
    minAmountLd: bigint
    options: Uint8Array
    /** Fee cap in lamports. LayerZero charges the real quoted fee, this only bounds it. */
    nativeFee: bigint
}): Buffer {
    const data = Buffer.alloc(8 + 4 + 32 + 8 + 8 + 4 + args.options.length + 1 + 8 + 8)
    let o = 0
    data.set(OFT_SEND_DISCRIMINATOR, o)
    o += 8
    data.writeUInt32LE(args.dstEid, o)
    o += 4
    data.set(args.to, o)
    o += 32
    data.writeBigUInt64LE(args.amountLd, o)
    o += 8
    data.writeBigUInt64LE(args.minAmountLd, o)
    o += 8
    data.writeUInt32LE(args.options.length, o)
    o += 4
    data.set(args.options, o)
    o += args.options.length
    data.writeUInt8(0, o) // compose_msg = None
    o += 1
    data.writeBigUInt64LE(args.nativeFee, o)
    o += 8
    data.writeBigUInt64LE(0n, o) // lz_token_fee
    return data
}

/** `min_amount_ld` for a send: `amount` minus the token's headroom (0 or a few bps). */
export function lzMinAmount(amount: bigint, minUnderBps: number): bigint {
    return amount - (amount * BigInt(minUnderBps)) / 10_000n
}

/** An address the issuer's program owns, computed from fixed seeds (a PDA). */
function pda(program: PublicKey, seeds: (Buffer | Uint8Array)[]): PublicKey {
    return PublicKey.findProgramAddressSync(seeds, program)[0]
}

/** A destination's LayerZero id as the 4 big-endian bytes the issuers use in their seeds. */
function eidBytes(eid: number): Buffer {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(eid)
    return b
}

const writable = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true })
const readonly = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false })

/**
 * The issuer's own accounts for `send`, in the order its program expects, plus the two the
 * LayerZero part needs to know: the issuer's store (it is "the sender" as far as LayerZero is
 * concerned) and its record for the destination chain (the "peer", which holds the address of
 * the issuer's contract on that chain).
 *
 * Orders and writable flags were read from real sends of each issuer; see the fixtures.
 */
export function issuerAccounts(
    token: LzTokenProfile,
    signer: PublicKey,
    tokenSource: PublicKey
): { metas: AccountMeta[]; store: PublicKey; peer: PublicKey } {
    const program = new PublicKey(token.issuerProgram)
    const mint = new PublicKey(token.mint)
    const tokenProgram = new PublicKey(token.tokenProgram)
    const eid = eidBytes(token.dstEid)
    // Anchor programs log through a fixed address of their own.
    const eventAuthority = pda(program, [Buffer.from('__event_authority')])
    const signerMeta: AccountMeta = { pubkey: signer, isSigner: true, isWritable: true }
    const issuer = token.issuer

    if (issuer.kind === 'standard-oft') {
        // LayerZero's standard program: the store hangs off the escrow, the peer off the store.
        const escrow = new PublicKey(issuer.escrow)
        const store = pda(program, [Buffer.from('OFT'), escrow.toBuffer()])
        const peer = pda(program, [Buffer.from('Peer'), store.toBuffer(), eid])
        return {
            store,
            peer,
            metas: [
                signerMeta,
                writable(peer),
                writable(store),
                writable(tokenSource), // 3: the sender's token balance
                writable(escrow),
                writable(mint),
                readonly(tokenProgram),
                readonly(eventAuthority),
                readonly(program),
            ],
        }
    }

    if (issuer.kind === 'usdt0') {
        // Tether's program has one store, so its accounts sit at fixed addresses. "Credits" is
        // its ledger of how much may still leave towards each chain.
        const store = pda(program, [Buffer.from('OFT')])
        const peer = pda(program, [Buffer.from('Peer'), eid])
        const credits = pda(program, [Buffer.from('Credits')])
        return {
            store,
            peer,
            metas: [
                signerMeta,
                readonly(peer),
                writable(store),
                writable(credits),
                writable(tokenSource), // 4: the sender's token balance
                writable(new PublicKey(issuer.escrow)),
                readonly(mint),
                readonly(tokenProgram),
                readonly(eventAuthority),
                readonly(program),
            ],
        }
    }

    // USD.AI: one program for USDai and sUSDai, one store per token.
    const store = new PublicKey(issuer.store)
    const peer = pda(program, [Buffer.from('Peer'), store.toBuffer(), eid])
    // Gas settings the issuer enforces for a plain send (message type 1) to this chain.
    const enforcedOptions = pda(program, [Buffer.from('EnforcedOptions'), store.toBuffer(), eid, Buffer.from([0, 1])])
    // A per-sender record that would exempt this wallet from the rate limit. It usually does
    // not exist; the program wants its address anyway and checks for itself.
    const exemption = pda(program, [Buffer.from('RateLimitExemption'), store.toBuffer(), signer.toBuffer()])
    // The store's own token account: tokens go here and are burned from here.
    const escrow = pda(program, [Buffer.from('Escrow'), store.toBuffer()])
    return {
        store,
        peer,
        metas: [
            signerMeta,
            readonly(store),
            readonly(peer),
            readonly(enforcedOptions),
            readonly(new PublicKey(issuer.pauseConfig)),
            readonly(new PublicKey(issuer.feeConfig)),
            writable(new PublicKey(issuer.defaultRateLimit)),
            writable(new PublicKey(issuer.rateLimit)),
            readonly(exemption),
            writable(tokenSource), // 9: the sender's token balance
            writable(escrow),
            writable(new PublicKey(issuer.feeDeposit)),
            writable(mint),
            readonly(tokenProgram),
            readonly(eventAuthority),
            readonly(program),
        ],
    }
}

/**
 * LayerZero's accounts for one send, worked out by LayerZero's own SDK from what is on chain:
 * which message library the issuer uses towards this chain, and through it the executor, the
 * verifiers, their fee vaults and the price feed. `payer` is the wallet that pays the fee.
 */
export async function layerZeroAccounts(
    rpc: RpcInterface,
    token: LzTokenProfile,
    store: PublicKey,
    peer: PublicKey,
    payer: PublicKey
): Promise<AccountMeta[]> {
    const endpoint = new EndpointProgram.Endpoint(EndpointProgram.ENDPOINT_PROGRAM_ID)
    const sender = publicKey(store.toBase58())
    // The peer record starts with an 8-byte type tag, then the 32-byte address of the issuer's
    // contract on the destination chain. Same layout for all three issuers.
    const peerAccount = await rpc.getAccount(publicKey(peer.toBase58()))
    if (!peerAccount.exists) {
        throw new Error(
            `${token.symbol}: the issuer has no record for destination ${token.dstEid} (${peer.toBase58()})`
        )
    }
    const receiver = peerAccount.data.slice(8, 40)
    const library = await endpoint.getSendLibrary(rpc, sender, token.dstEid)
    if (!library.programId)
        throw new Error(`${token.symbol}: no LayerZero send library set for destination ${token.dstEid}`)
    const metas = await endpoint.getSendIXAccountMetaForCPI(
        rpc,
        publicKey(payer.toBase58()),
        { path: { sender, dstEid: token.dstEid, receiver }, msgLibProgram: new UlnProgram.Uln(library.programId) },
        'confirmed'
    )
    return metas.map((m: { pubkey: unknown; isSigner: boolean; isWritable: boolean }) => ({
        pubkey: new PublicKey(String(m.pubkey)),
        isSigner: m.isSigner,
        isWritable: m.isWritable,
    }))
}

/**
 * The issuer's `send`, ready to sit right after `bridge_tokens_lz` in a transaction.
 *
 * `signer` is the wallet sending the transaction; `tokenSource` is that wallet's own balance
 * account for the token, where our program has just released the tokens. `rpc` is only used to
 * read LayerZero's settings; nothing is sent from here.
 */
export async function buildIssuerSend(args: {
    rpc: RpcInterface
    token: LzTokenProfile
    signer: PublicKey
    tokenSource: PublicKey
    /** 32 bytes: must equal the route's receiver, or the program refuses the release. */
    receiver: Uint8Array
    amount: bigint
    nativeFee?: bigint
}): Promise<TransactionInstruction> {
    const { token } = args
    const { metas, store, peer } = issuerAccounts(token, args.signer, args.tokenSource)
    const keys = [...metas, ...(await layerZeroAccounts(args.rpc, token, store, peer, args.signer))]
    const data = oftSendData({
        dstEid: token.dstEid, // the route carries the same id; the program checks they match
        to: args.receiver,
        amountLd: args.amount,
        minAmountLd: lzMinAmount(args.amount, token.minUnderBps),
        options: Uint8Array.from(token.options),
        nativeFee: args.nativeFee ?? token.nativeFeeCapLamports,
    })
    return new TransactionInstruction({ programId: new PublicKey(token.issuerProgram), keys, data })
}
