import { Pda, PublicKey } from '@metaplex-foundation/umi'
import { createWeb3JsEddsa } from '@metaplex-foundation/umi-eddsa-web3js'

const eddsa = createWeb3JsEddsa()

/** Same as `tick_math::MIN_TICK` / `INIT_TICK` / `TICK_PDA_OFFSET`. */
export const JUPITER_MIN_TICK = -16383
export const JUPITER_INIT_TICK = -2147483648
export const JUPITER_TICK_PDA_OFFSET = 16383

/** `Branch.status == 2` in the Vaults program. */
export const BRANCH_MERGED = 2

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

function viewOf(data: Uint8Array): DataView {
    return new DataView(data.buffer, data.byteOffset, data.byteLength)
}

/** Fields `get_jupiter_position` needs from the Position account (after the 8-byte disc). */
export type JupiterPositionFields = {
    vaultId: number
    nftId: number
    tick: number
    tickId: number
    supplyAmount: bigint
    dustDebtAmount: bigint
    isSupplyOnly: boolean
}

export function decodeJupiterPositionFields(data: Uint8Array): JupiterPositionFields {
    if (data.length < 71) {
        throw new Error('Jupiter Position account is too small')
    }
    const view = viewOf(data)
    return {
        vaultId: view.getUint16(8, true),
        nftId: view.getUint32(10, true),
        isSupplyOnly: data[46] !== 0,
        tick: view.getInt32(47, true),
        tickId: view.getUint32(51, true),
        supplyAmount: view.getBigUint64(55, true),
        dustDebtAmount: view.getBigUint64(63, true),
    }
}

/** Position body starts after the 8-byte discriminator. tick is i32 at offset 47. */
export function decodeJupiterPositionTick(data: Uint8Array): number {
    return decodeJupiterPositionFields(data).tick
}

export type JupiterTickFields = {
    tick: number
    isLiquidated: boolean
    totalIds: number
    isFullyLiquidated: boolean
    liquidationBranchId: number
    debtFactor: bigint
}

export function decodeJupiterTickFields(data: Uint8Array): JupiterTickFields {
    if (data.length < 40) {
        throw new Error('Jupiter Tick account is too small')
    }
    const view = viewOf(data)
    return {
        tick: view.getInt32(10, true),
        isLiquidated: data[14] !== 0,
        totalIds: view.getUint32(15, true),
        isFullyLiquidated: data[27] !== 0,
        liquidationBranchId: view.getUint32(28, true),
        debtFactor: view.getBigUint64(32, true),
    }
}

export type JupiterBranchFields = {
    branchId: number
    status: number
    minimaTick: number
    minimaTickPartials: number
    debtFactor: bigint
    connectedBranchId: number
}

export function decodeJupiterBranchFields(data: Uint8Array): JupiterBranchFields {
    if (data.length < 43) {
        throw new Error('Jupiter Branch account is too small')
    }
    const view = viewOf(data)
    return {
        branchId: view.getUint32(10, true),
        status: data[14],
        minimaTick: view.getInt32(15, true),
        minimaTickPartials: view.getUint32(19, true),
        debtFactor: view.getBigUint64(31, true),
        connectedBranchId: view.getUint32(39, true),
    }
}

export type JupiterTickIdLiquidationSlot = {
    isFullyLiquidated: boolean
    liquidationBranchId: number
    debtFactor: bigint
}

export function decodeJupiterTickIdLiquidation(data: Uint8Array): JupiterTickIdLiquidationSlot[] {
    // disc 8 + vault_id 2 + tick 4 + tick_map 4 = 18, then three (u8 + u32 + u64) slots.
    if (data.length < 57) {
        throw new Error('Jupiter TickIdLiquidation account is too small')
    }
    const view = viewOf(data)
    const slots: JupiterTickIdLiquidationSlot[] = []
    let offset = 18
    for (let i = 0; i < 3; i++) {
        slots.push({
            isFullyLiquidated: data[offset] !== 0,
            liquidationBranchId: view.getUint32(offset + 1, true),
            debtFactor: view.getBigUint64(offset + 5, true),
        })
        offset += 13
    }
    return slots
}

export function liquidationSlotIndex(tickId: number): number {
    return (tickId + 2) % 3
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

export function jupiterBranchPda(vaultsProgram: PublicKey, vaultId: number, branchId: number): Pda {
    return eddsa.findPda(vaultsProgram, [Buffer.from('branch'), u16Le(vaultId), u32Le(branchId)])
}

/** One TickIdLiquidation account holds three position ids. Last seed is the group. */
export function jupiterTickIdLiquidationPda(
    vaultsProgram: PublicKey,
    vaultId: number,
    tick: number,
    tickId: number
): Pda {
    return eddsa.findPda(vaultsProgram, [
        Buffer.from('tick_id_liquidation'),
        u16Le(vaultId),
        tickPdaSeed(tick),
        u32Le(Math.floor((tickId + 2) / 3)),
    ])
}
