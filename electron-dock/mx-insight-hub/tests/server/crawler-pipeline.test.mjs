import { scheduleActiveDatabaseSources } from '../../server/ingest/external/scheduler.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSourcePuller } from '../../server/ingest/external/database-source.mjs'
import {
  CRAWLER_MAPPING_VERSION,
  CRAWLER_PIPELINE_KEY,
  CRAWLER_SOURCES,
  CRAWLER_OPTIONAL_SOURCE_COLUMN_CONTRACT,
  CRAWLER_SOURCE_COLUMN_CONTRACT,
  CRAWLER_FIELD_MAP,
  crawlerSourceSpec,
  crawlerWriterContractForSpec,
} from '../../server/ingest/crawler/source-contract.mjs'
import {
  CRAWLER_WRITER_CONTRACT_DIGEST,
  CRAWLER_WRITER_CONTRACT_VERSION,
  CrawlerSavedRecordsPipeline,
} from '../../server/ingest/crawler/pipeline.mjs'

const PROFILE_ID = '11111111-1111-4111-8111-111111111111'
const SHARED_CONNECTION = Object.freeze({
  host: 'crawler.internal',
  port: 5432,
  database: 'agent_data_crawler_platform',
  username: 'mx_data',
  password: 'private-password',
  sslMode: 'require',
})

function validColumns() {
  return CRAWLER_SOURCE_COLUMN_CONTRACT.map((column) => ({ ...column }))
}

function writerAttestation() {
  return {
    confirmed: true,
    contractVersion: CRAWLER_WRITER_CONTRACT_VERSION,
    contractDigest: CRAWLER_WRITER_CONTRACT_DIGEST,
  }
}

function fixture() {
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
    fieldMap: { externalId: { from: 'record_key' } },
    approvedAt: null,
  }]))
  const activeMappings = new Map()
  const cursors = new Map()
  const descriptions = new Map(CRAWLER_SOURCES.map((spec) => [spec.sourceKey, {
    source: {
      sourceKey: spec.sourceKey,
      displayName: spec.displayName,
      datasetId: spec.datasetId,
      platform: spec.platform,
      objectType: spec.objectType,
      status: 'paused',
      schema: spec.locator.schema,
      table: spec.locator.table,
    },
    columns: validColumns(),
    issues: [],
    warnings: [],
  }]))
  const profile = {
    id: PROFILE_ID,
    key: 'crawler-production',
    displayName: 'Crawler production',
    revision: 2,
    connection: { ...SHARED_CONNECTION },
  }
  const calls = {
    updates: [],
    activations: [],
    describes: [],
    compatible: [],
    locks: [],
    enqueued: [],
    reset: [],
    saved: [],
    guards: 0,
  }
  const extraAttestations = new Map()
  const pendingActivation = new Set()
  let discoveryState = null
  let attestation = null
  let importRunFailure = null
  let progressFailure = null
  let guardError = null

  const store = {
    listExternalSources: async () => structuredClone([...sources.values()]),
    getCrawlerDiscoveryState: async () => structuredClone(discoveryState),
    saveCrawlerDiscoveryState: async state => { discoveryState = structuredClone(state) },
    listCrawlerAutoActivationPending: async () => [...pendingActivation],
    settleCrawlerAutoActivation: async keys => keys.forEach(key => pendingActivation.delete(key)),
    registerCrawlerSource: async (spec, template) => {
      if (sources.has(spec.sourceKey)) return sources.get(spec.sourceKey)
      sources.set(spec.sourceKey, { ...structuredClone(template), ...spec, id: spec.sourceId,
        status: 'paused', connection: { ...SHARED_CONNECTION, ...spec.locator } })
      mappings.set(spec.sourceKey, { id: spec.mappingId, sourceId: spec.sourceId, version: 1, fieldMap: CRAWLER_FIELD_MAP })
      pendingActivation.add(spec.sourceKey)
    },
    getExternalSource: async (key) => structuredClone(sources.get(key) ?? null),
    getDatabaseConnection: async (id) => id === PROFILE_ID ? structuredClone(profile) : null,
    getActiveMapping: async (sourceId) => {
      const spec = [...sources.values()].find(candidate => candidate.id === sourceId)
      return structuredClone(activeMappings.get(spec?.sourceKey) ?? null)
    },
    listSourceMappings: async (sourceId) => {
      const spec = [...sources.values()].find(candidate => candidate.id === sourceId)
      return spec ? [structuredClone(mappings.get(spec.sourceKey))] : []
    },
    listImportRuns: async (sourceId) => {
      if (sourceId === importRunFailure) throw new Error('run store unavailable')
      return []
    },
    getLatestPipelineWriterContractAttestation: async key => structuredClone(extraAttestations.get(key) || attestation),
    updateExternalSourcesBatch: async (updates) => {
      calls.updates.push(structuredClone(updates))
      for (const update of updates) {
        const source = sources.get(update.sourceKey)
        Object.assign(source, structuredClone(update))
      }
      return updates.map((update) => structuredClone(sources.get(update.sourceKey)))
    },
    activateExternalSourcesWithAttestation: async (input) => {
      calls.activations.push(structuredClone(input))
      if (input.automatic) input.sourceKeys.forEach(key => pendingActivation.delete(key))
      for (const contract of input.additionalContracts || []) extraAttestations.set(contract.pipelineKey, {
        contractVersion: contract.version, contractDigest: contract.digest,
      })
      for (const sourceKey of input.sourceKeys) {
        sources.get(sourceKey).status = 'active'
        const mapping = mappings.get(sourceKey)
        activeMappings.set(sourceKey, {
          ...mapping,
          approvedAt: new Date().toISOString(),
          approvedBy: input.attestedBy,
        })
      }
      attestation = {
        contractVersion: input.contractVersion,
        contractDigest: input.contractDigest,
        contractSummary: input.contractSummary,
        attestedBy: input.attestedBy,
      }
      return { sources: input.sourceKeys.map((key) => structuredClone(sources.get(key))) }
    },
  }

  const transactionClient = {
    query: async () => ({ rows: [] }),
    release() {},
  }
  const queue = {
    pool: { connect: async () => transactionClient },
    getCursor: async (id) => structuredClone(cursors.get(id.replace(/^external:/u, '')) ?? null),
    saveCursor: async (id, position, patch) => {
      const sourceKey = id.replace(/^external:/u, '')
      const cursor = {
        id,
        position: structuredClone(position),
        status: patch.status,
        error: patch.error,
        updatedAt: new Date().toISOString(),
      }
      cursors.set(sourceKey, cursor)
      calls.saved.push(structuredClone(cursor))
      return structuredClone(cursor)
    },
    enqueue: async (queueName, payload, options) => {
      calls.enqueued.push({ queueName, payload: structuredClone(payload), options: { ...options, client: undefined } })
      return `job-${payload.sourceKey}`
    },
  }
  // Use the real fail-fast in-process locks so concurrent pipeline operations
  // cannot silently share a lock as they did with the old no-op test double.
  const lockPuller = new DatabaseSourcePuller({ store, queue })
  const databasePuller = {
    withSourceLocks: async (keys, operation) => {
      calls.locks.push([...keys])
      return lockPuller.withSourceLocks(keys, (assertOwned, clients) => operation(async () => {
        await assertOwned()
        calls.guards += 1
        if (guardError) throw guardError
      }, clients))
    },
    resolveConnectionCandidate: async ({ databaseConnectionId, connection }) => ({
      databaseConnectionId: databaseConnectionId ?? null,
      databaseConnectionKey: databaseConnectionId ? profile.key : null,
      databaseConnectionRevision: databaseConnectionId ? profile.revision : null,
      connection: databaseConnectionId
        ? { ...profile.connection, ...connection }
        : { ...connection },
    }),
    testSourceCandidate: async () => ({ ready: true }),
    describe: async (sourceKey) => {
      calls.describes.push(sourceKey)
      return structuredClone(descriptions.get(sourceKey))
    },
    assertCheckpointCompatible: async (sourceKey) => calls.compatible.push(sourceKey),
    resetCheckpoints: async (keys, options) => {
      calls.reset.push({ keys: [...keys], options: structuredClone(options) })
      return keys.map((sourceKey) => ({ sourceKey, status: 'idle' }))
    },
    progress: async (sourceKey) => {
      if (sourceKey === progressFailure) throw new Error('source progress unavailable')
      return { totalRows: 10, completedRows: 4, remainingRows: 6, percent: 40 }
    },
  }
  const pipeline = new CrawlerSavedRecordsPipeline({ store, queue, databasePuller })

  return {
    pipeline,
    store,
    queue,
    databasePuller,
    lockPuller,
    sources,
    mappings,
    activeMappings,
    cursors,
    descriptions,
    calls,
    setAttestation(value) { attestation = value },
    setSourceAttestation(key, value) { extraAttestations.set(key, value) },
    failLockOwnership(error = new Error('source lock ownership lost')) { guardError = error },
    failImportRunsFor(sourceId) { importRunFailure = sourceId },
    failProgressFor(sourceKey) { progressFailure = sourceKey },
    activateAll() {
      for (const spec of CRAWLER_SOURCES) {
        sources.get(spec.sourceKey).status = 'active'
        activeMappings.set(spec.sourceKey, {
          ...mappings.get(spec.sourceKey),
          approvedAt: new Date().toISOString(),
        })
      }
      attestation = {
        contractVersion: CRAWLER_WRITER_CONTRACT_VERSION,
        contractDigest: CRAWLER_WRITER_CONTRACT_DIGEST,
      }
    },
  }
}

test('crawler status is aggregated while task inspection failures remain isolated', async () => {
  const setup = fixture()
  const first = CRAWLER_SOURCES[0]
  setup.failImportRunsFor(first.sourceId)

  const paused = await setup.pipeline.get()
  assert.equal(paused.displayName, 'Night-All-A 数据清洗任务')
  assert.equal(paused.status, 'paused')
  assert.equal(paused.tasks.length, 13)
  assert.equal(paused.tasks[0].error.code, 'crawler_task_failed')
  assert.equal(paused.tasks.slice(1).every((task) => task.error === null), true)
  assert.equal(paused.serving.defaultGranted, false)
  assert.equal(paused.serving.grants.every((grant) => grant.defaultGranted === false), true)
  assert.equal(JSON.stringify(paused).includes('private-password'), false)

  setup.sources.get(first.sourceKey).status = 'active'
  assert.equal((await setup.pipeline.get()).status, 'mixed')
})

test('crawler configure applies one shared profile to all fixed leaves and keeps them paused', async () => {
  const setup = fixture()
  const result = await setup.pipeline.configure({
    databaseConnectionId: PROFILE_ID,
    syncIntervalSeconds: 600,
  })

  assert.equal(result.status, 'paused')
  assert.equal(result.configured, true)
  assert.equal(result.databaseConnectionId, PROFILE_ID)
  assert.equal(result.databaseConnection.passwordConfigured, true)
  assert.equal(setup.calls.updates.length, 1)
  assert.equal(setup.calls.updates[0].length, 13)
  for (const spec of CRAWLER_SOURCES) {
    const source = setup.sources.get(spec.sourceKey)
    assert.equal(source.status, 'paused')
    assert.equal(source.databaseConnectionId, PROFILE_ID)
    assert.deepEqual(source.connection, spec.locator)
    assert.equal(source.syncIntervalSeconds, 600)
  }
})

test('crawler activation probes every selected leaf and atomically approves fixed mappings with attestation', async () => {
  const setup = fixture()

  await assert.rejects(
    () => setup.pipeline.setStatus('active'),
    (error) => error?.code === 'writer_contract_attestation_required',
  )
  assert.equal(setup.calls.describes.length, 13)
  assert.equal(setup.calls.compatible.length, 13)
  assert.equal(setup.calls.activations.length, 0)

  const result = await setup.pipeline.setStatus('active', {
    approvedBy: 'crawler-owner',
    writerContractAttestation: writerAttestation(),
  })
  assert.equal(result.status, 'active')
  assert.equal(setup.calls.describes.length, 26)
  assert.equal(setup.calls.compatible.length, 26)
  assert.equal(setup.calls.activations.length, 1)
  assert.equal(setup.calls.activations[0].sourceKeys.length, 13)
  assert.equal(setup.calls.activations[0].approvals.length, 13)
  assert.equal(setup.calls.activations[0].attestedBy, 'crawler-owner')
  assert.equal(setup.calls.guards, 1)
})

test('crawler mutations recheck advisory-lock ownership immediately before commit', async () => {
  const connectionSetup = fixture()
  connectionSetup.failLockOwnership()
  await assert.rejects(
    () => connectionSetup.pipeline.configure({ databaseConnectionId: PROFILE_ID }),
    /source lock ownership lost/u,
  )
  assert.equal(connectionSetup.calls.updates.length, 0)

  const activationSetup = fixture()
  activationSetup.failLockOwnership()
  await assert.rejects(
    () => activationSetup.pipeline.setStatus('active', {
      writerContractAttestation: writerAttestation(),
    }),
    /source lock ownership lost/u,
  )
  assert.equal(activationSetup.calls.activations.length, 0)

  const resumeSetup = fixture()
  resumeSetup.activateAll()
  const [failed] = CRAWLER_SOURCES
  resumeSetup.cursors.set(failed.sourceKey, {
    status: 'failed', position: {}, error: 'timeout', updatedAt: new Date().toISOString(),
  })
  resumeSetup.failLockOwnership()
  await assert.rejects(
    () => resumeSetup.pipeline.resumeFailedTask(failed.sourceKey),
    /source lock ownership lost/u,
  )
  assert.equal(resumeSetup.calls.saved.length, 0)
})

test('crawler can activate and pause one leaf without changing its siblings', async () => {
  const setup = fixture()
  const target = CRAWLER_SOURCES.find((spec) => spec.sourceType === 'local_news')

  const mixed = await setup.pipeline.setStatus('active', {
    sourceType: target.sourceType,
    writerContractAttestation: writerAttestation(),
  })
  assert.equal(mixed.status, 'mixed')
  assert.equal(setup.calls.activations[0].sourceKeys.length, 1)
  assert.equal(setup.calls.activations[0].sourceKeys[0], 'night-all-saved-records-local-news')
  assert.equal(setup.calls.describes.length, 1)

  const paused = await setup.pipeline.setTaskStatus(target.sourceKey, 'paused')
  assert.equal(paused.status, 'paused')
  assert.equal(CRAWLER_SOURCES.filter((spec) => setup.sources.get(spec.sourceKey).status === 'paused').length, 13)
})

test('crawler sync supports one leaf and isolates paused, running and unsafe leaves in run-all', async () => {
  const setup = fixture()
  setup.activateAll()
  const [one, paused, running, unsafe] = CRAWLER_SOURCES

  const single = await setup.pipeline.sync({ sourceType: one.sourceType, batchSize: 25 })
  assert.equal(single.task.sourceKey, one.sourceKey)
  assert.equal(single.task.status, 'scheduled')
  assert.equal(setup.calls.enqueued.at(-1).payload.batchSize, 25)

  setup.sources.get(paused.sourceKey).status = 'paused'
  setup.cursors.set(running.sourceKey, {
    status: 'running', position: {}, updatedAt: new Date().toISOString(),
  })
  setup.descriptions.get(unsafe.sourceKey).issues = ['no index begins with (last_seen_at, id)']
  setup.calls.enqueued.length = 0
  const all = await setup.pipeline.sync({ batchSize: 20 })

  assert.equal(all.tasks.length, 13)
  assert.equal(all.tasks.find((task) => task.sourceKey === paused.sourceKey).status, 'paused')
  assert.equal(all.tasks.find((task) => task.sourceKey === running.sourceKey).alreadyScheduled, true)
  assert.equal(all.tasks.find((task) => task.sourceKey === unsafe.sourceKey).status, 'failed')
  assert.equal(setup.calls.enqueued.length, 10)
  assert.equal(setup.calls.enqueued.every((call) => call.payload.batchSize === 20), true)
})

test('crawler resume, progress and reset keep per-leaf evidence independent', async () => {
  const setup = fixture()
  setup.activateAll()
  for (const source of setup.sources.values()) source.status = 'paused'
  const [failed, healthy] = CRAWLER_SOURCES
  setup.cursors.set(failed.sourceKey, {
    status: 'failed', position: { cursor: '2026-09-09T00:00:00Z', lastId: 7 }, error: 'timeout',
    updatedAt: new Date().toISOString(),
  })
  setup.cursors.set(healthy.sourceKey, {
    status: 'idle', position: {}, error: null, updatedAt: new Date().toISOString(),
  })

  const resumed = await setup.pipeline.resumeFailedTasks()
  assert.equal(resumed.tasks.find((task) => task.sourceKey === failed.sourceKey).resumed, true)
  assert.equal(resumed.tasks.find((task) => task.sourceKey === healthy.sourceKey).resumed, false)
  assert.equal(setup.calls.saved.length, 1)

  setup.failProgressFor(healthy.sourceKey)
  const progress = await setup.pipeline.progress()
  assert.equal(progress.tasks.length, 13)
  assert.equal(progress.tasks.find((task) => task.sourceKey === healthy.sourceKey).error.code, 'crawler_task_failed')
  assert.equal(progress.tasks.find((task) => task.sourceKey === failed.sourceKey).percent, 40)

  await assert.rejects(
    () => setup.pipeline.resetCheckpoints('wrong-pipeline'),
    (error) => error?.code === 'checkpoint_reset_confirmation_required',
  )
  const reset = await setup.pipeline.resetCheckpoints(CRAWLER_PIPELINE_KEY)
  assert.equal(reset.resets.length, 13)
  assert.equal(setup.calls.reset[0].keys.length, 13)
  assert.equal(Object.keys(setup.calls.reset[0].options.mappingOverrides).length, 13)
})

test('crawler bulk recovery restores all 14 failed leaves without competing for its own pipeline lock', async () => {
  const setup = fixture()
  setup.activateAll()
  const tender = crawlerSourceSpec('tender')
  await setup.store.registerCrawlerSource(tender, setup.sources.get(CRAWLER_SOURCES[0].sourceKey))
  setup.activeMappings.set(tender.sourceKey, { ...setup.mappings.get(tender.sourceKey), approvedAt: new Date().toISOString() })
  const contract = crawlerWriterContractForSpec(tender)
  setup.setSourceAttestation(contract.pipelineKey, { contractVersion: contract.version, contractDigest: contract.digest })
  setup.descriptions.set(tender.sourceKey, { columns: validColumns(), issues: [], warnings: [] })
  for (const source of setup.sources.values()) {
    setup.cursors.set(source.sourceKey, {
      status: 'failed', error: 'source_contract_mismatch',
      position: { cursor: '2026-10-13 04:15:16.123456+00', lastId: source.sourceKey,
        contractHash: 'original-contract', mappingVersion: 1, importRunId: 'original-run' },
    })
  }
  const originalPositions = new Map([...setup.cursors].map(([key, cursor]) => [key, structuredClone(cursor.position)]))
  const originalSources = structuredClone([...setup.sources.values()])
  const originalMappings = structuredClone([...setup.activeMappings.values()])

  const result = await setup.pipeline.resumeFailedTasks()

  assert.equal(result.tasks.length, 14)
  assert.equal(result.tasks.filter(task => task.resumed).length, 14, JSON.stringify(result.tasks))
  assert.deepEqual(result.tasks.map(task => task.sourceKey), [...setup.sources.keys()].sort())
  assert.equal(setup.calls.saved.length, 14)
  assert.equal(setup.calls.guards, 14)
  for (const [key, cursor] of setup.cursors) {
    assert.equal(cursor.status, 'idle')
    assert.equal(cursor.error, null)
    assert.deepEqual(cursor.position, originalPositions.get(key))
  }
  assert.deepEqual([...setup.sources.values()], originalSources)
  assert.deepEqual([...setup.activeMappings.values()], originalMappings)
  assert.equal(setup.calls.activations.length, 0)
  assert.equal(setup.calls.updates.length, 0)
  assert.equal(setup.calls.enqueued.length, 0)
  assert.equal(setup.calls.reset.length, 0)
  const repeated = await setup.pipeline.resumeFailedTasks()
  assert.ok(repeated.tasks.every(task => task.resumed === false && !task.error))
  assert.equal(setup.calls.saved.length, 14)
})

test('crawler bulk recovery respects an external pipeline lock without changing failed cursors', async () => {
  const setup = fixture()
  setup.activateAll()
  for (const spec of CRAWLER_SOURCES) setup.cursors.set(spec.sourceKey, {
    status: 'failed', position: { lastId: '7' }, error: 'original_failure',
  })
  const original = structuredClone([...setup.cursors])

  await setup.lockPuller.withSourceLock(CRAWLER_PIPELINE_KEY, async () => {
    const result = await setup.pipeline.resumeFailedTasks()
    assert.equal(result.tasks.length, 13)
    assert.ok(result.tasks.every(task => task.resumed === false && task.error?.code === 'source_busy'))
    assert.deepEqual([...setup.cursors], original)
    assert.equal(setup.calls.saved.length, 0)
  })
  const retried = await setup.pipeline.resumeFailedTasks()
  assert.ok(retried.tasks.every(task => task.resumed === true && !task.error))
})

test('crawler bulk recovery isolates a busy leaf and a failed probe while continuing later leaves', async () => {
  const setup = fixture()
  setup.activateAll()
  const [busy, invalid] = CRAWLER_SOURCES
  for (const spec of CRAWLER_SOURCES) setup.cursors.set(spec.sourceKey, {
    status: 'failed', position: { lastId: '7' }, error: 'original_failure',
  })
  const originalBusy = structuredClone(setup.cursors.get(busy.sourceKey))
  const originalInvalid = structuredClone(setup.cursors.get(invalid.sourceKey))
  setup.descriptions.get(invalid.sourceKey).issues = ['cursor index unavailable']

  await setup.lockPuller.withSourceLock(busy.sourceKey, async () => {
    const result = await setup.pipeline.resumeFailedTasks()
    assert.equal(result.tasks.find(task => task.sourceKey === busy.sourceKey).error.code, 'source_busy')
    assert.equal(result.tasks.find(task => task.sourceKey === invalid.sourceKey).error.code, 'source_probe_failed')
    assert.equal(result.tasks.filter(task => task.resumed).length, 11)
    assert.deepEqual(setup.cursors.get(busy.sourceKey), originalBusy)
    assert.deepEqual(setup.cursors.get(invalid.sourceKey), originalInvalid)
    assert.equal(setup.calls.saved.length, 11)
  })
  setup.descriptions.get(invalid.sourceKey).issues = []
  const retried = await setup.pipeline.resumeFailedTasks()
  assert.equal(retried.tasks.filter(task => task.resumed).length, 2)
  assert.ok(retried.tasks.every(task => !task.error))
})

for (const fullSchema of [false, true]) test(`crawler resume accepts ${fullSchema ? 'reviewed storage metadata' : 'nullable tag'} with the original mapping and checkpoint without enabling a paused source`, async () => {
  const setup = fixture()
  setup.activateAll()
  const spec = CRAWLER_SOURCES.find(source => source.sourceType === 'news')
  setup.sources.get(spec.sourceKey).status = 'paused'
  setup.descriptions.get(spec.sourceKey).columns.push(...CRAWLER_OPTIONAL_SOURCE_COLUMN_CONTRACT
    .filter(column => fullSchema || column.name === 'tag').map(column => ({ ...column })))
  const position = {
    contractHash: 'original-contract', mappingVersion: 1,
    cursor: '2026-10-13 04:15:16.123456+00', lastId: '21049', importRunId: 'original-run',
  }
  setup.cursors.set(spec.sourceKey, {
    status: 'failed', position, error: 'source_contract_mismatch', updatedAt: new Date().toISOString(),
  })
  const originalSources = structuredClone([...setup.sources.values()])
  const originalMappings = structuredClone([...setup.activeMappings.values()])
  const originalAttestation = await setup.store.getLatestPipelineWriterContractAttestation(CRAWLER_PIPELINE_KEY)
  setup.databasePuller.assertCheckpointCompatible = async (sourceKey, { mappingOverride }) => {
    assert.equal(sourceKey, spec.sourceKey)
    assert.deepEqual(mappingOverride, setup.activeMappings.get(spec.sourceKey))
    assert.deepEqual(setup.cursors.get(sourceKey).position, position)
    setup.calls.compatible.push(sourceKey)
  }

  const result = await setup.pipeline.resumeFailedTask(spec.sourceKey)

  assert.equal(result.task.resumed, true)
  assert.equal(result.task.clearedError, 'source_contract_mismatch')
  assert.deepEqual(setup.cursors.get(spec.sourceKey).position, position)
  assert.equal(setup.cursors.get(spec.sourceKey).status, 'idle')
  assert.equal(setup.cursors.get(spec.sourceKey).error, null)
  assert.deepEqual(setup.calls.describes, [spec.sourceKey])
  assert.deepEqual(setup.calls.compatible, [spec.sourceKey])
  assert.deepEqual([...setup.sources.values()], originalSources)
  assert.deepEqual([...setup.activeMappings.values()], originalMappings)
  assert.deepEqual(await setup.store.getLatestPipelineWriterContractAttestation(CRAWLER_PIPELINE_KEY), originalAttestation)
  assert.equal(setup.calls.activations.length, 0)
  assert.equal(setup.calls.updates.length, 0)
  assert.equal(setup.calls.enqueued.length, 0)
  assert.equal(setup.calls.reset.length, 0)
})

test('crawler recovery retains failed cursors and manual pauses when reviewed metadata drifts or unknown columns appear', async (t) => {
  const cases = [
    ['unknown column', columns => [...columns, { name: 'unreviewed_metadata', databaseType: 'jsonb', nullable: true }]],
    ['wrong type', columns => columns.map(column => column.name === 'published_date'
      ? { ...column, databaseType: 'varchar' } : column)],
    ['wrong nullability', columns => columns.map(column => column.name === 'storage_schema_version'
      ? { ...column, nullable: true } : column)],
  ]
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const setup = fixture()
    setup.activateAll()
    const spec = CRAWLER_SOURCES.find(source => source.sourceType === 'news')
    setup.sources.get(spec.sourceKey).status = 'paused'
    setup.descriptions.get(spec.sourceKey).columns = mutate([
      ...validColumns(), ...CRAWLER_OPTIONAL_SOURCE_COLUMN_CONTRACT.map(column => ({ ...column })),
    ])
    setup.cursors.set(spec.sourceKey, {
      status: 'failed', error: 'source_contract_mismatch',
      position: { contractHash: 'original-contract', mappingVersion: 1,
        cursor: '2026-10-13 04:15:16.123456+00', lastId: '21049', importRunId: 'original-run' },
    })
    const original = structuredClone(setup.cursors.get(spec.sourceKey))
    const originalMapping = structuredClone(setup.activeMappings.get(spec.sourceKey))
    const originalAttestation = await setup.store.getLatestPipelineWriterContractAttestation(CRAWLER_PIPELINE_KEY)
    await assert.rejects(() => setup.pipeline.resumeFailedTask(spec.sourceKey), error => error?.code === 'source_probe_failed')
    assert.deepEqual(setup.cursors.get(spec.sourceKey), original)
    assert.equal(setup.sources.get(spec.sourceKey).status, 'paused')
    assert.deepEqual(setup.activeMappings.get(spec.sourceKey), originalMapping)
    assert.deepEqual(await setup.store.getLatestPipelineWriterContractAttestation(CRAWLER_PIPELINE_KEY), originalAttestation)
    assert.equal(setup.calls.saved.length, 0)
    assert.equal(setup.calls.activations.length, 0)
    assert.equal(setup.calls.updates.length, 0)
    assert.equal(setup.calls.enqueued.length, 0)
    assert.equal(setup.calls.reset.length, 0)
  })
})

test('crawler resume leaves tender failed when its cursor index is missing and recovers compatible siblings independently', async () => {
  const setup = fixture()
  setup.activateAll()
  const news = CRAWLER_SOURCES.find(source => source.sourceType === 'news')
  const tender = crawlerSourceSpec('tender')
  await setup.store.registerCrawlerSource(tender, setup.sources.get(news.sourceKey))
  setup.activeMappings.set(tender.sourceKey, { ...setup.mappings.get(tender.sourceKey), approvedAt: new Date().toISOString() })
  const contract = crawlerWriterContractForSpec(tender)
  setup.setSourceAttestation(contract.pipelineKey, { contractVersion: contract.version, contractDigest: contract.digest })
  setup.descriptions.set(tender.sourceKey, {
    columns: [...validColumns(), { name: 'tag', databaseType: 'varchar', nullable: true }],
    issues: ['crawler source requires an exact live unique btree (last_seen_at, id) index'],
  })
  for (const spec of [news, tender]) setup.cursors.set(spec.sourceKey, {
    status: 'failed', position: { cursor: '2026-10-13T00:00:00Z', lastId: '7' },
    error: 'source_contract_mismatch', updatedAt: new Date().toISOString(),
  })
  const originalTenderCursor = structuredClone(setup.cursors.get(tender.sourceKey))

  const result = await setup.pipeline.resumeFailedTasks()

  assert.equal(result.tasks.find(task => task.sourceKey === news.sourceKey).resumed, true)
  assert.equal(result.tasks.find(task => task.sourceKey === tender.sourceKey).resumed, false)
  assert.equal(result.tasks.find(task => task.sourceKey === tender.sourceKey).error.code, 'source_probe_failed')
  assert.deepEqual(setup.cursors.get(tender.sourceKey), originalTenderCursor)
  assert.deepEqual(setup.calls.saved.map(cursor => cursor.id), [`external:${news.sourceKey}`])
  assert.equal(setup.sources.get(tender.sourceKey).status, 'paused')
  assert.equal(setup.calls.activations.length, 0)
  assert.equal(setup.calls.enqueued.length, 0)
})

test('crawler resume preserves failed evidence when saved approval, source, mapping or checkpoint validation fails', async (t) => {
  const cases = [
    ['missing writer approval', 'writer_contract_attestation_required', setup => setup.setAttestation(null)],
    ['stale writer approval', 'writer_contract_attestation_required', setup => setup.setAttestation({ contractVersion: 'old', contractDigest: 'old' })],
    ['source drift', 'pipeline_source_contract_drift', (setup, spec) => { setup.sources.get(spec.sourceKey).datasetId = 'wrong-dataset' }],
    ['mapping drift', 'builtin_mapping_conflict', (setup, spec) => { setup.activeMappings.get(spec.sourceKey).version = 2 }],
    ['inactive mapping', 'builtin_mapping_not_active', (setup, spec) => { setup.activeMappings.delete(spec.sourceKey) }],
    ['checkpoint mismatch', 'checkpoint_contract_mismatch', setup => {
      setup.databasePuller.assertCheckpointCompatible = async () => {
        throw Object.assign(new Error('checkpoint contract mismatch'), { code: 'checkpoint_contract_mismatch' })
      }
    }],
  ]
  for (const [name, code, mutate] of cases) await t.test(name, async () => {
    const setup = fixture()
    setup.activateAll()
    const spec = CRAWLER_SOURCES[0]
    setup.cursors.set(spec.sourceKey, {
      status: 'failed', position: { cursor: '2026-10-13T00:00:00Z', lastId: '7' },
      error: 'original_failure', updatedAt: new Date().toISOString(),
    })
    const original = structuredClone(setup.cursors.get(spec.sourceKey))
    mutate(setup, spec)
    await assert.rejects(() => setup.pipeline.resumeFailedTask(spec.sourceKey), error => error?.code === code)
    assert.deepEqual(setup.cursors.get(spec.sourceKey), original)
    assert.equal(setup.calls.saved.length, 0)
    assert.equal(setup.calls.activations.length, 0)
    assert.equal(setup.calls.enqueued.length, 0)
  })
})

test('crawler resume requires the dynamic category approval in addition to the seed writer approval', async () => {
  const setup = fixture()
  setup.activateAll()
  const spec = crawlerSourceSpec('tender')
  await setup.store.registerCrawlerSource(spec, setup.sources.get(CRAWLER_SOURCES[0].sourceKey))
  setup.cursors.set(spec.sourceKey, { status: 'failed', position: {}, error: 'original_failure' })
  const original = structuredClone(setup.cursors.get(spec.sourceKey))
  const contract = crawlerWriterContractForSpec(spec)
  for (const approval of [null, { contractVersion: contract.version, contractDigest: 'old' }]) {
    setup.setSourceAttestation(contract.pipelineKey, approval)
    await assert.rejects(
      () => setup.pipeline.resumeFailedTask(spec.sourceKey),
      error => error?.code === 'writer_contract_attestation_required',
    )
    assert.deepEqual(setup.cursors.get(spec.sourceKey), original)
  }
  assert.equal(setup.calls.saved.length, 0)
  assert.equal(setup.calls.activations.length, 0)
  assert.equal(setup.calls.enqueued.length, 0)
})

test('crawler abandoned-run recovery also rechecks the source before clearing its cursor', async () => {
  const setup = fixture()
  setup.activateAll()
  const spec = CRAWLER_SOURCES[0]
  setup.cursors.set(spec.sourceKey, {
    status: 'running', position: { cursor: '2026-10-13T00:00:00Z', lastId: '7', importRunId: 'original-run' },
    error: null, updatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  })
  const original = structuredClone(setup.cursors.get(spec.sourceKey))
  setup.descriptions.get(spec.sourceKey).issues = ['cursor index unavailable']
  await assert.rejects(() => setup.pipeline.resumeFailedTask(spec.sourceKey), error => error?.code === 'source_probe_failed')
  assert.deepEqual(setup.cursors.get(spec.sourceKey), original)
  setup.descriptions.get(spec.sourceKey).issues = []
  const result = await setup.pipeline.resumeFailedTask(spec.sourceKey)
  assert.equal(result.task.from, 'abandoned_run')
  assert.equal(result.task.resumed, true)
  assert.deepEqual(setup.cursors.get(spec.sourceKey).position, original.position)
  assert.equal(setup.calls.enqueued.length, 0)
})


test('discovery auto-activates a compatible category idempotently without changing existing work or manual pauses', async () => {
  const setup = fixture()
  setup.activateAll()
  const original = structuredClone([...setup.sources.values()])
  const originalMappings = structuredClone([...setup.activeMappings.values()])
  const spec = crawlerSourceSpec('education')
  setup.databasePuller.discoverCrawlerCategories = async () => ({ candidates: [
    { sourceType: 'education', table: 'public.saved_records_education', spec, issues: [] },
    { sourceType: 'health', spec: crawlerSourceSpec('health'), issues: ['requires independent partition'] },
  ], warnings: [] })
  setup.descriptions.set(spec.sourceKey, { columns: validColumns(), issues: [], warnings: [] })
  const discovered = await setup.pipeline.discover()
  assert.equal(discovered.displayName, 'Night-All-A 数据清洗任务')
  assert.equal(discovered.tasks.length, 14)
  assert.equal(discovered.status, 'active')
  assert.equal(discovered.tasks.find(task => task.sourceType === 'education').source.status, 'active')
  assert.equal(discovered.tasks.find(task => task.sourceType === 'education').activeMapping.version, 1)
  assert.deepEqual([...setup.sources.values()].slice(0, 13), original)
  assert.deepEqual([...setup.activeMappings.values()].slice(0, 13), originalMappings)
  assert.equal((await setup.pipeline.discover()).tasks.length, 14)
  assert.equal(setup.calls.activations.length, 1)
  assert.equal(setup.calls.activations[0].attestedBy, 'system:category-discovery')
  assert.equal(setup.calls.activations[0].additionalContracts.length, 1)
  assert.equal(setup.sources.has(crawlerSourceSpec('health').sourceKey), false)
  assert.equal(discovered.discovery.items[1].registered, false)
  const scheduled = await scheduleActiveDatabaseSources({ store: setup.store, queue: setup.queue })
  assert.equal(scheduled.enqueued, 14)
  assert.ok(setup.calls.enqueued.some(job => job.payload.sourceKey === spec.sourceKey))
  await setup.pipeline.setStatus('paused', { sourceType: 'education' })
  await setup.pipeline.discover()
  assert.equal(setup.sources.get(spec.sourceKey).status, 'paused')
  assert.equal(setup.calls.activations.length, 1)
  assert.equal((await setup.pipeline.progress()).tasks.length, 14)
})

test('automatic category activation retries contract failures but never overrides a manual pause', async () => {
  const setup = fixture()
  setup.activateAll()
  const spec = crawlerSourceSpec('education')
  setup.databasePuller.discoverCrawlerCategories = async () => ({ candidates: [{ sourceType: spec.sourceType, spec, issues: [] }] })
  setup.descriptions.set(spec.sourceKey, { columns: validColumns(), issues: ['missing cursor index'] })
  const blocked = await setup.pipeline.discover()
  assert.equal(setup.sources.get(spec.sourceKey).status, 'paused')
  assert.equal(blocked.discovery.activationFailures[0].code, 'source_probe_failed')
  setup.descriptions.set(spec.sourceKey, { columns: validColumns(), issues: [] })
  await setup.pipeline.discover()
  assert.equal(setup.sources.get(spec.sourceKey).status, 'active')
  assert.equal((await setup.store.listCrawlerAutoActivationPending()).length, 0)
})


test('manual pause cancels a pending automatic activation even after schema recovery', async () => {
  const setup = fixture()
  setup.activateAll()
  const spec = crawlerSourceSpec('education')
  setup.databasePuller.discoverCrawlerCategories = async () => ({ candidates: [{ sourceType: spec.sourceType, spec, issues: [] }] })
  setup.descriptions.set(spec.sourceKey, { columns: validColumns(), issues: ['index unavailable'] })
  await setup.pipeline.discover()
  assert.deepEqual(await setup.store.listCrawlerAutoActivationPending(), [spec.sourceKey])
  await setup.pipeline.setStatus('paused', { sourceType: 'education' })
  setup.descriptions.set(spec.sourceKey, { columns: validColumns(), issues: [] })
  await setup.pipeline.discover()
  assert.equal(setup.sources.get(spec.sourceKey).status, 'paused')
  assert.equal(setup.calls.activations.length, 0)
  assert.deepEqual(await setup.store.listCrawlerAutoActivationPending(), [])
})
