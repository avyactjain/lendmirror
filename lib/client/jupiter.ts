import { Pda, PublicKey } from '@metaplex-foundation/umi'
import { createWeb3JsEddsa } from '@metaplex-foundation/umi-eddsa-web3js'

const eddsa = createWeb3JsEddsa()

/** Same as `tick_math::MIN_TICK` / `INIT_TICK` / `TICK_PDA_OFFSET`. */
export const JUPITER_MIN_TICK = -16383
export const JUPITER_INIT_TICK = -2147483648
export const JUPITER_TICK_PDA_OFFSET = 16383

export function u16Le(n: number): Uint8Array {
    const buf = new Uint8Array(2)
    new DataView(buf.buffer).setUint16(0, n, true)
    return buf
}

export function u32Le(n: number): Uint8Array {
    const buf = new Uint8Array(4)
    new DataView(buf.buffer).setUint32(0, n >>> 0, true)
    return buf
}

export function normalizeTick(tick: number): number {
    return tick === JUPITER_INIT_TICK ? JUPITER_MIN_TICK : tick
}

export function tickPdaSeed(tick: number): Uint8Array {
    return u32Le(normalizeTick(tick) + JUPITER_TICK_PDA_OFFSET)
}

/** Position body starts after the 8-byte discriminator. tick is i32 at offset 47. */
export function decodeJupiterPositionTick(data: Uint8Array): number {
    if (data.length < 51) {
        throw new Error('Jupiter Position account is too small')
    }
    return new DataView(data.buffer, data.byteOffset, data.byteLength).getInt32(47, true)
}

export function jupiterPositionPda(vaultsProgram: PublicKey, vaultId: number, nftId: number): Pda {
    return eddsa.findPda(vaultsProgram, [Buffer.from('position'), u16Le(vaultId), u32Le(nftId)])
}

export function jupiterVaultStatePda(vaultsProgram: PublicKey, vaultId: number): Pda {
    return eddsa.findPda(vaultsProgram, [Buffer.from('vault_state'), u16Le(vaultId)])
}

export function jupiterVaultConfigPda(vaultsProgram: PublicKey, vaultId: number): Pda {
    return eddsa.findPda(vaultsProgram, [Buffer.from('vault_config'), u16Le(vaultId)])
}

export function jupiterTickPda(vaultsProgram: PublicKey, vaultId: number, tick: number): Pda {
    return eddsa.findPda(vaultsProgram, [Buffer.from('tick'), u16Le(vaultId), tickPdaSeed(tick)])
}
