import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  HIDDEN_PROVIDER_LABEL,
  sourceCatalogVisibleProjection,
} from '../../shared/source-catalog-visibility.mjs'

let pageBehaviorPromise

function pageBehavior() {
  pageBehaviorPromise ||= build({
    stdin: {
      contents: "export { sourceCatalogChangedFields } from './pages-source-catalog.jsx'",
      loader: 'js',
      resolveDir: fileURLToPath(new URL('../../src/', import.meta.url)),
    },
    bundle: true,
    define: { 'import.meta.env': '{}' },
    format: 'esm',
    jsx: 'automatic',
    platform: 'node',
    treeShaking: true,
    write: false,
  }).then(({ outputFiles }) => import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`))
  return pageBehaviorPromise
}

function catalogFormFixture() {
  return {
    canonicalName: '测试数据源',
    aliases: [],
    sourceKind: 'platform',
    majorCategory: '测试分类',
    scenarios: ['测试场景'],
    regions: ['中国大陆'],
    entryModules: [],
    monitorableContent: [],
    extractableClues: [],
    trackingFields: [],
    suggestedAccess: [],
    complianceBoundary: '',
    priority: 'P2',
    coverageStatus: 'covered',
    deliveryStatus: 'doing',
    reviewStatus: 'verified',
    runtimeStatus: 'healthy',
    ownerId: '',
    owner: '',
    connectorHints: ['tikhub'],
    notes: 'tikhub',
    tags: [],
    evidenceRefs: [],
    customFields: {},
  }
}

test('source-catalog UI projection removes provider identity from table, search, CSV and edit inputs', async () => {
  const rawForm = catalogFormFixture()
  const rawSnapshot = {
    items: [rawForm],
    facets: { connectorHints: ['tikhub'] },
    nested: { provider: 'tikhub' },
  }
  const visible = sourceCatalogVisibleProjection(rawSnapshot)

  assert.equal(/tikhub/iu.test(JSON.stringify(visible)), false)
  assert.deepEqual(visible.items[0].connectorHints, [HIDDEN_PROVIDER_LABEL])
  assert.equal(visible.items[0].notes, HIDDEN_PROVIDER_LABEL)
  assert.equal(rawSnapshot.items[0].notes, 'tikhub', 'projection must not mutate stored/admin lineage')

  const { sourceCatalogChangedFields } = await pageBehavior()
  const patch = sourceCatalogChangedFields(visible.items[0], {
    ...visible.items[0],
    priority: 'P1',
  })
  assert.deepEqual(patch, { priority: 'P1' })
  assert.equal(Object.hasOwn(patch, 'connectorHints'), false)
  assert.equal(Object.hasOwn(patch, 'notes'), false)
})

test('source-catalog browser client requests server safety projection and keeps a client fallback', async () => {
  const apiSource = await readFile(new URL('../../src/api.js', import.meta.url), 'utf8')
  const sourceCatalogMethod = apiSource.match(/sourceCatalog: \(token,[\s\S]*?\n  \)\),/u)?.[0] || ''

  assert.match(sourceCatalogMethod, /presentation: 'safe'/u)
  assert.match(sourceCatalogMethod, /visibleSourceCatalogResponse\(request\(/u)
})
