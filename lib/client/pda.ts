import { Pda, PublicKey, publicKey, publicKeyBytes } from '@metaplex-foundation/umi'
import { Endian, u32 } from '@metaplex-foundation/umi/serializers'
import { createWeb3JsEddsa } from '@metaplex-foundation/umi-eddsa-web3js'

import { OmniAppPDA } from '@layerzerolabs/lz-solana-sdk-v2/umi'

import { u16Le, u32Le } from './jupiter'

const eddsa = createWeb3JsEddsa()

/** BPFLoaderUpgradeab1e11111111111111111111111 — owns ProgramData PDAs. */
export const BPF_LOADER_UPGRADEABLE = publicKey('BPFLoaderUpgradeab1e11111111111111111111111')

export const LZ_RECEIVE_TYPES_SEED = 'LzReceiveTypes'

export class LendMirrorPDA extends OmniAppPDA {
    static STORE_SEED = 'LendMirrorStore'
    static PEER_SEED = 'LendMirrorPeer'
    static JUP_POSITION_SEED = 'JupPosition'
    static NONCE_SEED = 'Nonce'

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
}
