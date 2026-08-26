import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import test from 'node:test'
import { createApp } from '../../server/app.mjs'
import { applyMapping } from '../../server/ingest/external/mapping.mjs'
import { scheduleActiveDatabaseSources } from '../../server/ingest/external/scheduler.mjs'
import { ExternalSourcePuller } from '../../server/ingest/external/source-puller.mjs'
import { runExternalPullJob } from '../../server/ingest/external/sync-job.mjs'
import {
  PROVINCE_OPINION_INPUT,
  PROVINCE_OPINION_PIPELINE_KEY,
  PROVINCE_OPINION_WRITER_CONTRACT_DIGEST,
  PROVINCE_OPINION_WRITER_CONTRACT_VERSION,
  ProvinceOpinionPipeline,
  provinceOpinionSchedulingStatus,
} from '../../server/ingest/province/monitor-pipeline.mjs'

const SOURCE_ID = '11111111-1111-4111-8111-111111111111'
const FIRST_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_ID = '22222222-2222-4222-8222-222222222222'
const ADMIN_TOKEN = 'province-opinion-admin-token'
const HANLP_CONFIG = Object.freeze({
  backend: 'hanlp',
  hanlpUrl: 'http://mx-common-hanlp.mx-common.svc.cluster.local:8000',
})

async function withServer(app, run) {
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function call(baseUrl, path, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { response, payload: await response.json() }
}

function fixture({ segmenterConfig = HANLP_CONFIG } = {}) {
  const source = {
    id: SOURCE_ID,
    sourceKey: PROVINCE_OPINION_INPUT.sourceKey,
    displayName: '全国省份舆情结果',
    sourceKind: 'database',
    datasetId: 'public-opinion.province.v1',
    platform: 'public_opinion',
    objectType: 'opinion_item',
    status: 'paused',
    connection: {
      schema: PROVINCE_OPINION_INPUT.schema,
      table: PROVINCE_OPINION_INPUT.table,
      cursorColumn: PROVINCE_OPINION_INPUT.cursorColumn,
      idColumn: PROVINCE_OPINION_INPUT.idColumn,
    },
    syncIntervalSeconds: 300,
  }
  const mapping = {
    id: PROVINCE_OPINION_INPUT.builtInMappingId,
    sourceId: SOURCE_ID,
    version: PROVINCE_OPINION_INPUT.builtInMappingVersion,
    fieldMap: { externalId: { from: 'id' } },
    approvedAt: null,
  }
  let activeMapping = null
  let attestation = null
  let servingIndexesReady = true
  const store = {
    getExternalSource: async () => structuredClone(source),
    listSourceMappings: async () => [structuredClone(mapping)],
    getActiveMapping: async () => structuredClone(activeMapping),
    listImportRuns: async () => [],
    getLatestPipelineWriterContractAttestation: async () => structuredClone(attestation),
    getPublicOpinionServingIndexStatus: async () => ({
      ready: servingIndexesReady,
      required: [
        'canonical_province_opinion_hot_idx',
        'canonical_province_opinion_latest_idx',
      ],
      indexes: [
        { name: 'canonical_province_opinion_hot_idx', ready: servingIndexesReady },
        { name: 'canonical_province_opinion_latest_idx', ready: servingIndexesReady },
      ],
      missing: servingIndexesReady ? [] : [
        'canonical_province_opinion_hot_idx',
        'canonical_province_opinion_latest_idx',
      ],
    }),
    getPublicOpinionQualitySummary: async () => ({
      contractVersion: 'mx-insight-hub.public-opinion.quality-summary.v1',
      canonical: { total: 5_189, active: 5_189, deleted: 0 },
      publication: { stages: { formal: 5_189, candidate: 0 } },
    }),
    updateExternalSourcesBatch: async (updates) => {
      Object.assign(source, updates[0])
      if (updates[0].connection) source.connection = structuredClone(updates[0].connection)
      return [structuredClone(source)]
    },
    activateExternalSourcesWithAttestation: async (input) => {
      source.status = 'active'
      activeMapping = { ...mapping, approvedAt: new Date().toISOString(), approvedBy: input.attestedBy }
      attestation = {
        contractVersion: input.contractVersion,
        contractDigest: input.contractDigest,
        contractSummary: input.contractSummary,
        attestedBy: input.attestedBy,
        attestedAt: new Date().toISOString(),
      }
      return { sources: [structuredClone(source)], attestation: structuredClone(attestation) }
    },
    listExternalSources: async () => [structuredClone(source)],
  }
  let cursor = null
  const savedCursors = []
  const queue = {
    getCursor: async () => structuredClone(cursor),
    saveCursor: async (_id, position, patch) => {
      cursor = {
        id: `external:${PROVINCE_OPINION_INPUT.sourceKey}`,
        position: structuredClone(position),
        status: patch.status,
        error: patch.error,
        updatedAt: new Date().toISOString(),
      }
      savedCursors.push(structuredClone(cursor))
      return structuredClone(cursor)
    },
  }
  const calls = { testConnection: [], describe: [], compatible: [] }
  let description = { issues: ['cursor column updated_at is missing'], warnings: [] }
  const databasePuller = {
    withSourceLock: async (_key, operation) => operation(async () => {}, null),
    testConnection: async (connection) => calls.testConnection.push(structuredClone(connection)),
    describe: async (key, options) => {
      calls.describe.push({ key, options })
      return structuredClone(description)
    },
    assertCheckpointCompatible: async (key, options) => {
      calls.compatible.push({ key, options })
      return { compatible: true }
    },
    progress: async () => ({ totalRows: 0, completedRows: null, remainingRows: null, percent: null }),
    resetCheckpoints: async () => [],
  }
  return {
    source,
    mapping,
    store,
    queue,
    databasePuller,
    calls,
    savedCursors,
    pipeline: new ProvinceOpinionPipeline({ store, queue, databasePuller, segmenterConfig }),
    setCursor(value) { cursor = structuredClone(value) },
    setDescription(value) { description = structuredClone(value) },
    setServingIndexesReady(value) { servingIndexesReady = value },
    setAttestation(value) { attestation = structuredClone(value) },
    getAttestation() { return structuredClone(attestation) },
  }
}

const ATTESTATION = Object.freeze({
  confirmed: true,
  contractVersion: PROVINCE_OPINION_WRITER_CONTRACT_VERSION,
  contractDigest: PROVINCE_OPINION_WRITER_CONTRACT_DIGEST,
})

test('province scheduling reports gates and a materially overdue idle cursor', () => {
  const source = {
    status: 'active',
    syncIntervalSeconds: 300,
  }
  const writerAttestation = {
    contractVersion: PROVINCE_OPINION_WRITER_CONTRACT_VERSION,
    contractDigest: PROVINCE_OPINION_WRITER_CONTRACT_DIGEST,
  }
  const blocked = provinceOpinionSchedulingStatus({
    source,
    cursor: null,
    writerAttestation: null,
    now: new Date('2026-08-26T04:00:00.000Z'),
  })
  assert.equal(blocked.status, 'blocked')
  assert.match(blocked.message, /writer/)

  const scheduled = provinceOpinionSchedulingStatus({
    source,
    cursor: { status: 'idle', updatedAt: '2026-08-26T03:58:00.000Z' },
    writerAttestation,
    now: new Date('2026-08-26T04:00:00.000Z'),
  })
  assert.equal(scheduled.status, 'scheduled')
  assert.equal(scheduled.dueAt, '2026-08-26T04:03:00.000Z')

  const overdue = provinceOpinionSchedulingStatus({
    source,
    cursor: { status: 'idle', updatedAt: '2026-08-26T03:00:00.000Z' },
    writerAttestation,
    now: new Date('2026-08-26T04:00:00.000Z'),
  })
  assert.equal(overdue.status, 'overdue')
  assert.equal(overdue.dueAt, '2026-08-26T03:05:00.000Z')
  assert.equal(overdue.overdueBySeconds, 3_300)
  assert.match(overdue.message, /mx-insight-hub-ingest/)
})

function validDescription(overrides = {}) {
  const columns = [
    ['id', 'text'],
    ['title', 'text'],
    ['summary', 'text'],
    ['link', 'text'],
    ['source_name', 'text'],
    ['source_type', 'text'],
    ['platform', 'text'],
    ['published_at', 'timestamptz'],
    ['province', 'text'],
    ['heat_score', 'numeric'],
    ['updated_at', 'timestamptz'],
    ['source_stage', 'text'],
  ].map(([name, databaseType]) => ({ name, databaseType, nullable: false }))
  return {
    issues: [],
    warnings: [],
    columns,
    constraints: [
      {
        type: 'c',
        validated: true,
        expression: 'isfinite(updated_at)',
        definition: 'CHECK (isfinite(updated_at))',
      },
      {
        type: 'c',
        validated: true,
        expression: "(source_stage = ANY (ARRAY['formal'::text, 'candidate'::text]))",
        definition: "CHECK ((source_stage = ANY (ARRAY['formal'::text, 'candidate'::text])))",
      },
    ],
    ...overrides,
  }
}

test('migration installs only a paused, unconfigured and ungranted source contract', async () => {
  const sql = await readFile(
    new URL('../../migrations/033_province_opinion_source.sql', import.meta.url),
    'utf8',
  )
  assert.match(sql, /'province-opinion-results'/)
  assert.match(sql, /'paused'/)
  assert.match(sql, /"cursorColumn":"updated_at"/)
  assert.doesNotMatch(sql, /^\s*CREATE\s+INDEX/im)
  assert.match(sql, /scripts\/province-opinion-serving-indexes\.sql/)
  assert.match(sql, /"eventTime":\{"from":"published_at"/)
  assert.match(sql, /reserved source key province-opinion-results already exists/)
  assert.match(sql, /rename it before installing the fixed pipeline/)
  assert.doesNotMatch(sql, /ON CONFLICT \(source_key\) DO NOTHING/)
  assert.doesNotMatch(sql, /ON CONFLICT \(source_id, version\) DO NOTHING/)
  assert.doesNotMatch(sql, /"host"|"database"|"username"|"password"/)
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+(?:catalog\.)?platform_grants/is)

  const servingSql = await readFile(
    new URL('../../scripts/province-opinion-serving-indexes.sql', import.meta.url),
    'utf8',
  )
  assert.match(servingSql, /CREATE INDEX CONCURRENTLY canonical_province_opinion_hot_idx/)
  assert.match(servingSql, /CREATE INDEX CONCURRENTLY canonical_province_opinion_latest_idx/)
  assert.doesNotMatch(servingSql, /^\s*(?:BEGIN|COMMIT)\s*;/im)
})

test('province pipeline starts paused/unconfigured and keeps table, cursor and id fixed', async () => {
  const setup = fixture()
  const initial = await setup.pipeline.get()
  assert.equal(initial.status, 'paused')
  assert.equal(initial.configured, false)
  assert.equal(initial.writerContract.version, 'province-opinion.writer.v2')
  assert.match(initial.writerContract.summary.publicationStage, /source_stage=formal\|candidate/)
  assert.deepEqual(initial.fixedInput, {
    schema: 'public',
    table: 'monitor_strategy_results',
    cursorColumn: 'updated_at',
    idColumn: 'id',
  })
  await assert.rejects(
    () => setup.pipeline.configure({ connection: { table: 'other_table' } }),
    (error) => error.code === 'unsupported_pipeline_connection_fields',
  )

  const configured = await setup.pipeline.configure({
    connection: {
      host: 'night-all.internal',
      port: 5432,
      database: 'night_all',
      username: 'mx_data',
      password: 'private',
      sslMode: 'require',
    },
    syncIntervalSeconds: 600,
  })
  assert.equal(configured.configured, true)
  assert.equal(configured.syncIntervalSeconds, 600)
  assert.equal(setup.calls.testConnection.length, 1)
  assert.equal(setup.calls.testConnection[0].table, 'monitor_strategy_results')
  assert.equal(setup.calls.testConnection[0].cursorColumn, 'updated_at')
})

test('activation fails closed without updated_at/index and requires exact writer attestation', async () => {
  const setup = fixture()
  await setup.pipeline.configure({
    connection: {
      host: 'night-all.internal', database: 'night_all', username: 'mx_data',
      password: 'private', sslMode: 'require',
    },
  })
  await assert.rejects(
    () => setup.pipeline.setStatus('active', { writerContractAttestation: ATTESTATION }),
    (error) => error.code === 'source_probe_failed'
      && error.details.issues.includes('cursor column updated_at is missing'),
  )

  setup.setDescription(validDescription({
    columns: validDescription().columns.map((column) => (
      column.name === 'updated_at' ? { ...column, databaseType: 'date' } : column
    )),
  }))
  await assert.rejects(
    () => setup.pipeline.setStatus('active', { writerContractAttestation: ATTESTATION }),
    (error) => error.code === 'source_probe_failed'
      && error.details.issues.some((issue) => issue.includes('date cannot observe multiple same-day revisions')),
  )

  setup.setDescription(validDescription({
    constraints: [{
      type: 'c',
      validated: false,
      expression: 'isfinite(updated_at)',
      definition: 'CHECK (isfinite(updated_at)) NOT VALID',
    }],
  }))
  await assert.rejects(
    () => setup.pipeline.setStatus('active', { writerContractAttestation: ATTESTATION }),
    (error) => error.code === 'source_probe_failed'
      && error.details.issues.includes('updated_at requires a CHECK (isfinite(updated_at)) constraint'),
  )

  setup.setDescription(validDescription({
    columns: validDescription().columns.filter((column) => column.name !== 'source_stage'),
  }))
  await assert.rejects(
    () => setup.pipeline.setStatus('active', { writerContractAttestation: ATTESTATION }),
    (error) => error.code === 'source_probe_failed'
      && error.details.issues.includes('required province opinion column source_stage is missing'),
  )

  setup.setDescription(validDescription({
    columns: validDescription().columns.map((column) => (
      column.name === 'source_stage' ? { ...column, nullable: true } : column
    )),
  }))
  await assert.rejects(
    () => setup.pipeline.setStatus('active', { writerContractAttestation: ATTESTATION }),
    (error) => error.code === 'source_probe_failed'
      && error.details.issues.includes('source_stage column must be non-null'),
  )

  setup.setDescription(validDescription({
    constraints: [
      validDescription().constraints[0],
      {
        type: 'c',
        validated: true,
        expression: "(source_stage = ANY (ARRAY['formal'::text, 'candidate'::text, 'unknown'::text]))",
      },
    ],
  }))
  await assert.rejects(
    () => setup.pipeline.setStatus('active', { writerContractAttestation: ATTESTATION }),
    (error) => error.code === 'source_probe_failed'
      && error.details.issues.includes(
        "source_stage requires a validated CHECK allowing only 'formal' and 'candidate'",
      ),
  )

  setup.setDescription(validDescription({
    constraints: validDescription().constraints.map((constraint) => (
      constraint.expression.includes('source_stage')
        ? { ...constraint, validated: false }
        : constraint
    )),
  }))
  await assert.rejects(
    () => setup.pipeline.setStatus('active', { writerContractAttestation: ATTESTATION }),
    (error) => error.code === 'source_probe_failed'
      && error.details.issues.includes(
        "source_stage requires a validated CHECK allowing only 'formal' and 'candidate'",
      ),
  )

  setup.setDescription(validDescription())
  await assert.rejects(
    () => setup.pipeline.setStatus('active'),
    (error) => error.code === 'writer_contract_attestation_required',
  )
  const active = await setup.pipeline.setStatus('active', {
    approvedBy: 'operator-1',
    writerContractAttestation: ATTESTATION,
  })
  assert.equal(active.status, 'active')
  assert.equal(active.task.activeMapping.version, 1)
  assert.equal(setup.getAttestation().contractDigest, PROVINCE_OPINION_WRITER_CONTRACT_DIGEST)
})

test('an active province pipeline can re-confirm the current writer contract without pausing', async () => {
  const setup = fixture()
  await setup.pipeline.configure({
    connection: {
      host: 'night-all.internal', database: 'night_all', username: 'mx_data',
      password: 'private', sslMode: 'require',
    },
  })
  setup.setDescription(validDescription())
  await setup.pipeline.setStatus('active', {
    approvedBy: 'operator-1',
    writerContractAttestation: ATTESTATION,
  })
  setup.setAttestation({
    contractVersion: 'province-opinion.writer.v1',
    contractDigest: '0'.repeat(64),
    attestedBy: 'operator-old',
    attestedAt: '2026-08-24T14:16:00.000Z',
  })

  const stale = await setup.pipeline.get()
  assert.equal(stale.status, 'active')
  assert.equal(stale.task.scheduling.status, 'blocked')
  assert.match(stale.task.scheduling.message, /writer/)

  const refreshed = await setup.pipeline.setStatus('active', {
    approvedBy: 'operator-2',
    writerContractAttestation: ATTESTATION,
  })
  assert.equal(refreshed.status, 'active')
  assert.equal(refreshed.writerContract.latestAttestation.attestedBy, 'operator-2')
  assert.equal(
    refreshed.writerContract.latestAttestation.contractDigest,
    PROVINCE_OPINION_WRITER_CONTRACT_DIGEST,
  )
  assert.notEqual(refreshed.task.scheduling.status, 'blocked')
})

test('province activation and scheduling fail closed without explicit HanLP configuration', async () => {
  const setup = fixture({ segmenterConfig: { backend: 'jieba', hanlpUrl: null } })
  setup.setDescription(validDescription())
  await setup.pipeline.configure({
    connection: {
      host: 'night-all.internal', database: 'night_all', username: 'mx_data', password: 'private',
    },
  })

  const status = await setup.pipeline.get()
  assert.equal(status.indexing.requiredBackend, 'hanlp')
  assert.equal(status.indexing.readyToSchedule, false)
  assert.ok(status.configurationIssues.some((issue) => issue.includes('MX_COMMON_SEGMENTER=hanlp')))
  await assert.rejects(
    () => setup.pipeline.setStatus('active', { writerContractAttestation: ATTESTATION }),
    (error) => error?.code === 'province_hanlp_required',
  )
})

test('activation and Admin state fail closed until both Hub serving indexes are valid', async () => {
  const setup = fixture()
  await setup.pipeline.configure({
    connection: {
      host: 'night-all.internal', database: 'night_all', username: 'mx_data',
      password: 'private', sslMode: 'require',
    },
  })
  setup.setDescription(validDescription())
  setup.setServingIndexesReady(false)

  const state = await setup.pipeline.get()
  assert.equal(state.servingIndexes.ready, false)
  assert.match(state.configurationIssues[0], /canonical_province_opinion_hot_idx/)
  await assert.rejects(
    () => setup.pipeline.setStatus('active', { writerContractAttestation: ATTESTATION }),
    (error) => error.code === 'serving_indexes_required'
      && error.details.servingIndexes.missing.length === 2,
  )
  assert.equal(setup.source.status, 'paused')
})

test('activation rejects a fixed source whose canonical corpus identity has drifted', async () => {
  const setup = fixture()
  setup.source.datasetId = 'wrong-dataset'
  setup.source.connection = {
    host: 'night-all.internal', database: 'night_all', username: 'mx_data', password: 'private',
    schema: 'public', table: 'monitor_strategy_results', cursorColumn: 'updated_at', idColumn: 'id',
  }
  const state = await setup.pipeline.get()
  assert.equal(state.configured, false)
  assert.ok(state.configurationIssues.some((issue) => issue.includes('datasetId')))
  await assert.rejects(
    () => setup.pipeline.setStatus('active', { writerContractAttestation: ATTESTATION }),
    (error) => error.code === 'pipeline_source_contract_drift'
      && error.details.issues.includes('Fixed source datasetId must be public-opinion.province.v1'),
  )
  assert.equal(setup.calls.describe.length, 0)
})

test('Admin progress exposes the same province-specific source gate as activation', async () => {
  const setup = fixture()
  setup.setDescription(validDescription({ constraints: [] }))
  const blocked = await setup.pipeline.progress()
  assert.equal(blocked.blocker, 'source_contract_unsafe')
  assert.ok(blocked.issues.includes('updated_at requires a CHECK (isfinite(updated_at)) constraint'))

  setup.setDescription(validDescription())
  const ready = await setup.pipeline.progress()
  assert.equal(ready.blocker, null)
  assert.deepEqual(ready.issues, [])
})

test('failed task recovery preserves the durable checkpoint and logical import run', async () => {
  const setup = fixture()
  const position = {
    contractHash: 'a'.repeat(64),
    mappingVersion: 1,
    cursor: '2026-08-23T00:00:00.000Z',
    lastId: FIRST_ID,
    importRunId: SECOND_ID,
  }
  setup.setCursor({ status: 'failed', error: 'source_pull_failed', position })
  const result = await setup.pipeline.resumeFailedTask()
  assert.equal(result.task.resumed, true)
  assert.equal(result.task.from, 'failed')
  assert.deepEqual(setup.savedCursors[0].position, position)
  assert.equal(setup.savedCursors[0].status, 'idle')
})

test('province mapping promotes stable province code and numeric heat while keeping unknown province unclassified', () => {
  const fieldMap = {
    externalId: { from: 'id' },
    title: { from: 'title' },
    body: { from: 'summary' },
    admin1Code: { from: 'province', type: 'province_code' },
    'attributes.province': { from: 'province' },
    'attributes.sourcePlatform': { from: 'platform' },
    'metrics.heatScore': { from: 'heat_score', type: 'number' },
    _drop: { from: ['raw', 'llm_reason'] },
  }
  const known = applyMapping({
    id: 'item-1', title: '标题', summary: '摘要', province: '江苏省',
    platform: 'douyin', heat_score: '91.25', raw: { private: true }, llm_reason: 'private',
  }, fieldMap, { platform: 'public_opinion', objectType: 'opinion_item' }).record
  assert.equal(known.admin1Code, 'CN-JS')
  assert.equal(known.stableFields.attributes.province, '江苏省')
  assert.equal(known.heatScore, 91.25)
  assert.equal(known.extensions.raw, undefined)
  assert.equal(known.rawItem.raw.private, true)

  const unknown = applyMapping({
    id: 'item-2', title: '标题', summary: '摘要', province: '待分析',
    platform: 'douyin', heat_score: 1,
  }, fieldMap, { platform: 'public_opinion', objectType: 'opinion_item' }).record
  assert.equal(unknown.admin1Code, null)
  assert.equal(unknown.stableFields.attributes.province, '待分析')
})

test('province raw identity ignores transport/run coordinates but keeps semantic stage changes', () => {
  const fieldMap = {
    externalId: { from: 'id' },
    title: { from: 'title' },
    eventTime: { from: 'published_at', type: 'timestamp' },
    _drop: { from: ['updated_at'] },
  }
  const options = {
    platform: 'public_opinion',
    objectType: 'opinion_item',
    source: { origin: 'database', sourceKey: 'province-opinion-results' },
  }
  const first = applyMapping({
    id: 'item-1', title: '同一正文',
    run_id: 'run-1',
    heat_metrics: {
      provinceRecallRetrievedAt: '2026-08-24T10:00:00.000Z',
      sourceEnvelope: { stage: 'candidate', disposition: 'normalized', agentRunId: 'agent-1' },
    },
    raw: {
      politicalTerrorProvinceRecallRetrievedAt: '2026-08-24T10:00:00.000Z',
      politicalTerrorSourceEnvelope: { stage: 'candidate', disposition: 'normalized', agentRunId: 'agent-1' },
    },
    published_at: new Date('2026-08-24T09:00:00.000Z'),
    updated_at: new Date('2026-08-24T10:00:00.000Z'),
  }, fieldMap, options).record
  const replay = applyMapping({
    id: 'item-1', title: '同一正文',
    run_id: 'run-2',
    heat_metrics: {
      provinceRecallRetrievedAt: '2026-08-24T10:05:00.000Z',
      sourceEnvelope: { stage: 'candidate', disposition: 'normalized', agentRunId: 'agent-2' },
    },
    raw: {
      politicalTerrorProvinceRecallRetrievedAt: '2026-08-24T10:05:00.000Z',
      politicalTerrorSourceEnvelope: { stage: 'candidate', disposition: 'normalized', agentRunId: 'agent-2' },
    },
    published_at: new Date('2026-08-24T09:00:00.000Z'),
    updated_at: new Date('2026-08-24T10:05:00.000Z'),
  }, fieldMap, options).record
  const changed = applyMapping({
    id: 'item-1', title: '正文已修改',
    published_at: new Date('2026-08-24T09:00:00.000Z'),
    updated_at: new Date('2026-08-24T10:05:00.000Z'),
  }, fieldMap, options).record
  const rescheduled = applyMapping({
    id: 'item-1', title: '同一正文',
    published_at: new Date('2026-08-24T09:30:00.000Z'),
    updated_at: new Date('2026-08-24T10:05:00.000Z'),
  }, fieldMap, options).record
  const candidate = applyMapping({
    id: 'item-1', title: '同一正文', source_stage: 'candidate',
    published_at: new Date('2026-08-24T09:00:00.000Z'),
    updated_at: new Date('2026-08-24T10:05:00.000Z'),
  }, fieldMap, options).record

  assert.notEqual(first.rawItem.updated_at, replay.rawItem.updated_at)
  assert.equal(first.rawPayloadSha256, replay.rawPayloadSha256)
  assert.notEqual(first.rawPayloadSha256, changed.rawPayloadSha256)
  assert.notEqual(first.rawPayloadSha256, rescheduled.rawPayloadSha256)
  assert.notEqual(first.rawPayloadSha256, candidate.rawPayloadSha256)
  assert.equal(candidate.rawItem.source_stage, 'candidate')
  assert.notEqual(first.payloadSha256, rescheduled.payloadSha256)
})

test('fixed province source is scheduled once only after current writer attestation', async () => {
  const setup = fixture()
  setup.setDescription(validDescription())
  setup.source.status = 'active'
  setup.source.connection = {
    host: 'night-all.internal', database: 'night_all', username: 'mx_data', password: 'private',
    schema: 'public', table: 'monitor_strategy_results', cursorColumn: 'updated_at', idColumn: 'id',
  }
  setup.store.getLatestPipelineWriterContractAttestation = async () => ({
    contractVersion: PROVINCE_OPINION_WRITER_CONTRACT_VERSION,
    contractDigest: PROVINCE_OPINION_WRITER_CONTRACT_DIGEST,
  })
  const jobs = []
  const client = {
    query: async () => ({ rows: [] }),
    release() {},
  }
  const queue = {
    pool: { connect: async () => client },
    getCursor: async () => null,
    enqueue: async (name, payload, options) => {
      jobs.push({ name, payload, options })
      return 'job-1'
    },
  }
  const result = await scheduleActiveDatabaseSources({
    store: setup.store,
    queue,
    databasePuller: setup.databasePuller,
    segmenterConfig: HANLP_CONFIG,
    now: new Date(),
  })
  assert.equal(result.active, 1)
  assert.equal(result.enqueued, 1)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].payload.sourceKey, PROVINCE_OPINION_INPUT.sourceKey)
  assert.equal(jobs[0].payload.trigger, 'schedule')
  assert.equal(jobs[0].payload.batchSize, 200)
  assert.equal(PROVINCE_OPINION_PIPELINE_KEY, 'province-opinion')

  setup.source.datasetId = 'wrong-dataset'
  const drifted = await scheduleActiveDatabaseSources({
    store: setup.store,
    queue,
    databasePuller: setup.databasePuller,
    segmenterConfig: HANLP_CONFIG,
    now: new Date(),
  })
  assert.equal(drifted.enqueued, 0)
  assert.equal(jobs.length, 1)
})

test('first worker chunk persists source-contract drift before reading any source rows', async () => {
  let pullCalled = false
  let marked = null
  const contractError = new Error('private upstream detail')
  contractError.code = 'source_contract_mismatch'
  const result = await runExternalPullJob({
    puller: {
      assertReadyForPull: async () => { throw contractError },
      pullBatch: async () => { pullCalled = true },
      markSourceContractFailed: async (sourceKey, code) => { marked = { sourceKey, code } },
    },
    queue: { heartbeat: async () => {} },
    payload: { sourceKey: PROVINCE_OPINION_INPUT.sourceKey, chunk: 0 },
    job: { id: 'job-1', attempts: 1, max_attempts: 3 },
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    logger: { warn() {} },
  })
  assert.equal(pullCalled, false)
  assert.deepEqual(marked, {
    sourceKey: PROVINCE_OPINION_INPUT.sourceKey,
    code: 'source_contract_mismatch',
  })
  assert.equal(result.failed, true)
  assert.equal(result.error, 'source_contract_mismatch')
})

test('worker preflight re-probes the full province contract at each new logical run', async () => {
  const setup = fixture()
  const puller = new ExternalSourcePuller({
    store: setup.store,
    queue: setup.queue,
    databasePuller: setup.databasePuller,
    sqliteApiPuller: {},
  })
  setup.setDescription(validDescription({ constraints: [] }))
  await assert.rejects(
    () => puller.assertReadyForPull(PROVINCE_OPINION_INPUT.sourceKey),
    (error) => error.code === 'source_contract_mismatch',
  )
  setup.setDescription(validDescription())
  assert.deepEqual(
    await puller.assertReadyForPull(PROVINCE_OPINION_INPUT.sourceKey),
    { ready: true },
  )
})

test('province pipeline routes are Admin-only and the fixed source rejects generic mutation', async () => {
  const setup = fixture()
  const app = createApp({
    service: {},
    store: setup.store,
    queue: setup.queue,
    databasePuller: setup.databasePuller,
    segmenterConfig: HANLP_CONFIG,
    adapter: { dependencies: async () => ({ status: 'up' }) },
    adminToken: ADMIN_TOKEN,
    logger: { error() {} },
  })
  await withServer(app, async (baseUrl) => {
    const denied = await call(baseUrl, '/internal/v1/admin/pipelines/province-opinion', {
      headers: { 'x-api-key': 'mih_live_not_admin' },
    })
    assert.equal(denied.response.status, 403)
    assert.equal(denied.payload.error.code, 'admin_token_required')

    const deniedQuality = await call(
      baseUrl,
      '/internal/v1/admin/pipelines/province-opinion/quality-summary',
      { headers: { 'x-api-key': 'mih_live_not_admin' } },
    )
    assert.equal(deniedQuality.response.status, 403)
    assert.equal(deniedQuality.payload.error.code, 'admin_token_required')

    const headers = { 'x-mx-insight-admin-token': ADMIN_TOKEN }
    const aggregate = await call(baseUrl, '/internal/v1/admin/pipelines/province-opinion', { headers })
    assert.equal(aggregate.response.status, 200)
    assert.equal(aggregate.payload.data.status, 'paused')
    assert.equal(aggregate.payload.data.configured, false)

    const quality = await call(
      baseUrl,
      '/internal/v1/admin/pipelines/province-opinion/quality-summary',
      { headers },
    )
    assert.equal(quality.response.status, 200)
    assert.equal(quality.payload.data.pipelineKey, PROVINCE_OPINION_PIPELINE_KEY)
    assert.equal(quality.payload.data.canonical.total, 5_189)
    assert.equal(
      quality.payload.data.contractVersion,
      'mx-insight-hub.public-opinion.quality-summary.v1',
    )

    const genericMutation = await call(
      baseUrl,
      '/internal/v1/admin/sources/province-opinion-results',
      { method: 'PUT', headers, body: { status: 'active' } },
    )
    assert.equal(genericMutation.response.status, 409)
    assert.equal(genericMutation.payload.error.code, 'pipeline_managed_source')

    const sync = await call(baseUrl, '/internal/v1/admin/pipelines/province-opinion/sync', {
      method: 'POST', headers, body: {},
    })
    assert.equal(sync.response.status, 409)
    assert.equal(sync.payload.error.code, 'pipeline_paused')
  })
})
