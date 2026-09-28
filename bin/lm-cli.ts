import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
    printDeploymentBanner,
    resolveDeployment,
    rpcFingerprint,
} from '../lib/deployment'

function fail(message: string): never {
    console.error(message)
    process.exit(1)
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
    const result = spawnSync(command, args, { stdio: 'inherit', env, shell: false })
    if (result.error) {
        fail(result.error.message)
    }
    process.exit(result.status ?? 1)
}

function hasFlag(args: string[], name: string): boolean {
    return args.some((a) => a === name || a.startsWith(`${name}=`))
}

/**
 * Forge treats everything after `--constructor-args` as constructor values.
 * Insert flags before that (and similar) so --rpc-url / --private-key are not eaten.
 */
function insertForgeFlags(args: string[], flags: string[]): string[] {
    const cut = args.findIndex(
        (a) =>
            a === '--constructor-args' ||
            a.startsWith('--constructor-args=') ||
            a === '--constructor-args-path' ||
            a.startsWith('--constructor-args-path=') ||
            a === '--encoded-constructor-args' ||
            a.startsWith('--encoded-constructor-args=')
    )
    if (cut === -1) return [...args, ...flags]
    return [...args.slice(0, cut), ...flags, ...args.slice(cut)]
}

/** Read `solana config get` keypair and rpc URL. */
function readSolanaCliConfig(): { keypairPath?: string; rpcUrl?: string } {
    const result = spawnSync('solana', ['config', 'get'], { encoding: 'utf8' })
    if (result.status !== 0) {
        return {}
    }
    const text = result.stdout ?? ''
    const keypairMatch = text.match(/Keypair Path:\s*(.+)/)
    const rpcMatch = text.match(/RPC URL:\s*(.+)/)
    return {
        keypairPath: keypairMatch?.[1]?.trim(),
        rpcUrl: rpcMatch?.[1]?.trim(),
    }
}

function expandHome(p: string): string {
    if (p.startsWith('~/')) return join(homedir(), p.slice(2))
    return p
}

function warnSolanaCliMismatch(): void {
    const resolved = resolveDeployment()
    const cli = readSolanaCliConfig()
    if (cli.keypairPath) {
        try {
            const secret = JSON.parse(readFileSync(expandHome(cli.keypairPath), 'utf8')) as number[]
            const { Keypair } = require('@solana/web3.js') as typeof import('@solana/web3.js')
            const cliPubkey = Keypair.fromSecretKey(Uint8Array.from(secret)).publicKey.toBase58()
            const profilePubkey = resolved.solanaKeypair.publicKey.toBase58()
            if (cliPubkey !== profilePubkey) {
                console.warn(
                    `[lm] solana config keypair is ${cliPubkey}; profile uses ${profilePubkey}. This command overrides with --keypair.`
                )
            }
        } catch {
            /* ignore unreadable cli keypair */
        }
    }
    if (cli.rpcUrl) {
        const cliFp = rpcFingerprint(cli.rpcUrl)
        const profileFp = rpcFingerprint(resolved.solanaRpc)
        if (cliFp !== profileFp) {
            console.warn(
                `[lm] solana config RPC is ${cliFp}; profile uses ${profileFp}. This command overrides with --url.`
            )
        }
    }
}

function main(): void {
    const argv = process.argv.slice(2)
    if (argv.length === 0) {
        fail('Usage: npx lm <build|solana|forge|cast|anchor> ...')
    }

    const resolved = resolveDeployment()
    printDeploymentBanner(resolved)
    const [cmd, ...rest] = argv

    if (cmd === 'build') {
        run(
            'anchor',
            ['build', '-p', 'lendmirror', ...rest],
            { ...process.env, LENDMIRROR_ID: resolved.profile.programId }
        )
    }

    if (cmd === 'anchor') {
        if (rest[0] === 'build') {
            run(
                'anchor',
                rest,
                { ...process.env, LENDMIRROR_ID: resolved.profile.programId }
            )
        }
        run('anchor', rest, { ...process.env, LENDMIRROR_ID: resolved.profile.programId })
    }

    if (cmd === 'solana') {
        warnSolanaCliMismatch()
        const args = [...rest]
        if (!hasFlag(args, '--url') && !hasFlag(args, '-u')) {
            args.push('--url', resolved.solanaRpc)
        }
        if (!hasFlag(args, '--keypair') && !hasFlag(args, '-k')) {
            args.push('--keypair', resolved.solanaKeypairPath)
        }
        run('solana', args)
    }

    if (cmd === 'forge' || cmd === 'cast') {
        let args = [...rest]
        const inject: string[] = []
        if (!hasFlag(args, '--rpc-url')) {
            inject.push('--rpc-url', resolved.evmRpc)
        }
        if (!hasFlag(args, '--private-key')) {
            // forge create / cast send need the key. Read-only cast calls can ignore it.
            const needsKey =
                cmd === 'forge' ||
                args[0] === 'send' ||
                args[0] === 'publish' ||
                args.includes('--broadcast')
            if (needsKey) {
                inject.push('--private-key', resolved.evmPrivateKey)
            }
        }
        if (inject.length > 0) {
            args = insertForgeFlags(args, inject)
        }
        run(cmd, args, {
            ...process.env,
            // Clear bare PRIVATE_KEY so a leftover shell export cannot win.
            PRIVATE_KEY: resolved.evmPrivateKey,
        })
    }

    fail(`Unknown lm command: ${cmd}. Use build, solana, forge, cast, or anchor.`)
}

main()
