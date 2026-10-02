/**
 * The issuer-side half of `bridge_tokens_lz`: build each issuer's own `send` instruction from a
 * captured template (`config/*.ts`, `lzTokens`), so it can run as the instruction right after
 * ours in the same transaction.
 *
 * Why templates: none of the issuers (USD.AI's console_oft, USDT0's Legacy Mesh) is LayerZero's
 * standard OFT program, none publishes usable seeds for every account, and their stores do not
 * decode with the standard SDK. A real send on the lane is the one reliable source for the
 * account list. Only three slots depend on who sends: the signer, the sender's token account,
 * and (for USD.AI) a per-sender rate-limit-exemption PDA; everything else is a lane constant.
 * The program's guard re-checks the parts that matter for fund safety (program id, amount,
 * destination, source account), so a stale template can only make the send fail, never
 * redirect it.
 */
import { AccountMeta, PublicKey, TransactionInstruction } from '@solana/web3.js'

import type { LzTokenProfile } from '../../config/types'

/** `sha256("global:send")[..8]`: both issuers use the standard discriminator and arg layout. */
export const OFT_SEND_DISCRIMINATOR = Buffer.from([102, 251, 20, 187, 65, 75, 12, 69])

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
    data.writeUInt8(0, o)
    o += 1 // compose_msg = None
    data.writeBigUInt64LE(args.nativeFee, o)
    o += 8
    data.writeBigUInt64LE(0n, o) // lz_token_fee
    return data
}

/** `min_amount_ld` for a send: `amount` minus the token's headroom (0 or a few bps). */
export function lzMinAmount(amount: bigint, minUnderBps: number): bigint {
    return amount - (amount * BigInt(minUnderBps)) / 10_000n
}

/**
 * The issuer's `send`, built from the captured template with our slots substituted:
 * every occurrence of the template's signer → `signer`; the token-source slot → `tokenSource`
 * (the signer's own token account); the per-sender PDA, when the issuer has one → re-derived
 * for `signer`. Writability is kept exactly as captured.
 */
export function buildIssuerSend(args: {
    token: LzTokenProfile
    signer: PublicKey
    tokenSource: PublicKey
    /** 32 bytes: must equal the route's receiver, or the program refuses the release. */
    receiver: Uint8Array
    amount: bigint
    nativeFee?: bigint
}): TransactionInstruction {
    const { token } = args
    const keys: AccountMeta[] = token.accounts.map(({ key, w }, index) => {
        let pubkey = new PublicKey(key)
        if (key === token.templateSigner) pubkey = args.signer
        if (index === token.tokenSourceIndex) pubkey = args.tokenSource
        if (token.senderPda && index === token.senderPda.index) {
            pubkey = PublicKey.findProgramAddressSync(
                [
                    Buffer.from(token.senderPda.seedPrefix),
                    new PublicKey(token.senderPda.seedBase).toBuffer(),
                    args.signer.toBuffer(),
                ],
                new PublicKey(token.issuerProgram)
            )[0]
        }
        return { pubkey, isWritable: w, isSigner: key === token.templateSigner }
    })
    const data = oftSendData({
        dstEid: token.dstEid, // the route carries the same eid; the program checks they match
        to: args.receiver,
        amountLd: args.amount,
        minAmountLd: lzMinAmount(args.amount, token.minUnderBps),
        options: Uint8Array.from(token.options),
        nativeFee: args.nativeFee ?? token.nativeFeeCapLamports,
    })
    return new TransactionInstruction({ programId: new PublicKey(token.issuerProgram), keys, data })
}
