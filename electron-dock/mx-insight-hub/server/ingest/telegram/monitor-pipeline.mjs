import { createHash } from 'node:crypto'
import { AppError } from '../../core/errors.mjs'
import { enqueueJobsAtomically } from '../external/atomic-enqueue.mjs'
import { validateDatabaseConnection } from '../external/database-source.mjs'
import { EXTERNAL_PULL_QUEUE } from '../external/sync-job.mjs'

export const TELEGRAM_MONITOR_MAPPING_VERSION = 2
export const TELEGRAM_MONITOR_WRITER_CONTRACT_VERSION = 'telegram-monitor.writer.v1'

export const TELEGRAM_MONITOR_INPUTS = Object.freeze([
  Object.freeze({
    role: 'chats',
    sourceKey: 'telegram-monitor-chats',
    schema: 'public',
    table: 'tg_monitor_chats',
    cursorColumn: 'updated_at',
    idColumn: 'chat_id',
    builtInMappingVersion: TELEGRAM_MONITOR_MAPPING_VERSION,
    builtInMappingId: 'f52f00f6-4326-4d0a-87ae-06b239450a1f',
  }),
  Object.freeze({
    role: 'messages',
    sourceKey: 'telegram-monitor-messages',
    schema: 'public',
    table: 'tg_monitor_messages',
    cursorColumn: 'updated_at',
    idColumn: 'id',
    builtInMappingVersion: TELEGRAM_MONITOR_MAPPING_VERSION,
    builtInMappingId: '32ac88ac-0c89-46c0-b22e-7885814ebd56',
  }),
])

export const TELEGRAM_MONITOR_SOURCE_KEYS = new Set(
  TELEGRAM_MONITOR_INPUTS.map((input) => input.sourceKey),
)

export const TELEGRAM_MONITOR_WRITER_CONTRACT_SUMMARY = Object.freeze({
  watermark: 'Every inserted or changed row advances updated_at, including edits, metrics, media and soft deletes.',
  deletion: 'Hard deletes are not used; deleted rows remain observable through the source deletion fields.',
  ordering: 'Writer commit ordering cannot place a later commit at or behind a checkpoint already exposed to the Hub.',
  inputs: TELEGRAM_MONITOR_INPUTS.map((input) => ({
    role: input.role,
    table: `${input.schema}.${input.table}`,
    cursor: [input.cursorColumn, input.idColumn],
  })),
})

export const TELEGRAM_MONITOR_WRITER_CONTRACT_DIGEST = createHash('sha256')
  .update(JSON.stringify(TELEGRAM_MONITOR_WRITER_CONTRACT_SUMMARY))
  .digest('hex')

export function isTelegramMonitorSourceKey(sourceKey) {
  return TELEGRAM_MONITOR_SOURCE_KEYS.has(sourceKey)
}

function writerContract() {
  return {
    version: TELEGRAM_MONITOR_WRITER_CONTRACT_VERSION,
    digest: TELEGRAM_MONITOR_WRITER_CONTRACT_DIGEST,
    summary: TELEGRAM_MONITOR_WRITER_CONTRACT_SUMMARY,
  }
}

function assertWriterContractAttestation(attestation) {
  const valid = attestation?.confirmed === true
    && attestation?.contractVersion === TELEGRAM_MONITOR_WRITER_CONTRACT_VERSION
    && attestation?.contractDigest === TELEGRAM_MONITOR_WRITER_CONTRACT_DIGEST
  if (!valid) {
    throw new AppError(
      409,
      'writer_contract_attestation_required',
      'Explicit confirmation of the Telegram source-writer contract is required before activation',
      { writerContract: writerContract() },
    )
  }
}

function isCurrentWriterContractAttestation(attestation) {
  return attestation?.contractVersion === TELEGRAM_MONITOR_WRITER_CONTRACT_VERSION
    && attestation?.contractDigest === TELEGRAM_MONITOR_WRITER_CONTRACT_DIGEST
}

const SHARED_CONNECTION_FIELDS = new Set([
  'host', 'port', 'database', 'username', 'password', 'sslMode',
])
const PIPELINE_ENQUEUE_ERRORS = Object.freeze({
  unavailable: {
    code: 'atomic_enqueue_unavailable',
    message: 'Telegram monitor sync requires the PostgreSQL queue',
  },
  failed: {
    code: 'pipeline_sync_enqueue_failed',
    message: 'No Telegram monitor task was scheduled; retry when the PostgreSQL queue is available',
  },
  outcomeUnknown: {
    code: 'pipeline_sync_enqueue_outcome_unknown',
    message: 'The Telegram monitor sync transaction outcome is unknown; inspect both task queues before retrying',
  },
})

function unsupportedFields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.keys(value).filter((field) => !allowed.has(field))
}

function sharedConnection(connection = {}) {
  return Object.fromEntries(
    Object.entries(connection).filter(([field]) => SHARED_CONNECTION_FIELDS.has(field)),
  )
}

function fixedConnection(input, sourceContractId = null) {
  return {
    schema: input.schema,
    table: input.table,
    cursorColumn: input.cursorColumn,
    idColumn: input.idColumn,
    ...(sourceContractId ? { sourceContractId } : {}),
  }
}

function safeDatabaseConnection(resolved, profile = null) {
  if (!resolved?.databaseConnectionId) return null
  const connection = resolved.connection || {}
  return {
    id: resolved.databaseConnectionId,
    connectionKey: profile?.key ?? resolved.databaseConnectionKey ?? null,
    displayName: profile?.displayName ?? null,
    revision: profile?.revision ?? resolved.databaseConnectionRevision ?? null,
    host: connection.host ?? null,
    port: connection.port ?? 5432,
    database: connection.database ?? null,
    username: connection.username ?? null,
    sslMode: connection.sslMode ?? 'require',
    passwordConfigured: typeof connection.password === 'string' && connection.password.length > 0,
  }
}

function sameValue(left, right) {
  const leftEntries = Object.entries(left || {}).sort(([a], [b]) => a.localeCompare(b))
  const rightEntries = Object.entries(right || {}).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries)
}

function sourceCoordinates(connection = {}) {
  return {
    host: connection.host ?? null,
    port: connection.port ?? 5432,
    database: connection.database ?? null,
    username: connection.username ?? null,
    sslMode: connection.sslMode ?? 'require',
  }
}

// Ten sync cycles, floored at 15 minutes. Kept identical to the SQLite pipeline:
// two different bars for the same judgement would be a trap, not a feature.
const ABANDONED_RUN_CYCLES = 10
const ABANDONED_RUN_FLOOR_MS = 15 * 60 * 1_000

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
  const updatedAt = cursor?.updated_at ?? cursor?.updatedAt ?? null
  if (!updatedAt || source.syncIntervalSeconds == null) return null
  return new Date(new Date(updatedAt).getTime() + source.syncIntervalSeconds * 1_000).toISOString()
}

function pipelineStatus(sources) {
  if (sources.every((source) => source.status === 'active')) return 'active'
  if (sources.every((source) => source.status === 'paused')) return 'paused'
  return 'mixed'
}

function isConfigured(connection) {
  return ['host', 'database', 'username', 'password'].every((field) => (
    typeof connection?.[field] === 'string' && connection[field].length > 0
  ))
}

function pipelineConfiguration(sources) {
  const connections = sources.map((source) => sharedConnection(source.connection))
  const databaseConnectionIds = sources.map((source) => source.databaseConnectionId ?? null)
  const sourceContractIds = sources.map((source) => source.connection?.sourceContractId ?? null)
  const intervals = sources.map((source) => source.syncIntervalSeconds)
  const databaseConnectionConsistent = databaseConnectionIds
    .slice(1)
    .every((value) => value === databaseConnectionIds[0])
  const inlineConnectionConsistent = connections.slice(1).every((value) => sameValue(value, connections[0]))
  const sourceContractConsistent = sourceContractIds.slice(1).every((value) => value === sourceContractIds[0])
  const connectionConsistent = databaseConnectionConsistent
    && (databaseConnectionIds[0] !== null || inlineConnectionConsistent)
    && sourceContractConsistent
  const syncIntervalConsistent = intervals.slice(1).every((value) => value === intervals[0])
  const inputIssues = []
  for (const [index, source] of sources.entries()) {
    const input = TELEGRAM_MONITOR_INPUTS[index]
    for (const field of ['schema', 'table', 'cursorColumn', 'idColumn']) {
      if (source.connection?.[field] !== input[field]) {
        inputIssues.push(`${input.sourceKey} ${field} must be ${input[field]}`)
      }
    }
    if (
      source.databaseConnectionId != null
      && Object.keys(sharedConnection(source.connection)).length > 0
    ) {
      inputIssues.push(`${input.sourceKey} must not duplicate shared database transport fields`)
    }
  }
  const issues = [...inputIssues]
  if (!databaseConnectionConsistent) {
    issues.push('Telegram monitor tasks do not share one database connection profile or inline mode')
  } else if (databaseConnectionIds[0] === null && !inlineConnectionConsistent) {
    issues.push('Telegram monitor tasks do not share one connection')
  }
  if (!sourceContractConsistent) issues.push('Telegram monitor tasks do not share one source contract generation')
  if (!syncIntervalConsistent) issues.push('Telegram monitor tasks do not share one sync interval')
  return {
    databaseConnectionId: databaseConnectionConsistent ? databaseConnectionIds[0] : null,
    connection: connectionConsistent && databaseConnectionIds[0] === null ? connections[0] : null,
    syncIntervalSeconds: syncIntervalConsistent ? intervals[0] : null,
    connectionConsistent,
    databaseConnectionConsistent,
    sourceContractConsistent,
    syncIntervalConsistent,
    inputContractsConsistent: inputIssues.length === 0,
    issues,
  }
}

function batchSize(value) {
  const size = value ?? 1_000
  if (!Number.isInteger(size) || size < 1 || size > 5_000) {
    throw new AppError(400, 'invalid_batch_size', 'batchSize must be an integer between 1 and 5000')
  }
  return size
}

function syncInterval(value) {
  if (value == null) return undefined
  if (!Number.isInteger(value) || value < 60 || value > 86_400) {
    throw new AppError(400, 'invalid_sync_interval', 'syncIntervalSeconds must be between 60 and 86400')
  }
  return value
}

export class TelegramMonitorPipeline {
  constructor({ store, queue, databasePuller, sourcePreparer = null }) {
    this.store = store
    this.queue = queue
    this.databasePuller = databasePuller
    this.sourcePreparer = sourcePreparer
  }

  async #source(input) {
    const source = await this.store.getExternalSource(input.sourceKey)
    if (!source) {
      throw new AppError(404, 'pipeline_source_not_found', `Telegram monitor source is not installed: ${input.sourceKey}`)
    }
    if (source.sourceKind !== 'database') {
      throw new AppError(409, 'pipeline_source_invalid', `Telegram monitor source is not a database source: ${input.sourceKey}`)
    }
    return source
  }

  async #sources() {
    return Promise.all(TELEGRAM_MONITOR_INPUTS.map((input) => this.#source(input)))
  }

  async #configuration(sources) {
    const configuration = pipelineConfiguration(sources)
    if (configuration.issues.length > 0) {
      return { ...configuration, effectiveConnection: null, databaseConnection: null }
    }
    try {
      const resolved = await this.databasePuller.resolveConnectionCandidate({
        databaseConnectionId: configuration.databaseConnectionId,
        connection: sources[0].connection,
      })
      const profile = resolved.databaseConnectionId && typeof this.store.getDatabaseConnection === 'function'
        ? await this.store.getDatabaseConnection(resolved.databaseConnectionId)
        : null
      return {
        ...configuration,
        effectiveConnection: resolved.connection,
        databaseConnection: safeDatabaseConnection(resolved, profile),
      }
    } catch (error) {
      return {
        ...configuration,
        effectiveConnection: null,
        databaseConnection: null,
        issues: [...configuration.issues, error?.message || 'Database connection is not configured'],
      }
    }
  }

  async #cursor(sourceKey) {
    return this.queue?.getCursor?.(`external:${sourceKey}`) ?? null
  }

  async #withLocks(sourceKeys, operation) {
    if (typeof this.databasePuller?.withSourceLocks !== 'function') {
      throw new AppError(503, 'source_lock_unavailable', 'Telegram monitor changes require source locking')
    }
    return this.databasePuller.withSourceLocks(sourceKeys, operation)
  }

  #requireSourcePreparer() {
    if (!this.sourcePreparer) {
      throw new AppError(503, 'source_prepare_unavailable', 'Telegram source preparation requires the PostgreSQL workload')
    }
  }

  async #sourcePreparationResetEvidence(sources, preparation, { generationChangedWithCheckpoint = false } = {}) {
    const cursors = await Promise.all(sources.map((source) => this.#cursor(source.sourceKey)))
    const checkpointed = cursors.map((cursor) => Boolean(
      cursor?.position?.contractHash || cursor?.position?.cursor || cursor?.position?.lastId,
    ))
    if (!checkpointed.some(Boolean)) {
      return { requiresCheckpointReset: false, checkpointResetReason: null }
    }
    const generation = preparation.contract?.generation ?? null
    const storedGenerationMismatch = sources.some((source) => (
      source.connection?.sourceContractId !== generation
    ))
    let contractMismatch = false
    for (const [index, input] of TELEGRAM_MONITOR_INPUTS.entries()) {
      if (!checkpointed[index]) continue
      const mappings = await this.store.listSourceMappings(sources[index].id)
      const builtIn = mappings.find((mapping) => (
        mapping.id === input.builtInMappingId && mapping.version === input.builtInMappingVersion
      ))
      if (!builtIn) continue
      try {
        await this.databasePuller.assertCheckpointCompatible(input.sourceKey, { mappingOverride: builtIn })
      } catch (error) {
        if (error?.code !== 'checkpoint_contract_mismatch') throw error
        contractMismatch = true
      }
    }
    const requiresCheckpointReset = generationChangedWithCheckpoint
      || preparation.sourceIdentityChanged === true
      || storedGenerationMismatch
      || contractMismatch
    return {
      requiresCheckpointReset,
      checkpointResetReason: requiresCheckpointReset
        ? 'The saved checkpoint belongs to another source installation or connection; reset both checkpoints explicitly before activation.'
        : null,
    }
  }

  async inspectSourcePreparation() {
    this.#requireSourcePreparer()
    const keys = TELEGRAM_MONITOR_INPUTS.map((input) => input.sourceKey)
    return this.#withLocks(keys, async () => {
      const sources = await this.#sources()
      if (sources.some((source) => source.status !== 'paused')) {
        throw new AppError(409, 'source_pause_required', 'Pause the Telegram monitor pipeline before inspecting source preparation')
      }
      const cursors = await Promise.all(keys.map((key) => this.#cursor(key)))
      if (cursors.some((cursor) => cursor?.status === 'running')) {
        throw new AppError(409, 'source_draining', 'Wait for both Telegram monitor tasks to reach a checkpoint')
      }
      const configuration = await this.#configuration(sources)
      if (configuration.issues.length > 0 || !isConfigured(configuration.effectiveConnection)) {
        throw new AppError(409, 'pipeline_configuration_required', 'Save one consistent Telegram source connection before preparing it')
      }
      const preparation = await this.sourcePreparer.inspect(configuration.effectiveConnection)
      return {
        ...preparation,
        ...await this.#sourcePreparationResetEvidence(sources, preparation),
      }
    })
  }

  async prepareSource(body = {}) {
    this.#requireSourcePreparer()
    const unsupported = unsupportedFields(body, new Set(['confirmPipelineKey', 'migrationCredentials']))
    if (unsupported.length > 0) {
      throw new AppError(400, 'unsupported_fields', `Unsupported source preparation fields: ${unsupported.join(', ')}`)
    }
    if (body?.confirmPipelineKey !== 'telegram-monitor') {
      throw new AppError(400, 'source_prepare_confirmation_required', 'confirmPipelineKey must be telegram-monitor')
    }
    const migrationCredentials = body?.migrationCredentials
    if (migrationCredentials != null) {
      if (typeof migrationCredentials !== 'object' || Array.isArray(migrationCredentials)) {
        throw new AppError(400, 'invalid_migration_credentials', 'migrationCredentials must contain username and password')
      }
      const unsupportedCredentials = unsupportedFields(migrationCredentials, new Set(['username', 'password']))
      if (unsupportedCredentials.length > 0) {
        throw new AppError(400, 'unsupported_fields', `Unsupported migration credential fields: ${unsupportedCredentials.join(', ')}`)
      }
      if (
        typeof migrationCredentials.username !== 'string'
        || migrationCredentials.username.trim().length === 0
        || migrationCredentials.username !== migrationCredentials.username.trim()
        || typeof migrationCredentials.password !== 'string'
        || migrationCredentials.password.length === 0
      ) {
        throw new AppError(400, 'invalid_migration_credentials', 'migrationCredentials requires a trimmed username and non-empty password')
      }
    }

    const keys = TELEGRAM_MONITOR_INPUTS.map((input) => input.sourceKey)
    return this.#withLocks(keys, async () => {
      const sources = await this.#sources()
      if (sources.some((source) => source.status !== 'paused')) {
        throw new AppError(409, 'source_pause_required', 'Pause the Telegram monitor pipeline before preparing its source')
      }
      const cursors = await Promise.all(keys.map((key) => this.#cursor(key)))
      if (cursors.some((cursor) => cursor?.status === 'running')) {
        throw new AppError(409, 'source_draining', 'Wait for both Telegram monitor tasks to reach a checkpoint')
      }
      const configuration = await this.#configuration(sources)
      if (configuration.issues.length > 0 || !isConfigured(configuration.effectiveConnection)) {
        throw new AppError(409, 'pipeline_configuration_required', 'Save one consistent Telegram source connection before preparing it')
      }
      const migrationConnection = migrationCredentials
        ? {
            ...configuration.effectiveConnection,
            username: migrationCredentials.username,
            password: migrationCredentials.password,
          }
        : configuration.effectiveConnection
      validateDatabaseConnection({
        ...migrationConnection,
        schema: TELEGRAM_MONITOR_INPUTS[0].schema,
        table: TELEGRAM_MONITOR_INPUTS[0].table,
        cursorColumn: TELEGRAM_MONITOR_INPUTS[0].cursorColumn,
        idColumn: TELEGRAM_MONITOR_INPUTS[0].idColumn,
      })
      const preparation = await this.sourcePreparer.prepare(migrationConnection)
      const generation = preparation.contract?.generation
      if (typeof generation !== 'string' || !/^[a-f0-9]{32}$/.test(generation)) {
        throw new AppError(409, 'source_prepare_incomplete', 'Telegram source generation evidence is missing')
      }
      const hasCheckpoint = cursors.some((cursor) => Boolean(
        cursor?.position?.contractHash || cursor?.position?.cursor || cursor?.position?.lastId,
      ))
      const generationChanged = sources.some((source) => source.connection?.sourceContractId !== generation)
      const generationChangedWithCheckpoint = generationChanged && hasCheckpoint
      if (generationChanged) {
        await this.store.updateExternalSourcesBatch(sources.map((source) => ({
          sourceKey: source.sourceKey,
          connection: { ...source.connection, sourceContractId: generation },
        })))
      }
      const updatedSources = await this.#sources()
      const resetEvidence = await this.#sourcePreparationResetEvidence(updatedSources, preparation, {
        generationChangedWithCheckpoint,
      })
      return {
        ...preparation,
        source: {
          ...preparation.source,
          user: migrationCredentials ? configuration.effectiveConnection.username : preparation.source.user,
        },
        migrationAccountUsed: Boolean(migrationCredentials),
        ...resetEvidence,
      }
    })
  }

  async #task(input, source) {
    const [activeMapping, mappings, cursor, runs] = await Promise.all([
      this.store.getActiveMapping(source.id),
      this.store.listSourceMappings(source.id),
      this.#cursor(source.sourceKey),
      this.store.listImportRuns(source.id, 1),
    ])
    return {
      ...input,
      source,
      activeMapping,
      builtInMappingAvailable: mappings.some((mapping) => (
        mapping.id === input.builtInMappingId && mapping.version === input.builtInMappingVersion
      )),
      cursor,
      latestRun: runs[0] ?? null,
      nextDueAt: nextDueAt(source, cursor),
    }
  }

  async get() {
    const sources = await this.#sources()
    const [tasks, latestAttestation] = await Promise.all([
      Promise.all(TELEGRAM_MONITOR_INPUTS.map((input, index) => this.#task(input, sources[index]))),
      this.store.getLatestPipelineWriterContractAttestation?.('telegram-monitor') ?? null,
    ])
    const configuration = await this.#configuration(sources)
    return {
      pipelineKey: 'telegram-monitor',
      displayName: 'Telegram monitor',
      builtInMappingVersion: TELEGRAM_MONITOR_MAPPING_VERSION,
      status: pipelineStatus(sources),
      databaseConnectionId: configuration.databaseConnectionId,
      databaseConnection: configuration.databaseConnection,
      connection: configuration.databaseConnectionId ? null : configuration.connection,
      syncIntervalSeconds: configuration.syncIntervalSeconds,
      configured: configuration.issues.length === 0 && isConfigured(configuration.effectiveConnection),
      connectionConsistent: configuration.connectionConsistent,
      databaseConnectionConsistent: configuration.databaseConnectionConsistent,
      sourceContractConsistent: configuration.sourceContractConsistent,
      syncIntervalConsistent: configuration.syncIntervalConsistent,
      inputContractsConsistent: configuration.inputContractsConsistent,
      configurationIssues: configuration.issues,
      writerContract: {
        ...writerContract(),
        latestAttestation,
      },
      tasks,
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
    const unsupportedConnection = unsupportedFields(body?.connection, SHARED_CONNECTION_FIELDS)
    if (unsupportedConnection.length > 0) {
      throw new AppError(
        400,
        'unsupported_pipeline_connection_fields',
        `Telegram monitor table and cursor fields are fixed; unsupported connection fields: ${unsupportedConnection.join(', ')}`,
      )
    }
    const interval = syncInterval(body?.syncIntervalSeconds)
    const keys = TELEGRAM_MONITOR_INPUTS.map((input) => input.sourceKey)
    const intervalOnly = Object.keys(body).length === 1
      && Object.prototype.hasOwnProperty.call(body, 'syncIntervalSeconds')
    if (intervalOnly) {
      await this.store.updateExternalSourcesBatch(keys.map((sourceKey) => ({
        sourceKey,
        syncIntervalSeconds: interval,
      })))
      return this.get()
    }
    return this.#withLocks(keys, async () => {
      const sources = await this.#sources()
      if (sources.some((source) => source.status !== 'paused')) {
        throw new AppError(409, 'source_pause_required', 'Pause the Telegram monitor pipeline before changing its connection')
      }
      const cursors = await Promise.all(keys.map((key) => this.#cursor(key)))
      if (cursors.some((cursor) => cursor?.status === 'running')) {
        throw new AppError(409, 'source_draining', 'Wait for both Telegram monitor tasks to reach a checkpoint')
      }

      let requestedConnection = null
      let databaseConnectionId
      let preserveSourceContract = false
      if (hasProfile || hasInline) {
        const previous = await this.#configuration(sources)
        if (hasProfile) {
          databaseConnectionId = body.databaseConnectionId.trim()
          requestedConnection = fixedConnection(TELEGRAM_MONITOR_INPUTS[0])
        } else {
          const existing = sources.every((source) => source.databaseConnectionId == null)
            ? sources.map((source) => sharedConnection(source.connection))
            : []
          const common = existing.length > 0
            && existing.slice(1).every((value) => sameValue(value, existing[0]))
            ? existing[0]
            : {}
          requestedConnection = {
            ...common,
            ...body.connection,
            ...fixedConnection(TELEGRAM_MONITOR_INPUTS[0]),
          }
          delete requestedConnection.dsnEnv
          databaseConnectionId = null
        }
        const candidate = { databaseConnectionId, connection: requestedConnection }
        const resolved = await this.databasePuller.resolveConnectionCandidate(candidate)
        validateDatabaseConnection(resolved.connection)
        await this.databasePuller.testSourceCandidate(candidate)
        preserveSourceContract = Boolean(previous.effectiveConnection)
          && sameValue(
            sourceCoordinates(previous.effectiveConnection),
            sourceCoordinates(resolved.connection),
          )
      }

      const updates = TELEGRAM_MONITOR_INPUTS.map((input) => ({
        sourceKey: input.sourceKey,
        ...(requestedConnection
          ? {
              databaseConnectionId,
              connection: {
                ...(databaseConnectionId ? {} : sharedConnection(requestedConnection)),
                ...fixedConnection(
                  input,
                  preserveSourceContract
                    ? sources.find((source) => source.sourceKey === input.sourceKey)?.connection?.sourceContractId
                    : null,
                ),
              },
            }
          : {}),
        ...(interval === undefined ? {} : { syncIntervalSeconds: interval }),
      }))
      await this.store.updateExternalSourcesBatch(updates)
      return this.get()
    })
  }

  async setStatus(status, { approvedBy = 'admin-token', writerContractAttestation = null } = {}) {
    if (!['active', 'paused'].includes(status)) {
      throw new AppError(400, 'invalid_status', 'status must be active or paused')
    }
    const keys = TELEGRAM_MONITOR_INPUTS.map((input) => input.sourceKey)
    if (status === 'paused') {
      const sources = await this.#sources()
      await this.store.updateExternalSourcesBatch(sources.map((source) => ({
        sourceKey: source.sourceKey,
        status: 'paused',
      })))
      return this.get()
    }
    return this.#withLocks(keys, async () => {
      const sources = await this.#sources()
      const configuration = await this.#configuration(sources)
      if (configuration.issues.length > 0) {
        throw new AppError(409, 'pipeline_configuration_drift', 'Telegram monitor task configuration has drifted', {
          issues: configuration.issues,
        })
      }
      const allPaused = sources.every((source) => source.status === 'paused')
      const allActive = sources.every((source) => source.status === 'active')
      if (!allPaused && !allActive) {
        throw new AppError(409, 'pipeline_mixed_status', 'Pause both Telegram monitor tasks before activating the pipeline')
      }
      const cursors = await Promise.all(keys.map((key) => this.#cursor(key)))
      if (cursors.some((cursor) => cursor?.status === 'running')) {
        throw new AppError(409, 'source_draining', 'Wait for both Telegram monitor tasks to reach a checkpoint')
      }
      if (this.sourcePreparer) {
        const preparation = await this.sourcePreparer.inspect(configuration.effectiveConnection)
        const generation = preparation.contract?.generation
        const generationMatches = typeof generation === 'string' && sources.every((source) => (
          source.connection?.sourceContractId === generation
        ))
        if (!preparation.ready || preparation.sourceIdentityChanged || !generationMatches) {
          throw new AppError(
            409,
            'source_prepare_required',
            'Prepare and verify the Telegram source contract before activation',
            { steps: preparation.steps, warnings: preparation.warnings },
          )
        }
      }

      const approvals = []
      const targetMappings = []
      for (const [index, source] of sources.entries()) {
        const input = TELEGRAM_MONITOR_INPUTS[index]
        const active = await this.store.getActiveMapping(source.id)
        if (active?.id === input.builtInMappingId && active.version === input.builtInMappingVersion) {
          targetMappings.push(active)
          continue
        }
        if (active && active.version >= input.builtInMappingVersion) {
          throw new AppError(409, 'builtin_mapping_conflict', `A non-built-in mapping is active for ${input.sourceKey}`)
        }
        const mappings = await this.store.listSourceMappings(source.id)
        const builtIn = mappings.find((mapping) => (
          mapping.id === input.builtInMappingId && mapping.version === input.builtInMappingVersion
        ))
        if (!builtIn) {
          throw new AppError(409, 'builtin_mapping_conflict', `Seeded built-in mapping is missing or collides for ${input.sourceKey}`)
        }
        targetMappings.push(builtIn)
        approvals.push({
          mappingId: input.builtInMappingId,
          sourceId: source.id,
          version: input.builtInMappingVersion,
        })
      }

      const descriptions = await Promise.all(
        TELEGRAM_MONITOR_INPUTS.map((input, index) => this.databasePuller.describe(input.sourceKey, {
          mappingOverride: targetMappings[index],
        })),
      )
      const blockedIndex = descriptions.findIndex((description) => description.issues.length > 0)
      if (blockedIndex >= 0) {
        const input = TELEGRAM_MONITOR_INPUTS[blockedIndex]
        throw new AppError(409, 'source_probe_failed', `Source schema is not safe for incremental sync: ${input.sourceKey}`, {
          sourceKey: input.sourceKey,
          issues: descriptions[blockedIndex].issues,
        })
      }
      for (const [index, input] of TELEGRAM_MONITOR_INPUTS.entries()) {
        await this.databasePuller.assertCheckpointCompatible(input.sourceKey, {
          mappingOverride: targetMappings[index],
        })
      }
      assertWriterContractAttestation(writerContractAttestation)
      await this.store.activateExternalSourcesWithAttestation({
        sourceKeys: sources.map((source) => source.sourceKey),
        pipelineKey: 'telegram-monitor',
        contractVersion: TELEGRAM_MONITOR_WRITER_CONTRACT_VERSION,
        contractDigest: TELEGRAM_MONITOR_WRITER_CONTRACT_DIGEST,
        contractSummary: TELEGRAM_MONITOR_WRITER_CONTRACT_SUMMARY,
        attestedBy: approvedBy,
        approvals,
      })
      return this.get()
    })
  }

  /**
   * Clear a failed cursor so scheduling can resume, without replaying anything.
   *
   * Both monitor tasks are scheduled together and the scheduler treats any
   * cursor that is not `idle` as not due, so one task left `failed` by a
   * transient fault froze the pair. See the SQLite pipeline for the same
   * recovery; the position, mapping and source status are untouched here too.
   */
  async resumeFailedTasks() {
    const keys = TELEGRAM_MONITOR_INPUTS.map((input) => input.sourceKey)
    return this.#withLocks(keys, async () => {
      const sources = await this.#sources()
      const cursors = await Promise.all(keys.map((key) => this.#cursor(key)))
      // Same bar as the SQLite pipeline: a live batch is untouchable, a run that
      // has been silent for ten cycles has no worker left to protect.
      const draining = sources
        .map((source, index) => ({ source, cursor: cursors[index] }))
        .filter(({ source, cursor }) => (
          cursor?.status === 'running' && !abandonedRun(source, cursor)
        ))
      if (draining.length > 0) {
        throw new AppError(
          409,
          'source_draining',
          'Wait for both Telegram monitor tasks to reach a checkpoint',
          { sourceKeys: draining.map(({ source }) => source.sourceKey) },
        )
      }
      const resumed = []
      for (const [index, source] of sources.entries()) {
        const cursor = cursors[index]
        const abandoned = cursor?.status === 'running' && abandonedRun(source, cursor)
        if (cursor?.status !== 'failed' && !abandoned) {
          resumed.push({ sourceKey: source.sourceKey, status: cursor?.status ?? 'idle', resumed: false })
          continue
        }
        await this.queue.saveCursor(
          `external:${source.sourceKey}`,
          cursor.position ?? {},
          { status: 'idle', processedDelta: 0, error: null },
        )
        resumed.push({
          sourceKey: source.sourceKey,
          status: 'idle',
          resumed: true,
          from: abandoned ? 'abandoned_run' : 'failed',
          silentForMs: abandoned ? cursorSilenceMs(cursor) : null,
          clearedError: cursor.error ?? null,
        })
      }
      return { pipelineKey: 'telegram-monitor', tasks: resumed }
    })
  }

  async resetCheckpoints(confirmPipelineKey) {
    if (confirmPipelineKey !== 'telegram-monitor') {
      throw new AppError(400, 'checkpoint_reset_confirmation_required', 'confirmPipelineKey must be telegram-monitor')
    }
    const sources = await this.#sources()
    if (sources.some((source) => source.status !== 'paused')) {
      throw new AppError(409, 'source_pause_required', 'Pause the Telegram monitor pipeline before resetting checkpoints')
    }
    const mappingOverrides = {}
    for (const [index, input] of TELEGRAM_MONITOR_INPUTS.entries()) {
      const mappings = await this.store.listSourceMappings(sources[index].id)
      const builtIn = mappings.find((mapping) => (
        mapping.id === input.builtInMappingId && mapping.version === input.builtInMappingVersion
      ))
      if (!builtIn) {
        throw new AppError(409, 'builtin_mapping_conflict', `Seeded built-in mapping is missing or collides for ${input.sourceKey}`)
      }
      mappingOverrides[input.sourceKey] = builtIn
    }
    const resets = await this.databasePuller.resetCheckpoints(
      TELEGRAM_MONITOR_INPUTS.map((input) => input.sourceKey),
      { mappingOverrides },
    )
    return { pipelineKey: 'telegram-monitor', resets }
  }

  async sync(body = {}) {
    const unsupported = unsupportedFields(body, new Set(['batchSize']))
    if (unsupported.length > 0) {
      throw new AppError(400, 'unsupported_fields', `Unsupported sync fields: ${unsupported.join(', ')}`)
    }
    const size = batchSize(body?.batchSize)
    const sources = await this.#sources()
    if (sources.some((source) => source.status !== 'active')) {
      throw new AppError(409, 'pipeline_paused', 'Activate both Telegram monitor tasks before scheduling sync')
    }
    const latestAttestation = await this.store.getLatestPipelineWriterContractAttestation?.('telegram-monitor')
    if (!isCurrentWriterContractAttestation(latestAttestation)) {
      throw new AppError(
        409,
        'writer_contract_attestation_required',
        'Activate the Telegram monitor pipeline under the current writer contract before scheduling sync',
        { writerContract: writerContract() },
      )
    }
    const cursors = await Promise.all(sources.map((source) => this.#cursor(source.sourceKey)))
    const pending = sources.filter((_source, index) => cursors[index]?.status !== 'running')
    for (const source of pending) {
      const description = await this.databasePuller.describe(source.sourceKey)
      if (description.issues.length > 0) {
        throw new AppError(409, 'source_probe_failed', `Source schema is not safe for incremental sync: ${source.sourceKey}`, {
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
    return { pipelineKey: 'telegram-monitor', tasks: scheduled }
  }

  async progress() {
    const checkedAt = new Date().toISOString()
    const tasks = await Promise.all(TELEGRAM_MONITOR_INPUTS.map(async (input) => ({
      role: input.role,
      sourceKey: input.sourceKey,
      ...(await this.databasePuller.progress(input.sourceKey)),
      checkedAt,
    })))
    const complete = tasks.every((task) => task.completedRows != null && task.remainingRows != null)
    const totalRows = tasks.reduce((sum, task) => sum + task.totalRows, 0)
    const completedRows = complete ? tasks.reduce((sum, task) => sum + task.completedRows, 0) : null
    const remainingRows = complete ? tasks.reduce((sum, task) => sum + task.remainingRows, 0) : null
    return {
      pipelineKey: 'telegram-monitor',
      checkedAt,
      totalRows,
      completedRows,
      remainingRows,
      percent: complete ? (totalRows === 0 ? 100 : Math.round((completedRows / totalRows) * 10_000) / 100) : null,
      tasks,
    }
  }
}
