import { createHash } from 'node:crypto'
import { AppError } from '../../core/errors.mjs'
import { validateDatabaseConnection } from '../external/database-source.mjs'
import { EXTERNAL_PULL_QUEUE } from '../external/sync-job.mjs'
import {
  MOBILE_COMMERCE_COLUMNS,
  MOBILE_COMMERCE_MAPPING_ID,
  MOBILE_COMMERCE_MAPPING_VERSION,
  MOBILE_COMMERCE_PIPELINE_KEY,
  MOBILE_COMMERCE_SOURCE_KEY,
  MOBILE_COMMERCE_SOURCE_LOCATOR,
  mobileCommerceProbeIssues,
  mobileCommerceSourceContractIssues,
} from './source-contract.mjs'

export const MOBILE_COMMERCE_WRITER_CONTRACT_VERSION = 'mobile-commerce.writer.v2'
export const MOBILE_COMMERCE_WRITER_CONTRACT_SUMMARY = Object.freeze({
  mutation: 'Rows visible to the Hub are append-only. Existing business fields are not updated in place unless a future updated_at/change-journal contract replaces this one.',
  identity: 'id is immutable, unique, and never reused for the lifetime of this fixed dataset; it identifies a capture row, not necessarily a marketplace product. A truncate, table replacement, or ID-sequence reuse requires a new source/dataset contract.',
  watermark: 'collected_at is non-null, finite source-local Asia/Shanghai collection time assigned before insert and is never rewritten.',
  ordering: 'A later commit cannot insert a collected_at value behind a checkpoint already consumed by the Hub.',
  deletion: 'Hard deletes are not observable under this contract and must not be used for rows that have entered this feed.',
  input: Object.freeze({
    table: `${MOBILE_COMMERCE_SOURCE_LOCATOR.schema}.${MOBILE_COMMERCE_SOURCE_LOCATOR.table}`,
    cursor: [MOBILE_COMMERCE_SOURCE_LOCATOR.cursorColumn, MOBILE_COMMERCE_SOURCE_LOCATOR.idColumn],
    recommendedIndex: `(${MOBILE_COMMERCE_SOURCE_LOCATOR.cursorColumn}, ${MOBILE_COMMERCE_SOURCE_LOCATOR.idColumn})`,
    sourceTimezone: 'Asia/Shanghai (+08:00)',
  }),
})
export const MOBILE_COMMERCE_WRITER_CONTRACT_DIGEST = createHash('sha256')
  .update(JSON.stringify(MOBILE_COMMERCE_WRITER_CONTRACT_SUMMARY))
  .digest('hex')

const TRANSPORT_FIELDS = new Set(['host', 'port', 'database', 'username', 'password', 'sslMode'])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const MAX_BATCH_SIZE = 5_000
const ABANDONED_RUN_CYCLES = 10
const ABANDONED_RUN_FLOOR_MS = 15 * 60 * 1_000

function unsupportedFields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.keys(value).filter((field) => !allowed.has(field))
}

function transportOf(connection = {}) {
  return Object.fromEntries(
    Object.entries(connection).filter(([field]) => TRANSPORT_FIELDS.has(field)),
  )
}

function safeTransport(connection = {}) {
  const { password, ...safe } = transportOf(connection)
  return {
    ...safe,
    passwordConfigured: typeof password === 'string' && password.length > 0,
  }
}

function safeSource(source) {
  if (!source) return source
  const { password, ...connection } = source.connection || {}
  return {
    ...source,
    connection: {
      ...connection,
      passwordConfigured: typeof password === 'string' && password.length > 0,
    },
  }
}

function assertStableTransportIdentity(connection) {
  if (connection?.dsnEnv) {
    throw new AppError(
      409,
      'mobile_commerce_dsn_env_unsupported',
      'The fixed mobile-commerce pipeline requires an explicit PostgreSQL host/database transport; dsnEnv can change target without checkpoint evidence',
    )
  }
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
    throw new AppError(400, 'invalid_batch_size', `batchSize must be between 1 and ${MAX_BATCH_SIZE}`)
  }
  return size
}

function writerContract() {
  return {
    version: MOBILE_COMMERCE_WRITER_CONTRACT_VERSION,
    digest: MOBILE_COMMERCE_WRITER_CONTRACT_DIGEST,
    summary: MOBILE_COMMERCE_WRITER_CONTRACT_SUMMARY,
  }
}

function assertWriterContractAttestation(attestation) {
  if (
    attestation?.confirmed !== true
    || attestation?.contractVersion !== MOBILE_COMMERCE_WRITER_CONTRACT_VERSION
    || attestation?.contractDigest !== MOBILE_COMMERCE_WRITER_CONTRACT_DIGEST
  ) {
    throw new AppError(
      409,
      'writer_contract_attestation_required',
      'Explicit confirmation of the mobile-commerce append-only writer contract is required before activation',
      { writerContract: writerContract() },
    )
  }
}

function currentWriterContract(attestation) {
  return attestation?.contractVersion === MOBILE_COMMERCE_WRITER_CONTRACT_VERSION
    && attestation?.contractDigest === MOBILE_COMMERCE_WRITER_CONTRACT_DIGEST
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

export class MobileCommercePipeline {
  constructor({ store, queue, databasePuller }) {
    this.store = store
    this.queue = queue
    this.databasePuller = databasePuller
  }

  async #source() {
    const source = await this.store.getExternalSource(MOBILE_COMMERCE_SOURCE_KEY)
    if (!source) {
      throw new AppError(404, 'pipeline_source_not_found', 'Mobile-commerce source is not installed')
    }
    if (source.sourceKind !== 'database') {
      throw new AppError(409, 'pipeline_source_invalid', 'Mobile-commerce source must be PostgreSQL')
    }
    return source
  }

  async #cursor() {
    return this.queue?.getCursor?.(`external:${MOBILE_COMMERCE_SOURCE_KEY}`) ?? null
  }

  async #profile(id) {
    if (!id) return null
    if (typeof this.store.getDatabaseConnection !== 'function') {
      throw new AppError(503, 'database_connection_store_unavailable', 'Shared database connections require the current Hub migration')
    }
    const profile = await this.store.getDatabaseConnection(id)
    if (!profile) throw new AppError(404, 'database_connection_not_found', 'Database connection was not found')
    return profile
  }

  async #effectiveConnection(source) {
    if (typeof this.databasePuller?.resolveConnectionCandidate !== 'function') {
      throw new AppError(503, 'source_validation_unavailable', 'Mobile-commerce connection resolution requires the PostgreSQL workload')
    }
    const [profile, resolved] = await Promise.all([
      this.#profile(source.databaseConnectionId),
      this.databasePuller.resolveConnectionCandidate({
        databaseConnectionId: source.databaseConnectionId,
        connection: source.connection || {},
      }),
    ])
    assertStableTransportIdentity(resolved.connection)
    return { connection: resolved.connection, profile }
  }

  async #withLock(operation) {
    if (typeof this.databasePuller?.withSourceLock !== 'function') {
      throw new AppError(503, 'source_lock_unavailable', 'Mobile-commerce changes require source locking')
    }
    return this.databasePuller.withSourceLock(MOBILE_COMMERCE_SOURCE_KEY, operation)
  }

  async #builtInMapping(source) {
    const mappings = await this.store.listSourceMappings(source.id)
    const mapping = mappings.find((candidate) => (
      candidate.id === MOBILE_COMMERCE_MAPPING_ID
      && candidate.version === MOBILE_COMMERCE_MAPPING_VERSION
    ))
    if (!mapping) {
      throw new AppError(409, 'builtin_mapping_conflict', 'Seeded mobile-commerce mapping is missing or collides')
    }
    return { mapping, mappings }
  }

  async get() {
    const source = await this.#source()
    const [activeMapping, mappingResult, cursor, runs, latestAttestation] = await Promise.all([
      this.store.getActiveMapping(source.id),
      this.#builtInMapping(source),
      this.#cursor(),
      this.store.listImportRuns(source.id, 1),
      this.store.getLatestPipelineWriterContractAttestation?.(MOBILE_COMMERCE_PIPELINE_KEY) ?? null,
    ])
    let profile = null
    let effectiveConnection = null
    const configurationIssues = mobileCommerceSourceContractIssues(source)
    try {
      const resolved = await this.#effectiveConnection(source)
      effectiveConnection = resolved.connection
      profile = resolved.profile
    } catch (error) {
      configurationIssues.push(error?.message || 'Database connection is not configured')
    }
    return {
      pipelineKey: MOBILE_COMMERCE_PIPELINE_KEY,
      displayName: '手机端商家商品采集',
      status: source.status,
      configured: configurationIssues.length === 0,
      databaseConnectionId: source.databaseConnectionId ?? null,
      databaseConnection: profile ? {
        id: profile.id,
        connectionKey: profile.key,
        displayName: profile.displayName,
        ...safeTransport(profile.connection),
      } : null,
      connection: source.databaseConnectionId ? null : safeTransport(effectiveConnection || source.connection),
      syncIntervalSeconds: source.syncIntervalSeconds,
      fixedInput: {
        ...MOBILE_COMMERCE_SOURCE_LOCATOR,
        sourceTimezone: 'Asia/Shanghai',
        columns: [...MOBILE_COMMERCE_COLUMNS],
      },
      configurationIssues,
      writerContract: { ...writerContract(), latestAttestation },
      mapping: {
        mode: 'fixed-contract',
        builtInVersion: MOBILE_COMMERCE_MAPPING_VERSION,
        builtInAvailable: mappingResult.mappings.some((candidate) => candidate.id === MOBILE_COMMERCE_MAPPING_ID),
        activeVersion: activeMapping?.version ?? null,
        agentStudio: {
          status: 'reserved',
          message: '固定表先使用可复现映射；未知格式的 Agent 建议与审批链后续接入。',
        },
      },
      catalogClassification: {
        field: 'platform',
        authority: 'PostgreSQL 数据源目录 active revision',
        mappingStatus: 'exact-name-or-reviewed-context-alias',
        unknownBehavior: '保留原值并标记 unmapped，不猜测目录归属',
      },
      serving: {
        endpoint: 'GET /api/v1/data/mobile-commerce/items',
        mode: 'stored-only',
        authorizationPlatform: 'mobile_commerce',
        remoteFetch: {
          status: 'reserved',
          available: false,
          executionPlane: 'external-mobile-collector',
          hubRole: 'asynchronous-trigger-and-data-api',
          plannedMode: 'asynchronous-command',
          message: '远端主动获取接口尚未接入。',
        },
      },
      task: {
        source: safeSource(source),
        activeMapping,
        cursor,
        latestRun: runs[0] ?? null,
        nextDueAt: nextDueAt(source, cursor),
      },
    }
  }

  async configure(body = {}) {
    const allowed = new Set(['databaseConnectionId', 'connection', 'syncIntervalSeconds'])
    const unsupported = unsupportedFields(body, allowed)
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
    if (hasProfile && (typeof body.databaseConnectionId !== 'string' || !UUID_PATTERN.test(body.databaseConnectionId))) {
      throw new AppError(400, 'invalid_database_connection_id', 'databaseConnectionId must be a UUID')
    }
    if (hasInline && (typeof body.connection !== 'object' || Array.isArray(body.connection))) {
      throw new AppError(400, 'invalid_connection', 'connection must be an object')
    }
    const unsupportedConnection = unsupportedFields(body.connection, TRANSPORT_FIELDS)
    if (unsupportedConnection.length > 0) {
      throw new AppError(400, 'unsupported_pipeline_connection_fields', `Mobile-commerce table locator is fixed; unsupported fields: ${unsupportedConnection.join(', ')}`)
    }
    const interval = syncInterval(body.syncIntervalSeconds)
    const intervalOnly = Object.keys(body).length === 1
      && Object.prototype.hasOwnProperty.call(body, 'syncIntervalSeconds')
    if (intervalOnly) {
      await this.store.updateExternalSource(MOBILE_COMMERCE_SOURCE_KEY, {
        syncIntervalSeconds: interval,
      })
      return this.get()
    }
    return this.#withLock(async () => {
      const source = await this.#source()
      if (source.status !== 'paused') {
        throw new AppError(409, 'source_pause_required', 'Pause the mobile-commerce pipeline before changing its database connection')
      }
      const cursor = await this.#cursor()
      if (cursor?.status === 'running') {
        throw new AppError(409, 'source_draining', 'Wait for the mobile-commerce task to reach a checkpoint')
      }

      let databaseConnectionId
      let connection
      if (hasProfile) {
        const profile = await this.#profile(body.databaseConnectionId)
        assertStableTransportIdentity(profile.connection)
        databaseConnectionId = profile.id
        connection = { ...MOBILE_COMMERCE_SOURCE_LOCATOR }
        await this.databasePuller.testSourceCandidate({ databaseConnectionId, connection })
      } else if (hasInline) {
        const currentTransport = source.databaseConnectionId ? {} : transportOf(source.connection)
        connection = {
          ...currentTransport,
          ...body.connection,
          ...MOBILE_COMMERCE_SOURCE_LOCATOR,
        }
        validateDatabaseConnection(connection)
        await this.databasePuller.testSourceCandidate({ databaseConnectionId: null, connection })
        databaseConnectionId = null
      }
      await this.store.updateExternalSource(MOBILE_COMMERCE_SOURCE_KEY, {
        ...(connection ? { connection, databaseConnectionId } : {}),
        ...(interval === undefined ? {} : { syncIntervalSeconds: interval }),
      })
      return this.get()
    })
  }

  async setStatus(status, { approvedBy = 'admin-token', writerContractAttestation = null } = {}) {
    if (!['active', 'paused'].includes(status)) {
      throw new AppError(400, 'invalid_status', 'status must be active or paused')
    }
    if (status === 'paused') {
      await this.store.updateExternalSource(MOBILE_COMMERCE_SOURCE_KEY, { status: 'paused' })
      return this.get()
    }
    return this.#withLock(async () => {
      const source = await this.#source()
      const sourceIssues = mobileCommerceSourceContractIssues(source)
      if (sourceIssues.length > 0) {
        throw new AppError(409, 'pipeline_configuration_drift', 'Mobile-commerce source contract has drifted', { issues: sourceIssues })
      }
      const cursor = await this.#cursor()
      if (cursor?.status === 'running') {
        throw new AppError(409, 'source_draining', 'Wait for the mobile-commerce task to reach a checkpoint')
      }
      await this.#effectiveConnection(source)
      const active = await this.store.getActiveMapping(source.id)
      const { mapping: builtIn } = await this.#builtInMapping(source)
      if (active && (active.id !== MOBILE_COMMERCE_MAPPING_ID || active.version !== MOBILE_COMMERCE_MAPPING_VERSION)) {
        throw new AppError(409, 'builtin_mapping_conflict', 'A non-built-in mapping is active for the mobile-commerce source')
      }
      const targetMapping = active || builtIn
      const description = await this.databasePuller.describe(MOBILE_COMMERCE_SOURCE_KEY, {
        mappingOverride: targetMapping,
      })
      const issues = mobileCommerceProbeIssues(description)
      if (issues.length > 0) {
        throw new AppError(409, 'source_probe_failed', 'Mobile-commerce source is not safe for incremental sync', { issues })
      }
      await this.databasePuller.assertCheckpointCompatible(MOBILE_COMMERCE_SOURCE_KEY, {
        mappingOverride: targetMapping,
      })
      assertWriterContractAttestation(writerContractAttestation)
      if (typeof this.store.activateExternalSourcesWithAttestation !== 'function') {
        throw new AppError(503, 'pipeline_activation_unavailable', 'Pipeline activation requires the PostgreSQL store')
      }
      await this.store.activateExternalSourcesWithAttestation({
        sourceKeys: [MOBILE_COMMERCE_SOURCE_KEY],
        pipelineKey: MOBILE_COMMERCE_PIPELINE_KEY,
        contractVersion: MOBILE_COMMERCE_WRITER_CONTRACT_VERSION,
        contractDigest: MOBILE_COMMERCE_WRITER_CONTRACT_DIGEST,
        contractSummary: MOBILE_COMMERCE_WRITER_CONTRACT_SUMMARY,
        attestedBy: approvedBy,
        approvals: active ? [] : [{
          mappingId: MOBILE_COMMERCE_MAPPING_ID,
          sourceId: source.id,
          version: MOBILE_COMMERCE_MAPPING_VERSION,
        }],
      })
      return {
        ...(await this.get()),
        activationWarnings: Array.isArray(description.warnings) ? [...description.warnings] : [],
      }
    })
  }

  async sync(body = {}) {
    const unsupported = unsupportedFields(body, new Set(['batchSize']))
    if (unsupported.length > 0) {
      throw new AppError(400, 'unsupported_fields', `Unsupported sync fields: ${unsupported.join(', ')}`)
    }
    const size = batchSize(body.batchSize)
    const source = await this.#source()
    if (source.status !== 'active') {
      throw new AppError(409, 'pipeline_paused', 'Activate the mobile-commerce pipeline before scheduling sync')
    }
    const attestation = await this.store.getLatestPipelineWriterContractAttestation?.(MOBILE_COMMERCE_PIPELINE_KEY)
    if (!currentWriterContract(attestation)) {
      throw new AppError(409, 'writer_contract_attestation_required', 'Activate under the current mobile-commerce writer contract before scheduling sync')
    }
    if (!this.queue?.enqueue) {
      throw new AppError(503, 'queue_unavailable', 'Mobile-commerce sync requires the PostgreSQL queue')
    }
    const cursor = await this.#cursor()
    if (cursor?.status === 'running') {
      return { pipelineKey: MOBILE_COMMERCE_PIPELINE_KEY, jobId: null, alreadyScheduled: true }
    }
    const description = await this.databasePuller.describe(MOBILE_COMMERCE_SOURCE_KEY)
    const issues = mobileCommerceProbeIssues(description)
    if (issues.length > 0) {
      throw new AppError(409, 'source_probe_failed', 'Mobile-commerce source is not safe for incremental sync', { issues })
    }
    const jobId = await this.queue.enqueue(
      EXTERNAL_PULL_QUEUE,
      { sourceKey: MOBILE_COMMERCE_SOURCE_KEY, batchSize: size, trigger: 'manual', chunk: 0 },
      { dedupeKey: `external-pull:${MOBILE_COMMERCE_SOURCE_KEY}:0`, priority: 220 },
    )
    return { pipelineKey: MOBILE_COMMERCE_PIPELINE_KEY, jobId, alreadyScheduled: jobId == null }
  }

  async progress() {
    if (typeof this.databasePuller?.progress !== 'function') {
      throw new AppError(503, 'source_progress_unavailable', 'Mobile-commerce progress requires the PostgreSQL source workload')
    }
    return {
      pipelineKey: MOBILE_COMMERCE_PIPELINE_KEY,
      checkedAt: new Date().toISOString(),
      ...(await this.databasePuller.progress(MOBILE_COMMERCE_SOURCE_KEY)),
    }
  }

  async resumeFailedTask() {
    return this.#withLock(async () => {
      const source = await this.#source()
      const cursor = await this.#cursor()
      const abandoned = cursor?.status === 'running' && abandonedRun(source, cursor)
      if (cursor?.status === 'running' && !abandoned) {
        throw new AppError(409, 'source_draining', 'The mobile-commerce task still has a live batch')
      }
      if (cursor?.status !== 'failed' && !abandoned) {
        return { pipelineKey: MOBILE_COMMERCE_PIPELINE_KEY, resumed: false, status: cursor?.status ?? 'idle' }
      }
      const saved = await this.queue.saveCursor(
        `external:${MOBILE_COMMERCE_SOURCE_KEY}`,
        cursor.position ?? {},
        { status: 'idle', processedDelta: 0, error: null },
      )
      return {
        pipelineKey: MOBILE_COMMERCE_PIPELINE_KEY,
        resumed: true,
        from: abandoned ? 'abandoned_run' : 'failed',
        cursor: saved,
      }
    })
  }

  async resetCheckpoint(confirmPipelineKey) {
    if (confirmPipelineKey !== MOBILE_COMMERCE_PIPELINE_KEY) {
      throw new AppError(400, 'checkpoint_reset_confirmation_required', `confirmPipelineKey must be ${MOBILE_COMMERCE_PIPELINE_KEY}`)
    }
    const source = await this.#source()
    if (source.status !== 'paused') {
      throw new AppError(409, 'source_pause_required', 'Pause the mobile-commerce pipeline before resetting its checkpoint')
    }
    return {
      pipelineKey: MOBILE_COMMERCE_PIPELINE_KEY,
      cursor: await this.databasePuller.resetCheckpoint(MOBILE_COMMERCE_SOURCE_KEY),
    }
  }
}
