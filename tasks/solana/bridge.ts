import { generateSigner, publicKey, transactionBuilder } from '@metaplex-foundation/umi'
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
    bridgeTokensOft,
    setBridgeRoute,
} from '../../lib/client/bridge'
import { getProfile, requireCcip, resolveSolanaEid } from '../common/deployment'
import { TransactionType, addComputeUnitInstructions, deriveConnection, getExplorerTxLink, getSolanaDeployment } from '.'

/**
 * Token bridging tasks.
 *   set-bridge-route  admin fixes provider + EVM treasury for one (mint, chain id)
 *   bridge-tokens     level >= 1 sends an amount; the destination is not a parameter
 */

task('lz:oapp:solana:set-bridge-route', 'Admin: fix the bridge provider and EVM treasury for a token and chain')
    .addOptionalParam('eid', 'Solana endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .addParam('mint', 'Token mint (base58). "usdc" = profile CCTP USDC mint', undefined, types.string)
    .addParam('provider', 'cctp, ccip, or oft (LayerZero)', undefined, types.string)
    .addOptionalParam('oftProgram', 'oft only: the token\'s OFT program id', '', types.string)
    .addOptionalParam('escrow', 'oft only: the OFT token escrow account', '', types.string)
    .addOptionalParam('dstEid', 'oft only: LayerZero endpoint id of the destination (Arbitrum 30110, Ethereum 30101)', undefined, types.int)
    .addOptionalParam('chainId', 'EVM chain id. Default: Sepolia 11155111 on devnet', undefined, types.int)
    .addOptionalParam('receiver', 'EVM treasury address. Default: profile.treasury', '', types.string)
    .addOptionalParam('destinationCaller', 'CCTP only: EVM address allowed to claim. Default: receiver. "any" = anyone', '', types.string)
    .addOptionalParam('maxAmount', 'Per-tx cap in base units', '1000000000', types.string)
    .addOptionalParam('enabled', 'true or false', 'true', types.string)
    .addOptionalParam('computeUnitPriceScaleFactor', 'Compute unit price scale factor', 4, types.float)
    .setAction(async (args) => {
        const eid = resolveSolanaEid(args.eid)
        const profile = getProfile()
        const { connection, umi, umiWalletSigner } = await deriveConnection(eid)
        const instance = new lendmirror.LendMirror(publicKey(getSolanaDeployment(eid).programId))
        const receiver = args.receiver || profile.treasury
        if (!receiver) throw new Error('No treasury address. Deploy LendMirrorTreasury and set profile.treasury, or pass --receiver.')
        const chainId = BigInt(args.chainId ?? (profile.type === 'devnet' ? 11155111 : 42161))
        const mint = args.mint === 'usdc' ? profile.cctp?.usdcMint : args.mint
        if (!mint) throw new Error('No USDC mint in the profile; pass --mint.')

        let provider: number
        let providerProgram: string
        let providerAux = ''
        let domainOrSelector: bigint
        if (args.provider === 'oft') {
            if (!args.oftProgram || !args.escrow || args.dstEid === undefined) {
                throw new Error('--provider oft needs --oft-program, --escrow, and --dst-eid')
            }
            provider = PROVIDER_LZ_OFT
            providerProgram = args.oftProgram
            providerAux = args.escrow
            domainOrSelector = BigInt(args.dstEid)
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
        const destinationCaller = args.destinationCaller === 'any' ? '' : args.destinationCaller || receiver

        let txBuilder = transactionBuilder().add(
            setBridgeRoute(instance, umiWalletSigner, {
                mint,
                dstChainId: chainId,
                provider,
                providerProgram,
                providerAux,
                receiver,
                destinationCaller,
                domainOrSelector,
                gasLimit: 0n,
                enabled: args.enabled === 'true',
                maxAmountPerTx: BigInt(args.maxAmount),
            })
        )
        txBuilder = await addComputeUnitInstructions(connection, umi, eid, txBuilder, umiWalletSigner, args.computeUnitPriceScaleFactor, TransactionType.SetAuthority)
        const tx = await txBuilder.sendAndConfirm(umi)
        console.log(`setBridgeRoute: ${getExplorerTxLink(bs58.encode(tx.signature), eid === 40168)}`)
        console.log('route', bridgeRouteAddress(String(instance.programId), mint, chainId).toBase58())
        console.log({ mint, chainId: chainId.toString(), provider: args.provider, receiver, destinationCaller: destinationCaller || 'anyone' })
    })

task('lz:oapp:solana:bridge-tokens', 'Level >= 1: bridge tokens from a wrapper to the EVM treasury (route decides how and where)')
    .addOptionalParam('eid', 'Solana endpoint ID. Default: DEPLOYMENT_TYPE profile.', undefined, types.int)
    .addOptionalParam('vaultId', 'Jupiter vault id', 1, types.int)
    .addOptionalParam('nftId', 'Jupiter position nft id', 29, types.int)
    .addParam('mint', 'Token mint (base58). "usdc" = profile CCTP USDC mint', undefined, types.string)
    .addParam('amount', 'Base units to bridge', undefined, types.string)
    .addOptionalParam('chainId', 'EVM chain id. Default: Sepolia 11155111 on devnet', undefined, types.int)
    .addOptionalParam('fast', 'CCTP fast transfer: pass the max fee in base units. Default: standard, no fee', '', types.string)
    .addOptionalParam('fundLamports', 'CCIP only: SOL moved onto the bridge signer for the fee', 50_000_000, types.int)
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
        const mint = args.mint === 'usdc' ? profile.cctp?.usdcMint : args.mint
        if (!mint) throw new Error('No USDC mint in the profile; pass --mint.')

        const routeInfo = await connection.getAccountInfo(bridgeRouteAddress(programId, mint, chainId))
        if (!routeInfo) throw new Error('No BridgeRoute for this mint and chain. Run set-bridge-route first.')
        const route = lendmirror.accounts.getBridgeRouteAccountDataSerializer().deserialize(routeInfo.data)[0]
        const [wrapper] = instance.pda.wrapper(args.vaultId, args.nftId)
        const ondemand = await instance.ondemandIfAttached(umi.rpc, wrapper)
        const common = { vaultId: args.vaultId, nftId: args.nftId, mint, dstChainId: chainId, amount: BigInt(args.amount) }

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
            const receiver = '0x' + Buffer.from(route.receiver).subarray(12).toString('hex')
            const built = await bridgeTokensOft(
                instance,
                umi.rpc,
                umiWalletSigner,
                {
                    ...common,
                    oftProgram: String(route.providerProgram),
                    tokenEscrow: String(route.providerAux),
                    dstEid: Number(route.domainOrSelector),
                    receiver,
                },
                ondemand
            )
            console.log('LayerZero fee:', built.nativeFee.toString(), 'lamports; amount arriving:', built.amountReceived.toString())
            txBuilder = txBuilder.add(built.instruction)
        } else {
            throw new Error(`Route provider ${route.provider} has no instruction (Wormhole NTT is reserved).`)
        }
        txBuilder = await addComputeUnitInstructions(connection, umi, eid, txBuilder, umiWalletSigner, args.computeUnitPriceScaleFactor, TransactionType.SendMessage, extraLookupTables)
        const tx = await txBuilder.sendAndConfirm(umi)
        const sig = bs58.encode(tx.signature)
        console.log(`bridgeTokens: ${getExplorerTxLink(sig, eid === 40168)}`)
        if (route.provider === PROVIDER_CCTP) {
            console.log('Next: wait for Circle attestation, then `npx hardhat lz:oapp:evm:treasury:claim-cctp --tx-hash', sig + '`')
        }
        if (route.provider === PROVIDER_LZ_OFT) {
            const { getLayerZeroScanLink } = await import('../utils')
            console.log('LayerZero:', getLayerZeroScanLink(sig, profile.type === 'devnet'))
        }
    })
