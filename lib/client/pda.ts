import { Pda, PublicKey, publicKey, publicKeyBytes } from '@metaplex-foundation/umi'
import { Endian, u32 } from '@metaplex-foundation/umi/serializers'
import { createWeb3JsEddsa } from '@metaplex-foundation/umi-eddsa-web3js'

import { OmniAppPDA } from '@layerzerolabs/lz-solana-sdk-v2/umi'

import { u16Le, u32Le } from './jupiter'
import { SEEDS } from './seeds'

const eddsa = createWeb3JsEddsa()

/** BPFLoaderUpgradeab1e11111111111111111111111 — owns ProgramData PDAs. */
export const BPF_LOADER_UPGRADEABLE = publicKey('BPFLoaderUpgradeab1e11111111111111111111111')

export const LZ_RECEIVE_TYPES_SEED = 'LzReceiveTypes'

export class LendMirrorPDA extends OmniAppPDA {
    // Seed strings live in `seeds.ts`, next to their Rust twins. These aliases keep the
    // existing call sites working.
    static STORE_SEED = SEEDS.STORE
    static PEER_SEED = SEEDS.PEER
    static JUP_POSITION_SEED = SEEDS.JUP_POSITION
    static NONCE_SEED = 'Nonce'
    static WRAPPER_SEED = SEEDS.WRAPPER
    static ONDEMAND_SEED = SEEDS.ONDEMAND
    static WRAPPER_AUTH_SEED = SEEDS.WRAPPER_AUTH

    constructor(public readonly programId: PublicKey) {
        super(programId)
    }

    /** BPF-loader ProgramData PDA for this program. Used by `init_store`. */
    programData(): Pda {
        return eddsa.findPda(BPF_LOADER_UPGRADEABLE, [publicKeyBytes(this.programId)])
    }

    // seeds = [STORE_SEED],
    oapp(): Pda {
        return eddsa.findPda(this.programId, [Buffer.from(LendMirrorPDA.STORE_SEED, 'utf8')])
    }

    // seeds = [PEER_SEED, &count.key().to_bytes(), &params.dst_eid.to_be_bytes()],
    peer(dstChainId: number): Pda {
        const [count] = this.oapp()
        return eddsa.findPda(this.programId, [
            Buffer.from(LendMirrorPDA.PEER_SEED, 'utf8'),
            publicKeyBytes(count),
            u32({ endian: Endian.Big }).serialize(dstChainId),
        ])
    }

    // seeds = [NONCE_SEED, &params.receiver, &params.src_eid.to_be_bytes(), &params.sender]
    nonce(receiver: PublicKey, remoteEid: number, sender: Uint8Array): Pda {
        return eddsa.findPda(this.programId, [
            Buffer.from(LendMirrorPDA.NONCE_SEED, 'utf8'),
            publicKeyBytes(receiver),
            u32({ endian: Endian.Big }).serialize(remoteEid),
            sender,
        ])
    }

    // seeds = [LZ_RECEIVE_TYPES_SEED, &store.key().to_bytes()]
    lzReceiveTypesAccounts(): Pda {
        const [store] = this.oapp()
        return eddsa.findPda(this.programId, [Buffer.from(LZ_RECEIVE_TYPES_SEED, 'utf8'), publicKeyBytes(store)])
    }

    // seeds = [JUP_POSITION_SEED, vault_id le, nft_id le]
    jupPosition(vaultId: number, nftId: number): Pda {
        return eddsa.findPda(this.programId, [
            Buffer.from(LendMirrorPDA.JUP_POSITION_SEED, 'utf8'),
            u16Le(vaultId),
            u32Le(nftId),
        ])
    }

    // seeds = [WRAPPER_SEED, vault_id le, nft_id le]
    wrapper(vaultId: number, nftId: number): Pda {
        return eddsa.findPda(this.programId, [
            Buffer.from(LendMirrorPDA.WRAPPER_SEED, 'utf8'),
            u16Le(vaultId),
            u32Le(nftId),
        ])
    }

    // seeds = [ONDEMAND_SEED, wrapper.key()]
    ondemand(wrapper: PublicKey): Pda {
        return eddsa.findPda(this.programId, [
            Buffer.from(LendMirrorPDA.ONDEMAND_SEED, 'utf8'),
            publicKeyBytes(wrapper),
        ])
    }

    // seeds = [WRAPPER_AUTH_SEED, wrapper.key()]. Never created as an account; it only signs.
    wrapperAuthority(wrapper: PublicKey): Pda {
        return eddsa.findPda(this.programId, [
            Buffer.from(LendMirrorPDA.WRAPPER_AUTH_SEED, 'utf8'),
            publicKeyBytes(wrapper),
        ])
    }
}
