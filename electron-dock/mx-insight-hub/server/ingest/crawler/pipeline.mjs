import { AppError } from '../../core/errors.mjs'
import { enqueueJobsAtomically } from '../external/atomic-enqueue.mjs'
import { validateDatabaseConnection } from '../external/database-source.mjs'
import { EXTERNAL_PULL_QUEUE } from '../external/sync-job.mjs'
import {
  CRAWLER_MAPPING_VERSION,
  CRAWLER_PIPELINE_KEY,
  CRAWLER_SOURCE_TYPES,
  CRAWLER_WRITER_CONTRACT_DIGEST,
  CRAWLER_WRITER_CONTRACT_SUMMARY,
  CRAWLER_WRITER_CONTRACT_VERSION,
  crawlerSourceSpec,
  crawlerSourceSpecForKey,
  crawlerWriterContractForSpec,
  listCrawlerSpecs,
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
  if (tasks.length > 0 && tasks.every((task) => task.source?.status === 'active')) return 'active'
  if (tasks.length > 0 && tasks.every((task) => task.source?.status === 'paused')) return 'paused'
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
    const spec = crawlerSourceSpecForKey(identifier) || crawlerSourceSpec(identifier)
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
    return Promise.all((await listCrawlerSpecs(this.store)).map((spec) => this.#source(spec)))
  }

  async #cursor(sourceKey) {
    return this.queue?.getCursor?.(`external:${sourceKey}`) ?? null
  }

  async #withLocks(specs, operation) {
    if (typeof this.databasePuller?.withSourceLocks !== 'function') {
      throw new AppError(503, 'source_lock_unavailable', 'Crawler changes require source locking')
    }
    return this.databasePuller.withSourceLocks([CRAWLER_PIPELINE_KEY, ...specs.map((spec) => spec.sourceKey)], operation)
  }

  async #configuration(sources, contractSpecs = sources.map(source => crawlerSourceSpecForKey(source.sourceKey))) {
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
    const specs = await listCrawlerSpecs(this.store)
    const settledSources = await Promise.allSettled(specs.map((spec) => this.#source(spec)))
    const rawSources = settledSources.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
    const taskResults = await Promise.all(specs.map(async (spec, index) => {
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
      rawSources.length === specs.length
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
      displayName: 'Night-All-A 数据清洗任务',
      sourceTypes: specs.map(spec => spec.sourceType),
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
      writerContract: { ...writerContract(), latestAttestation,
        sourceContracts: specs.filter(spec => !CRAWLER_SOURCE_TYPES.includes(spec.sourceType)).map(crawlerWriterContractForSpec),
      },
      discovery: await this.store.getCrawlerDiscoveryState?.() ?? null,
      serving: {
        mode: 'canonical-stored-only',
        authorization: 'independent-source-type-grant',
        defaultGranted: false,
        grants: specs.map((spec) => ({
          sourceType: spec.sourceType,
          platform: spec.platform,
          defaultGranted: false,
        })),
      },
      tasks: taskResults,
    }
  }

  async discover() {
    if (!this.store.registerCrawlerSource || !this.databasePuller?.discoverCrawlerCategories) {
      throw new AppError(503, 'crawler_discovery_unavailable', '类别发现需要 PostgreSQL 清洗服务')
    }
    await this.databasePuller.withSourceLocks([CRAWLER_PIPELINE_KEY], async assertOwned => {
      const sources = await this.#sources()
      const config = await this.#configuration(sources)
      if (!config.connectionConsistent || !isConfigured(config.effectiveConnection)) {
        throw new AppError(409, 'pipeline_configuration_drift', '先配置一致的只读源库连接，再发现类别')
      }
      const result = await this.databasePuller.discoverCrawlerCategories(sources[0].sourceKey)
      const items = []
      for (const candidate of result.candidates) {
        const { spec, ...item } = candidate
        item.issues = [...item.issues]
        item.registered = sources.some(source => source.sourceKey === spec?.sourceKey)
        if (spec && item.issues.length === 0 && !item.registered) {
          try {
            await assertOwned()
            await this.store.registerCrawlerSource(spec, sources[0])
            item.registered = true
          } catch (error) {
            item.issues.push(error?.code === 'crawler_scope_conflict' ? error.message : '类别注册失败；请核对 Hub 数据库后重试')
          }
        }
        items.push(item)
      }
      const state = { checkedAt: new Date().toISOString(), items, warnings: result.warnings || [] }
      await assertOwned()
      await this.store.saveCrawlerDiscoveryState(state)
    })
    // Activation is a separate bounded step under the same source locks. A crash
    // after registration is recoverable from the transactionally stored intent.
    await this.activateDiscoveredCategories()
    return this.get()
  }

  async activateDiscoveredCategories() {
    const pending = await this.store.listCrawlerAutoActivationPending?.() || []
    const failures = []
    for (const sourceKey of pending) {
      const spec = this.#spec(sourceKey)
      try {
        await this.setStatus('active', {
          sourceKey, approvedBy: 'system:category-discovery', automatic: true,
          writerContractAttestation: { confirmed: true,
            contractVersion: CRAWLER_WRITER_CONTRACT_VERSION, contractDigest: CRAWLER_WRITER_CONTRACT_DIGEST,
            sourceContracts: [crawlerWriterContractForSpec(spec)],
          },
        })
      } catch (error) {
        failures.push({ sourceKey, sourceType: spec.sourceType, code: error?.code || 'category_activation_failed' })
      }
    }
    const previous = await this.store.getCrawlerDiscoveryState?.()
    if (previous) await this.store.saveCrawlerDiscoveryState({ ...previous, activationFailures: failures })
    return failures
  }

  async configure(body = {}) {
    const specs = await listCrawlerSpecs(this.store)
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
      await this.store.updateExternalSourcesBatch(specs.map((spec) => ({
        sourceKey: spec.sourceKey,
        syncIntervalSeconds: interval,
      })))
      return this.get()
    }

    return this.#withLocks(specs, async (assertOwned) => {
      specs.splice(0, specs.length, ...await listCrawlerSpecs(this.store))
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
          ...fixedConnection(specs[0]),
        },
      }
      delete candidate.connection.dsnEnv
      const resolved = await this.databasePuller.resolveConnectionCandidate(candidate)
      validateDatabaseConnection(resolved.connection)
      await this.databasePuller.testSourceCandidate(candidate)

      // Connection probes can outlive a PostgreSQL advisory-lock session.
      // Recheck ownership immediately before committing the shared update.
      await assertOwned()
      await this.store.updateExternalSourcesBatch(specs.map((spec) => ({
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
    automatic = false,
  } = {}) {
    if (!['active', 'paused'].includes(status)) {
      throw new AppError(400, 'invalid_status', 'status must be active or paused')
    }
    if (sourceKey && sourceType) {
      throw new AppError(400, 'ambiguous_crawler_source', 'Choose sourceKey or sourceType, not both')
    }
    const identifier = sourceKey || sourceType
    const specs = identifier ? [this.#spec(identifier)] : await listCrawlerSpecs(this.store)
    if (status === 'paused') {
      return this.databasePuller.withSourceLocks([CRAWLER_PIPELINE_KEY], async () => {
        await this.store.settleCrawlerAutoActivation?.(specs.map(spec => spec.sourceKey), approvedBy)
        await this.store.updateExternalSourcesBatch(specs.map(spec => ({ sourceKey: spec.sourceKey, status: 'paused' })))
        return this.get()
      })
    }

    return this.#withLocks(specs, async (assertOwned) => {
      if (automatic) {
        const pending = await this.store.listCrawlerAutoActivationPending?.() || []
        if (!specs.every(spec => pending.includes(spec.sourceKey))) return null
        // Auto-discovered leaves inherit the operator-reviewed writer guarantees
        // of this existing pipeline; schema probes cannot invent those guarantees.
        await this.#assertCurrentAttestation()
      }
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
      const additionalContracts = specs.filter(spec => !CRAWLER_SOURCE_TYPES.includes(spec.sourceType)).map(crawlerWriterContractForSpec)
      for (const contract of additionalContracts) {
        if (!writerContractAttestation.sourceContracts?.some(value => value.pipelineKey === contract.pipelineKey
          && value.version === contract.version && value.digest === contract.digest)) {
          throw new AppError(409, 'writer_contract_attestation_required', '请刷新并确认新增类别的独立 writer 合同')
        }
      }
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
        additionalContracts,
        automatic,
        approvals: specs.flatMap((spec, index) => (
          mappingResults[index].active ? [] : [{
            mappingId: spec.mappingId,
            sourceId: sources[index].id,
            version: CRAWLER_MAPPING_VERSION,
          }]
        )),
      })
      return automatic ? null : this.get()
    })
  }

  async setTaskStatus(sourceKey, status, options = {}) {
    return this.setStatus(status, { ...options, sourceKey })
  }

  async #syncCandidate(spec, { allowPaused }) {
    if (!CRAWLER_SOURCE_TYPES.includes(spec.sourceType)) {
      const contract = crawlerWriterContractForSpec(spec)
      const attestation = await this.store.getLatestPipelineWriterContractAttestation?.(contract.pipelineKey)
      if (attestation?.contractDigest !== contract.digest || attestation?.contractVersion !== contract.version) {
        throw new AppError(409, 'writer_contract_attestation_required', '新增类别需要独立确认 writer 合同')
      }
    }
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
    const specs = await listCrawlerSpecs(this.store)
    const unsupported = unsupportedFields(body, new Set(['batchSize']))
    if (unsupported.length > 0) {
      throw new AppError(400, 'unsupported_fields', `Unsupported sync fields: ${unsupported.join(', ')}`)
    }
    const size = batchSize(body.batchSize)
    await this.#assertCurrentAttestation()
    const settled = await Promise.allSettled(specs.map((spec) => (
      this.#syncCandidate(spec, { allowPaused: true })
    )))
    const tasks = new Array(specs.length)
    const jobs = []
    for (const [index, result] of settled.entries()) {
      const spec = specs[index]
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
    const specs = await listCrawlerSpecs(this.store)
    const checkedAt = new Date().toISOString()
    const settled = await Promise.allSettled(specs.map(async (spec) => ({
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
            sourceType: specs[index].sourceType,
            sourceKey: specs[index].sourceKey,
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
    const specs = await listCrawlerSpecs(this.store)
    if (identifier) return this.resumeFailedTask(identifier)
    const settled = await Promise.allSettled(specs.map((spec) => this.#resumeSpec(spec)))
    return {
      pipelineKey: CRAWLER_PIPELINE_KEY,
      tasks: settled.map((result, index) => result.status === 'fulfilled'
        ? result.value
        : { sourceKey: specs[index].sourceKey, resumed: false, error: taskError(result.reason) }),
    }
  }

  async resetCheckpoint(identifier, confirmPipelineKey) {
    const spec = this.#spec(identifier)
    const result = await this.#resetSpecs([spec], confirmPipelineKey)
    return { pipelineKey: CRAWLER_PIPELINE_KEY, reset: result.resets[0] ?? null }
  }

  async resetCheckpoints(confirmPipelineKey) {
    return this.#resetSpecs(await listCrawlerSpecs(this.store), confirmPipelineKey)
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
