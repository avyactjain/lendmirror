import { Pda, PublicKey, publicKey, publicKeyBytes } from '@metaplex-foundation/umi'
import { Endian, u32 } from '@metaplex-foundation/umi/serializers'
import { createWeb3JsEddsa } from '@metaplex-foundation/umi-eddsa-web3js'

import { OmniAppPDA } from '@layerzerolabs/lz-solana-sdk-v2/umi'

const eddsa = createWeb3JsEddsa()

export const LZ_RECEIVE_TYPES_SEED = 'LzReceiveTypes'

/** Pyth push-oracle program. Shard-0 PDAs are the sponsored feed accounts. */
export const PYTH_PUSH_ORACLE_PROGRAM_ID: PublicKey = publicKey('pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT')

/** PDA([shard_u16_le, feed_id], pyth push oracle). Shard 0 is the public push feed. */
export function pythPushFeedAccount(feedId: Uint8Array, shardId = 0): Pda {
    if (feedId.length !== 32) {
        throw new Error('feedId must be 32 bytes')
    }
    const shard = Buffer.alloc(2)
    shard.writeUInt16LE(shardId, 0)
    return eddsa.findPda(PYTH_PUSH_ORACLE_PROGRAM_ID, [shard, feedId])
}

export class LendMirrorPDA extends OmniAppPDA {
    static STORE_SEED = 'LendMirrorStore'
    static PEER_SEED = 'LendMirrorPeer'
    static PYTH_PRICE_SEED = 'PythPrice'
    static NONCE_SEED = 'Nonce'

    constructor(public readonly programId: PublicKey) {
        super(programId)
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

    // seeds = [PYTH_PRICE_SEED, feed_id]
    pythPrice(feedId: Uint8Array): Pda {
        if (feedId.length !== 32) {
            throw new Error('feedId must be 32 bytes')
        }
        return eddsa.findPda(this.programId, [Buffer.from(LendMirrorPDA.PYTH_PRICE_SEED, 'utf8'), feedId])
    }
}
