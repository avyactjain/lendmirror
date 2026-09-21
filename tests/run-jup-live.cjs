process.env.TS_NODE_TRANSPILE_ONLY = 'true'
process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({
    module: 'commonjs',
    esModuleInterop: true,
    moduleResolution: 'node',
})
require('ts-node/register/transpile-only')
require('./live-position.sdk.test.ts')
