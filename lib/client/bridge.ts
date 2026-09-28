/**
 * Client side of token bridging: BridgeRoute PDA, the CCTP v2 account set, and the CCIP
 * per-token account set. Pure derivations; nothing here signs or sends.
 *
 * Fund safety recap: the program reads the EVM receiver from the BridgeRoute account, so
 * nothing in these builders lets a caller choose a destination.
 */
import { AccountMeta, PublicKey as UmiPublicKey, RpcInterface, Signer, WrappedInstruction, publicKey } from '@metaplex-foundation/umi'
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'

import { OftPDA, oft } from '@layerzerolabs/oft-v2-solana-sdk'
import { createNoopSigner } from '@metaplex-foundation/umi'

import { ccipPayerAddress, ccipRouteAddress, ccipSendAccounts, CcipRouteAccount } from './ccip'
import { LendMirror, instructions } from './lendmirror'

export const PROVIDER_CCTP = 1
export const PROVIDER_CCIP = 2
/** LayerZero OFT: the token's issuer registered it with LayerZero (USDT0, USDai, sUSDai). */
export const PROVIDER_LZ_OFT = 3

/** Circle CCTP v2 program ids. Same on Devnet and mainnet. */
export const CCTP_TOKEN_MESSENGER_MINTER_V2 = 'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe'
export const CCTP_MESSAGE_TRANSMITTER_V2 = 'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC'
/** CCTP v2 finality thresholds. */
export const CCTP_FINALITY_FAST = 1000
export const CCTP_FINALITY_STANDARD = 2000

/** 20-byte EVM address → 32 bytes, left padded, as every bridge expects it. */
export function evmAddressTo32(address: string): Uint8Array {
    const raw = address.startsWith('0x') ? address.slice(2) : address
    if (raw.length !== 40) throw new Error(`Expected a 20-byte hex address, got ${address}`)
    const out = new Uint8Array(32)
    out.set(Buffer.from(raw, 'hex'), 12)
    return out
}

export function bridgeRouteAddress(programId: string, mint: string, dstChainId: bigint): PublicKey {
    const chain = Buffer.alloc(8)
    chain.writeBigUInt64LE(dstChainId)
    return PublicKey.findProgramAddressSync(
        [Buffer.from('LendMirrorBridgeRoute'), new PublicKey(mint).toBuffer(), chain],
        new PublicKey(programId)
    )[0]
}

export type SetBridgeRouteArgs = {
    mint: string
    dstChainId: bigint
    provider: number
    providerProgram: string
    /** LayerZero only: the OFT token escrow account. Leave empty for CCTP and CCIP. */
    providerAux?: string
    /** EVM treasury address, 0x-prefixed 20 bytes. */
    receiver: string
    /** CCTP: who may claim on the EVM side. Empty string = anyone (Circle relays). */
    destinationCaller: string
    domainOrSelector: bigint
    gasLimit: bigint
    enabled: boolean
    maxAmountPerTx: bigint
}

export function setBridgeRoute(instance: LendMirror, admin: Signer, args: SetBridgeRouteArgs): WrappedInstruction {
    const programId = String(instance.programId)
    return instructions.setBridgeRoute(
        { programs: instance.programRepo },
        {
            admin,
            store: instance.pda.oapp()[0],
            bridgeRoute: publicKey(bridgeRouteAddress(programId, args.mint, args.dstChainId).toBase58()),
            // Kinobi inlines SetBridgeRouteParams because only this instruction uses it.
            mint: publicKey(args.mint),
            dstChainId: args.dstChainId,
            provider: args.provider,
            providerProgram: publicKey(args.providerProgram),
            providerAux: publicKey(args.providerAux || '11111111111111111111111111111111'),
            receiver: evmAddressTo32(args.receiver),
            destinationCaller: args.destinationCaller ? evmAddressTo32(args.destinationCaller) : new Uint8Array(32),
            domainOrSelector: args.domainOrSelector,
            gasLimit: args.gasLimit,
            enabled: args.enabled,
            maxAmountPerTx: args.maxAmountPerTx,
        }
    ).items[0]
}

/**
 * Circle's PDAs for `deposit_for_burn`, from the TokenMessengerMinterV2 / MessageTransmitterV2 IDLs.
 * `remote_token_messenger` is seeded by the destination domain written as a decimal string.
 */
export function cctpAccounts(mint: string, owner: string, destinationDomain: number) {
    const tmm = new PublicKey(CCTP_TOKEN_MESSENGER_MINTER_V2)
    const mt = new PublicKey(CCTP_MESSAGE_TRANSMITTER_V2)
    const pda = (program: PublicKey, seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, program)[0]
    return {
        senderAuthorityPda: pda(tmm, [Buffer.from('sender_authority')]),
        denylistAccount: pda(tmm, [Buffer.from('denylist_account'), new PublicKey(owner).toBuffer()]),
        messageTransmitter: pda(mt, [Buffer.from('message_transmitter')]),
        tokenMessenger: pda(tmm, [Buffer.from('token_messenger')]),
        remoteTokenMessenger: pda(tmm, [Buffer.from('remote_token_messenger'), Buffer.from(String(destinationDomain))]),
        tokenMinter: pda(tmm, [Buffer.from('token_minter')]),
        localToken: pda(tmm, [Buffer.from('local_token'), new PublicKey(mint).toBuffer()]),
        eventAuthority: pda(tmm, [Buffer.from('__event_authority')]),
    }
}

export type BridgeTokensArgs = {
    vaultId: number
    nftId: number
    mint: string
    dstChainId: bigint
    amount: bigint
}

/** `bridge_tokens_cctp`. `eventData` is a fresh keypair that must also sign the transaction. */
export async function bridgeTokensCctp(
    instance: LendMirror,
    authority: Signer,
    eventData: Signer,
    args: BridgeTokensArgs & { destinationDomain: number; maxFee?: bigint; minFinalityThreshold?: number },
    ondemand: UmiPublicKey | undefined
): Promise<WrappedInstruction> {
    const programId = String(instance.programId)
    const [wrapper] = instance.pda.wrapper(args.vaultId, args.nftId)
    const [wrapperAuthority] = instance.pda.wrapperAuthority(wrapper)
    const bridgeSigner = ccipPayerAddress(programId)
    const cctp = cctpAccounts(args.mint, bridgeSigner, args.destinationDomain)
    const k = (key: PublicKey) => publicKey(key.toBase58())
    return instructions.bridgeTokensCctp(
        { identity: authority, programs: instance.programRepo },
        {
            authority,
            store: instance.pda.oapp()[0],
            wrapper,
            ondemand,
            wrapperAuthority,
            bridgeSigner: publicKey(bridgeSigner),
            bridgeRoute: k(bridgeRouteAddress(programId, args.mint, args.dstChainId)),
            mint: publicKey(args.mint),
            wrapperAta: LendMirror.ata(wrapperAuthority, publicKey(args.mint)),
            bridgeAta: LendMirror.ata(publicKey(bridgeSigner), publicKey(args.mint)),
            tokenProgram: publicKey(TOKEN_PROGRAM_ID),
            associatedTokenProgram: publicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
            senderAuthorityPda: k(cctp.senderAuthorityPda),
            denylistAccount: k(cctp.denylistAccount),
            messageTransmitter: k(cctp.messageTransmitter),
            tokenMessenger: k(cctp.tokenMessenger),
            remoteTokenMessenger: k(cctp.remoteTokenMessenger),
            tokenMinter: k(cctp.tokenMinter),
            localToken: k(cctp.localToken),
            messageSentEventData: eventData,
            messageTransmitterProgram: publicKey(CCTP_MESSAGE_TRANSMITTER_V2),
            tokenMessengerMinterProgram: publicKey(CCTP_TOKEN_MESSENGER_MINTER_V2),
            eventAuthority: k(cctp.eventAuthority),
            params: {
                amount: args.amount,
                dstChainId: args.dstChainId,
                maxFee: args.maxFee ?? 0n,
                minFinalityThreshold: args.minFinalityThreshold ?? CCTP_FINALITY_STANDARD,
                feeLamports: 0n,
                minAmount: 0n,
                nativeFee: 0n,
                options: new Uint8Array(0),
            },
        }
    ).items[0]
}

/**
 * Chainlink's per-token accounts for `ccip_send` with `token_amounts`, in the order the router
 * documents (docs.chain.link/ccip/api-reference/svm/v1.6.0/router). `poolProgram` and the
 * lookup table come from the token admin registry on chain; pass what you read there.
 */
export function ccipTokenRemainingAccounts(args: {
    route: CcipRouteAccount
    mint: string
    bridgeSigner: string
    poolProgram: string
    lookupTable: string
    tokenProgram?: string
}): AccountMeta[] {
    const { route, mint } = args
    const tokenProgram = new PublicKey(args.tokenProgram ?? TOKEN_PROGRAM_ID)
    const mintKey = new PublicKey(mint)
    const router = new PublicKey(route.router)
    const feeQuoter = new PublicKey(route.feeQuoter)
    const pool = new PublicKey(args.poolProgram)
    const selector = Buffer.alloc(8)
    selector.writeBigUInt64LE(route.destChainSelector)
    const pda = (program: PublicKey, seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program)[0]
    const poolSigner = pda(pool, [Buffer.from('ccip_tokenpool_signer'), mintKey.toBuffer()])
    const userTokenAccount = getAssociatedTokenAddressSync(mintKey, new PublicKey(args.bridgeSigner), true, tokenProgram)
    const poolTokenAccount = getAssociatedTokenAddressSync(mintKey, poolSigner, true, tokenProgram)
    const meta = (key: PublicKey, isWritable: boolean): AccountMeta => ({ pubkey: publicKey(key.toBase58()), isSigner: false, isWritable })
    return [
        meta(userTokenAccount, true),
        meta(pda(feeQuoter, [Buffer.from('per_chain_per_token_config'), selector, mintKey.toBuffer()]), false),
        meta(pda(feeQuoter, [Buffer.from('ccip_tokenpool_chainconfig'), selector, mintKey.toBuffer()]), false),
        meta(new PublicKey(args.lookupTable), false),
        meta(pda(router, [Buffer.from('token_admin_registry'), mintKey.toBuffer()]), false),
        meta(pool, false),
        meta(pda(pool, [Buffer.from('ccip_tokenpool_config'), mintKey.toBuffer()]), false),
        meta(poolTokenAccount, true),
        meta(poolSigner, false),
        meta(tokenProgram, false),
        meta(mintKey, false),
        meta(pda(feeQuoter, [Buffer.from('fee_billing_token_config'), mintKey.toBuffer()]), false),
    ]
}

/** `bridge_tokens_ccip`. The caller reads `poolProgram` / `lookupTable` from Chainlink's token admin registry. */
export function bridgeTokensCcip(
    instance: LendMirror,
    authority: Signer,
    args: BridgeTokensArgs & { route: CcipRouteAccount; poolProgram: string; lookupTable: string; feeLamports: bigint },
    ondemand: UmiPublicKey | undefined
): WrappedInstruction {
    const programId = String(instance.programId)
    const [wrapper] = instance.pda.wrapper(args.vaultId, args.nftId)
    const [wrapperAuthority] = instance.pda.wrapperAuthority(wrapper)
    const bridgeSigner = ccipPayerAddress(programId)
    const routeAccounts = ccipSendAccounts(args.route, bridgeSigner)
    const remaining = ccipTokenRemainingAccounts({
        route: args.route,
        mint: args.mint,
        bridgeSigner,
        poolProgram: args.poolProgram,
        lookupTable: args.lookupTable,
    })
    return instructions
        .bridgeTokensCcip(
            { identity: authority, programs: instance.programRepo },
            {
                authority,
                store: instance.pda.oapp()[0],
                wrapper,
                ondemand,
                wrapperAuthority,
                bridgeSigner: publicKey(bridgeSigner),
                bridgeRoute: publicKey(bridgeRouteAddress(programId, args.mint, args.dstChainId).toBase58()),
                mint: publicKey(args.mint),
                wrapperAta: LendMirror.ata(wrapperAuthority, publicKey(args.mint)),
                bridgeAta: LendMirror.ata(publicKey(bridgeSigner), publicKey(args.mint)),
                tokenProgram: publicKey(TOKEN_PROGRAM_ID),
                associatedTokenProgram: publicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
                ccipRoute: publicKey(ccipRouteAddress(programId)),
                config: publicKey(routeAccounts.config),
                destChainState: publicKey(routeAccounts.destChainState),
                nonce: publicKey(routeAccounts.nonce),
                feeTokenProgram: publicKey(TOKEN_PROGRAM_ID),
                feeTokenMint: publicKey(routeAccounts.feeTokenMint),
                feeTokenUser: routeAccounts.feeTokenUser,
                feeTokenReceiver: publicKey(routeAccounts.feeTokenReceiver),
                feeBillingSigner: publicKey(routeAccounts.feeBillingSigner),
                feeQuoter: publicKey(args.route.feeQuoter),
                feeQuoterConfig: publicKey(routeAccounts.feeQuoterConfig),
                feeQuoterDestChain: publicKey(routeAccounts.feeQuoterDestChain),
                feeQuoterBillingTokenConfig: publicKey(routeAccounts.feeQuoterBillingTokenConfig),
                feeQuoterLinkTokenConfig: publicKey(routeAccounts.feeQuoterLinkTokenConfig),
                rmnRemote: publicKey(args.route.rmnRemote),
                rmnRemoteCurses: publicKey(routeAccounts.rmnRemoteCurses),
                rmnRemoteConfig: publicKey(routeAccounts.rmnRemoteConfig),
                tokenPoolsSigner: publicKey(routeAccounts.tokenPoolsSigner),
                ccipRouter: publicKey(args.route.router),
                params: {
                    amount: args.amount,
                    dstChainId: args.dstChainId,
                    maxFee: 0n,
                    minFinalityThreshold: 0,
                    feeLamports: args.feeLamports,
                    minAmount: 0n,
                    nativeFee: 0n,
                    options: new Uint8Array(0),
                },
            }
        )
        .addRemainingAccounts(remaining).items[0]
}

/**
 * LayerZero OFT: quote the fee and the amount that will arrive, then build `bridge_tokens_oft`.
 *
 * The OFT SDK builds the OFT program's own `send` with the bridge signer PDA as signer (a
 * "noop" signer: we only need its address). We reuse that instruction's account list: the first
 * nine are the OFT program's named accounts, the rest are the LayerZero Endpoint accounts that
 * our instruction passes through as remaining accounts.
 */
export async function bridgeTokensOft(
    instance: LendMirror,
    rpc: RpcInterface,
    authority: Signer,
    args: BridgeTokensArgs & {
        oftProgram: string
        tokenEscrow: string
        dstEid: number
        /** EVM treasury, 0x-prefixed. Must equal the route's receiver. */
        receiver: string
        /** SOL moved onto the bridge signer for the LayerZero fee. Default: the quoted fee plus 10%. */
        feeLamports?: bigint
    },
    ondemand: UmiPublicKey | undefined
): Promise<{ instruction: WrappedInstruction; nativeFee: bigint; amountReceived: bigint }> {
    const programId = String(instance.programId)
    const [wrapper] = instance.pda.wrapper(args.vaultId, args.nftId)
    const [wrapperAuthority] = instance.pda.wrapperAuthority(wrapper)
    const bridgeSigner = publicKey(ccipPayerAddress(programId))
    const oftProgram = publicKey(args.oftProgram)
    const tokenMint = publicKey(args.mint)
    const tokenEscrow = publicKey(args.tokenEscrow)
    const to = evmAddressTo32(args.receiver)
    const tokenSource = LendMirror.ata(bridgeSigner, tokenMint)

    // What arrives after the OFT drops dust below its shared decimals, and what LayerZero charges.
    const { oftReceipt } = await oft.quoteOft(
        rpc,
        { payer: bridgeSigner, tokenMint, tokenEscrow },
        { dstEid: args.dstEid, to, amountLd: args.amount, minAmountLd: 0n },
        oftProgram
    )
    const amountReceived = BigInt(oftReceipt.amountReceivedLd)
    const { nativeFee } = await oft.quote(
        rpc,
        { payer: bridgeSigner, tokenMint, tokenEscrow },
        { dstEid: args.dstEid, to, amountLd: args.amount, minAmountLd: amountReceived },
        { oft: oftProgram }
    )

    const sdkSend = await oft.send(
        rpc,
        { payer: createNoopSigner(bridgeSigner), tokenMint, tokenEscrow, tokenSource },
        { dstEid: args.dstEid, to, amountLd: args.amount, minAmountLd: amountReceived, nativeFee },
        { oft: oftProgram }
    )
    const keys = sdkSend.instruction.keys
    const [peer] = new OftPDA(oftProgram).peer(new OftPDA(oftProgram).oftStore(tokenEscrow)[0], args.dstEid)
    const [oftStore] = new OftPDA(oftProgram).oftStore(tokenEscrow)
    const eventAuthority = keys[7].pubkey
    const endpointAccounts: AccountMeta[] = keys.slice(9).map((k) => ({ pubkey: k.pubkey, isSigner: false, isWritable: k.isWritable }))

    const feeLamports = args.feeLamports ?? nativeFee + nativeFee / 10n
    const instruction = instructions
        .bridgeTokensOft(
            { identity: authority, programs: instance.programRepo },
            {
                authority,
                store: instance.pda.oapp()[0],
                wrapper,
                ondemand,
                wrapperAuthority,
                bridgeSigner,
                bridgeRoute: publicKey(bridgeRouteAddress(programId, args.mint, args.dstChainId).toBase58()),
                mint: tokenMint,
                wrapperAta: LendMirror.ata(wrapperAuthority, tokenMint),
                bridgeAta: tokenSource,
                tokenProgram: publicKey(TOKEN_PROGRAM_ID),
                associatedTokenProgram: publicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
                oftProgram,
                peer,
                oftStore,
                tokenEscrow,
                eventAuthority,
                params: {
                    amount: args.amount,
                    dstChainId: args.dstChainId,
                    maxFee: 0n,
                    minFinalityThreshold: 0,
                    feeLamports,
                    minAmount: amountReceived,
                    nativeFee,
                    options: new Uint8Array(0),
                },
            }
        )
        .addRemainingAccounts(endpointAccounts).items[0]
    return { instruction, nativeFee, amountReceived }
}
