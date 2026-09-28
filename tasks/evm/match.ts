import { task, types } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'

task('lz:oapp:evm:match', 'Print match or mismatch for a position on the two routers (or --all)')
    .addOptionalParam('position', '32-byte position account, hex or base58', '', types.string)
    .addFlag('all', 'Walk every position the contract has seen')
    .addOptionalParam('contractName', 'Deployed EVM contract name', 'LendMirror', types.string)
    .setAction(async ({ position, all, contractName }, hre: HardhatRuntimeEnvironment) => {
        const signer = (await hre.ethers.getSigners())[0]
        const artifact = await hre.artifacts.readArtifact(contractName)
        const deployment = await hre.deployments.get(contractName)
        const contract = new hre.ethers.Contract(deployment.address, artifact.abi, signer)
        console.log('proxy', deployment.address)

        let keys: string[]
        if (all) {
            const count = Number(await contract.positionCount())
            keys = await Promise.all(Array.from({ length: count }, (_, i) => contract.positions(i)))
            console.log(`${count} position(s) seen`)
        } else {
            if (!position) throw new Error('Pass --position <pubkey> or --all')
            keys = [await toBytes32(position)]
        }

        for (const key of keys) {
            const lz = await contract.fromLayerZero(key)
            const ccip = await contract.fromChainlink(key)
            const isMatch = await contract.matched(key)
            console.log('position', key)
            printSide('  layerZero', lz)
            printSide('  chainlink', ccip)
            console.log(isMatch ? '  match' : '  mismatch')
        }
    })

function printSide(name: string, delivery: { received: boolean; bodyHash: string; snapshot: { vaultId: { toString(): string }; nftId: { toString(): string }; colRaw: { toString(): string }; debtRaw: { toString(): string } } }) {
    if (!delivery.received) {
        console.log(name, 'missing')
        return
    }
    const s = delivery.snapshot
    console.log(
        name,
        `vault ${s.vaultId.toString()}`,
        `nft ${s.nftId.toString()}`,
        `col ${s.colRaw.toString()}`,
        `debt ${s.debtRaw.toString()}`,
        `hash ${delivery.bodyHash}`
    )
}

async function toBytes32(position: string): Promise<string> {
    if (position.startsWith('0x')) {
        const raw = position.slice(2)
        if (raw.length !== 64) throw new Error('Hex position must be 32 bytes.')
        return '0x' + raw
    }
    const { PublicKey } = await import('@solana/web3.js')
    return '0x' + Buffer.from(new PublicKey(position).toBytes()).toString('hex')
}
