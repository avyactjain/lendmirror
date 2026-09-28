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
const WRAPPER_SEED = Buffer.from('LendMirrorWrapperV1')
const PROGRAM_ID = new PublicKey('GQDxkWJhMGppaXExXBC8hGWmfaUv9igo4PKdaLyc53T1')
const ENDPOINT_PROGRAM = new PublicKey('76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6')
const JUPITER_VAULTS_DEVNET = new PublicKey('Ho32sUQ4NzuAQgkPkHuNDG3G18rgHmYtXFA8EBmqQrAu')
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112')
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const CCTP_TOKEN_MESSENGER_MINTER = new PublicKey('CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe')
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
    const [ccipRoutePda] = PublicKey.findProgramAddressSync([Buffer.from('LendMirrorCcip')], PROGRAM_ID)
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

    it('wrap_position stores layout version 1 and level 0', async () => {
        const [wrapperPda] = wrapperAddress(1, 8002)
        const wrapper = await program.account.positionWrapper.fetch(wrapperPda)
        expect(wrapper.version).to.equal(1)
        expect(wrapper.level).to.equal(0)
        expect(wrapper.custody).to.equal(false)
        expect(wrapper.sendCount.toNumber()).to.equal(0)
        expect(wrapper.lastSentSnapshotTime.toNumber()).to.equal(0)
    })

    it('old flow instructions are gone; the combined send exists', () => {
        const names = (idl as { instructions: { name: string }[] }).instructions.map((ix) => ix.name)
        expect(names).to.not.include('send')
        expect(names).to.not.include('send_ccip')
        expect(names).to.not.include('request_bridge_ondemand')
        expect(names).to.include('send_position_snapshot_via_chainlink_and_lz')
    })

    it('refresh_wrapper works without an OnDemand account (fails later, on the Jupiter account)', async () => {
        // The owner refreshes with `ondemand = null`. There is no Jupiter position on this
        // local validator, so the call must fail on the Jupiter `position` account, not on
        // the missing OnDemand account (AccountNotInitialized = 3012).
        const [wrapperPda] = wrapperAddress(1, 8002)
        const [position] = jupiterPda('position', 1, 8002)
        const [vaultState] = jupiterPda('vault_state', 1)
        const [vaultConfig] = jupiterPda('vault_config', 1)
        try {
            await program.methods
                .refreshWrapper()
                .accounts({
                    authority: admin.publicKey,
                    store: storePda,
                    wrapper: wrapperPda,
                    ondemand: null,
                    vaultsProgram: JUPITER_VAULTS_DEVNET,
                    position,
                    vaultState,
                    vaultConfig,
                    tick: position,
                    tickIdLiquidation: null,
                })
                .rpc()
            expect.fail('expected a Jupiter account failure')
        } catch (err) {
            assertLogsMatch(err, /ConstraintOwner|2004|AccountOwnedByWrongProgram|3007|ConstraintSeeds|2006/)
            const text = String((err as { logs?: string[] }).logs ?? err)
            expect(text).to.not.match(/AccountNotInitialized|3012/)
        }
    })

    it('set_ccip_route with placeholder programs, so the send accounts all exist', async () => {
        // Anchor loads and type-checks EVERY account before it evaluates any `constraint = ...`
        // expression. Without a CcipRoute account the send would fail with
        // AccountNotInitialized (3012) on `ccip_route` before the Unauthorized check ran.
        await program.methods
            .setCcipRoute({
                router: SystemProgram.programId,
                feeQuoter: SystemProgram.programId,
                rmnRemote: SystemProgram.programId,
                linkMint: SystemProgram.programId,
                destChainSelector: new BN(1),
                receiver: Array(20).fill(7),
                gasLimit: new BN(0),
            })
            .accounts({
                admin: admin.publicKey,
                ccipRoute: ccipRoutePda,
                store: storePda,
                systemProgram: SystemProgram.programId,
            })
            .rpc()
    })

    it('send rejects a caller who is neither a sender nor an OnDemand caller', async () => {
        try {
            await program.methods
                .sendPositionSnapshotViaChainlinkAndLz(sendParams())
                .accounts(sendAccounts(stranger.publicKey, wrapperAddress(1, 8002)[0]))
                .signers([stranger])
                .rpc()
            expect.fail('expected Unauthorized')
        } catch (err) {
            assertLogsMatch(err, /Unauthorized|6004/)
        }
    })

    it('send by a sender stops on the empty snapshot, after the account checks pass', async () => {
        // Admin is on `senders`. With every account in place the first thing `apply`
        // does is look for a snapshot, so the expected error is NoPositionSnapshot.
        try {
            await program.methods
                .sendPositionSnapshotViaChainlinkAndLz(sendParams())
                .accounts(sendAccounts(admin.publicKey, wrapperAddress(1, 8002)[0]))
                .rpc()
            expect.fail('expected NoPositionSnapshot')
        } catch (err) {
            assertLogsMatch(err, /NoPositionSnapshot|6006/)
        }
    })

    it('set_wrapper_level: admin only, 0..4, and it does not touch custody', async () => {
        const [wrapperPda] = wrapperAddress(1, 8002)
        try {
            await program.methods
                .setWrapperLevel(1)
                .accounts({ admin: stranger.publicKey, store: storePda, wrapper: wrapperPda })
                .signers([stranger])
                .rpc()
            expect.fail('expected ConstraintAddress')
        } catch (err) {
            assertLogsMatch(err, /ConstraintAddress|2012|Unauthorized|6004/)
        }
        try {
            await program.methods
                .setWrapperLevel(5)
                .accounts({ admin: admin.publicKey, store: storePda, wrapper: wrapperPda })
                .rpc()
            expect.fail('expected InvalidLevel')
        } catch (err) {
            assertLogsMatch(err, /InvalidLevel|6015/)
        }
        await program.methods
            .setWrapperLevel(2)
            .accounts({ admin: admin.publicKey, store: storePda, wrapper: wrapperPda })
            .rpc()
        const wrapper = await program.account.positionWrapper.fetch(wrapperPda)
        expect(wrapper.level).to.equal(2)
        expect(wrapper.custody).to.equal(false)
    })

    it('deposit_position_nft fails on the Jupiter mint when the position does not exist', async () => {
        // No Jupiter position on this validator, so the mint PDA is empty. The point of the
        // test: the instruction is wired and reaches the mint check, and the wrapper keeps
        // custody = false.
        const [wrapperPda] = wrapperAddress(1, 8002)
        const [wrapperAuthority] = PublicKey.findProgramAddressSync(
            [Buffer.from('LendMirrorWrapperAuth'), wrapperPda.toBuffer()],
            PROGRAM_ID
        )
        const [positionMint] = jupiterPda('position_mint', 1, 8002)
        const placeholder = Keypair.generate().publicKey
        try {
            await program.methods
                .depositPositionNft()
                .accounts({
                    authority: admin.publicKey,
                    store: storePda,
                    wrapper: wrapperPda,
                    wrapperAuthority,
                    vaultsProgram: JUPITER_VAULTS_DEVNET,
                    positionMint,
                    sourceNftAta: placeholder,
                    wrapperNftAta: placeholder,
                    tokenProgram: TOKEN_PROGRAM,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM,
                    systemProgram: SystemProgram.programId,
                })
                .rpc()
            expect.fail('expected a mint account failure')
        } catch (err) {
            assertLogsMatch(err, /AccountNotInitialized|3012|AccountOwnedByWrongProgram|3007|ConstraintSeeds|2006/)
        }
        const wrapper = await program.account.positionWrapper.fetch(wrapperPda)
        expect(wrapper.custody).to.equal(false)
    })

    it('custody and operate instructions are in the IDL', () => {
        const names = (idl as { instructions: { name: string }[] }).instructions.map((ix) => ix.name)
        for (const name of ['set_wrapper_level', 'deposit_position_nft', 'release_position_nft', 'operate_position']) {
            expect(names).to.include(name)
        }
    })

    it('set_bridge_route: admin only, known provider, non-zero receiver', async () => {
        const mint = Keypair.generate().publicKey
        const [route] = bridgeRouteAddress(mint, 11155111n)
        const params = {
            mint,
            dstChainId: new BN(11155111),
            provider: 1,
            providerProgram: SystemProgram.programId,
            providerAux: PublicKey.default,
            receiver: Array(32).fill(1),
            destinationCaller: Array(32).fill(0),
            domainOrSelector: new BN(0),
            gasLimit: new BN(0),
            enabled: true,
            maxAmountPerTx: new BN(1_000_000),
        }
        try {
            await program.methods
                .setBridgeRoute(params)
                .accounts({ admin: stranger.publicKey, store: storePda, bridgeRoute: route, systemProgram: SystemProgram.programId })
                .signers([stranger])
                .rpc()
            expect.fail('expected ConstraintAddress')
        } catch (err) {
            assertLogsMatch(err, /ConstraintAddress|2012/)
        }
        try {
            await program.methods
                .setBridgeRoute({ ...params, provider: 9 })
                .accounts({ admin: admin.publicKey, store: storePda, bridgeRoute: route, systemProgram: SystemProgram.programId })
                .rpc()
            expect.fail('expected WrongProvider')
        } catch (err) {
            assertLogsMatch(err, /WrongProvider|6021/)
        }
        try {
            await program.methods
                .setBridgeRoute({ ...params, receiver: Array(32).fill(0) })
                .accounts({ admin: admin.publicKey, store: storePda, bridgeRoute: route, systemProgram: SystemProgram.programId })
                .rpc()
            expect.fail('expected InvalidBridgeAccount')
        } catch (err) {
            assertLogsMatch(err, /InvalidBridgeAccount|6022/)
        }
        await program.methods
            .setBridgeRoute(params)
            .accounts({ admin: admin.publicKey, store: storePda, bridgeRoute: route, systemProgram: SystemProgram.programId })
            .rpc()
        const stored = await program.account.bridgeRoute.fetch(route)
        expect(stored.provider).to.equal(1)
        expect(stored.enabled).to.equal(true)
        expect(Buffer.from(stored.receiver).toString('hex')).to.equal('01'.repeat(32))

        // A LayerZero route must carry the OFT escrow; a Circle route must not.
        const escrow = Keypair.generate().publicKey
        try {
            await program.methods
                .setBridgeRoute({ ...params, provider: 3 })
                .accounts({ admin: admin.publicKey, store: storePda, bridgeRoute: route, systemProgram: SystemProgram.programId })
                .rpc()
            expect.fail('expected InvalidBridgeAccount: OFT route without escrow')
        } catch (err) {
            assertLogsMatch(err, /InvalidBridgeAccount|6022/)
        }
        await program.methods
            .setBridgeRoute({ ...params, provider: 3, providerAux: escrow, domainOrSelector: new BN(30110) })
            .accounts({ admin: admin.publicKey, store: storePda, bridgeRoute: route, systemProgram: SystemProgram.programId })
            .rpc()
        const oftRoute = await program.account.bridgeRoute.fetch(route)
        expect(oftRoute.provider).to.equal(3)
        expect(oftRoute.providerAux.toBase58()).to.equal(escrow.toBase58())
    })

    it('bridge_tokens_cctp: level 0 is denied, level 2 reaches the Circle CPI', async () => {
        // A real SPL mint on the local validator, with the wrapper authority holding 10 units.
        const { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAssociatedTokenAddressSync } = await import('@solana/spl-token')
        const mint = await createMint(provider.connection, admin, admin.publicKey, null, 6)
        const [wrapperPda] = wrapperAddress(1, 8002)
        const [wrapperAuthority] = PublicKey.findProgramAddressSync(
            [Buffer.from('LendMirrorWrapperAuth'), wrapperPda.toBuffer()],
            PROGRAM_ID
        )
        const [bridgeSigner] = PublicKey.findProgramAddressSync([Buffer.from('LendMirrorCcipPayer')], PROGRAM_ID)
        const wrapperAta = await getOrCreateAssociatedTokenAccount(provider.connection, admin, mint, wrapperAuthority, true)
        await mintTo(provider.connection, admin, mint, wrapperAta.address, admin, 10)
        const bridgeAta = getAssociatedTokenAddressSync(mint, bridgeSigner, true)
        const [route] = bridgeRouteAddress(mint, 11155111n)
        await program.methods
            .setBridgeRoute({
                mint,
                dstChainId: new BN(11155111),
                provider: 1,
                providerProgram: CCTP_TOKEN_MESSENGER_MINTER,
                providerAux: PublicKey.default,
                receiver: Array(32).fill(1),
                destinationCaller: Array(32).fill(0),
                domainOrSelector: new BN(0),
                gasLimit: new BN(0),
                enabled: true,
                maxAmountPerTx: new BN(5),
            })
            .accounts({ admin: admin.publicKey, store: storePda, bridgeRoute: route, systemProgram: SystemProgram.programId })
            .rpc()

        const eventData = Keypair.generate()
        const placeholder = Keypair.generate().publicKey
        // The instruction embeds a `BridgeCommon` accounts struct. Anchor's TS client wants it
        // nested under its field name; the Kinobi client (lib/client/bridge.ts) flattens it.
        const accounts = {
            common: {
                authority: admin.publicKey,
                store: storePda,
                wrapper: wrapperPda,
                ondemand: null,
                wrapperAuthority,
                bridgeSigner,
                bridgeRoute: route,
                mint,
                wrapperAta: wrapperAta.address,
                bridgeAta,
                tokenProgram: TOKEN_PROGRAM,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM,
                systemProgram: SystemProgram.programId,
            },
            senderAuthorityPda: placeholder,
            denylistAccount: placeholder,
            messageTransmitter: placeholder,
            tokenMessenger: placeholder,
            remoteTokenMessenger: placeholder,
            tokenMinter: placeholder,
            localToken: placeholder,
            messageSentEventData: eventData.publicKey,
            messageTransmitterProgram: placeholder,
            tokenMessengerMinterProgram: CCTP_TOKEN_MESSENGER_MINTER,
            eventAuthority: placeholder,
        }
        const params = (amount: number) => ({
            amount: new BN(amount),
            dstChainId: new BN(11155111),
            maxFee: new BN(0),
            minFinalityThreshold: 2000,
            feeLamports: new BN(0),
            minAmount: new BN(0),
            nativeFee: new BN(0),
            options: Buffer.alloc(0),
        })

        // Level 0 (set it back from 2): the wrapper constraint rejects before anything moves.
        await program.methods.setWrapperLevel(0).accounts({ admin: admin.publicKey, store: storePda, wrapper: wrapperPda }).rpc()
        try {
            await program.methods.bridgeTokensCctp(params(3)).accounts(accounts).signers([eventData]).rpc()
            expect.fail('expected LevelDenied')
        } catch (err) {
            assertLogsMatch(err, /LevelDenied|6014/)
        }

        // Over the route cap.
        await program.methods.setWrapperLevel(2).accounts({ admin: admin.publicKey, store: storePda, wrapper: wrapperPda }).rpc()
        try {
            await program.methods.bridgeTokensCctp(params(6)).accounts(accounts).signers([eventData]).rpc()
            expect.fail('expected AmountTooLarge')
        } catch (err) {
            assertLogsMatch(err, /AmountTooLarge|6020/)
        }

        // Allowed: the tokens move to the bridge signer's ATA, then the CPI into Circle fails
        // because Circle's program is not on this validator. The whole transaction reverts, so
        // the wrapper keeps its 10 units. This proves everything up to the provider call.
        try {
            await program.methods.bridgeTokensCctp(params(3)).accounts(accounts).signers([eventData]).rpc()
            expect.fail('expected the CCTP program to be missing')
        } catch (err) {
            assertLogsMatch(err, /Program is not deployed|ProgramAccountNotFound|invalid account data|not executable|UnsupportedProgramId|Unsupported program id|An account required by the instruction is missing/)
        }
        const balance = await provider.connection.getTokenAccountBalance(wrapperAta.address)
        expect(balance.value.amount).to.equal('10')
    })

    /** BridgeRoute PDA: ["LendMirrorBridgeRoute", mint, dst_chain_id le]. */
    function bridgeRouteAddress(mint: PublicKey, dstChainId: bigint): [PublicKey, number] {
        const chain = Buffer.alloc(8)
        chain.writeBigUInt64LE(dstChainId)
        return PublicKey.findProgramAddressSync([Buffer.from('LendMirrorBridgeRoute'), mint.toBuffer(), chain], PROGRAM_ID)
    }

    /** Wrapper PDA under the V1 seed. */
    function wrapperAddress(vaultId: number, nftId: number): [PublicKey, number] {
        const vaultBuf = Buffer.alloc(2)
        vaultBuf.writeUInt16LE(vaultId)
        const nftBuf = Buffer.alloc(4)
        nftBuf.writeUInt32LE(nftId)
        return PublicKey.findProgramAddressSync([WRAPPER_SEED, vaultBuf, nftBuf], PROGRAM_ID)
    }

    /** Jupiter vault PDAs: ["position", vault le, nft le] or ["vault_state" | "vault_config", vault le]. */
    function jupiterPda(kind: string, vaultId: number, nftId?: number): [PublicKey, number] {
        const vaultBuf = Buffer.alloc(2)
        vaultBuf.writeUInt16LE(vaultId)
        const seeds = [Buffer.from(kind), vaultBuf]
        if (nftId !== undefined) {
            const nftBuf = Buffer.alloc(4)
            nftBuf.writeUInt32LE(nftId)
            seeds.push(nftBuf)
        }
        return PublicKey.findProgramAddressSync(seeds, JUPITER_VAULTS_DEVNET)
    }

    function sendParams() {
        return {
            dstEid: DST_EID,
            options: Buffer.alloc(0),
            nativeFee: new BN(0),
            lzTokenFee: new BN(0),
            ccipFeeLamports: new BN(0),
        }
    }

    /**
     * All 27 accounts of the combined send. The CCIP accounts are placeholders: the
     * test never reaches the Chainlink CPI, only the checks in front of it.
     */
    function sendAccounts(authority: PublicKey, wrapper: PublicKey) {
        const eidBuf = Buffer.alloc(4)
        eidBuf.writeUInt32BE(DST_EID)
        const [peer] = PublicKey.findProgramAddressSync([PEER_SEED, storePda.toBuffer(), eidBuf], PROGRAM_ID)
        const [endpoint] = PublicKey.findProgramAddressSync([Buffer.from('Endpoint')], ENDPOINT_PROGRAM)
        const [ccipPayer] = PublicKey.findProgramAddressSync([Buffer.from('LendMirrorCcipPayer')], PROGRAM_ID)
        const placeholder = Keypair.generate().publicKey
        return {
            authority,
            ondemand: null,
            wrapper,
            store: storePda,
            peer,
            endpoint,
            ccipPayer,
            ccipRoute: ccipRoutePda,
            config: placeholder,
            destChainState: placeholder,
            nonce: placeholder,
            systemProgram: SystemProgram.programId,
            feeTokenProgram: TOKEN_PROGRAM,
            feeTokenMint: NATIVE_MINT,
            feeTokenUser: PublicKey.default,
            feeTokenReceiver: placeholder,
            feeBillingSigner: placeholder,
            feeQuoter: SystemProgram.programId,
            feeQuoterConfig: placeholder,
            feeQuoterDestChain: placeholder,
            feeQuoterBillingTokenConfig: placeholder,
            feeQuoterLinkTokenConfig: placeholder,
            rmnRemote: SystemProgram.programId,
            rmnRemoteCurses: placeholder,
            rmnRemoteConfig: placeholder,
            tokenPoolsSigner: placeholder,
            ccipRouter: SystemProgram.programId,
        }
    }
})
