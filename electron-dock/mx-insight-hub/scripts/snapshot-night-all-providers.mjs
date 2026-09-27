// Offline source inventory. Never reads config.json, environment files or a database.
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const root = resolve(process.argv[2] || '')
if (!process.argv[2]) throw new Error('Usage: node scripts/snapshot-night-all-providers.mjs /path/to/Night-All')
const require = createRequire(`${root}/package.json`)
const base = 'lib/integrations/social-providers'
const t = require(`${root}/${base}/tikhub/index.js`)
const j = require(`${root}/${base}/justone/index.js`)
const param = (name, required = false) => ({ name, required })
const endpoints = t.loadCatalog().map(row => ({
  provider: 'tikhub', id: row.endpoint_id, platform: row.platform, method: row.method,
  path: row.path, parameters: row.params.map(p => ({ name: p.name, required: !!p.required })),
  capabilities: t.classify(row),
  forwarding: row.endpoint_id.includes('open_douyin_app') ? 'deferred' : 'implemented_disabled',
  evidence: [`${base}/tikhub/curated-search-endpoints.js`, `${base}/tikhub/static-endpoints.js`],
}))
for (const platform of j.supportedPlatforms()) {
  const config = j.platform(platform)
  for (const [capability, row] of Object.entries(config.endpoints || { search_posts: config.endpoint })) {
    let parameters
    if (row.path === '/api/search/v1') parameters = [param('keyword', true), param('start', true), param('end', true), param('nextCursor')]
    else if (platform === 'douyin') parameters = [param('keyword', true), ...['sortType', 'publishTime', 'duration', 'page', 'searchId'].map(n => param(n))]
    else if (platform === 'xianyu') parameters = [param('keyword', true), param('page')]
    else if (capability === 'user_profile') parameters = [param('url', true)]
    else if (capability === 'user_posts') parameters = [param('profileId', true), param('cursor')]
    else parameters = [param('keyword', true), param('startDate', true), param('endDate', true), param('cursor')]
    endpoints.push({ provider: 'justone', id: row.endpoint_id, platform, method: row.method, path: row.path,
      parameters, fixedQuery: row.path === '/api/search/v1' ? { source: config.source } : {},
      capabilities: [capability], forwarding: 'implemented_disabled', evidence: [`${base}/justone/platforms/${platform}.js`] })
  }
}
const files = [...new Set(endpoints.flatMap(e => e.evidence))].sort()
const evidence = await Promise.all(files.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(`${root}/${path}`)).digest('hex') })))
const snapshot = {
  version: 'night-all-source-snapshot.2026-09-26',
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dynamicCatalogs: ['data/tikhub/endpoints.json', 'data/tikhub/tiktok-endpoints.json'].map(path => ({ path, present: existsSync(`${root}/${path}`) })),
  scope: 'Source-defined endpoints only; not the production database or the complete supplier catalog. No credentials or live verification.',
  evidence, endpoints,
}
await writeFile(new URL('../server/data/night-all-provider-inventory.json', import.meta.url), `${JSON.stringify(snapshot, null, 2)}\n`)
console.log(`${endpoints.length} source-defined endpoints snapshotted; no provider requests`)
