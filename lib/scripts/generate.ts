import * as fs from 'fs'
import * as path from 'path'

import { Idl } from '@coral-xyz/anchor'
import { AnchorIdl, rootNodeFromAnchor } from '@kinobi-so/nodes-from-anchor'
import { renderVisitor } from '@kinobi-so/renderers-js-umi'
import { createFromRoot } from 'kinobi'

async function generateTypeScriptSDK(): Promise<void> {
    const generatedSDKDir = path.join(__dirname, '..', 'client', 'generated', 'lendmirror')
    const anchorIdlPath = path.join(__dirname, '..', '..', 'target', 'idl', 'lendmirror.json')
    const anchorIdl = JSON.parse(fs.readFileSync(anchorIdlPath, 'utf8')) as Idl
    anchorIdl.address = '' // Kinobi cannot resolve the env-based declare_id. Program id is passed at runtime.
    // This is also acceptable as the client SDK requires the program ID to be provided at runtime.
    console.error('Generating TypeScript SDK to %s. IDL from %s', generatedSDKDir, anchorIdlPath)
    const kinobi = createFromRoot(rootNodeFromAnchor(anchorIdl as AnchorIdl))
    void kinobi.accept(
        renderVisitor(generatedSDKDir, {
            prettierOptions: {
                semi: false,
                singleQuote: true,
                tabWidth: 4,
                printWidth: 120,
                trailingComma: 'es5',
            },
        })
    )
}

;(async (): Promise<void> => {
    await generateTypeScriptSDK()
})().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
})
