import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import { PublicKey } from '@solana/web3.js'
import { expect } from 'chai'

import devnet from '../config/devnet'
import mainnet from '../config/mainnet'
import { buildIssuerSend, issuerAccounts, lzMinAmount, oftSendData, tokenSourceIndex } from '../lib/client/lzSend'

import { CAPTURED_SENDS } from './fixtures/lz-sends'

/**
 * The send builder against real transactions (tests/fixtures/lz-sends.ts).
 *
 * Offline: the argument bytes, and the issuer's own accounts, which follow fixed rules.
 * Live (read-only RPC, skipped with LZ_OFFLINE=1): the full list including LayerZero's part,
 * which LayerZero's SDK reads from chain. Built for the same sender as the real transaction,
 * the list must be the same accounts in the same order.
 */
describe('LayerZero issuer send builder', () => {
    const tokens = [...mainnet.lzTokens, ...devnet.lzTokens]
    const token = (symbol: string) => {
        const t = tokens.find((x) => x.symbol === symbol)
        if (!t) throw new Error(`${symbol} missing from config`)
        return t
    }

    it('encodes the exact bytes of the real USDT send', () => {
        const data = oftSendData({
            dstEid: 30110,
            to: Uint8Array.from(Buffer.from('00000000000000000000000069940ddddd009bb8b253a907a2071587606a35ce', 'hex')),
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
            to: Uint8Array.from(Buffer.from('0000000000000000000000007e0371ec1177d3cf177a1a9a87dbc1e1864cd828', 'hex')),
            amountLd: 253776131414n,
            minAmountLd: 253522355282n,
            options: new Uint8Array(0),
            nativeFee: 865132n,
        })
        expect(data.toString('hex')).to.equal(
            '66fb14bb414b0c459e7500000000000000000000000000007e0371ec1177d3cf177a1a9a87dbc1e1864cd82856753c163b00000052241c073b00000000000000006c330d00000000000000000000000000'
        )
    })

    it('min amount: 0 bps keeps the amount, 40 bps shaves 0.4%', () => {
        expect(lzMinAmount(1_000_000n, 0)).to.equal(1_000_000n)
        expect(lzMinAmount(1_000_000n, 40)).to.equal(996_000n)
    })

    for (const symbol of Object.keys(CAPTURED_SENDS)) {
        const real = CAPTURED_SENDS[symbol]

        it(`${symbol}: the issuer's own accounts match the real send (offline)`, () => {
            const t = token(symbol)
            const { metas } = issuerAccounts(t, new PublicKey(real.signer), new PublicKey(real.tokenSource))
            metas.forEach((m, i) => {
                expect(m.pubkey.toBase58(), `account ${i}`).to.equal(real.accounts[i].key)
                expect(m.isWritable, `writable flag ${i}`).to.equal(real.accounts[i].w)
            })
            // The entry the program pins to the caller's own token balance.
            expect(metas[tokenSourceIndex(t)].pubkey.toBase58()).to.equal(real.tokenSource)
            // Only the sending wallet signs.
            expect(metas.filter((m) => m.isSigner).map((m) => m.pubkey.toBase58())).to.deep.equal([real.signer])
        })

        it(`${symbol}: the full list, LayerZero's part included, matches the real send (live)`, async function () {
            if (process.env.LZ_OFFLINE) this.skip()
            this.timeout(120_000)
            const t = token(symbol)
            const url = mainnet.lzTokens.includes(t)
                ? process.env.RPC_URL_SOLANA_MAINNET || 'https://api.mainnet-beta.solana.com'
                : process.env.RPC_URL_SOLANA_DEVNET || 'https://api.devnet.solana.com'
            const ix = await buildIssuerSend({
                rpc: createUmi(url).rpc,
                token: t,
                signer: new PublicKey(real.signer),
                tokenSource: new PublicKey(real.tokenSource),
                receiver: new Uint8Array(32),
                amount: 1n,
            })
            expect(ix.programId.toBase58()).to.equal(t.issuerProgram)
            expect(ix.data.readUInt32LE(8), 'destination id in the data').to.equal(t.dstEid)
            expect(ix.keys.map((k) => k.pubkey.toBase58())).to.deep.equal(real.accounts.map((a) => a.key))
            // A transaction merges flags per account: writable anywhere means writable everywhere.
            // The real send's flags are the merged ones, so merge ours before comparing.
            const writableSomewhere = new Set(ix.keys.filter((k) => k.isWritable).map((k) => k.pubkey.toBase58()))
            ix.keys.forEach((k, i) => {
                expect(writableSomewhere.has(k.pubkey.toBase58()), `writable flag ${i}`).to.equal(real.accounts[i].w)
            })
        })
    }

    it('another sender gets its own wallet, token balance and exemption record', () => {
        const t = token('USDai')
        if (t.issuer.kind !== 'usdai') throw new Error('USDai should use the usdai layout')
        const signer = new PublicKey('B8HnbEgetyiAdvkbgZR7LsChh93KR3jWuSw6xSQxt1hL')
        const tokenSource = new PublicKey('11111111111111111111111111111112')
        const { metas } = issuerAccounts(t, signer, tokenSource)
        expect(metas[0].pubkey.equals(signer)).to.equal(true)
        expect(metas[9].pubkey.equals(tokenSource)).to.equal(true)
        const exemption = PublicKey.findProgramAddressSync(
            [Buffer.from('RateLimitExemption'), new PublicKey(t.issuer.store).toBuffer(), signer.toBuffer()],
            new PublicKey(t.issuerProgram)
        )[0]
        expect(metas[8].pubkey.equals(exemption)).to.equal(true)
        // Everything else is the same for every sender.
        const real = CAPTURED_SENDS.USDai
        metas.forEach((m, i) => {
            if (i === 0 || i === 8 || i === 9) return
            expect(m.pubkey.toBase58(), `account ${i}`).to.equal(real.accounts[i].key)
        })
    })
})
