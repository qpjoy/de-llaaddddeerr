import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const sha = source => createHash('sha256').update(source).digest('hex')
const files = { parser: 'server/contracts/tikhub-content-search.mjs', adapter: 'server/adapters/tikhub.mjs',
  workflow: 'server/external-platforms/content-search-workflow.mjs', store: 'server/external-platforms/content-search-store.mjs',
  platformStore: 'server/external-platforms/store.mjs', diagnosticsSource: 'server/ops/verify-kuaishou-search-49814.mjs' }
const metadata = { implementation: 'bundled_local_candidate' }
for (const [name, path] of Object.entries(files)) metadata[`${name}Sha256`] = sha(await readFile(new URL(`../${path}`, import.meta.url)))
const result = await build({ entryPoints: [new URL('../server/ops/verify-kuaishou-search-49814.mjs', import.meta.url).pathname],
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22', external: ['pg'],
  define: { __KUAISHOU_VERIFICATION_BUILD__: JSON.stringify(metadata) },
  banner: { js: '// Exact retained Kuaishou receipt verification. READ ONLY; supplier transport replaced by original bytes.' } })
if (result.outputFiles.length !== 1) throw new Error('unexpected_bundle_output')
const source = result.outputFiles[0].text
if (Buffer.byteLength(source) > 8388608) throw new Error('bundle_too_large')
process.stderr.write(JSON.stringify({ verificationRevision: 'kuaishou-search-49814-verification.v1', ...metadata,
  bundleSha256: sha(source), bundleBytes: Buffer.byteLength(source) }) + '\n')
process.stdout.write(source)
