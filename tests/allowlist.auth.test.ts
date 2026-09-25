/**
 * Authority / allowlist checks for LendMirror instructions.
 *
 * Needs a local validator with LayerZero Endpoint cloned from Devnet
 * (see Anchor.toml [test.validator]).
 */
import * as anchor from '@coral-xyz/anchor'
import { Program, BN } from '@coral-xyz/anchor'
import { expect } from 'chai'
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js'

import idl from '../target/idl/lendmirror.json'

const STORE_SEED = Buffer.from('LendMirrorStoreV0')
const PEER_SEED = Buffer.from('LendMirrorPeer')
const WRAPPER_SEED = Buffer.from('LendMirrorWrapper')
const PROGRAM_ID = new PublicKey('GQDxkWJhMGppaXExXBC8hGWmfaUv9igo4PKdaLyc53T1')
const ENDPOINT_PROGRAM = new PublicKey('76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6')
const JUPITER_VAULTS_DEVNET = new PublicKey('Ho32sUQ4NzuAQgkPkHuNDG3G18rgHmYtXFA8EBmqQrAu')
/** BPFLoaderUpgradeab1e11111111111111111111111 */
const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')
/** Sepolia V2 testnet eid */
const DST_EID = 40161
const PEER_BYTES = Buffer.alloc(32, 7)

function programDataPda(programId: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_LOADER_UPGRADEABLE_PROGRAM_ID)[0]
}

function assertLogsMatch(err: unknown, pattern: RegExp) {
    const e = err as { logs?: string[]; message?: string }
    const text = [...(e.logs ?? []), e.message ?? '', String(err)].join('\n')
    expect(text, `expected ${pattern}, got: ${text}`).to.match(pattern)
}

describe('allowlist auth', function () {
    this.timeout(120_000)

    const provider = anchor.AnchorProvider.env()
    anchor.setProvider(provider)

    const program = new Program(idl as anchor.Idl, provider)
    const admin = (provider.wallet as anchor.Wallet).payer
    const stranger = Keypair.generate()

    const [storePda] = PublicKey.findProgramAddressSync([STORE_SEED], PROGRAM_ID)
    const programData = programDataPda(PROGRAM_ID)

    function initStoreAccounts(payer: PublicKey) {
        return {
            payer,
            store: storePda,
            program: PROGRAM_ID,
            programData,
            systemProgram: SystemProgram.programId,
        }
    }

    /** Remaining accounts for Endpoint register_oapp CPI (same order as SDK). */
    function registerOappRemaining(payer: PublicKey): anchor.web3.AccountMeta[] {
        // Mirrors EndpointProgram.getRegisterOappIxAccountMetaForCPI(payer, store)
        const [oappRegistry] = PublicKey.findProgramAddressSync(
            [Buffer.from('OApp'), storePda.toBuffer()],
            ENDPOINT_PROGRAM
        )
        const [eventAuthority] = PublicKey.findProgramAddressSync(
            [Buffer.from('__event_authority')],
            ENDPOINT_PROGRAM
        )
        return [
            { pubkey: ENDPOINT_PROGRAM, isSigner: false, isWritable: false },
            { pubkey: payer, isSigner: false, isWritable: true },
            { pubkey: storePda, isSigner: false, isWritable: false },
            { pubkey: oappRegistry, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: eventAuthority, isSigner: false, isWritable: false },
            { pubkey: ENDPOINT_PROGRAM, isSigner: false, isWritable: false },
        ]
    }

    before(async () => {
        const sig = await provider.connection.requestAirdrop(stranger.publicKey, 2e9)
        await provider.connection.confirmTransaction(sig, 'confirmed')
    })

    it('programData PDA is the BPF-loader PDA of this program', () => {
        expect(programData.toBase58()).to.equal(
            PublicKey.findProgramAddressSync(
                [PROGRAM_ID.toBuffer()],
                BPF_LOADER_UPGRADEABLE_PROGRAM_ID
            )[0].toBase58()
        )
    })

    it('init_store rejects a payer who is not the upgrade authority', async () => {
        try {
            await program.methods
                .initStore({
                    admin: stranger.publicKey,
                    endpoint: ENDPOINT_PROGRAM,
                    vaultsProgram: JUPITER_VAULTS_DEVNET,
                })
                .accounts(initStoreAccounts(stranger.publicKey))
                .remainingAccounts(registerOappRemaining(stranger.publicKey))
                .signers([stranger])
                .rpc()
            expect.fail('expected Unauthorized')
        } catch (err) {
            assertLogsMatch(err, /Unauthorized|6004/)
        }
    })

    it('init_store rejects the wrong ProgramData account', async () => {
        try {
            await program.methods
                .initStore({
                    admin: admin.publicKey,
                    endpoint: ENDPOINT_PROGRAM,
                    vaultsProgram: JUPITER_VAULTS_DEVNET,
                })
                .accounts({
                    ...initStoreAccounts(admin.publicKey),
                    programData: SystemProgram.programId,
                })
                .remainingAccounts(registerOappRemaining(admin.publicKey))
                .rpc()
            expect.fail('expected ProgramData constraint failure')
        } catch (err) {
            assertLogsMatch(err, /Unauthorized|6004|AccountOwnedByWrongProgram|3007|AccountDiscriminatorMismatch|3002/)
        }
    })

    it('init_store succeeds when payer is the upgrade authority', async () => {
        await program.methods
            .initStore({
                admin: admin.publicKey,
                endpoint: ENDPOINT_PROGRAM,
                vaultsProgram: JUPITER_VAULTS_DEVNET,
            })
            .accounts(initStoreAccounts(admin.publicKey))
            .remainingAccounts(registerOappRemaining(admin.publicKey))
            .rpc()

        const store = await program.account.store.fetch(storePda)
        expect(store.admin.toBase58()).to.equal(admin.publicKey.toBase58())
        expect(store.snapshotterCount).to.equal(1)
        expect(store.senderCount).to.equal(1)
        expect(store.snapshotters[0].toBase58()).to.equal(admin.publicKey.toBase58())
        expect(store.senders[0].toBase58()).to.equal(admin.publicKey.toBase58())
    })

    it('set_snapshotters rejects non-admin', async () => {
        try {
            await program.methods
                .setSnapshotters({ keys: [stranger.publicKey] })
                .accounts({ admin: stranger.publicKey, store: storePda })
                .signers([stranger])
                .rpc()
            expect.fail('expected ConstraintAddress')
        } catch (err) {
            assertLogsMatch(err, /ConstraintAddress|2006|Unauthorized|6004/)
        }
    })

    it('set_senders rejects non-admin', async () => {
        try {
            await program.methods
                .setSenders({ keys: [stranger.publicKey] })
                .accounts({ admin: stranger.publicKey, store: storePda })
                .signers([stranger])
                .rpc()
            expect.fail('expected ConstraintAddress')
        } catch (err) {
            assertLogsMatch(err, /ConstraintAddress|2006|Unauthorized|6004/)
        }
    })

    it('admin can replace snapshotters and senders', async () => {
        await program.methods
            .setSnapshotters({ keys: [admin.publicKey, stranger.publicKey] })
            .accounts({ admin: admin.publicKey, store: storePda })
            .rpc()
        await program.methods
            .setSenders({ keys: [admin.publicKey] })
            .accounts({ admin: admin.publicKey, store: storePda })
            .rpc()

        const store = await program.account.store.fetch(storePda)
        expect(store.snapshotterCount).to.equal(2)
        expect(store.senderCount).to.equal(1)
    })

    it('set_peer_config for send auth tests', async () => {
        const eidBuf = Buffer.alloc(4)
        eidBuf.writeUInt32BE(DST_EID)
        const [peerPda] = PublicKey.findProgramAddressSync(
            [PEER_SEED, storePda.toBuffer(), eidBuf],
            PROGRAM_ID
        )
        // Tuple enum variant PeerAddress([u8; 32]) — Anchor wants the field wrapped.
        await program.methods
            .setPeerConfig({
                remoteEid: DST_EID,
                config: { peerAddress: [Uint8Array.from(PEER_BYTES)] },
            })
            .accounts({
                admin: admin.publicKey,
                peer: peerPda,
                store: storePda,
                systemProgram: SystemProgram.programId,
            })
            .rpc()
    })

    it('wrap_position rejects non-snapshotter', async () => {
        await program.methods
            .setSnapshotters({ keys: [admin.publicKey] })
            .accounts({ admin: admin.publicKey, store: storePda })
            .rpc()
        const vaultId = 1
        const nftId = 8001
        const vaultBuf = Buffer.alloc(2)
        vaultBuf.writeUInt16LE(vaultId)
        const nftBuf = Buffer.alloc(4)
        nftBuf.writeUInt32LE(nftId)
        const [wrapperPda] = PublicKey.findProgramAddressSync(
            [WRAPPER_SEED, vaultBuf, nftBuf],
            PROGRAM_ID
        )
        try {
            await program.methods
                .wrapPosition({ vaultId, nftId })
                .accounts({
                    authority: stranger.publicKey,
                    store: storePda,
                    wrapper: wrapperPda,
                    systemProgram: SystemProgram.programId,
                })
                .signers([stranger])
                .rpc()
            expect.fail('expected Unauthorized')
        } catch (err) {
            assertLogsMatch(err, /Unauthorized|6004/)
        }
    })

    it('wrap_position succeeds for snapshotter', async () => {
        const vaultId = 1
        const nftId = 8002
        const vaultBuf = Buffer.alloc(2)
        vaultBuf.writeUInt16LE(vaultId)
        const nftBuf = Buffer.alloc(4)
        nftBuf.writeUInt32LE(nftId)
        const [wrapperPda] = PublicKey.findProgramAddressSync(
            [WRAPPER_SEED, vaultBuf, nftBuf],
            PROGRAM_ID
        )
        await program.methods
            .wrapPosition({ vaultId, nftId })
            .accounts({
                authority: admin.publicKey,
                store: storePda,
                wrapper: wrapperPda,
                systemProgram: SystemProgram.programId,
            })
            .rpc()
    })

    it('send rejects non-sender', async () => {
        const eidBuf = Buffer.alloc(4)
        eidBuf.writeUInt32BE(DST_EID)
        const [peerPda] = PublicKey.findProgramAddressSync(
            [PEER_SEED, storePda.toBuffer(), eidBuf],
            PROGRAM_ID
        )
        const [endpointSetting] = PublicKey.findProgramAddressSync(
            [Buffer.from('Endpoint')],
            ENDPOINT_PROGRAM
        )
        const vaultId = 1
        const nftId = 9001
        const vaultBuf = Buffer.alloc(2)
        vaultBuf.writeUInt16LE(vaultId)
        const nftBuf = Buffer.alloc(4)
        nftBuf.writeUInt32LE(nftId)
        const [wrapperPda] = PublicKey.findProgramAddressSync(
            [WRAPPER_SEED, vaultBuf, nftBuf],
            PROGRAM_ID
        )
        await program.methods
            .wrapPosition({ vaultId, nftId })
            .accounts({
                authority: admin.publicKey,
                store: storePda,
                wrapper: wrapperPda,
                systemProgram: SystemProgram.programId,
            })
            .rpc()
        try {
            await program.methods
                .send({
                    dstEid: DST_EID,
                    options: Buffer.alloc(0),
                    nativeFee: new BN(0),
                    lzTokenFee: new BN(0),
                })
                .accounts({
                    authority: stranger.publicKey,
                    peer: peerPda,
                    store: storePda,
                    wrapper: wrapperPda,
                    endpoint: endpointSetting,
                })
                .signers([stranger])
                .rpc()
            expect.fail('expected Unauthorized')
        } catch (err) {
            assertLogsMatch(err, /Unauthorized|6004/)
        }
    })

    it('send rejects when lz_send_allowed is false', async () => {
        const eidBuf = Buffer.alloc(4)
        eidBuf.writeUInt32BE(DST_EID)
        const [peerPda] = PublicKey.findProgramAddressSync(
            [PEER_SEED, storePda.toBuffer(), eidBuf],
            PROGRAM_ID
        )
        const [endpointSetting] = PublicKey.findProgramAddressSync(
            [Buffer.from('Endpoint')],
            ENDPOINT_PROGRAM
        )
        const vaultId = 1
        const nftId = 9002
        const vaultBuf = Buffer.alloc(2)
        vaultBuf.writeUInt16LE(vaultId)
        const nftBuf = Buffer.alloc(4)
        nftBuf.writeUInt32LE(nftId)
        const [wrapperPda] = PublicKey.findProgramAddressSync(
            [WRAPPER_SEED, vaultBuf, nftBuf],
            PROGRAM_ID
        )
        await program.methods
            .wrapPosition({ vaultId, nftId })
            .accounts({
                authority: admin.publicKey,
                store: storePda,
                wrapper: wrapperPda,
                systemProgram: SystemProgram.programId,
            })
            .rpc()
        try {
            await program.methods
                .send({
                    dstEid: DST_EID,
                    options: Buffer.alloc(0),
                    nativeFee: new BN(0),
                    lzTokenFee: new BN(0),
                })
                .accounts({
                    authority: admin.publicKey,
                    peer: peerPda,
                    store: storePda,
                    wrapper: wrapperPda,
                    endpoint: endpointSetting,
                })
                .rpc()
            expect.fail('expected Unauthorized')
        } catch (err) {
            assertLogsMatch(err, /Unauthorized|6004/)
        }
    })
})
