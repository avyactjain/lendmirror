import {
    AccountMeta,
    Cluster,
    ClusterFilter,
    Commitment,
    Program,
    ProgramError,
    ProgramRepositoryInterface,
    PublicKey,
    RpcInterface,
    Signer,
    WrappedInstruction,
    createNullRpc,
    publicKey,
} from '@metaplex-foundation/umi'
import { createDefaultProgramRepository } from '@metaplex-foundation/umi-program-repository'
import { toWeb3JsInstruction } from '@metaplex-foundation/umi-web3js-adapters'
import { ComputeBudgetProgram } from '@solana/web3.js'
import { hexlify } from 'ethers/lib/utils'

import {
    EndpointProgram,
    EventPDA,
    MessageLibInterface,
    SimpleMessageLibProgram,
    SolanaPacketPath,
    UlnProgram,
    simulateWeb3JsTransaction,
} from '@layerzerolabs/lz-solana-sdk-v2/umi'

import * as accounts from './generated/lendmirror/accounts'
import * as errors from './generated/lendmirror/errors'
import * as instructions from './generated/lendmirror/instructions'
import * as types from './generated/lendmirror/types'
import {
    BRANCH_MERGED,
    decodeJupiterBranchFields,
    decodeJupiterPositionFields,
    decodeJupiterTickFields,
    decodeJupiterTickIdLiquidation,
    jupiterBranchPda,
    jupiterPositionPda,
    jupiterTickIdLiquidationPda,
    jupiterTickPda,
    jupiterVaultConfigPda,
    jupiterVaultStatePda,
    liquidationSlotIndex,
    normalizeTick,
} from './jupiter'
import { LendMirrorPDA as LendMirrorPDA } from './pda'
import { SetPeerAddressParam, SetPeerEnforcedOptionsParam } from './types'

export { accounts, errors, instructions, types }
export const JUPITER_VAULTS_MAINNET = publicKey('jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi')
export const JUPITER_VAULTS_DEVNET = publicKey('Ho32sUQ4NzuAQgkPkHuNDG3G18rgHmYtXFA8EBmqQrAu')

export const POSITION_SNAPSHOT_BODY_LEN = 225

export type PositionSnapshotFields = {
    position: Uint8Array
    vaultId: number
    nftId: number
    positionMint: Uint8Array
    supplyToken: Uint8Array
    borrowToken: Uint8Array
    colRaw: bigint
    debtRaw: bigint
    dustDebt: bigint
    netDebt: bigint
    tick: number
    tickId: number
    storedColRaw: bigint
    storedDebtRaw: bigint
    storedTick: number
    isSupplyOnly: boolean
    isLiquidated: boolean
    isFullyLiquidated: boolean
    branchId: number
    vaultSupplyExchangePrice: bigint
    vaultBorrowExchangePrice: bigint
    snapshotTime: bigint
}

function require32(name: string, bytes: Uint8Array) {
    if (bytes.length !== 32) {
        throw new Error(`${name} must be 32 bytes`)
    }
}

/** Same layout as `impl LzMessage for PositionSnapshot` on Solana. */
export function encodePositionSnapshot(snap: PositionSnapshotFields): Uint8Array {
    require32('position', snap.position)
    require32('positionMint', snap.positionMint)
    require32('supplyToken', snap.supplyToken)
    require32('borrowToken', snap.borrowToken)
    const out = new Uint8Array(32 + POSITION_SNAPSHOT_BODY_LEN)
    const view = new DataView(out.buffer)
    view.setUint32(28, POSITION_SNAPSHOT_BODY_LEN)
    out.set(snap.position, 32)
    view.setUint16(64, snap.vaultId)
    view.setUint32(66, snap.nftId)
    out.set(snap.positionMint, 70)
    out.set(snap.supplyToken, 102)
    out.set(snap.borrowToken, 134)
    view.setBigUint64(166, snap.colRaw)
    view.setBigUint64(174, snap.debtRaw)
    view.setBigUint64(182, snap.dustDebt)
    view.setBigUint64(190, snap.netDebt)
    view.setInt32(198, snap.tick)
    view.setUint32(202, snap.tickId)
    view.setBigUint64(206, snap.storedColRaw)
    view.setBigUint64(214, snap.storedDebtRaw)
    view.setInt32(222, snap.storedTick)
    out[226] = snap.isSupplyOnly ? 1 : 0
    out[227] = snap.isLiquidated ? 1 : 0
    out[228] = snap.isFullyLiquidated ? 1 : 0
    view.setUint32(229, snap.branchId)
    view.setBigUint64(233, snap.vaultSupplyExchangePrice)
    view.setBigUint64(241, snap.vaultBorrowExchangePrice)
    view.setBigInt64(249, snap.snapshotTime)
    return out
}

/** Work out TickIdLiquidation + the branch chain the program will walk. */
async function collectLivePositionAccounts(
    rpc: RpcInterface,
    vaultsProgram: PublicKey,
    vaultId: number,
    position: { tick: number; tickId: number; isSupplyOnly: boolean }
): Promise<{ tickIdLiquidation?: PublicKey; branches: PublicKey[] }> {
    const branches: PublicKey[] = []
    if (position.isSupplyOnly) {
        return { branches }
    }

    const [tickPda] = jupiterTickPda(vaultsProgram, vaultId, position.tick)
    const tickAccount = await rpc.getAccount(tickPda)
    if (!tickAccount.exists) {
        return { branches }
    }
    const tick = decodeJupiterTickFields(tickAccount.data)
    const isLiquidated = tick.isLiquidated || tick.totalIds > position.tickId
    if (!isLiquidated) {
        return { branches }
    }

    let tickIdLiquidation: PublicKey | undefined
    let isFullyLiquidated = tick.isFullyLiquidated
    let branchId = tick.liquidationBranchId
    if (tick.totalIds !== position.tickId) {
        const [liq] = jupiterTickIdLiquidationPda(
            vaultsProgram,
            vaultId,
            normalizeTick(position.tick),
            position.tickId
        )
        const liqAccount = await rpc.getAccount(liq)
        if (liqAccount.exists) {
            tickIdLiquidation = liq
            const slot = decodeJupiterTickIdLiquidation(liqAccount.data)[liquidationSlotIndex(position.tickId)]
            isFullyLiquidated = slot.isFullyLiquidated
            branchId = slot.liquidationBranchId
        }
    }
    if (isFullyLiquidated) {
        return { tickIdLiquidation, branches }
    }

    let next = branchId
    for (let hop = 0; hop < 32; hop++) {
        const [branchPda] = jupiterBranchPda(vaultsProgram, vaultId, next)
        if (branches.some((key) => key === branchPda)) {
            break
        }
        const branchAccount = await rpc.getAccount(branchPda)
        if (!branchAccount.exists) {
            break
        }
        branches.push(branchPda)
        const decoded = decodeJupiterBranchFields(branchAccount.data)
        if (decoded.status !== BRANCH_MERGED) {
            break
        }
        next = decoded.connectedBranchId
    }
    return { tickIdLiquidation, branches }
}

const ENDPOINT_PROGRAM_ID: PublicKey = EndpointProgram.ENDPOINT_PROGRAM_ID

export enum MessageType {
    VANILLA = 1,
    COMPOSED_TYPE = 2,
}

export class LendMirror {
    public readonly pda: LendMirrorPDA
    public readonly eventAuthority: PublicKey
    public readonly programRepo: ProgramRepositoryInterface
    public readonly endpointSDK: EndpointProgram.Endpoint

    constructor(
        public readonly programId: PublicKey,
        public endpointProgramId: PublicKey = EndpointProgram.ENDPOINT_PROGRAM_ID,
        rpc?: RpcInterface
    ) {
        this.pda = new LendMirrorPDA(programId)
        if (rpc === undefined) {
            rpc = createNullRpc()
            rpc.getCluster = (): Cluster => 'custom'
        }
        this.programRepo = createDefaultProgramRepository({ rpc: rpc }, [
            {
                name: 'lendmirror',
                publicKey: programId,
                getErrorFromCode(code: number, cause?: Error): ProgramError | null {
                    return errors.getLendmirrorErrorFromCode(code, this, cause)
                },
                getErrorFromName(name: string, cause?: Error): ProgramError | null {
                    return errors.getLendmirrorErrorFromName(name, this, cause)
                },
                isOnCluster(): boolean {
                    return true
                },
            } satisfies Program,
        ])
        this.eventAuthority = new EventPDA(programId).eventAuthority()[0]
        this.endpointSDK = new EndpointProgram.Endpoint(endpointProgramId)
    }

    async getEnforcedOptions(rpc: RpcInterface, remoteEid: number): Promise<types.EnforcedOptions> {
        const [peer] = this.pda.peer(remoteEid)
        const peerInfo = await accounts.fetchPeerConfig({ rpc }, peer)
        return peerInfo.enforcedOptions
    }

    getProgram(clusterFilter: ClusterFilter = 'custom'): Program {
        return this.programRepo.get('lendmirror', clusterFilter)
    }

    async getStore(rpc: RpcInterface, commitment: Commitment = 'confirmed'): Promise<accounts.Store | null> {
        const [count] = this.pda.oapp()
        return accounts.safeFetchStore({ rpc }, count, { commitment })
    }

    async getWrapper(
        rpc: RpcInterface,
        vaultId: number,
        nftId: number,
        commitment: Commitment = 'confirmed'
    ): Promise<accounts.PositionWrapper | null> {
        const [wrapper] = this.pda.wrapper(vaultId, nftId)
        return accounts.safeFetchPositionWrapper({ rpc }, wrapper, { commitment })
    }

    wrapPosition(authority: Signer, vaultId: number, nftId: number): WrappedInstruction {
        return instructions.wrapPosition(
            { identity: authority, programs: this.programRepo },
            {
                authority,
                store: this.pda.oapp()[0],
                wrapper: this.pda.wrapper(vaultId, nftId)[0],
                vaultId,
                nftId,
            }
        ).items[0]
    }

    attachOndemand(authority: Signer, vaultId: number, nftId: number): WrappedInstruction {
        const [wrapper] = this.pda.wrapper(vaultId, nftId)
        return instructions.attachOndemand(
            { identity: authority, programs: this.programRepo },
            {
                authority,
                wrapper,
                ondemand: this.pda.ondemand(wrapper)[0],
            }
        ).items[0]
    }

    setOndemandCallers(authority: Signer, vaultId: number, nftId: number, keys: PublicKey[]): WrappedInstruction {
        const [wrapper] = this.pda.wrapper(vaultId, nftId)
        return instructions.setOndemandCallers(
            { identity: authority, programs: this.programRepo },
            {
                authority,
                wrapper,
                ondemand: this.pda.ondemand(wrapper)[0],
                params: { keys },
            }
        ).items[0]
    }

    requestBridgeOndemand(authority: Signer, vaultId: number, nftId: number): WrappedInstruction {
        const [wrapper] = this.pda.wrapper(vaultId, nftId)
        return instructions.requestBridgeOndemand(
            { identity: authority, programs: this.programRepo },
            {
                authority,
                wrapper,
                ondemand: this.pda.ondemand(wrapper)[0],
            }
        ).items[0]
    }

    async refreshWrapper(
        rpc: RpcInterface,
        authority: Signer,
        vaultId: number,
        nftId: number,
        vaultsProgram: PublicKey
    ): Promise<WrappedInstruction> {
        const [store] = this.pda.oapp()
        const [wrapper] = this.pda.wrapper(vaultId, nftId)
        const [position] = jupiterPositionPda(vaultsProgram, vaultId, nftId)
        const [vaultState] = jupiterVaultStatePda(vaultsProgram, vaultId)
        const [vaultConfig] = jupiterVaultConfigPda(vaultsProgram, vaultId)
        const positionAccount = await rpc.getAccount(position)
        if (!positionAccount.exists) {
            throw new Error(`No Jupiter position for vault ${vaultId} nft ${nftId} (${position})`)
        }
        const positionFields = decodeJupiterPositionFields(positionAccount.data)
        const [tickPda] = jupiterTickPda(vaultsProgram, vaultId, positionFields.tick)
        const { tickIdLiquidation, branches } = await collectLivePositionAccounts(
            rpc,
            vaultsProgram,
            vaultId,
            positionFields
        )
        return instructions
            .refreshWrapper(
                { identity: authority, programs: this.programRepo },
                {
                    authority,
                    store,
                    wrapper,
                    vaultsProgram,
                    position,
                    vaultState,
                    vaultConfig,
                    tick: tickPda,
                    tickIdLiquidation,
                }
            )
            .addRemainingAccounts(branches.map((pubkey) => ({ pubkey, isWritable: false, isSigner: false }))).items[0]
    }

    initStore(payer: Signer, admin: PublicKey, vaultsProgram: PublicKey): WrappedInstruction {
        const [oapp] = this.pda.oapp()
        const remainingAccounts = this.endpointSDK.getRegisterOappIxAccountMetaForCPI(payer.publicKey, oapp)
        return instructions
            .initStore(
                { payer: payer, programs: this.programRepo },
                {
                    payer,
                    store: oapp,
                    program: this.programId,
                    programData: this.pda.programData()[0],
                    admin: admin,
                    endpoint: this.endpointSDK.programId,
                    vaultsProgram,
                }
            )
            .addRemainingAccounts(remainingAccounts).items[0]
    }

    async getJupiterPosition(
        rpc: RpcInterface,
        authority: Signer,
        vaultId: number,
        nftId: number,
        vaultsProgram: PublicKey,
        payer?: Signer
    ): Promise<WrappedInstruction> {
        const feePayer = payer ?? authority
        const [store] = this.pda.oapp()
        const [position] = jupiterPositionPda(vaultsProgram, vaultId, nftId)
        const [vaultState] = jupiterVaultStatePda(vaultsProgram, vaultId)
        const [vaultConfig] = jupiterVaultConfigPda(vaultsProgram, vaultId)
        const [positionStore] = this.pda.jupPosition(vaultId, nftId)
        const positionAccount = await rpc.getAccount(position)
        if (!positionAccount.exists) {
            throw new Error(`No Jupiter position for vault ${vaultId} nft ${nftId} (${position})`)
        }
        const positionFields = decodeJupiterPositionFields(positionAccount.data)
        const [tickPda] = jupiterTickPda(vaultsProgram, vaultId, positionFields.tick)
        const { tickIdLiquidation, branches } = await collectLivePositionAccounts(
            rpc,
            vaultsProgram,
            vaultId,
            positionFields
        )
        return instructions
            .getJupiterPosition(
                { identity: authority, payer: feePayer, programs: this.programRepo },
                {
                    authority,
                    payer: feePayer,
                    store,
                    vaultsProgram,
                    position,
                    vaultState,
                    vaultConfig,
                    tick: tickPda,
                    tickIdLiquidation,
                    positionStore,
                    vaultId,
                    nftId,
                }
            )
            .addRemainingAccounts(branches.map((pubkey) => ({ pubkey, isWritable: false, isSigner: false }))).items[0]
    }

    async sendPayload(
        rpc: RpcInterface,
        authority: Signer,
        params: EndpointProgram.types.MessagingFee & {
            dstEid: number
            options: Uint8Array
            vaultId: number
            nftId: number
        },
        remainingAccounts?: AccountMeta[],
        commitment: Commitment = 'confirmed'
    ): Promise<WrappedInstruction> {
        const { dstEid, nativeFee, lzTokenFee, options, vaultId, nftId } = params
        const payer = authority.publicKey
        const msgLibProgram = await this.getSendLibraryProgram(rpc, payer, dstEid)
        const [oapp] = this.pda.oapp()
        const [peer] = this.pda.peer(dstEid)
        const [wrapper] = this.pda.wrapper(vaultId, nftId)
        const receiverInfo = await accounts.fetchPeerConfig({ rpc }, peer, { commitment })
        const packetPath: SolanaPacketPath = {
            dstEid,
            sender: oapp,
            receiver: receiverInfo.peerAddress,
        }
        remainingAccounts =
            remainingAccounts ??
            (await this.endpointSDK.getSendIXAccountMetaForCPI(
                rpc,
                payer,
                {
                    path: packetPath,
                    msgLibProgram,
                },
                commitment
            ))
        if (remainingAccounts === undefined) {
            throw new Error('Failed to get remaining accounts for send instruction')
        }
        return instructions
            .send(
                { identity: authority, programs: this.programRepo },
                {
                    authority,
                    store: oapp,
                    peer: peer,
                    wrapper,
                    endpoint: this.endpointSDK.pda.setting()[0],
                    dstEid,
                    options,
                    nativeFee: nativeFee,
                    lzTokenFee: lzTokenFee ?? 0,
                }
            )
            .addRemainingAccounts(remainingAccounts).items[0]
    }

    setSnapshotters(admin: Signer, keys: PublicKey[]): WrappedInstruction {
        return instructions.setSnapshotters(
            { programs: this.programRepo },
            {
                admin,
                store: this.pda.oapp()[0],
                params: { keys },
            }
        ).items[0]
    }

    setSenders(admin: Signer, keys: PublicKey[]): WrappedInstruction {
        return instructions.setSenders(
            { programs: this.programRepo },
            {
                admin,
                store: this.pda.oapp()[0],
                params: { keys },
            }
        ).items[0]
    }

    setPeerConfig(
        accounts: {
            admin: Signer
        },
        param: (SetPeerAddressParam | SetPeerEnforcedOptionsParam) & {
            remote: number
        }
    ): WrappedInstruction {
        const { admin } = accounts
        const { remote } = param
        let config: types.PeerConfigParamArgs
        if (param.__kind === 'PeerAddress') {
            if (param.peer.length !== 32) {
                throw new Error('Peer must be 32 bytes (left-padded with zeroes)')
            }
            config = types.peerConfigParam('PeerAddress', [param.peer])
        } else if (param.__kind === 'EnforcedOptions') {
            config = {
                __kind: 'EnforcedOptions',
                send: param.send,
                sendAndCall: param.sendAndCall,
            }
        } else {
            throw new Error('Invalid peer config')
        }

        return instructions.setPeerConfig(
            { programs: this.programRepo },
            {
                admin,
                store: this.pda.oapp()[0],
                peer: this.pda.peer(remote)[0],
                // args
                remoteEid: remote,
                config,
            }
        ).items[0]
    }

    async quotePayload(
        rpc: RpcInterface,
        payer: PublicKey,
        params: {
            dstEid: number
            options: Uint8Array
            payInLzToken: boolean
            vaultId: number
            nftId: number
        },
        remainingAccounts?: AccountMeta[],
        commitment: Commitment = 'confirmed'
    ): Promise<EndpointProgram.types.MessagingFee> {
        const { dstEid, options, payInLzToken, vaultId, nftId } = params
        const msgLibProgram = await this.getSendLibraryProgram(rpc, payer, dstEid)
        const [oapp] = this.pda.oapp()
        const [peer] = this.pda.peer(dstEid)
        const [wrapper] = this.pda.wrapper(vaultId, nftId)
        const receiverInfo = await accounts.fetchPeerConfig({ rpc }, peer, { commitment })
        const packetPath: SolanaPacketPath = {
            dstEid,
            sender: oapp,
            receiver: receiverInfo.peerAddress,
        }
        remainingAccounts =
            remainingAccounts ??
            (await this.endpointSDK.getQuoteIXAccountMetaForCPI(rpc, payer, {
                path: packetPath,
                msgLibProgram,
            }))
        if (remainingAccounts === undefined) {
            throw new Error('Failed to get remaining accounts for quote instruction')
        }
        const ix = instructions
            .quoteSend(
                {
                    programs: this.programRepo,
                },
                {
                    store: oapp,
                    wrapper,
                    peer,
                    endpoint: this.endpointSDK.pda.setting()[0],
                    dstEid,
                    options,
                    payInLzToken,
                    receiver: packetPath.receiver,
                }
            )
            .addRemainingAccounts(remainingAccounts).items[0]

        //TODO: use @solana-developers/helpers to get the compute units
        const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
            units: 400000,
        })

        return simulateWeb3JsTransaction(
            rpc,
            [modifyComputeUnits, toWeb3JsInstruction(ix.instruction)],
            this.programId,
            payer,
            EndpointProgram.types.getMessagingFeeSerializer(),
            'confirmed'
        )
    }

    async getSendLibraryProgram(
        rpc: RpcInterface,
        payer: PublicKey,
        dstEid: number
    ): Promise<SimpleMessageLibProgram.SimpleMessageLib | UlnProgram.Uln> {
        const [oapp] = this.pda.oapp()
        const sendLibInfo = await this.endpointSDK.getSendLibrary(rpc, oapp, dstEid)
        if (!sendLibInfo.programId) {
            throw new Error('Send library not initialized or blocked message library')
        }
        const { programId: msgLibProgram } = sendLibInfo
        const msgLibVersion = await this.endpointSDK.getMessageLibVersion(rpc, payer, msgLibProgram)
        if (msgLibVersion.major === 0n && msgLibVersion.minor == 0 && msgLibVersion.endpointVersion == 2) {
            return new SimpleMessageLibProgram.SimpleMessageLib(msgLibProgram)
        } else if (msgLibVersion.major === 3n && msgLibVersion.minor == 0 && msgLibVersion.endpointVersion == 2) {
            return new UlnProgram.Uln(msgLibProgram)
        }
        throw new Error(`Unsupported message library version: ${JSON.stringify(msgLibVersion, null, 2)}`)
    }
}

export async function getPeer(rpc: RpcInterface, dstEid: number, oftProgramId: PublicKey): Promise<string> {
    const [peer] = new LendMirrorPDA(oftProgramId).peer(dstEid)
    const info = await accounts.fetchPeerConfig({ rpc }, peer)
    return hexlify(info.peerAddress)
}

export function initConfig(
    programId: PublicKey,
    accounts: {
        admin: Signer
        payer: Signer
    },
    remoteEid: number,
    programs?: {
        msgLib?: PublicKey
        endpoint?: PublicKey
    }
): WrappedInstruction {
    const { admin, payer } = accounts
    const pda = new LendMirrorPDA(programId)

    let msgLibProgram: PublicKey, endpointProgram: PublicKey
    if (programs === undefined) {
        msgLibProgram = UlnProgram.ULN_PROGRAM_ID
        endpointProgram = EndpointProgram.ENDPOINT_PROGRAM_ID
    } else {
        msgLibProgram = programs.msgLib ?? UlnProgram.ULN_PROGRAM_ID
        endpointProgram = programs.endpoint ?? EndpointProgram.ENDPOINT_PROGRAM_ID
    }

    const endpoint = new EndpointProgram.Endpoint(endpointProgram)
    let msgLib: MessageLibInterface
    if (msgLibProgram === SimpleMessageLibProgram.SIMPLE_MESSAGELIB_PROGRAM_ID) {
        msgLib = new SimpleMessageLibProgram.SimpleMessageLib(SimpleMessageLibProgram.SIMPLE_MESSAGELIB_PROGRAM_ID)
    } else {
        msgLib = new UlnProgram.Uln(msgLibProgram)
    }
    return endpoint.initOAppConfig(
        {
            delegate: admin,
            payer: payer.publicKey,
        },
        {
            msgLibSDK: msgLib,
            oapp: pda.oapp()[0],
            remote: remoteEid,
        }
    )
}

export function initSendLibrary(
    accounts: {
        admin: Signer
        oapp: PublicKey
    },
    remoteEid: number,
    endpointProgram: PublicKey = ENDPOINT_PROGRAM_ID
): WrappedInstruction {
    const { admin, oapp } = accounts
    const endpoint = new EndpointProgram.Endpoint(endpointProgram)
    return endpoint.initOAppSendLibrary(admin, { sender: oapp, remote: remoteEid })
}

export function initReceiveLibrary(
    accounts: {
        admin: Signer
        oapp: PublicKey
    },
    remoteEid: number,
    endpointProgram: PublicKey = ENDPOINT_PROGRAM_ID
): WrappedInstruction {
    const { admin, oapp } = accounts
    const endpoint = new EndpointProgram.Endpoint(endpointProgram)
    return endpoint.initOAppReceiveLibrary(admin, { receiver: oapp, remote: remoteEid })
}

export function initOAppNonce(
    accounts: {
        admin: Signer
        oapp: PublicKey
    },
    remoteEid: number,
    remoteOappAddr: Uint8Array, // must be 32 bytes
    endpointProgram: PublicKey = ENDPOINT_PROGRAM_ID
): WrappedInstruction {
    const { admin, oapp } = accounts
    const endpoint = new EndpointProgram.Endpoint(endpointProgram)

    return endpoint.initOAppNonce(admin, {
        localOApp: oapp,
        remote: remoteEid,
        remoteOApp: remoteOappAddr,
    })
}
