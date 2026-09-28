import { task, types } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'

/**
 * Treasury tasks. The treasury is the hardcoded destination for bridged tokens; these tasks
 * configure where it may forward and let anyone trigger a forward.
 */

async function treasury(hre: HardhatRuntimeEnvironment) {
    const signer = (await hre.ethers.getSigners())[0]
    const artifact = await hre.artifacts.readArtifact('LendMirrorTreasury')
    const deployment = await hre.deployments.get('LendMirrorTreasury')
    return { contract: new hre.ethers.Contract(deployment.address, artifact.abi, signer), address: deployment.address }
}

task('lz:oapp:evm:treasury:set-strategy', 'Owner: the only address forward(token) may send to')
    .addParam('token', 'ERC20 address', undefined, types.string)
    .addParam('strategy', 'Destination address (0x0 disables forwarding)', undefined, types.string)
    .setAction(async ({ token, strategy }, hre) => {
        const { contract, address } = await treasury(hre)
        const tx = await contract.setStrategy(token, strategy)
        console.log('treasury', address, 'tx', tx.hash)
        await tx.wait()
        console.log('strategy for', token, 'is now', await contract.strategy(token))
    })

task('lz:oapp:evm:treasury:forward', 'Anyone: move the treasury balance of a token to its strategy')
    .addParam('token', 'ERC20 address', undefined, types.string)
    .setAction(async ({ token }, hre) => {
        const { contract, address } = await treasury(hre)
        const tx = await contract.forward(token)
        console.log('treasury', address, 'tx', tx.hash)
        await tx.wait()
    })

task('lz:oapp:evm:treasury:set-ccip-route', 'Owner: allow the CCIP router, Solana selector, and Solana bridge signer')
    .addOptionalParam('sender', 'Solana bridge signer pubkey (base58). Default: profile ccip.payer', '', types.string)
    .addOptionalParam('allowed', 'true or false', 'true', types.string)
    .setAction(async ({ sender, allowed }, hre) => {
        const { requireCcip, pubkeyBytes32 } = await import('../../lib/deployment')
        const ccip = requireCcip()
        const { contract, address } = await treasury(hre)
        const senderBytes = pubkeyBytes32(sender || ccip.payer)
        const tx = await contract.setCcipRoute(ccip.evmRouter, ccip.sourceChainSelector, senderBytes, allowed === 'true')
        console.log('treasury', address, 'router', ccip.evmRouter, 'sender', senderBytes, 'tx', tx.hash)
        await tx.wait()
    })

task('lz:oapp:evm:treasury:set-cctp-transmitter', 'Owner: Circle MessageTransmitterV2 on this chain')
    .addOptionalParam('transmitter', 'Address. Default: profile cctp.evmMessageTransmitter', '', types.string)
    .setAction(async ({ transmitter }, hre) => {
        const { getProfile } = await import('../../lib/deployment')
        const profile = getProfile()
        const target = transmitter || profile.cctp?.evmMessageTransmitter
        if (!target) throw new Error('No CCTP transmitter in the profile. Pass --transmitter.')
        const { contract, address } = await treasury(hre)
        const tx = await contract.setCctpMessageTransmitter(target)
        console.log('treasury', address, 'transmitter', target, 'tx', tx.hash)
        await tx.wait()
    })

task('lz:oapp:evm:treasury:claim-cctp', 'Anyone: finish a CCTP transfer with Circle\'s attestation')
    .addParam('txHash', 'Solana transaction signature of bridge-tokens-cctp', undefined, types.string)
    .setAction(async ({ txHash }, hre) => {
        const { getProfile } = await import('../../lib/deployment')
        const profile = getProfile()
        if (!profile.cctp) throw new Error('No CCTP config in the profile.')
        // Circle's attestation API: /v2/messages/{sourceDomain}?transactionHash=...
        const url = `${profile.cctp.attestationApi}/v2/messages/${profile.cctp.solanaDomain}?transactionHash=${txHash}`
        const res = await fetch(url)
        if (!res.ok) throw new Error(`attestation API ${res.status}: ${await res.text()}`)
        const body = (await res.json()) as { messages?: { message: string; attestation: string; status: string }[] }
        const msg = body.messages?.[0]
        if (!msg || msg.status !== 'complete') {
            throw new Error(`attestation not ready: ${JSON.stringify(body).slice(0, 300)}`)
        }
        const { contract, address } = await treasury(hre)
        const tx = await contract.claimCctp(msg.message, msg.attestation)
        console.log('treasury', address, 'claim tx', tx.hash)
        await tx.wait()
    })
