import { expect } from 'chai'
import { PublicKey } from '@solana/web3.js'
import { publicKey } from '@metaplex-foundation/umi'

import { LendMirrorPDA } from '../lib/client/pda'

const PROGRAM_ID = 'GQDxkWJhMGppaXExXBC8hGWmfaUv9igo4PKdaLyc53T1'

describe('wrapper PDAs', () => {
    const pda = new LendMirrorPDA(publicKey(PROGRAM_ID))
    const programId = new PublicKey(PROGRAM_ID)

    it('wrapper seeds match LendMirrorWrapper + vault_id le + nft_id le', () => {
        const vaultId = 1
        const nftId = 29
        const [client] = pda.wrapper(vaultId, nftId)
        const vaultBuf = Buffer.alloc(2)
        vaultBuf.writeUInt16LE(vaultId)
        const nftBuf = Buffer.alloc(4)
        nftBuf.writeUInt32LE(nftId)
        const [expected] = PublicKey.findProgramAddressSync(
            [Buffer.from('LendMirrorWrapper'), vaultBuf, nftBuf],
            programId
        )
        expect(client).to.equal(expected.toBase58())
    })

    it('ondemand seeds match LendMirrorOnDemand + wrapper', () => {
        const [wrapper] = pda.wrapper(1, 29)
        const [client] = pda.ondemand(wrapper)
        const [expected] = PublicKey.findProgramAddressSync(
            [Buffer.from('LendMirrorOnDemand'), new PublicKey(wrapper).toBuffer()],
            programId
        )
        expect(client).to.equal(expected.toBase58())
    })
})
