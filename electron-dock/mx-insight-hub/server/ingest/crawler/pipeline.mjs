import { AppError } from '../../core/errors.mjs'
import { enqueueJobsAtomically } from '../external/atomic-enqueue.mjs'
import { validateDatabaseConnection } from '../external/database-source.mjs'
import { EXTERNAL_PULL_QUEUE } from '../external/sync-job.mjs'
import {
  CRAWLER_MAPPING_VERSION,
  CRAWLER_PIPELINE_KEY,
  CRAWLER_SOURCES,
  CRAWLER_SOURCE_TYPES,
  CRAWLER_WRITER_CONTRACT_DIGEST,
  CRAWLER_WRITER_CONTRACT_SUMMARY,
  CRAWLER_WRITER_CONTRACT_VERSION,
  crawlerProbeIssues,
  crawlerSourceContractIssues,
} from './source-contract.mjs'

export { isCrawlerSourceKey } from './source-contract.mjs'

export {
  CRAWLER_WRITER_CONTRACT_DIGEST,
  CRAWLER_WRITER_CONTRACT_SUMMARY,
  CRAWLER_WRITER_CONTRACT_VERSION,
} from './source-contract.mjs'

const SHARED_CONNECTION_FIELDS = new Set([
  'host', 'port', 'database', 'username', 'password', 'sslMode',
])
const MAX_BATCH_SIZE = 5_000
const ABANDONED_RUN_CYCLES = 10
const ABANDONED_RUN_FLOOR_MS = 15 * 60 * 1_000
const PIPELINE_ENQUEUE_ERRORS = Object.freeze({
  unavailable: {
    code: 'atomic_enqueue_unavailable',
    message: 'Crawler sync requires the PostgreSQL queue',
  },
  failed: {
    code: 'pipeline_sync_enqueue_failed',
    message: 'No crawler task was scheduled; retry when the PostgreSQL queue is available',
  },
  outcomeUnknown: {
    code: 'pipeline_sync_enqueue_outcome_unknown',
    message: 'The crawler scheduling transaction outcome is unknown; inspect the task queue before retrying',
  },
})

function writerContract() {
  return {
    version: CRAWLER_WRITER_CONTRACT_VERSION,
    digest: CRAWLER_WRITER_CONTRACT_DIGEST,
    summary: CRAWLER_WRITER_CONTRACT_SUMMARY,
  }
}

function currentWriterContract(attestation) {
  return attestation?.contractVersion === CRAWLER_WRITER_CONTRACT_VERSION
    && attestation?.contractDigest === CRAWLER_WRITER_CONTRACT_DIGEST
}

function assertWriterContractAttestation(attestation) {
  if (
    attestation?.confirmed !== true
    || attestation?.contractVersion !== CRAWLER_WRITER_CONTRACT_VERSION
    || attestation?.contractDigest !== CRAWLER_WRITER_CONTRACT_DIGEST
  ) {
    throw new AppError(
      409,
      'writer_contract_attestation_required',
      'Explicit confirmation of the crawler source-writer contract is required before activation',
      { writerContract: writerContract() },
    )
  }
}

function unsupportedFields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.keys(value).filter((field) => !allowed.has(field))
}

function sharedConnection(connection = {}) {
  return Object.fromEntries(
    Object.entries(connection).filter(([field]) => SHARED_CONNECTION_FIELDS.has(field)),
  )
}

function fixedConnection(spec) {
  return {
    schema: spec.locator.schema,
    table: spec.locator.table,
    cursorColumn: spec.locator.cursorColumn,
    idColumn: spec.locator.idColumn,
  }
}

function safeTransport(connection = {}) {
  const { password, ...safe } = sharedConnection(connection)
  return {
    ...safe,
    passwordConfigured: typeof password === 'string' && password.length > 0,
  }
}

function safeSource(source) {
  if (!source) return source
  const { password: _password, ...connection } = source.connection || {}
  return { ...source, connection: { ...connection, ...safeTransport(source.connection) } }
}

function safeDatabaseConnection(resolved, profile = null) {
  if (!resolved?.databaseConnectionId) return null
  const connection = resolved.connection || {}
  return {
    id: resolved.databaseConnectionId,
    connectionKey: profile?.key ?? resolved.databaseConnectionKey ?? null,
    displayName: profile?.displayName ?? null,
    revision: profile?.revision ?? resolved.databaseConnectionRevision ?? null,
    ...safeTransport(connection),
  }
}

function sameValue(left, right) {
  const entries = (value) => Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(entries(left)) === JSON.stringify(entries(right))
}

function isConfigured(connection) {
  return ['host', 'database', 'username', 'password'].every((field) => (
    typeof connection?.[field] === 'string' && connection[field].length > 0
  ))
}

function syncInterval(value) {
  if (value == null) return undefined
  if (!Number.isInteger(value) || value < 60 || value > 86_400) {
    throw new AppError(400, 'invalid_sync_interval', 'syncIntervalSeconds must be between 60 and 86400')
  }
  return value
}

function batchSize(value) {
  const size = value ?? 1_000
  if (!Number.isInteger(size) || size < 1 || size > MAX_BATCH_SIZE) {
    throw new AppError(400, 'invalid_batch_size', `batchSize must be an integer between 1 and ${MAX_BATCH_SIZE}`)
  }
  return size
}

function pipelineStatus(tasks) {
  if (tasks.length === CRAWLER_SOURCES.length && tasks.every((task) => task.source?.status === 'active')) return 'active'
  if (tasks.length === CRAWLER_SOURCES.length && tasks.every((task) => task.source?.status === 'paused')) return 'paused'
  return 'mixed'
}

function cursorSilenceMs(cursor) {
  const updatedAt = cursor?.updated_at ?? cursor?.updatedAt ?? null
  if (!updatedAt) return null
  return Date.now() - new Date(updatedAt).getTime()
}

function abandonedRun(source, cursor) {
  const silence = cursorSilenceMs(cursor)
  if (silence == null) return false
  const cadence = Number(source?.syncIntervalSeconds || 300) * 1_000
  return silence >= Math.max(cadence * ABANDONED_RUN_CYCLES, ABANDONED_RUN_FLOOR_MS)
}

function nextDueAt(source, cursor) {
  if (source?.status !== 'active' || cursor?.status !== 'idle') return null
  const updatedAt = cursor?.updated_at ?? cursor?.updatedAt ?? null
  if (!updatedAt || source.syncIntervalSeconds == null) return null
  return new Date(new Date(updatedAt).getTime() + source.syncIntervalSeconds * 1_000).toISOString()
}

function taskError(error) {
  return {
    code: error?.code || 'crawler_task_failed',
    message: error?.message || 'Crawler task inspection failed',
  }
}

export class CrawlerSavedRecordsPipeline {
  constructor({ store, queue, databasePuller }) {
    this.store = store
    this.queue = queue
    this.databasePuller = databasePuller
  }

  #spec(identifier) {
    const spec = CRAWLER_SOURCES.find((candidate) => (
      candidate.sourceKey === identifier || candidate.sourceType === identifier
    ))
    if (!spec) {
      throw new AppError(404, 'crawler_source_not_found', `Unknown crawler source: ${identifier}`)
    }
    return spec
  }

  async #source(spec) {
    const source = await this.store.getExternalSource(spec.sourceKey)
    if (!source) {
      throw new AppError(404, 'pipeline_source_not_found', `Crawler source is not installed: ${spec.sourceKey}`)
    }
    if (source.sourceKind !== 'database') {
      throw new AppError(409, 'pipeline_source_invalid', `Crawler source must be PostgreSQL: ${spec.sourceKey}`)
    }
    return source
  }

  async #sources() {
    return Promise.all(CRAWLER_SOURCES.map((spec) => this.#source(spec)))
  }

  async #cursor(sourceKey) {
    return this.queue?.getCursor?.(`external:${sourceKey}`) ?? null
  }

  async #withLocks(specs, operation) {
    if (typeof this.databasePuller?.withSourceLocks !== 'function') {
      throw new AppError(503, 'source_lock_unavailable', 'Crawler changes require source locking')
    }
    return this.databasePuller.withSourceLocks(specs.map((spec) => spec.sourceKey), operation)
  }

  async #configuration(sources, contractSpecs = CRAWLER_SOURCES) {
    const ids = sources.map((source) => source.databaseConnectionId ?? null)
    const transports = sources.map((source) => sharedConnection(source.connection))
    const intervals = sources.map((source) => source.syncIntervalSeconds)
    const databaseConnectionConsistent = ids.slice(1).every((id) => id === ids[0])
    const inlineConnectionConsistent = transports.slice(1).every((value) => sameValue(value, transports[0]))
    const connectionConsistent = databaseConnectionConsistent
      && (ids[0] !== null || inlineConnectionConsistent)
    const syncIntervalConsistent = intervals.slice(1).every((value) => value === intervals[0])
    const byKey = new Map(sources.map((source) => [source.sourceKey, source]))
    const issues = contractSpecs.flatMap((spec) => {
      const source = byKey.get(spec.sourceKey)
      return source ? crawlerSourceContractIssues(source, spec) : [`${spec.sourceKey} is not installed`]
    })
    if (!databaseConnectionConsistent) {
      issues.push('Crawler tasks do not share one database connection profile or inline mode')
    } else if (ids[0] === null && !inlineConnectionConsistent) {
      issues.push('Crawler tasks do not share one inline database connection')
    }
    if (!syncIntervalConsistent) issues.push('Crawler tasks do not share one sync interval')

    const base = {
      databaseConnectionId: databaseConnectionConsistent ? ids[0] : null,
      connection: connectionConsistent && ids[0] === null ? transports[0] : null,
      syncIntervalSeconds: syncIntervalConsistent ? intervals[0] : null,
      connectionConsistent,
      databaseConnectionConsistent,
      syncIntervalConsistent,
      issues,
      effectiveConnection: null,
      databaseConnection: null,
    }
    if (issues.length > 0 || sources.length === 0) return base
    try {
      const resolved = await this.databasePuller.resolveConnectionCandidate({
        databaseConnectionId: base.databaseConnectionId,
        connection: sources[0].connection,
      })
      const profile = resolved.databaseConnectionId && typeof this.store.getDatabaseConnection === 'function'
        ? await this.store.getDatabaseConnection(resolved.databaseConnectionId)
        : null
      return {
        ...base,
        effectiveConnection: resolved.connection,
        databaseConnection: safeDatabaseConnection(resolved, profile),
      }
    } catch (error) {
      return { ...base, issues: [...issues, error?.message || 'Database connection is not configured'] }
    }
  }

  async #builtInMapping(spec, source) {
    const [active, mappings] = await Promise.all([
      this.store.getActiveMapping(source.id),
      this.store.listSourceMappings(source.id),
    ])
    if (active && (active.id !== spec.mappingId || active.version !== CRAWLER_MAPPING_VERSION)) {
      throw new AppError(409, 'builtin_mapping_conflict', `A non-built-in mapping is active for ${spec.sourceKey}`)
    }
    const builtIn = active || mappings.find((mapping) => (
      mapping.id === spec.mappingId && mapping.version === CRAWLER_MAPPING_VERSION
    ))
    if (!builtIn) {
      throw new AppError(409, 'builtin_mapping_conflict', `Seeded built-in mapping is missing or collides for ${spec.sourceKey}`)
    }
    return { active, builtIn }
  }

  async #task(spec, source) {
    const [mappingResult, cursor, runs] = await Promise.all([
      this.#builtInMapping(spec, source),
      this.#cursor(source.sourceKey),
      this.store.listImportRuns(source.id, 1),
    ])
    return {
      ...spec,
      source: safeSource(source),
      activeMapping: mappingResult.active,
      builtInMappingAvailable: true,
      cursor,
      latestRun: runs[0] ?? null,
      nextDueAt: nextDueAt(source, cursor),
      configurationIssues: crawlerSourceContractIssues(source, spec),
      serving: {
        publicGrant: spec.platform,
        defaultGranted: false,
      },
      error: null,
    }
  }

  async get() {
    const settledSources = await Promise.allSettled(CRAWLER_SOURCES.map((spec) => this.#source(spec)))
    const rawSources = settledSources.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
    const taskResults = await Promise.all(CRAWLER_SOURCES.map(async (spec, index) => {
      const sourceResult = settledSources[index]
      if (sourceResult.status === 'rejected') {
        const error = taskError(sourceResult.reason)
        return { ...spec, source: null, configurationIssues: [error.message], error }
      }
      try {
        return await this.#task(spec, sourceResult.value)
      } catch (error) {
        const safeError = taskError(error)
        return {
          ...spec,
          source: safeSource(sourceResult.value),
          configurationIssues: [safeError.message],
          error: safeError,
        }
      }
    }))
    const [configuration, latestAttestation] = await Promise.all([
      rawSources.length === CRAWLER_SOURCES.length
        ? this.#configuration(rawSources)
        : Promise.resolve({
            databaseConnectionId: null,
            databaseConnection: null,
            connection: null,
            syncIntervalSeconds: null,
            connectionConsistent: false,
            databaseConnectionConsistent: false,
            syncIntervalConsistent: false,
            effectiveConnection: null,
            issues: taskResults.filter((task) => !task.source).map((task) => `${task.sourceKey} is not installed`),
          }),
      this.store.getLatestPipelineWriterContractAttestation?.(CRAWLER_PIPELINE_KEY) ?? null,
    ])
    return {
      pipelineKey: CRAWLER_PIPELINE_KEY,
      displayName: 'Night-All saved records 清洗任务',
      sourceTypes: [...CRAWLER_SOURCE_TYPES],
      builtInMappingVersion: CRAWLER_MAPPING_VERSION,
      status: pipelineStatus(taskResults),
      databaseConnectionId: configuration.databaseConnectionId,
      databaseConnection: configuration.databaseConnection,
      connection: configuration.databaseConnectionId || !configuration.connection
        ? null
        : safeTransport(configuration.connection),
      syncIntervalSeconds: configuration.syncIntervalSeconds,
      configured: configuration.issues.length === 0 && isConfigured(configuration.effectiveConnection),
      connectionConsistent: configuration.connectionConsistent,
      databaseConnectionConsistent: configuration.databaseConnectionConsistent,
      syncIntervalConsistent: configuration.syncIntervalConsistent,
      configurationIssues: configuration.issues,
      writerContract: { ...writerContract(), latestAttestation },
      serving: {
        mode: 'canonical-stored-only',
        authorization: 'independent-source-type-grant',
        defaultGranted: false,
        grants: CRAWLER_SOURCES.map((spec) => ({
          sourceType: spec.sourceType,
          platform: spec.platform,
          defaultGranted: false,
        })),
      },
      tasks: taskResults,
    }
  }

  async configure(body = {}) {
    const unsupported = unsupportedFields(body, new Set(['databaseConnectionId', 'connection', 'syncIntervalSeconds']))
    if (unsupported.length > 0) {
      throw new AppError(400, 'unsupported_fields', `Unsupported pipeline fields: ${unsupported.join(', ')}`)
    }
    const hasProfile = Object.prototype.hasOwnProperty.call(body, 'databaseConnectionId')
    const hasInline = body.connection != null
    if (hasProfile && hasInline) {
      throw new AppError(400, 'ambiguous_database_connection', 'Choose a shared database connection or task-owned credentials, not both')
    }
    if (!hasProfile && !hasInline && body.syncIntervalSeconds == null) {
      throw new AppError(400, 'invalid_request', 'databaseConnectionId, connection, or syncIntervalSeconds is required')
    }
    if (hasProfile && (typeof body.databaseConnectionId !== 'string' || !body.databaseConnectionId.trim())) {
      throw new AppError(400, 'invalid_database_connection_id', 'databaseConnectionId must be a non-empty UUID')
    }
    if (hasInline && (typeof body.connection !== 'object' || Array.isArray(body.connection))) {
      throw new AppError(400, 'invalid_connection', 'connection must be an object')
    }
    const unsupportedConnection = unsupportedFields(body.connection, SHARED_CONNECTION_FIELDS)
    if (unsupportedConnection.length > 0) {
      throw new AppError(
        400,
        'unsupported_pipeline_connection_fields',
        `Crawler table and cursor fields are fixed; unsupported connection fields: ${unsupportedConnection.join(', ')}`,
      )
    }
    const interval = syncInterval(body.syncIntervalSeconds)
    const intervalOnly = Object.keys(body).length === 1
      && Object.prototype.hasOwnProperty.call(body, 'syncIntervalSeconds')
    if (intervalOnly) {
      await this.store.updateExternalSourcesBatch(CRAWLER_SOURCES.map((spec) => ({
        sourceKey: spec.sourceKey,
        syncIntervalSeconds: interval,
      })))
      return this.get()
    }

    return this.#withLocks(CRAWLER_SOURCES, async (assertOwned) => {
      const sources = await this.#sources()
      if (sources.some((source) => source.status !== 'paused')) {
        throw new AppError(409, 'source_pause_required', 'Pause every crawler task before changing the shared connection')
      }
      const cursors = await Promise.all(sources.map((source) => this.#cursor(source.sourceKey)))
      if (cursors.some((cursor) => cursor?.status === 'running')) {
        throw new AppError(409, 'source_draining', 'Wait for every crawler task to reach a checkpoint')
      }

      const databaseConnectionId = hasProfile ? body.databaseConnectionId.trim() : null
      const existing = sources.every((source) => source.databaseConnectionId == null)
        ? sources.map((source) => sharedConnection(source.connection))
        : []
      const common = existing.length > 0 && existing.slice(1).every((value) => sameValue(value, existing[0]))
        ? existing[0]
        : {}
      const transport = hasInline ? { ...common, ...body.connection } : {}
      const candidate = {
        databaseConnectionId,
        connection: {
          ...(databaseConnectionId ? {} : transport),
          ...fixedConnection(CRAWLER_SOURCES[0]),
        },
      }
      delete candidate.connection.dsnEnv
      const resolved = await this.databasePuller.resolveConnectionCandidate(candidate)
      validateDatabaseConnection(resolved.connection)
      await this.databasePuller.testSourceCandidate(candidate)

      // Connection probes can outlive a PostgreSQL advisory-lock session.
      // Recheck ownership immediately before committing the shared update.
      await assertOwned()
      await this.store.updateExternalSourcesBatch(CRAWLER_SOURCES.map((spec) => ({
        sourceKey: spec.sourceKey,
        databaseConnectionId,
        connection: {
          ...(databaseConnectionId ? {} : transport),
          ...fixedConnection(spec),
        },
        ...(interval === undefined ? {} : { syncIntervalSeconds: interval }),
      })))
      return this.get()
    })
  }

  async setStatus(status, {
    sourceKey = null,
    sourceType = null,
    approvedBy = 'admin-token',
    writerContractAttestation = null,
  } = {}) {
    if (!['active', 'paused'].includes(status)) {
      throw new AppError(400, 'invalid_status', 'status must be active or paused')
    }
    if (sourceKey && sourceType) {
      throw new AppError(400, 'ambiguous_crawler_source', 'Choose sourceKey or sourceType, not both')
    }
    const identifier = sourceKey || sourceType
    const specs = identifier ? [this.#spec(identifier)] : CRAWLER_SOURCES
    if (status === 'paused') {
      await this.store.updateExternalSourcesBatch(specs.map((spec) => ({
        sourceKey: spec.sourceKey,
        status: 'paused',
      })))
      return this.get()
    }

    return this.#withLocks(specs, async (assertOwned) => {
      const allSources = await this.#sources()
      const selected = new Map(allSources.map((source) => [source.sourceKey, source]))
      const configuration = await this.#configuration(allSources, specs)
      if (configuration.issues.length > 0 || !isConfigured(configuration.effectiveConnection)) {
        throw new AppError(409, 'pipeline_configuration_drift', 'Crawler task configuration has drifted', {
          issues: configuration.issues,
        })
      }
      const sources = specs.map((spec) => selected.get(spec.sourceKey))
      const cursors = await Promise.all(sources.map((source) => this.#cursor(source.sourceKey)))
      if (cursors.some((cursor) => cursor?.status === 'running')) {
        throw new AppError(409, 'source_draining', 'Wait for selected crawler tasks to reach a checkpoint')
      }

      const mappingResults = await Promise.all(specs.map((spec, index) => (
        this.#builtInMapping(spec, sources[index])
      )))
      const descriptions = await Promise.all(specs.map((spec, index) => (
        this.databasePuller.describe(spec.sourceKey, { mappingOverride: mappingResults[index].builtIn })
      )))
      for (const [index, description] of descriptions.entries()) {
        const issues = crawlerProbeIssues(description, specs[index])
        if (issues.length > 0) {
          throw new AppError(
            409,
            'source_probe_failed',
            `Crawler source schema is not safe for incremental sync: ${specs[index].sourceKey}`,
            { sourceKey: specs[index].sourceKey, issues, warnings: description.warnings || [] },
          )
        }
      }
      for (const [index, spec] of specs.entries()) {
        await this.databasePuller.assertCheckpointCompatible(spec.sourceKey, {
          mappingOverride: mappingResults[index].builtIn,
        })
      }
      assertWriterContractAttestation(writerContractAttestation)
      // Schema probes and checkpoint checks are remote work. Do not activate
      // if the lock session was lost while they were running.
      await assertOwned()
      await this.store.activateExternalSourcesWithAttestation({
        sourceKeys: specs.map((spec) => spec.sourceKey),
        pipelineKey: CRAWLER_PIPELINE_KEY,
        contractVersion: CRAWLER_WRITER_CONTRACT_VERSION,
        contractDigest: CRAWLER_WRITER_CONTRACT_DIGEST,
        contractSummary: CRAWLER_WRITER_CONTRACT_SUMMARY,
        attestedBy: approvedBy,
        approvals: specs.flatMap((spec, index) => (
          mappingResults[index].active ? [] : [{
            mappingId: spec.mappingId,
            sourceId: sources[index].id,
            version: CRAWLER_MAPPING_VERSION,
          }]
        )),
      })
      return this.get()
    })
  }

  async setTaskStatus(sourceKey, status, options = {}) {
    return this.setStatus(status, { ...options, sourceKey })
  }

  async #syncCandidate(spec, { allowPaused }) {
    const source = await this.#source(spec)
    const contractIssues = crawlerSourceContractIssues(source, spec)
    if (contractIssues.length > 0) {
      throw new AppError(409, 'pipeline_source_contract_drift', `Crawler source contract has drifted: ${spec.sourceKey}`, {
        sourceKey: spec.sourceKey,
        issues: contractIssues,
      })
    }
    if (source.status !== 'active') {
      if (allowPaused) return { task: { sourceKey: spec.sourceKey, status: 'paused', scheduled: false }, job: null }
      throw new AppError(409, 'pipeline_paused', `Activate the crawler task before scheduling sync: ${spec.sourceKey}`)
    }
    const cursor = await this.#cursor(spec.sourceKey)
    if (cursor?.status === 'running') {
      return {
        task: { sourceKey: spec.sourceKey, status: 'running', jobId: null, alreadyScheduled: true },
        job: null,
      }
    }
    const mappingResult = await this.#builtInMapping(spec, source)
    if (!mappingResult.active) {
      throw new AppError(409, 'builtin_mapping_not_active', `Activate the fixed mapping before syncing ${spec.sourceKey}`)
    }
    const description = await this.databasePuller.describe(spec.sourceKey, {
      mappingOverride: mappingResult.builtIn,
    })
    const issues = crawlerProbeIssues(description, spec)
    if (issues.length > 0) {
      throw new AppError(409, 'source_probe_failed', `Crawler source schema is not safe for incremental sync: ${spec.sourceKey}`, {
        sourceKey: spec.sourceKey,
        issues,
      })
    }
    await this.databasePuller.assertCheckpointCompatible(spec.sourceKey, {
      mappingOverride: mappingResult.builtIn,
    })
    return { task: null, source, job: { sourceKey: spec.sourceKey } }
  }

  #job(spec, size) {
    return {
      sourceKey: spec.sourceKey,
      queue: EXTERNAL_PULL_QUEUE,
      payload: { sourceKey: spec.sourceKey, batchSize: size, trigger: 'manual', chunk: 0 },
      options: { dedupeKey: `external-pull:${spec.sourceKey}:0`, priority: 220 },
    }
  }

  async #assertCurrentAttestation() {
    const attestation = await this.store.getLatestPipelineWriterContractAttestation?.(CRAWLER_PIPELINE_KEY)
    if (!currentWriterContract(attestation)) {
      throw new AppError(
        409,
        'writer_contract_attestation_required',
        'Activate crawler tasks under the current writer contract before scheduling sync',
        { writerContract: writerContract() },
      )
    }
  }

  async syncOne(identifier, body = {}) {
    const unsupported = unsupportedFields(body, new Set(['batchSize']))
    if (unsupported.length > 0) {
      throw new AppError(400, 'unsupported_fields', `Unsupported sync fields: ${unsupported.join(', ')}`)
    }
    const spec = this.#spec(identifier)
    const size = batchSize(body.batchSize)
    await this.#assertCurrentAttestation()
    const candidate = await this.#syncCandidate(spec, { allowPaused: false })
    if (candidate.task) return { pipelineKey: CRAWLER_PIPELINE_KEY, task: candidate.task }
    const [jobId] = await enqueueJobsAtomically(this.queue, [this.#job(spec, size)], PIPELINE_ENQUEUE_ERRORS)
    return {
      pipelineKey: CRAWLER_PIPELINE_KEY,
      task: { sourceKey: spec.sourceKey, status: 'scheduled', jobId, alreadyScheduled: jobId === null },
    }
  }

  async syncAll(body = {}) {
    const unsupported = unsupportedFields(body, new Set(['batchSize']))
    if (unsupported.length > 0) {
      throw new AppError(400, 'unsupported_fields', `Unsupported sync fields: ${unsupported.join(', ')}`)
    }
    const size = batchSize(body.batchSize)
    await this.#assertCurrentAttestation()
    const settled = await Promise.allSettled(CRAWLER_SOURCES.map((spec) => (
      this.#syncCandidate(spec, { allowPaused: true })
    )))
    const tasks = new Array(CRAWLER_SOURCES.length)
    const jobs = []
    for (const [index, result] of settled.entries()) {
      const spec = CRAWLER_SOURCES[index]
      if (result.status === 'rejected') {
        tasks[index] = { sourceKey: spec.sourceKey, status: 'failed', scheduled: false, error: taskError(result.reason) }
      } else if (result.value.task) {
        tasks[index] = result.value.task
      } else {
        jobs.push({ ...this.#job(spec, size), resultIndex: index })
      }
    }
    const jobIds = await enqueueJobsAtomically(this.queue, jobs, PIPELINE_ENQUEUE_ERRORS)
    for (const [index, job] of jobs.entries()) {
      tasks[job.resultIndex] = {
        sourceKey: job.sourceKey,
        status: 'scheduled',
        jobId: jobIds[index],
        alreadyScheduled: jobIds[index] === null,
      }
    }
    return { pipelineKey: CRAWLER_PIPELINE_KEY, tasks }
  }

  async sync(body = {}) {
    const unsupported = unsupportedFields(body, new Set(['batchSize', 'sourceType']))
    if (unsupported.length > 0) {
      throw new AppError(400, 'unsupported_fields', `Unsupported sync fields: ${unsupported.join(', ')}`)
    }
    if (body.sourceType != null) {
      if (typeof body.sourceType !== 'string' || !body.sourceType.trim()) {
        throw new AppError(400, 'invalid_source_type', 'sourceType must be a non-empty string')
      }
      return this.syncOne(body.sourceType.trim(), { batchSize: body.batchSize })
    }
    return this.syncAll({ batchSize: body.batchSize })
  }

  async progress() {
    const checkedAt = new Date().toISOString()
    const settled = await Promise.allSettled(CRAWLER_SOURCES.map(async (spec) => ({
      sourceType: spec.sourceType,
      sourceKey: spec.sourceKey,
      ...await this.databasePuller.progress(spec.sourceKey),
      checkedAt,
    })))
    return {
      pipelineKey: CRAWLER_PIPELINE_KEY,
      checkedAt,
      tasks: settled.map((result, index) => result.status === 'fulfilled'
        ? result.value
        : {
            sourceType: CRAWLER_SOURCES[index].sourceType,
            sourceKey: CRAWLER_SOURCES[index].sourceKey,
            checkedAt,
            error: taskError(result.reason),
          }),
    }
  }

  async #resumeSpec(spec) {
    return this.#withLocks([spec], async (assertOwned) => {
      const source = await this.#source(spec)
      const cursor = await this.#cursor(spec.sourceKey)
      const abandoned = cursor?.status === 'running' && abandonedRun(source, cursor)
      if (cursor?.status !== 'failed' && !abandoned) {
        return { sourceKey: spec.sourceKey, status: cursor?.status ?? 'idle', resumed: false }
      }
      await assertOwned()
      await this.queue.saveCursor(
        `external:${spec.sourceKey}`,
        cursor.position ?? {},
        { status: 'idle', processedDelta: 0, error: null },
      )
      return {
        sourceKey: spec.sourceKey,
        status: 'idle',
        resumed: true,
        from: abandoned ? 'abandoned_run' : 'failed',
        silentForMs: abandoned ? cursorSilenceMs(cursor) : null,
        clearedError: cursor.error ?? null,
      }
    })
  }

  async resumeFailedTask(identifier) {
    return { pipelineKey: CRAWLER_PIPELINE_KEY, task: await this.#resumeSpec(this.#spec(identifier)) }
  }

  async resumeFailedTasks(identifier = null) {
    if (identifier) return this.resumeFailedTask(identifier)
    const settled = await Promise.allSettled(CRAWLER_SOURCES.map((spec) => this.#resumeSpec(spec)))
    return {
      pipelineKey: CRAWLER_PIPELINE_KEY,
      tasks: settled.map((result, index) => result.status === 'fulfilled'
        ? result.value
        : { sourceKey: CRAWLER_SOURCES[index].sourceKey, resumed: false, error: taskError(result.reason) }),
    }
  }

  async resetCheckpoint(identifier, confirmPipelineKey) {
    const spec = this.#spec(identifier)
    const result = await this.#resetSpecs([spec], confirmPipelineKey)
    return { pipelineKey: CRAWLER_PIPELINE_KEY, reset: result.resets[0] ?? null }
  }

  async resetCheckpoints(confirmPipelineKey) {
    return this.#resetSpecs(CRAWLER_SOURCES, confirmPipelineKey)
  }

  async #resetSpecs(specs, confirmPipelineKey) {
    if (confirmPipelineKey !== CRAWLER_PIPELINE_KEY) {
      throw new AppError(
        400,
        'checkpoint_reset_confirmation_required',
        `confirmPipelineKey must be ${CRAWLER_PIPELINE_KEY}`,
      )
    }
    const sources = await Promise.all(specs.map((spec) => this.#source(spec)))
    if (sources.some((source) => source.status !== 'paused')) {
      throw new AppError(409, 'source_pause_required', 'Pause selected crawler tasks before resetting checkpoints')
    }
    const mappingResults = await Promise.all(specs.map((spec, index) => (
      this.#builtInMapping(spec, sources[index])
    )))
    const mappingOverrides = Object.fromEntries(specs.map((spec, index) => [
      spec.sourceKey,
      mappingResults[index].builtIn,
    ]))
    const resets = await this.databasePuller.resetCheckpoints(
      specs.map((spec) => spec.sourceKey),
      { mappingOverrides },
    )
    return { pipelineKey: CRAWLER_PIPELINE_KEY, resets }
  }
}
