import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

import { Keypair, PublicKey } from '@solana/web3.js'
import { Wallet } from 'ethers'

import type { CcipProfile, DeploymentProfile, DeploymentType } from '../config/types'
import devnet from '../config/devnet'
import mainnet from '../config/mainnet'

export type { CcipProfile, DeploymentProfile, DeploymentType }

export type ResolvedDeployment = {
    profile: DeploymentProfile
    solanaKeypairPath: string
    solanaKeypair: Keypair
    solanaRpc: string
    evmPrivateKey: string
    evmAddress: string
    evmRpc: string
}

const PROFILES: Record<DeploymentType, DeploymentProfile> = {
    devnet,
    mainnet,
}

function requireEnv(name: string): string {
    const value = process.env[name]?.trim()
    if (!value) {
        throw new Error(`Missing ${name}. Set it in .env for the active DEPLOYMENT_TYPE.`)
    }
    return value
}

/** Read DEPLOYMENT_TYPE and return the matching profile. Secrets are not loaded. */
export function getProfile(): DeploymentProfile {
    const raw = process.env.DEPLOYMENT_TYPE?.trim().toLowerCase()
    if (raw !== 'devnet' && raw !== 'mainnet') {
        throw new Error(
            `DEPLOYMENT_TYPE must be "devnet" or "mainnet". Got ${raw === undefined || raw === '' ? '(empty)' : JSON.stringify(raw)}.`
        )
    }
    return PROFILES[raw]
}

/** Profile plus key paths, RPC URLs, and loaded Solana / EVM keys. */
export function resolveDeployment(): ResolvedDeployment {
    const profile = getProfile()
    const solanaKeypairPath = requireEnv(profile.env.solanaKeypairPath)
    const solanaRpc = requireEnv(profile.env.solanaRpc)
    const evmPrivateKey = requireEnv(profile.env.evmPrivateKey)
    const evmRpc = requireEnv(profile.env.evmRpc)

    if (!existsSync(solanaKeypairPath)) {
        throw new Error(`Solana keypair file not found: ${solanaKeypairPath} (${profile.env.solanaKeypairPath})`)
    }
    const secret = JSON.parse(readFileSync(solanaKeypairPath, 'utf8')) as number[]
    const solanaKeypair = Keypair.fromSecretKey(Uint8Array.from(secret))
    const evmAddress = new Wallet(evmPrivateKey).address

    return {
        profile,
        solanaKeypairPath,
        solanaKeypair,
        solanaRpc,
        evmPrivateKey,
        evmAddress,
        evmRpc,
    }
}

/** Chainlink settings for the active profile. Stops when this path has no CCIP route. */
export function requireCcip(): CcipProfile {
    const { profile } = { profile: getProfile() }
    if (!profile.ccip) {
        throw new Error(`Chainlink is not wired for DEPLOYMENT_TYPE=${profile.type}.`)
    }
    return profile.ccip
}

/**
 * Stop when a CLI eid or Hardhat network does not match the active profile.
 * Pass only the values the caller supplied.
 */
export function assertMatchesProfile(opts: {
    solanaEid?: number
    evmEid?: number
    evmNetwork?: string
}): DeploymentProfile {
    const profile = getProfile()
    if (opts.solanaEid !== undefined && opts.solanaEid !== profile.solanaEid) {
        throw new Error(
            `Solana eid ${opts.solanaEid} does not match DEPLOYMENT_TYPE=${profile.type} (expected ${profile.solanaEid}).`
        )
    }
    if (opts.evmEid !== undefined && opts.evmEid !== profile.evmEid) {
        throw new Error(
            `EVM eid ${opts.evmEid} does not match DEPLOYMENT_TYPE=${profile.type} (expected ${profile.evmEid}).`
        )
    }
    if (opts.evmNetwork !== undefined && opts.evmNetwork !== profile.evmNetwork) {
        throw new Error(
            `Network ${opts.evmNetwork} does not match DEPLOYMENT_TYPE=${profile.type} (expected ${profile.evmNetwork}).`
        )
    }
    return profile
}

/** One line before a write: type, wallets, program, RPC host. */
export function printDeploymentBanner(resolved: ResolvedDeployment = resolveDeployment()): void {
    const { profile, solanaKeypair, solanaRpc, evmAddress, evmRpc } = resolved
    let solanaHost = solanaRpc
    let evmHost = evmRpc
    try {
        solanaHost = new URL(solanaRpc).host
    } catch {
        /* keep raw */
    }
    try {
        evmHost = new URL(evmRpc).host
    } catch {
        /* keep raw */
    }
    console.log(
        `[lm] type=${profile.type} solana=${solanaKeypair.publicKey.toBase58()} evm=${evmAddress} program=${profile.programId} solanaRpc=${solanaHost} evmRpc=${evmHost}`
    )
}

/** Host fingerprint so we can compare solana config URL to the profile RPC without printing API keys. */
export function rpcFingerprint(url: string): string {
    try {
        const u = new URL(url)
        return `${u.host}${u.pathname}`
    } catch {
        return createHash('sha256').update(url).digest('hex').slice(0, 12)
    }
}

export function pubkeyBytes32(pubkey: string): string {
    return '0x' + Buffer.from(new PublicKey(pubkey).toBytes()).toString('hex')
}
