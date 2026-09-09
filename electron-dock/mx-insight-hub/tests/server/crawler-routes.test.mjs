import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createApp } from '../../server/app.mjs'
import {
  CRAWLER_MAPPING_VERSION,
  CRAWLER_SOURCES,
  CRAWLER_SOURCE_COLUMNS,
} from '../../server/ingest/crawler/source-contract.mjs'
import {
  CRAWLER_WRITER_CONTRACT_DIGEST,
  CRAWLER_WRITER_CONTRACT_VERSION,
} from '../../server/ingest/crawler/pipeline.mjs'

const ADMIN_TOKEN = 'test-admin-token'
const SHARED_CONNECTION = Object.freeze({
  host: 'crawler.internal',
  port: 5432,
  database: 'agent_data_crawler_platform',
  username: 'mx_data',
  password: 'private-password',
  sslMode: 'require',
})

async function withServer(app, callback) {
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await callback(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function call(baseUrl, body) {
  const response = await fetch(`${baseUrl}/internal/v1/admin/pipelines/night-all-saved-records/status`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-mx-insight-admin-token': ADMIN_TOKEN,
    },
    body: JSON.stringify(body),
  })
  return { response, payload: await response.json() }
}

function validColumns() {
  const notNull = new Set([
    'id', 'source_type', 'connector_id', 'evidence', 'quality_status', 'record_type',
    'source_id', 'record_key', 'source_url', 'title', 'text', 'author', 'metrics',
    'media', 'attributes', 'first_seen_at', 'last_seen_at', 'created_at',
  ])
  const json = new Set(['evidence', 'author', 'metrics', 'media', 'attributes', 'raw'])
  const timestamp = new Set(['first_seen_at', 'last_seen_at', 'created_at'])
  const text = new Set(['source_url', 'text'])
  return CRAWLER_SOURCE_COLUMNS.map((name) => ({
    name,
    databaseType: name === 'id'
      ? 'int4'
      : timestamp.has(name)
        ? 'timestamptz'
        : json.has(name)
          ? 'jsonb'
          : text.has(name)
            ? 'text'
          : name === 'run_id'
            ? 'int4'
            : 'varchar',
    nullable: !notNull.has(name),
  }))
}

function routeFixture() {
  const sources = new Map(CRAWLER_SOURCES.map((spec) => [spec.sourceKey, {
    id: spec.sourceId,
    sourceKey: spec.sourceKey,
    displayName: spec.displayName,
    sourceKind: 'database',
    datasetId: spec.datasetId,
    platform: spec.platform,
    objectType: spec.objectType,
    status: 'paused',
    databaseConnectionId: null,
    connection: { ...SHARED_CONNECTION, ...spec.locator },
    syncIntervalSeconds: 300,
  }]))
  const mappings = new Map(CRAWLER_SOURCES.map((spec) => [spec.sourceKey, {
    id: spec.mappingId,
    sourceId: spec.sourceId,
    version: CRAWLER_MAPPING_VERSION,
    approvedAt: null,
  }]))
  const activeMappings = new Map()
  const calls = { updates: [], activations: [] }

  const store = {
    getExternalSource: async (sourceKey) => structuredClone(sources.get(sourceKey) ?? null),
    getActiveMapping: async (sourceId) => {
      const spec = CRAWLER_SOURCES.find((candidate) => candidate.sourceId === sourceId)
      return structuredClone(activeMappings.get(spec?.sourceKey) ?? null)
    },
    listSourceMappings: async (sourceId) => {
      const spec = CRAWLER_SOURCES.find((candidate) => candidate.sourceId === sourceId)
      return spec ? [structuredClone(mappings.get(spec.sourceKey))] : []
    },
    listImportRuns: async () => [],
    getLatestPipelineWriterContractAttestation: async () => null,
    updateExternalSourcesBatch: async (updates) => {
      calls.updates.push(structuredClone(updates))
      for (const update of updates) Object.assign(sources.get(update.sourceKey), update)
      return updates.map((update) => structuredClone(sources.get(update.sourceKey)))
    },
    activateExternalSourcesWithAttestation: async (input) => {
      calls.activations.push(structuredClone(input))
      for (const sourceKey of input.sourceKeys) {
        sources.get(sourceKey).status = 'active'
        activeMappings.set(sourceKey, {
          ...mappings.get(sourceKey),
          approvedAt: new Date().toISOString(),
        })
      }
    },
  }
  const queue = { getCursor: async () => null }
  const databasePuller = {
    withSourceLocks: async (_sourceKeys, operation) => operation(async () => {}, null),
    resolveConnectionCandidate: async ({ connection }) => ({
      databaseConnectionId: null,
      connection,
    }),
    describe: async (sourceKey) => {
      const spec = CRAWLER_SOURCES.find((candidate) => candidate.sourceKey === sourceKey)
      return {
        source: {
          sourceKey: spec.sourceKey,
          datasetId: spec.datasetId,
          platform: spec.platform,
          objectType: spec.objectType,
          schema: spec.locator.schema,
          table: spec.locator.table,
        },
        columns: validColumns(),
        issues: [],
        warnings: [],
      }
    },
    assertCheckpointCompatible: async () => {},
  }
  const app = createApp({
    service: {},
    store,
    queue,
    databasePuller,
    adapter: { dependencies: async () => ({ status: 'up' }) },
    adminToken: ADMIN_TOKEN,
    logger: { error() {} },
  })
  return { app, calls }
}

test('Night-All status route applies a sourceType selector and keeps activation attested', async () => {
  const fixture = routeFixture()
  await withServer(fixture.app, async (baseUrl) => {
    const missingAttestation = await call(baseUrl, { status: 'active', sourceType: 'news' })
    assert.equal(missingAttestation.response.status, 409)
    assert.equal(
      missingAttestation.payload.error.code,
      'writer_contract_attestation_required',
      JSON.stringify(missingAttestation.payload),
    )

    const activated = await call(baseUrl, {
      status: 'active',
      sourceType: 'news',
      writerContractAttestation: {
        confirmed: true,
        contractVersion: CRAWLER_WRITER_CONTRACT_VERSION,
        contractDigest: CRAWLER_WRITER_CONTRACT_DIGEST,
      },
    })
    assert.equal(activated.response.status, 200)
    assert.equal(activated.payload.data.status, 'mixed')
    assert.deepEqual(fixture.calls.activations.at(-1).sourceKeys, ['night-all-saved-records-news'])

    const paused = await call(baseUrl, { status: 'paused', sourceType: 'news' })
    assert.equal(paused.response.status, 200)
    assert.deepEqual(fixture.calls.updates.at(-1), [{
      sourceKey: 'night-all-saved-records-news',
      status: 'paused',
    }])
  })
})

test('Night-All status route rejects unsupported selectors and malformed sourceType values', async () => {
  const fixture = routeFixture()
  await withServer(fixture.app, async (baseUrl) => {
    const sourceKey = await call(baseUrl, {
      status: 'paused',
      sourceKey: 'night-all-saved-records-news',
    })
    assert.equal(sourceKey.response.status, 400)
    assert.equal(sourceKey.payload.error.code, 'unsupported_fields')

    for (const sourceType of [null, '', ' news', 'NEWS', 'unknown', ['news']]) {
      const result = await call(baseUrl, { status: 'paused', sourceType })
      assert.equal(result.response.status, 400, JSON.stringify(sourceType))
      assert.equal(result.payload.error.code, 'invalid_source_type', JSON.stringify(sourceType))
    }
  })
  assert.equal(fixture.calls.updates.length, 0)
  assert.equal(fixture.calls.activations.length, 0)
})
