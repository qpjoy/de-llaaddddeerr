import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CRAWLER_MAPPING_VERSION,
  CRAWLER_PIPELINE_KEY,
  CRAWLER_SOURCES,
  CRAWLER_SOURCE_COLUMN_CONTRACT,
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
  let attestation = null
  let importRunFailure = null
  let progressFailure = null
  let guardError = null

  const store = {
    getExternalSource: async (key) => structuredClone(sources.get(key) ?? null),
    getDatabaseConnection: async (id) => id === PROFILE_ID ? structuredClone(profile) : null,
    getActiveMapping: async (sourceId) => {
      const spec = CRAWLER_SOURCES.find((candidate) => candidate.sourceId === sourceId)
      return structuredClone(activeMappings.get(spec?.sourceKey) ?? null)
    },
    listSourceMappings: async (sourceId) => {
      const spec = CRAWLER_SOURCES.find((candidate) => candidate.sourceId === sourceId)
      return spec ? [structuredClone(mappings.get(spec.sourceKey))] : []
    },
    listImportRuns: async (sourceId) => {
      if (sourceId === importRunFailure) throw new Error('run store unavailable')
      return []
    },
    getLatestPipelineWriterContractAttestation: async () => structuredClone(attestation),
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
  const databasePuller = {
    withSourceLocks: async (keys, operation) => {
      calls.locks.push([...keys])
      return operation(async () => {
        calls.guards += 1
        if (guardError) throw guardError
      }, null)
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
    sources,
    mappings,
    activeMappings,
    cursors,
    descriptions,
    calls,
    setAttestation(value) { attestation = value },
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
  assert.equal(paused.displayName, 'Night-All saved records 清洗任务')
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
