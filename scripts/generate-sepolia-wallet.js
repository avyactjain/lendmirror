#!/usr/bin/env node
// Local Ethereum keypair. Same address on Sepolia and every other EVM chain.
// Prints once. Copy PRIVATE_KEY into .env. Do not commit it.
// This does not fund the wallet. You still need Sepolia ETH from a faucet.

const { Wallet } = require('ethers')

const wallet = Wallet.createRandom()

console.log('address:', wallet.address)
console.log('PRIVATE_KEY=' + wallet.privateKey)
