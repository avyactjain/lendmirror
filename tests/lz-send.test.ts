import { PublicKey } from '@solana/web3.js'
import { expect } from 'chai'

import mainnet from '../config/mainnet'
import { buildIssuerSend, lzMinAmount, oftSendData } from '../lib/client/lzSend'

/**
 * The send builders against REAL mainnet transactions, byte for byte and account for account:
 *   USDai  4MH2cvvP6nhTouuPRjTVrPecFVc2N4uh6ZhoLVcNqoeKAK8fVKLWABVcXW2NDvYwLzoNzF5BpfxsTeEJKmgCj5Sm
 *   sUSDai w9q6nMmpVcFkBYhYHXkHa5C62fUQmxLgbSeTW6eBgUpdpMoD7aarCWd9ck25bQWTW26mdmGivoaERUtAz8vbNnc
 *   USDT   2u38YgKHvKKj2mDw4781Q9bJUxXp2L9qHKvDu26yNK5V2GyeuDwF7VJr9PVMjzcQYy6c5EtouHmzgA76yqGRUaB9
 * Rebuilding each template with its own original signer must reproduce the captured list
 * exactly, including USD.AI's per-sender rate-limit-exemption PDA.
 */
describe('LayerZero issuer send builder', () => {
    const token = (symbol: string) => {
        const t = mainnet.lzTokens.find((x) => x.symbol === symbol)
        if (!t) throw new Error(`${symbol} missing from config`)
        return t
    }

    it('encodes the exact bytes of the real USDT send', () => {
        const data = oftSendData({
            dstEid: 30110,
            to: Buffer.from('00000000000000000000000069940ddddd009bb8b253a907a2071587606a35ce', 'hex'),
            amountLd: 346504126n,
            minAmountLd: 344668174n,
            options: Uint8Array.from([0, 3]),
            nativeFee: 740343n,
        })
        expect(data.toString('hex')).to.equal(
            '66fb14bb414b0c459e75000000000000000000000000000069940ddddd009bb8b253a907a2071587606a35cebe3ba714000000000e388b140000000002000000000300f74b0b00000000000000000000000000'
        )
    })

    it('encodes the exact bytes of the real sUSDai send', () => {
        const data = oftSendData({
            dstEid: 30110,
            to: Buffer.from('0000000000000000000000007e0371ec1177d3cf177a1a9a87dbc1e1864cd828', 'hex'),
            amountLd: 253776131414n,
            minAmountLd: 253522355282n,
            options: new Uint8Array(0),
            nativeFee: 865132n,
        })
        expect(data.toString('hex')).to.equal(
            '66fb14bb414b0c459e7500000000000000000000000000007e0371ec1177d3cf177a1a9a87dbc1e1864cd82856753c163b00000052241c073b00000000000000006c330d00000000000000000000000000'
        )
    })

    for (const symbol of ['USDai', 'sUSDai', 'USDT']) {
        it(`rebuilds the captured ${symbol} account list from its own template signer`, () => {
            const t = token(symbol)
            const ix = buildIssuerSend({
                token: t,
                signer: new PublicKey(t.templateSigner),
                tokenSource: new PublicKey(t.accounts[t.tokenSourceIndex].key),
                receiver: new Uint8Array(32),
                amount: 1n,
            })
            expect(ix.programId.toBase58()).to.equal(t.issuerProgram)
            expect(ix.keys.length).to.equal(t.accounts.length)
            ix.keys.forEach((k, i) => {
                expect(k.pubkey.toBase58(), `account ${i}`).to.equal(t.accounts[i].key)
                expect(k.isWritable, `writability ${i}`).to.equal(t.accounts[i].w)
            })
            // Only the wallet signs; the program's guard pins the slots that matter.
            expect(ix.keys.filter((k) => k.isSigner).every((k) => k.pubkey.toBase58() === t.templateSigner)).to.equal(true)
        })
    }

    it('swaps in another signer, its token account, and its exemption PDA', () => {
        const t = token('USDai')
        const signer = new PublicKey('B8HnhBYYdLXXDJMvW45bcE2TWCS1Lx2nFVkJMCaxjUWF')
        const tokenSource = new PublicKey('11111111111111111111111111111112')
        const ix = buildIssuerSend({ token: t, signer, tokenSource, receiver: new Uint8Array(32), amount: 1n })
        expect(ix.keys[0].pubkey.equals(signer)).to.equal(true)
        expect(ix.keys[t.tokenSourceIndex].pubkey.equals(tokenSource)).to.equal(true)
        const expected = PublicKey.findProgramAddressSync(
            [Buffer.from('RateLimitExemption'), new PublicKey(t.senderPda!.seedBase).toBuffer(), signer.toBuffer()],
            new PublicKey(t.issuerProgram)
        )[0]
        expect(ix.keys[t.senderPda!.index].pubkey.equals(expected)).to.equal(true)
        // Every other slot stays the lane constant.
        ix.keys.forEach((k, i) => {
            if (i === 0 || i === t.tokenSourceIndex || i === t.senderPda!.index || i === 29) return
            expect(k.pubkey.toBase58(), `account ${i}`).to.equal(t.accounts[i].key)
        })
        // Slot 29 is the second occurrence of the signer (the fee payer inside the endpoint list).
        expect(ix.keys[29].pubkey.equals(signer)).to.equal(true)
    })

    it('min amount: 0 bps keeps the amount, 40 bps shaves 0.4%', () => {
        expect(lzMinAmount(1_000_000n, 0)).to.equal(1_000_000n)
        expect(lzMinAmount(1_000_000n, 40)).to.equal(996_000n)
    })
})
