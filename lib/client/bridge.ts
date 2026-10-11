/**
 * Client side of token bridging: BridgeRoute PDA, the CCTP v2 account set, and the CCIP
 * per-token account set. Pure derivations; nothing here signs or sends.
 *
 * Fund safety recap: the program reads the EVM receiver from the BridgeRoute account, so
 * nothing in these builders lets a caller choose a destination.
 */
import { AccountMeta, Signer, PublicKey as UmiPublicKey, WrappedInstruction, publicKey } from '@metaplex-foundation/umi'
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { Connection, PublicKey } from '@solana/web3.js'

import { CcipRouteAccount, ccipPayerAddress, ccipRouteAddress, ccipSendAccounts } from './ccip'
import { LendMirror, instructions } from './lendmirror'
import { SEEDS } from './seeds'

export const PROVIDER_CCTP = 1
export const PROVIDER_CCIP = 2
/** LayerZero: the token's issuer bridges it over LayerZero (USDT via USDT0, USDai, sUSDai).
 * Served by `bridge_tokens_lz` plus the issuer's own send in the same transaction. */
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
        [Buffer.from(SEEDS.BRIDGE_ROUTE), new PublicKey(mint).toBuffer(), chain],
        new PublicKey(programId)
    )[0]
}

export type SetBridgeRouteArgs = {
    mint: string
    dstChainId: bigint
    provider: number
    providerProgram: string
    /** Unused since `bridge_tokens_lz`; the program requires it absent. */
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
    const pda = (program: PublicKey, seeds: (Buffer | Uint8Array)[]) =>
        PublicKey.findProgramAddressSync(seeds, program)[0]
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
 * Chainlink's per-token accounts for `ccip_send` with `token_amounts`.
 *
 * Chainlink publishes each token's pool accounts in an address lookup table whose address sits
 * in the token admin registry PDA (`["token_admin_registry", mint]` under the router). The
 * table holds, in order: the table itself, the registry, the pool program, the pool config, the
 * pool token account, the pool signer, the token program, the mint, the fee-quoter token config,
 * and any extra accounts the pool needs. The router expects that same order, preceded by the
 * sender's token account and the two per-destination fee-quoter PDAs
 * (docs.chain.link/ccip/api-reference/svm/v1.6.0/router).
 */
export async function ccipTokenRemainingAccounts(args: {
    connection: Connection
    route: CcipRouteAccount
    mint: string
    bridgeSigner: string
}): Promise<{ accounts: AccountMeta[]; tokenProgram: PublicKey; lookupTable: PublicKey }> {
    const { route } = args
    const mintKey = new PublicKey(args.mint)
    const mintInfo = await args.connection.getAccountInfo(mintKey)
    if (!mintInfo) throw new Error(`Mint ${args.mint} not found`)
    const tokenProgram = mintInfo.owner // Token or Token-2022, whichever issued the mint
    const router = new PublicKey(route.router)
    const feeQuoter = new PublicKey(route.feeQuoter)
    const selector = Buffer.alloc(8)
    selector.writeBigUInt64LE(route.destChainSelector)
    const pda = (program: PublicKey, seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program)[0]

    const registry = pda(router, [Buffer.from('token_admin_registry'), mintKey.toBuffer()])
    const registryInfo = await args.connection.getAccountInfo(registry)
    if (!registryInfo)
        throw new Error(`Token ${args.mint} is not registered with CCIP on this cluster (no token admin registry)`)
    // TokenAdminRegistry: discriminator 8, version 1, administrator 32, pending_administrator 32,
    // lookup_table 32, writable_indexes [u128; 2] (a bitmap over the table's entries, most
    // significant bit = entry 0), mint 32, supports_auto_derivation 1.
    const lookupTable = new PublicKey(registryInfo.data.subarray(73, 105))
    const writableBits = registryInfo.data.subarray(105, 137)
    const isWritable = (index: number): boolean => {
        const word = index < 128 ? 0 : 1
        const bit = index < 128 ? index : index - 128
        // Each word is a little-endian u128 and entry 0 is its most significant bit, so entry
        // `bit` lives at bit position 127 - bit counted from the least significant end.
        const pos = 127 - bit
        const byte = writableBits[word * 16 + Math.floor(pos / 8)]
        return ((byte >> (pos % 8)) & 1) === 1
    }
    const table = await args.connection.getAddressLookupTable(lookupTable)
    if (!table.value) throw new Error(`Lookup table ${lookupTable.toBase58()} not found`)
    const entries = table.value.state.addresses
    if (entries.length < 9)
        throw new Error(`Lookup table ${lookupTable.toBase58()} has ${entries.length} entries; expected at least 9`)
    const poolProgram = entries[2]

    const userTokenAccount = getAssociatedTokenAddressSync(
        mintKey,
        new PublicKey(args.bridgeSigner),
        true,
        tokenProgram
    )
    const meta = (key: PublicKey, isWritable: boolean): AccountMeta => ({
        pubkey: publicKey(key.toBase58()),
        isSigner: false,
        isWritable,
    })
    const accounts = [
        meta(userTokenAccount, true),
        // fee quoter's per-destination billing config for this token
        meta(pda(feeQuoter, [Buffer.from('per_chain_per_token_config'), selector, mintKey.toBuffer()]), false),
        // the POOL program's per-destination config (verified on Devnet: the router derives it there)
        // Writable: the pool updates its outbound rate-limit bucket in this account on every send.
        meta(pda(poolProgram, [Buffer.from('ccip_tokenpool_chainconfig'), selector, mintKey.toBuffer()]), true),
        // The router checks each table entry's writability against the registry bitmap.
        ...entries.map((key, index) => meta(key, isWritable(index))),
    ]
    return { accounts, tokenProgram, lookupTable }
}

/**
 * `bridge_tokens_ccip`. Pool accounts come from Chainlink's on-chain registry and lookup table.
 * Reference that table in the transaction: with ~45 accounts the send does not fit otherwise.
 */
export async function bridgeTokensCcip(
    instance: LendMirror,
    connection: Connection,
    authority: Signer,
    args: BridgeTokensArgs & { route: CcipRouteAccount; feeLamports: bigint },
    ondemand: UmiPublicKey | undefined
): Promise<{ instruction: WrappedInstruction; lookupTable: UmiPublicKey }> {
    const programId = String(instance.programId)
    const [wrapper] = instance.pda.wrapper(args.vaultId, args.nftId)
    const [wrapperAuthority] = instance.pda.wrapperAuthority(wrapper)
    const bridgeSigner = ccipPayerAddress(programId)
    const routeAccounts = ccipSendAccounts(args.route, bridgeSigner)
    const {
        accounts: remaining,
        tokenProgram,
        lookupTable,
    } = await ccipTokenRemainingAccounts({
        connection,
        route: args.route,
        mint: args.mint,
        bridgeSigner,
    })
    const tokenProgramKey = publicKey(tokenProgram.toBase58())
    const instruction = instructions
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
                wrapperAta: LendMirror.ata(wrapperAuthority, publicKey(args.mint), tokenProgramKey),
                bridgeAta: LendMirror.ata(publicKey(bridgeSigner), publicKey(args.mint), tokenProgramKey),
                tokenProgram: tokenProgramKey,
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
    return { instruction, lookupTable: publicKey(lookupTable.toBase58()) }
}

/**
 * `bridge_tokens_lz`: OUR half of a LayerZero bridge transaction.
 *
 * The transaction must carry the issuer's own `send` (see `lzSend.ts`) as the instruction right
 * after this one; the program reads it through the instructions sysvar and releases the tokens
 * to `authority`'s token account only when it goes, whole, to the route's receiver. See
 * `BridgeTokensLz` in the program for why this is not a CPI (Solana's call-depth limit).
 */
export function bridgeTokensLz(
    instance: LendMirror,
    authority: Signer,
    args: BridgeTokensArgs & {
        /** Token program that owns the mint (classic Token or Token-2022). */
        tokenProgram: string
    },
    ondemand: UmiPublicKey | undefined
): WrappedInstruction {
    const programId = String(instance.programId)
    const [wrapper] = instance.pda.wrapper(args.vaultId, args.nftId)
    const [wrapperAuthority] = instance.pda.wrapperAuthority(wrapper)
    const tokenMint = publicKey(args.mint)
    const tokenProgram = publicKey(args.tokenProgram)
    return instructions.bridgeTokensLz(
        { identity: authority, programs: instance.programRepo },
        {
            authority,
            store: instance.pda.oapp()[0],
            wrapper,
            ondemand,
            wrapperAuthority,
            bridgeRoute: publicKey(bridgeRouteAddress(programId, args.mint, args.dstChainId).toBase58()),
            mint: tokenMint,
            wrapperAta: LendMirror.ata(wrapperAuthority, tokenMint, tokenProgram),
            authorityAta: LendMirror.ata(authority.publicKey, tokenMint, tokenProgram),
            tokenProgram,
            associatedTokenProgram: publicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
            params: {
                amount: args.amount,
                dstChainId: args.dstChainId,
                // The guard reads everything else from the issuer's send instruction.
                maxFee: 0n,
                minFinalityThreshold: 0,
                feeLamports: 0n,
                minAmount: 0n,
                nativeFee: 0n,
                options: new Uint8Array(0),
            },
        }
    ).items[0]
}
