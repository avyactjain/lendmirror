#!/usr/bin/env node
/**
 * Loads DEPLOYMENT_TYPE from .env, then runs solana / forge / cast / anchor build
 * with the profile RPC, key, and program id.
 *
 * Usage:
 *   npx lm build
 *   npx lm solana program deploy ...
 *   npx lm forge create ...
 *   npx lm cast send ...
 */
require('dotenv').config()
require('ts-node').register({
    transpileOnly: true,
    compilerOptions: { module: 'commonjs', esModuleInterop: true },
})
require('./lm-cli.ts')
