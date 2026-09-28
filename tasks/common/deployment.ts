import { assertMatchesProfile, getProfile, printDeploymentBanner, requireCcip, resolveDeployment } from '../../lib/deployment'

/** Solana eid from the CLI or from DEPLOYMENT_TYPE. Rejects a mismatch. */
export function resolveSolanaEid(eid?: number): number {
    const profile = assertMatchesProfile({ solanaEid: eid })
    return eid ?? profile.solanaEid
}

/** EVM eid from the CLI or from DEPLOYMENT_TYPE. Rejects a mismatch. */
export function resolveEvmEid(eid?: number): number {
    const profile = assertMatchesProfile({ evmEid: eid })
    return eid ?? profile.evmEid
}

/** Hardhat / deployments network from the CLI or from DEPLOYMENT_TYPE. */
export function resolveEvmNetwork(network?: string): string {
    const profile = assertMatchesProfile({ evmNetwork: network })
    return network ?? profile.evmNetwork
}

/** Banner + resolved secrets before a write task. */
export function beginWrite(): ReturnType<typeof resolveDeployment> {
    const resolved = resolveDeployment()
    printDeploymentBanner(resolved)
    return resolved
}

export { getProfile, requireCcip, assertMatchesProfile }
