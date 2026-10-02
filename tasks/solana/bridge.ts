import { Umi, generateSigner, publicKey, transactionBuilder } from '@metaplex-foundation/umi'
import { fromWeb3JsInstruction, toWeb3JsTransaction } from '@metaplex-foundation/umi-web3js-adapters'
import bs58 from 'bs58'
import { task, types } from 'hardhat/config'

import { lendmirror } from '../../lib/client'
import {
    CCTP_FINALITY_STANDARD,
    CCTP_TOKEN_MESSENGER_MINTER_V2,
    PROVIDER_CCIP,
    PROVIDER_CCTP,
    PROVIDER_LZ_OFT,
    bridgeRouteAddress,
    bridgeTokensCcip,
    bridgeTokensCctp,
    bridgeTokensLz,
    setBridgeRoute,
} from '../../lib/client/bridge'
import { buildIssuerSend } from '../../lib/client/lzSend'
import { getProfile, requireCcip, resolveSolanaEid } from '../common/deployment'

import {
    TransactionType,
    addComputeUnitInstructions,
    deriveConnection,
    getExplorerTxLink,
    getSolanaDeployment,
} from '.'

/** "USDT" / "USDai" / "sUSDai" / "usdc" / a raw mint → the mint, plus the LZ profile if any. */
function resolveMint(profile: ReturnType<typeof getProfile>, raw: string) {
    if (raw === 'usdc') {
        if (!profile.cctp) throw new Error('No USDC mint in the profile; pass the mint itself.')
        return { mint: profile.cctp.usdcMint, lzToken: undefined }
    }
    const bySymbol = profile.lzTokens.find((t) => t.symbol.toLowerCase() === raw.toLowerCase())
    const byMint = profile.lzTokens.find((t) => t.mint === raw)
    const lzToken = bySymbol ?? byMint
    return { mint: lzToken?.mint ?? raw, lzToken }
}

/** Simulate the built transaction without sending and print what it would do. */
async function dryRun(
    connection: import('@solana/web3.js').Connection,
    umi: Umi,
    txBuilder: ReturnType<typeof transactionBuilder>
) {
    const built = await txBuilder.buildWithLatestBlockhash(umi)
    const web3Tx = toWeb3JsTransaction(built)
    const size = web3Tx.serialize().length
    const sim = await connection.simulateTransaction(web3Tx, { sigVerify: false, replaceRecentBlockhash: true })
    console.log('--- dry run, nothing sent ---')
    console.log('transaction size:', size, 'bytes (limit 1232)')
    console.log('compute units:', sim.value.unitsConsumed ?? 'unknown')
    if (sim.value.err) {
        console.log('simulation FAILED:', JSON.stringify(sim.value.err))
    } else {
        console.log('simulation ok')
    }
    for (const line of sim.value.logs ?? []) console.log(' ', line)
    if (sim.value.err) throw new Error('Dry run failed; see the logs above.')
}

/**
 * Token bridging tasks.
 *   set-bridge-route  admin fixes provider + EVM treasury for one (mint, chain id)
 *   bridge-tokens     level >= 1 sends an amount; the destination is not a parameter
 */

task('lz:oapp:solana:set-bridge-route', 'Admin: fix the bridge provider and EVM treasury for a token and chain')
    .addOptionalParam('eid', 'Solana endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .addParam('mint', 'Token mint (base58). "usdc" = profile CCTP USDC mint', undefined, types.string)
    .addParam('provider', 'cctp, ccip, or oft (LayerZero)', undefined, types.string)
    .addOptionalParam('chainId', 'EVM chain id. Default: Sepolia 11155111 on devnet', undefined, types.int)
    .addOptionalParam('receiver', 'EVM treasury address. Default: profile.treasury', '', types.string)
    .addOptionalParam(
        'destinationCaller',
        'CCTP only: EVM address allowed to claim. Default: receiver. "any" = anyone',
        '',
        types.string
    )
    .addOptionalParam('maxAmount', 'Per-tx cap in base units', '1000000000', types.string)
    .addOptionalParam('enabled', 'true or false', 'true', types.string)
    .addOptionalParam('computeUnitPriceScaleFactor', 'Compute unit price scale factor', 4, types.float)
    .setAction(async (args) => {
        const eid = resolveSolanaEid(args.eid)
        const profile = getProfile()
        const { connection, umi, umiWalletSigner } = await deriveConnection(eid)
        const instance = new lendmirror.LendMirror(publicKey(getSolanaDeployment(eid).programId))
        const receiver = args.receiver || profile.treasury
        if (!receiver)
            throw new Error(
                'No treasury address. Deploy LendMirrorTreasury and set profile.treasury, or pass --receiver.'
            )
        const chainId = BigInt(args.chainId ?? (profile.type === 'devnet' ? 11155111 : 42161))
        const { mint, lzToken } = resolveMint(profile, args.mint)

        let provider: number
        let providerProgram: string
        let domainOrSelector: bigint
        let gasLimit = 0n
        if (args.provider === 'oft') {
            // Everything comes from the profile's captured lane data (config/<type>.ts lzTokens).
            if (!lzToken) throw new Error(`--provider oft: ${args.mint} is not in the profile's lzTokens.`)
            provider = PROVIDER_LZ_OFT
            providerProgram = lzToken.issuerProgram
            domainOrSelector = BigInt(lzToken.dstEid)
            // For LayerZero the route's gas_limit field carries the position of the sender's
            // token account in the issuer's send, which the program pins.
            gasLimit = BigInt(lzToken.tokenSourceIndex)
        } else if (args.provider === 'cctp') {
            if (!profile.cctp) throw new Error('No CCTP config in the profile.')
            provider = PROVIDER_CCTP
            providerProgram = CCTP_TOKEN_MESSENGER_MINTER_V2
            domainOrSelector = BigInt(profile.cctp.evmDomain)
        } else if (args.provider === 'ccip') {
            const ccip = requireCcip()
            provider = PROVIDER_CCIP
            providerProgram = ccip.router
            domainOrSelector = ccip.destChainSelector
        } else {
            throw new Error('--provider must be cctp, ccip, or oft')
        }
        // Only CCTP reads destination_caller; store zeros elsewhere.
        const destinationCaller =
            args.provider !== 'cctp' || args.destinationCaller === 'any' ? '' : args.destinationCaller || receiver

        let txBuilder = transactionBuilder().add(
            setBridgeRoute(instance, umiWalletSigner, {
                mint,
                dstChainId: chainId,
                provider,
                providerProgram,
                receiver,
                destinationCaller,
                domainOrSelector,
                gasLimit,
                enabled: args.enabled === 'true',
                maxAmountPerTx: BigInt(args.maxAmount),
            })
        )
        txBuilder = await addComputeUnitInstructions(
            connection,
            umi,
            eid,
            txBuilder,
            umiWalletSigner,
            args.computeUnitPriceScaleFactor,
            TransactionType.SetAuthority
        )
        const tx = await txBuilder.sendAndConfirm(umi)
        console.log(`setBridgeRoute: ${getExplorerTxLink(bs58.encode(tx.signature), eid === 40168)}`)
        console.log('route', bridgeRouteAddress(String(instance.programId), mint, chainId).toBase58())
        console.log({
            mint,
            chainId: chainId.toString(),
            provider: args.provider,
            receiver,
            destinationCaller: destinationCaller || 'anyone',
        })
        if (lzToken)
            console.log(
                `Treasury side: set a strategy for ${lzToken.symbol} (${lzToken.evmToken}, LayerZero eid ${lzToken.dstEid}) before forwarding.`
            )
    })

task(
    'lz:oapp:solana:bridge-tokens',
    'Level >= 1: bridge tokens from a wrapper to the EVM treasury (route decides how and where)'
)
    .addOptionalParam('eid', 'Solana endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .addOptionalParam('vaultId', 'Jupiter vault id', 1, types.int)
    .addOptionalParam('nftId', 'Jupiter position nft id', 29, types.int)
    .addParam('mint', 'Token mint (base58). "usdc" = profile CCTP USDC mint', undefined, types.string)
    .addParam('amount', 'Base units to bridge', undefined, types.string)
    .addOptionalParam('chainId', 'EVM chain id. Default: Sepolia 11155111 on devnet', undefined, types.int)
    .addOptionalParam(
        'fast',
        'CCTP fast transfer: pass the max fee in base units. Default: standard, no fee',
        '',
        types.string
    )
    .addOptionalParam('fundLamports', 'CCIP only: SOL moved onto the bridge signer for the fee', 50_000_000, types.int)
    .addFlag('dryRun', 'Build and simulate everything, print the result, send nothing')
    .addOptionalParam(
        'tamper',
        'LayerZero only, for proving the guard on a live network: "amount" (send 1 unit less), "receiver" (send elsewhere), "no-send" (release alone). The program must refuse.',
        '',
        types.string
    )
    .addOptionalParam('computeUnitPriceScaleFactor', 'Compute unit price scale factor', 4, types.float)
    .setAction(async (args) => {
        const { PublicKey } = await import('@solana/web3.js')
        const { ccipRouteAddress, decodeCcipRoute } = await import('../../lib/client/ccip')
        const eid = resolveSolanaEid(args.eid)
        const profile = getProfile()
        const { connection, umi, umiWalletSigner } = await deriveConnection(eid)
        const programId = getSolanaDeployment(eid).programId
        const instance = new lendmirror.LendMirror(publicKey(programId))
        const chainId = BigInt(args.chainId ?? (profile.type === 'devnet' ? 11155111 : 42161))
        const { mint, lzToken } = resolveMint(profile, args.mint)

        const routeInfo = await connection.getAccountInfo(bridgeRouteAddress(programId, mint, chainId))
        if (!routeInfo) throw new Error('No BridgeRoute for this mint and chain. Run set-bridge-route first.')
        const route = lendmirror.accounts.getBridgeRouteAccountDataSerializer().deserialize(routeInfo.data)[0]
        const [wrapper] = instance.pda.wrapper(args.vaultId, args.nftId)
        const ondemand = await instance.ondemandIfAttached(umi.rpc, wrapper)
        const common = {
            vaultId: args.vaultId,
            nftId: args.nftId,
            mint,
            dstChainId: chainId,
            amount: BigInt(args.amount),
        }

        let txBuilder = transactionBuilder()
        const extraLookupTables: ReturnType<typeof publicKey>[] = []
        if (route.provider === PROVIDER_CCTP) {
            const eventData = generateSigner(umi)
            txBuilder = txBuilder.add(
                await bridgeTokensCctp(
                    instance,
                    umiWalletSigner,
                    eventData,
                    {
                        ...common,
                        destinationDomain: Number(route.domainOrSelector),
                        maxFee: args.fast ? BigInt(args.fast) : 0n,
                        minFinalityThreshold: args.fast ? 1000 : CCTP_FINALITY_STANDARD,
                    },
                    ondemand
                )
            )
        } else if (route.provider === PROVIDER_CCIP) {
            const ccipRouteInfo = await connection.getAccountInfo(new PublicKey(ccipRouteAddress(programId)))
            if (!ccipRouteInfo) throw new Error('No CCIP route. Run lz:oapp:solana:set-ccip-route first.')
            const built = await bridgeTokensCcip(
                instance,
                connection,
                umiWalletSigner,
                { ...common, route: decodeCcipRoute(ccipRouteInfo.data), feeLamports: BigInt(args.fundLamports) },
                ondemand
            )
            txBuilder = txBuilder.add(built.instruction)
            extraLookupTables.push(built.lookupTable)
        } else if (route.provider === PROVIDER_LZ_OFT) {
            // Two instructions, in this exact order: our release, then the issuer's send. The
            // program reads the send through the instructions sysvar and refuses anything that
            // does not go, whole, to the route's receiver. The wallet pays the LayerZero fee.
            if (!lzToken) throw new Error('This mint has no LayerZero lane in the profile (config lzTokens).')
            const { getAssociatedTokenAddressSync } = await import('@solana/spl-token')
            const walletPk = new PublicKey(umiWalletSigner.publicKey)
            const tokenSource = getAssociatedTokenAddressSync(
                new PublicKey(mint),
                walletPk,
                false,
                new PublicKey(lzToken.tokenProgram)
            )
            txBuilder = txBuilder.add(
                bridgeTokensLz(instance, umiWalletSigner, { ...common, tokenProgram: lzToken.tokenProgram }, ondemand)
            )
            // `--tamper` builds a deliberately wrong pairing so the refusal can be shown live.
            const tamperedReceiver = Uint8Array.from(route.receiver)
            if (args.tamper === 'receiver') tamperedReceiver[31] ^= 1
            const sendIx = buildIssuerSend({
                token: lzToken,
                signer: walletPk,
                tokenSource,
                receiver: tamperedReceiver,
                amount: args.tamper === 'amount' ? common.amount - 1n : common.amount,
            })
            if (args.tamper !== 'no-send') {
                txBuilder = txBuilder.add({
                    instruction: fromWeb3JsInstruction(sendIx),
                    signers: [umiWalletSigner],
                    bytesCreatedOnChain: 0,
                })
            }
            if (args.tamper)
                console.log(`TAMPERED (${args.tamper}): the program must refuse this with MissingBridgeSend.`)
            extraLookupTables.push(publicKey(lzToken.lookupTable))
            console.log(
                `${lzToken.symbol}: fee cap ${lzToken.nativeFeeCapLamports} lamports, paid by the wallet; arrives as ${lzToken.evmToken} on LayerZero eid ${lzToken.dstEid}.`
            )
        } else {
            throw new Error(`Route provider ${route.provider} has no instruction (Wormhole NTT is reserved).`)
        }
        txBuilder = await addComputeUnitInstructions(
            connection,
            umi,
            eid,
            txBuilder,
            umiWalletSigner,
            args.computeUnitPriceScaleFactor,
            TransactionType.SendMessage,
            extraLookupTables
        )
        if (args.dryRun) {
            await dryRun(connection, umi, txBuilder)
            return
        }
        const tx = await txBuilder.sendAndConfirm(umi)
        const sig = bs58.encode(tx.signature)
        console.log(`bridgeTokens: ${getExplorerTxLink(sig, eid === 40168)}`)
        if (route.provider === PROVIDER_CCTP) {
            console.log(
                'Next: wait for Circle attestation, then `npx hardhat lz:oapp:evm:treasury:claim-cctp --tx-hash',
                sig + '`'
            )
        }
        if (route.provider === PROVIDER_LZ_OFT) {
            const { getLayerZeroScanLink } = await import('../utils')
            console.log('LayerZero:', getLayerZeroScanLink(sig, profile.type === 'devnet'))
        }
    })
