import { AppError } from '../../core/errors.mjs'
import { enqueueJobsAtomically } from '../external/atomic-enqueue.mjs'
import { EXTERNAL_PULL_QUEUE } from '../external/sync-job.mjs'

export const TELEGRAM_SQLITE_PIPELINE_KEY = 'telegram-sqlite'
export const TELEGRAM_SQLITE_MAPPING_VERSION = 1

export const TELEGRAM_SQLITE_INPUTS = Object.freeze([
  Object.freeze({
    role: 'chats',
    sourceKey: 'telegram-sqlite-api-chats',
    endpoint: '/v1/chats',
    resource: 'chats',
    pageSize: 500,
    datasetId: 'telegram.sqlite.chats.v1',
    dataset: 'telegram.sqlite.chats.v1',
    objectType: 'chat',
    builtInMappingVersion: TELEGRAM_SQLITE_MAPPING_VERSION,
    builtInMappingId: 'e360ebf5-f353-4338-a16f-087a29290959',
  }),
  Object.freeze({
    role: 'messages',
    sourceKey: 'telegram-sqlite-api-messages',
    endpoint: '/v1/messages?include_deleted=true',
    resource: 'messages',
    pageSize: 500,
    datasetId: 'telegram.sqlite.messages.v1',
    dataset: 'telegram.sqlite.messages.v1',
    objectType: 'message',
    builtInMappingVersion: TELEGRAM_SQLITE_MAPPING_VERSION,
    builtInMappingId: 'a89be04c-4a9c-4f75-b234-f9b75e89e56f',
  }),
])

export const TELEGRAM_SQLITE_SOURCE_KEYS = new Set(
  TELEGRAM_SQLITE_INPUTS.map((input) => input.sourceKey),
)

/**
 * The upstream list API has no monotonic change cursor. This policy therefore
 * describes an eventual-reconciliation contract, not an exact CDC contract.
 */
export const TELEGRAM_SQLITE_STRATEGY = Object.freeze({
  consistency: 'eventual',
  initialSync: 'full',
  incrementalSync: '24h_overlap',
  overlapSeconds: 86_400,
  reconciliation: 'daily_full',
  fullReconcileIntervalSeconds: 86_400,
  deletionRule: 'explicit_deleted_at_only',
})

const SHARED_CONNECTION_FIELDS = new Set(['baseUrl', 'token'])
const PIPELINE_ENQUEUE_ERRORS = Object.freeze({
  unavailable: {
    code: 'atomic_enqueue_unavailable',
    message: 'Telegram SQLite sync requires the PostgreSQL queue',
  },
  failed: {
    code: 'pipeline_sync_enqueue_failed',
    message: 'No Telegram SQLite task was scheduled; retry when the PostgreSQL queue is available',
  },
  outcomeUnknown: {
    code: 'pipeline_sync_enqueue_outcome_unknown',
    message: 'The Telegram SQLite sync transaction outcome is unknown; inspect both task queues before retrying',
  },
})

export function isTelegramSQLiteSourceKey(sourceKey) {
  return TELEGRAM_SQLITE_SOURCE_KEYS.has(sourceKey)
}

function unsupportedFields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.keys(value).filter((field) => !allowed.has(field))
}

function hasOwn(value, field) {
  return Object.prototype.hasOwnProperty.call(value || {}, field)
}

function tokenConfigured(token) {
  return typeof token === 'string' && token.trim().length > 0
}

function safeConnection(connection = {}, { includeFixed = false } = {}) {
  return {
    baseUrl: connection.baseUrl ?? null,
    tokenConfigured: tokenConfigured(connection.token),
    ...(includeFixed
      ? {
          resource: connection.resource ?? null,
          pageSize: connection.pageSize ?? null,
        }
      : {}),
  }
}

function sharedConnection(connection = {}) {
  return {
    baseUrl: connection.baseUrl ?? null,
    token: connection.token ?? null,
  }
}

function sameSharedConnection(left, right) {
  return left?.baseUrl === right?.baseUrl && left?.token === right?.token
}

function isConfigured(connection) {
  return typeof connection?.baseUrl === 'string'
    && connection.baseUrl.trim().length > 0
    && tokenConfigured(connection.token)
}

function pipelineStatus(sources) {
  if (sources.every((source) => source.status === 'active')) return 'active'
  if (sources.every((source) => source.status === 'paused')) return 'paused'
  return 'mixed'
}

function nextDueAt(source, cursor) {
  const updatedAt = cursor?.updated_at ?? cursor?.updatedAt ?? null
  if (!updatedAt || source.syncIntervalSeconds == null) return null
  return new Date(new Date(updatedAt).getTime() + source.syncIntervalSeconds * 1_000).toISOString()
}

function syncInterval(value) {
  if (value == null) return undefined
  if (!Number.isInteger(value) || value < 60 || value > 86_400) {
    throw new AppError(400, 'invalid_sync_interval', 'syncIntervalSeconds must be between 60 and 86400')
  }
  return value
}

function batchSize(value) {
  const size = value ?? 500
  if (!Number.isInteger(size) || size < 1 || size > 500) {
    throw new AppError(400, 'invalid_batch_size', 'batchSize must be an integer between 1 and 500')
  }
  return size
}

function redactSecrets(value, secrets) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Date) return value
  if (typeof value === 'string') {
    return secrets.reduce((result, secret) => result.replaceAll(secret, '[redacted]'), value)
  }
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, secrets))
  if (typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    const normalized = key.toLowerCase()
    if (normalized === 'token' || normalized === 'authorization' || normalized === 'password') return []
    return [[key, redactSecrets(item, secrets)]]
  }))
}

function pipelineConfiguration(sources) {
  const shared = sources.map((source) => sharedConnection(source.connection))
  const intervals = sources.map((source) => source.syncIntervalSeconds)
  const connectionConsistent = shared.slice(1).every((value) => sameSharedConnection(value, shared[0]))
  const syncIntervalConsistent = intervals.slice(1).every((value) => value === intervals[0])
  const inputIssues = []

  for (const [index, source] of sources.entries()) {
    const input = TELEGRAM_SQLITE_INPUTS[index]
    if (source.connection?.resource !== input.resource) {
      inputIssues.push(`${input.sourceKey} resource must be ${input.resource}`)
    }
    if (source.connection?.pageSize !== input.pageSize) {
      inputIssues.push(`${input.sourceKey} pageSize must be ${input.pageSize}`)
    }
    if (source.datasetId !== input.datasetId) {
      inputIssues.push(`${input.sourceKey} dataset must be ${input.datasetId}`)
    }
    if (source.platform !== 'telegram' || source.objectType !== input.objectType) {
      inputIssues.push(`${input.sourceKey} canonical scope does not match the built-in pipeline`)
    }
  }

  const issues = [...inputIssues]
  if (!connectionConsistent) issues.push('Telegram SQLite tasks do not share one connection')
  if (!syncIntervalConsistent) issues.push('Telegram SQLite tasks do not share one sync interval')
  return {
    connection: connectionConsistent ? shared[0] : null,
    syncIntervalSeconds: syncIntervalConsistent ? intervals[0] : null,
    connectionConsistent,
    syncIntervalConsistent,
    inputContractsConsistent: inputIssues.length === 0,
    issues,
  }
}

function safeSource(source) {
  return {
    ...source,
    connection: safeConnection(source.connection, { includeFixed: true }),
  }
}

export class TelegramSQLitePipeline {
  constructor({ store, queue, sqliteApiPuller }) {
    this.store = store
    this.queue = queue
    this.sqliteApiPuller = sqliteApiPuller
  }

  async #source(input) {
    const source = await this.store.getExternalSource(input.sourceKey)
    if (!source) {
      throw new AppError(404, 'pipeline_source_not_found', `Telegram SQLite source is not installed: ${input.sourceKey}`)
    }
    if (source.sourceKind !== 'sqlite_api') {
      throw new AppError(409, 'pipeline_source_invalid', `Telegram SQLite source has the wrong kind: ${input.sourceKey}`)
    }
    return source
  }

  async #sources() {
    return Promise.all(TELEGRAM_SQLITE_INPUTS.map((input) => this.#source(input)))
  }

  async #cursor(sourceKey) {
    return this.queue?.getCursor?.(`external:${sourceKey}`) ?? null
  }

  async #withLocks(operation) {
    if (typeof this.sqliteApiPuller?.withSourceLocks !== 'function') {
      throw new AppError(503, 'source_lock_unavailable', 'Telegram SQLite changes require source locking')
    }
    return this.sqliteApiPuller.withSourceLocks(
      TELEGRAM_SQLITE_INPUTS.map((input) => input.sourceKey),
      operation,
    )
  }

  async #builtInMapping(source, input) {
    const mappings = await this.store.listSourceMappings(source.id)
    const builtIn = mappings.find((mapping) => (
      mapping.id === input.builtInMappingId && mapping.version === input.builtInMappingVersion
    ))
    if (!builtIn) {
      throw new AppError(409, 'builtin_mapping_conflict', `Seeded built-in mapping is missing or collides for ${input.sourceKey}`)
    }
    return builtIn
  }

  async #task(input, source, secrets) {
    const [activeMapping, mappings, cursor, runs] = await Promise.all([
      this.store.getActiveMapping(source.id),
      this.store.listSourceMappings(source.id),
      this.#cursor(source.sourceKey),
      this.store.listImportRuns(source.id, 1),
    ])
    return redactSecrets({
      ...input,
      source: safeSource(source),
      activeMapping,
      builtInMappingAvailable: mappings.some((mapping) => (
        mapping.id === input.builtInMappingId && mapping.version === input.builtInMappingVersion
      )),
      cursor,
      latestRun: runs[0] ?? null,
      nextDueAt: nextDueAt(source, cursor),
    }, secrets)
  }

  async get() {
    const sources = await this.#sources()
    const configuration = pipelineConfiguration(sources)
    const secrets = sources
      .map((source) => source.connection?.token)
      .filter((token) => tokenConfigured(token))
    const tasks = await Promise.all(TELEGRAM_SQLITE_INPUTS.map((input, index) => (
      this.#task(input, sources[index], secrets)
    )))
    const configured = configuration.issues.length === 0 && isConfigured(configuration.connection)
    return {
      pipelineKey: TELEGRAM_SQLITE_PIPELINE_KEY,
      displayName: 'Telegram SQLite API',
      builtInMappingVersion: TELEGRAM_SQLITE_MAPPING_VERSION,
      status: pipelineStatus(sources),
      draining: tasks.some((task) => task.cursor?.status === 'running'),
      connection: configuration.connection ? safeConnection(configuration.connection) : null,
      syncIntervalSeconds: configuration.syncIntervalSeconds,
      configured,
      connectionConsistent: configuration.connectionConsistent,
      syncIntervalConsistent: configuration.syncIntervalConsistent,
      inputContractsConsistent: configuration.inputContractsConsistent,
      configurationIssues: configuration.issues,
      strategy: TELEGRAM_SQLITE_STRATEGY,
      tasks,
    }
  }

  async configure(body = {}) {
    const unsupported = unsupportedFields(body, new Set(['connection', 'syncIntervalSeconds']))
    if (unsupported.length > 0) {
      throw new AppError(400, 'unsupported_fields', `Unsupported pipeline fields: ${unsupported.join(', ')}`)
    }
    if (body.connection == null && body.syncIntervalSeconds == null) {
      throw new AppError(400, 'invalid_request', 'connection or syncIntervalSeconds is required')
    }
    if (body.connection != null && (typeof body.connection !== 'object' || Array.isArray(body.connection))) {
      throw new AppError(400, 'invalid_connection', 'connection must be an object')
    }
    const unsupportedConnection = unsupportedFields(body.connection, SHARED_CONNECTION_FIELDS)
    if (unsupportedConnection.length > 0) {
      throw new AppError(
        400,
        'unsupported_pipeline_connection_fields',
        `Telegram SQLite resources and page size are fixed; unsupported connection fields: ${unsupportedConnection.join(', ')}`,
      )
    }
    if (hasOwn(body.connection, 'baseUrl') && (
      typeof body.connection.baseUrl !== 'string' || body.connection.baseUrl.trim().length === 0
    )) {
      throw new AppError(400, 'invalid_connection', 'baseUrl must be a non-empty string')
    }
    if (hasOwn(body.connection, 'token') && typeof body.connection.token !== 'string') {
      throw new AppError(400, 'invalid_connection', 'token must be a string')
    }
    const interval = syncInterval(body.syncIntervalSeconds)

    return this.#withLocks(async () => {
      const sources = await this.#sources()
      if (sources.some((source) => source.status !== 'paused')) {
        throw new AppError(409, 'source_pause_required', 'Pause the Telegram SQLite pipeline before changing its configuration')
      }
      const cursors = await Promise.all(sources.map((source) => this.#cursor(source.sourceKey)))
      if (cursors.some((cursor) => cursor?.status === 'running')) {
        throw new AppError(409, 'source_draining', 'Wait for both Telegram SQLite tasks to reach a checkpoint')
      }

      let requestedConnection = null
      if (body.connection != null) {
        const existing = sources.map((source) => sharedConnection(source.connection))
        const commonBaseUrl = existing.slice(1).every((item) => item.baseUrl === existing[0].baseUrl)
          ? existing[0].baseUrl
          : null
        const commonToken = existing.slice(1).every((item) => item.token === existing[0].token)
          ? existing[0].token
          : null
        const requestedToken = body.connection.token?.trim().length > 0
          ? body.connection.token
          : commonToken
        requestedConnection = {
          baseUrl: hasOwn(body.connection, 'baseUrl') ? body.connection.baseUrl : commonBaseUrl,
          token: requestedToken,
        }
        if (!isConfigured(requestedConnection)) {
          throw new AppError(
            400,
            'invalid_connection',
            'A shared baseUrl and non-empty token are required; a blank token only preserves an existing shared token',
          )
        }
        if (typeof this.sqliteApiPuller?.testConnection !== 'function') {
          throw new AppError(503, 'source_validation_unavailable', 'Telegram SQLite connection validation is unavailable')
        }
        await Promise.all(TELEGRAM_SQLITE_INPUTS.map((input) => (
          this.sqliteApiPuller.testConnection({
            ...requestedConnection,
            resource: input.resource,
            pageSize: input.pageSize,
          })
        )))
      }

      await this.store.updateExternalSourcesBatch(TELEGRAM_SQLITE_INPUTS.map((input) => ({
        sourceKey: input.sourceKey,
        ...(requestedConnection
          ? {
              connection: {
                ...requestedConnection,
                resource: input.resource,
                pageSize: input.pageSize,
              },
            }
          : {}),
        ...(interval === undefined ? {} : { syncIntervalSeconds: interval }),
      })))
      return this.get()
    })
  }

  async setStatus(status, { approvedBy = 'admin-token' } = {}) {
    if (!['active', 'paused'].includes(status)) {
      throw new AppError(400, 'invalid_status', 'status must be active or paused')
    }

    // Pausing is deliberately lock-free: changing both statuses first prevents
    // another chunk from being scheduled while an in-flight chunk drains to its
    // durable checkpoint.
    if (status === 'paused') {
      const sources = await this.#sources()
      await this.store.updateExternalSourcesBatch(sources.map((source) => ({
        sourceKey: source.sourceKey,
        status: 'paused',
      })))
      return this.get()
    }

    return this.#withLocks(async () => {
      const sources = await this.#sources()
      const configuration = pipelineConfiguration(sources)
      if (configuration.issues.length > 0) {
        throw new AppError(409, 'pipeline_configuration_drift', 'Telegram SQLite task configuration has drifted', {
          issues: configuration.issues,
        })
      }
      if (!isConfigured(configuration.connection)) {
        throw new AppError(409, 'pipeline_configuration_required', 'Configure the Telegram SQLite API before activation')
      }
      const allPaused = sources.every((source) => source.status === 'paused')
      const allActive = sources.every((source) => source.status === 'active')
      if (!allPaused && !allActive) {
        throw new AppError(409, 'pipeline_mixed_status', 'Pause both Telegram SQLite tasks before activating the pipeline')
      }
      const cursors = await Promise.all(sources.map((source) => this.#cursor(source.sourceKey)))
      if (cursors.some((cursor) => cursor?.status === 'running')) {
        throw new AppError(409, 'source_draining', 'Wait for both Telegram SQLite tasks to reach a checkpoint')
      }
      if (typeof this.sqliteApiPuller?.testConnection !== 'function') {
        throw new AppError(503, 'source_validation_unavailable', 'Telegram SQLite connection validation is unavailable')
      }
      await this.sqliteApiPuller.testConnection({
        ...configuration.connection,
        resource: TELEGRAM_SQLITE_INPUTS[0].resource,
        pageSize: TELEGRAM_SQLITE_INPUTS[0].pageSize,
      })

      const targetMappings = []
      const approvals = []
      for (const [index, source] of sources.entries()) {
        const input = TELEGRAM_SQLITE_INPUTS[index]
        const active = await this.store.getActiveMapping(source.id)
        if (active) {
          if (active.id !== input.builtInMappingId || active.version !== input.builtInMappingVersion) {
            throw new AppError(409, 'builtin_mapping_conflict', `A non-built-in mapping is active for ${input.sourceKey}`)
          }
          targetMappings.push(active)
          continue
        }
        const builtIn = await this.#builtInMapping(source, input)
        targetMappings.push(builtIn)
        approvals.push({
          mappingId: input.builtInMappingId,
          sourceId: source.id,
          version: input.builtInMappingVersion,
        })
      }

      const descriptions = await Promise.all(TELEGRAM_SQLITE_INPUTS.map((input, index) => (
        this.sqliteApiPuller.describe(input.sourceKey, { mappingOverride: targetMappings[index] })
      )))
      const blockedIndex = descriptions.findIndex((description) => description.issues?.length > 0)
      if (blockedIndex >= 0) {
        const input = TELEGRAM_SQLITE_INPUTS[blockedIndex]
        throw new AppError(409, 'source_probe_failed', `Source contract is not safe for sync: ${input.sourceKey}`, {
          sourceKey: input.sourceKey,
          issues: descriptions[blockedIndex].issues,
        })
      }
      for (const [index, input] of TELEGRAM_SQLITE_INPUTS.entries()) {
        await this.sqliteApiPuller.assertCheckpointCompatible(input.sourceKey, {
          mappingOverride: targetMappings[index],
        })
      }

      if (approvals.length > 0) {
        if (typeof this.store.approveSourceMappingsBatch !== 'function') {
          throw new AppError(503, 'pipeline_activation_unavailable', 'Atomic built-in mapping approval is unavailable')
        }
        const approved = await this.store.approveSourceMappingsBatch({ approvals, approvedBy })
        if (approved.length !== approvals.length) {
          throw new AppError(409, 'builtin_mapping_conflict', 'Not every built-in mapping was approved')
        }
      }
      await this.store.updateExternalSourcesBatch(sources.map((source) => ({
        sourceKey: source.sourceKey,
        status: 'active',
      })))
      return this.get()
    })
  }

  async resetCheckpoints(confirmPipelineKey) {
    if (confirmPipelineKey !== TELEGRAM_SQLITE_PIPELINE_KEY) {
      throw new AppError(
        400,
        'checkpoint_reset_confirmation_required',
        `confirmPipelineKey must be ${TELEGRAM_SQLITE_PIPELINE_KEY}`,
      )
    }
    const sources = await this.#sources()
    if (sources.some((source) => source.status !== 'paused')) {
      throw new AppError(409, 'source_pause_required', 'Pause the Telegram SQLite pipeline before resetting checkpoints')
    }
    const cursors = await Promise.all(sources.map((source) => this.#cursor(source.sourceKey)))
    if (cursors.some((cursor) => cursor?.status === 'running')) {
      throw new AppError(409, 'source_draining', 'Wait for both Telegram SQLite tasks to reach a checkpoint')
    }
    const mappingOverrides = {}
    for (const [index, input] of TELEGRAM_SQLITE_INPUTS.entries()) {
      mappingOverrides[input.sourceKey] = await this.#builtInMapping(sources[index], input)
    }
    if (typeof this.sqliteApiPuller?.resetCheckpoints !== 'function') {
      throw new AppError(503, 'checkpoint_reset_unavailable', 'Telegram SQLite checkpoint reset is unavailable')
    }
    const resets = await this.sqliteApiPuller.resetCheckpoints(
      TELEGRAM_SQLITE_INPUTS.map((input) => input.sourceKey),
      { mappingOverrides },
    )
    return { pipelineKey: TELEGRAM_SQLITE_PIPELINE_KEY, strategy: TELEGRAM_SQLITE_STRATEGY, resets }
  }

  async sync(body = {}) {
    const unsupported = unsupportedFields(body, new Set(['batchSize']))
    if (unsupported.length > 0) {
      throw new AppError(400, 'unsupported_fields', `Unsupported sync fields: ${unsupported.join(', ')}`)
    }
    const size = batchSize(body.batchSize)
    const sources = await this.#sources()
    if (sources.some((source) => source.status !== 'active')) {
      throw new AppError(409, 'pipeline_paused', 'Activate both Telegram SQLite tasks before scheduling sync')
    }
    const cursors = await Promise.all(sources.map((source) => this.#cursor(source.sourceKey)))
    const pending = sources.filter((_source, index) => cursors[index]?.status !== 'running')
    for (const source of pending) {
      const description = await this.sqliteApiPuller.describe(source.sourceKey)
      if (description.issues?.length > 0) {
        throw new AppError(409, 'source_probe_failed', `Source contract is not safe for sync: ${source.sourceKey}`, {
          sourceKey: source.sourceKey,
          issues: description.issues,
        })
      }
    }

    const scheduled = new Array(sources.length)
    const jobs = []
    for (const [index, source] of sources.entries()) {
      if (cursors[index]?.status === 'running') {
        scheduled[index] = { sourceKey: source.sourceKey, jobId: null, alreadyScheduled: true }
        continue
      }
      jobs.push({
        resultIndex: index,
        sourceKey: source.sourceKey,
        queue: EXTERNAL_PULL_QUEUE,
        payload: { sourceKey: source.sourceKey, batchSize: size, trigger: 'manual', chunk: 0 },
        options: { dedupeKey: `external-pull:${source.sourceKey}:0`, priority: 220 },
      })
    }
    const jobIds = await enqueueJobsAtomically(this.queue, jobs, PIPELINE_ENQUEUE_ERRORS)
    for (const [index, job] of jobs.entries()) {
      scheduled[job.resultIndex] = {
        sourceKey: job.sourceKey,
        jobId: jobIds[index],
        alreadyScheduled: jobIds[index] === null,
      }
    }
    return {
      pipelineKey: TELEGRAM_SQLITE_PIPELINE_KEY,
      strategy: TELEGRAM_SQLITE_STRATEGY,
      tasks: scheduled,
    }
  }

  async progress() {
    const checkedAt = new Date().toISOString()
    const sources = await this.#sources()
    const secrets = sources
      .map((source) => source.connection?.token)
      .filter((token) => tokenConfigured(token))
    const tasks = await Promise.all(TELEGRAM_SQLITE_INPUTS.map(async (input) => ({
      role: input.role,
      sourceKey: input.sourceKey,
      ...(await this.sqliteApiPuller.progress(input.sourceKey)),
      checkedAt,
    })))
    const totalsKnown = tasks.every((task) => Number.isFinite(task.totalRows))
    const complete = totalsKnown && tasks.every((task) => (
      Number.isFinite(task.completedRows) && Number.isFinite(task.remainingRows)
    ))
    const totalRows = totalsKnown ? tasks.reduce((sum, task) => sum + task.totalRows, 0) : null
    const completedRows = complete ? tasks.reduce((sum, task) => sum + task.completedRows, 0) : null
    const remainingRows = complete ? tasks.reduce((sum, task) => sum + task.remainingRows, 0) : null
    return redactSecrets({
      pipelineKey: TELEGRAM_SQLITE_PIPELINE_KEY,
      checkedAt,
      totalRows,
      completedRows,
      remainingRows,
      percent: complete ? (totalRows === 0 ? 100 : Math.round((completedRows / totalRows) * 10_000) / 100) : null,
      strategy: TELEGRAM_SQLITE_STRATEGY,
      tasks,
    }, secrets)
  }
}
