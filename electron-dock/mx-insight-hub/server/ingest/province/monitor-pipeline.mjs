import { createHash } from 'node:crypto'
import { AppError } from '../../core/errors.mjs'
import { PROVINCE_GEOGRAPHY_PIPELINE_KEY } from '../../agent/pipeline-store.mjs'
import { enqueueJobsAtomically } from '../external/atomic-enqueue.mjs'
import { validateDatabaseConnection } from '../external/database-source.mjs'
import { EXTERNAL_PULL_QUEUE } from '../external/sync-job.mjs'
import {
  PROVINCE_OPINION_SOURCE_KEY,
  PROVINCE_OPINION_SOURCE_LOCATOR,
  provinceOpinionProbeIssues,
  provinceOpinionSourceContractIssues,
} from './source-contract.mjs'

export {
  PROVINCE_OPINION_SOURCE_KEY,
  provinceOpinionProbeIssues,
  provinceOpinionSourceContractIssues,
} from './source-contract.mjs'

export const PROVINCE_OPINION_PIPELINE_KEY = 'province-opinion'
export const PROVINCE_OPINION_MAPPING_VERSION = 1
export const PROVINCE_OPINION_WRITER_CONTRACT_VERSION = 'province-opinion.writer.v1'
export const PROVINCE_OPINION_SAFE_BATCH_SIZE = 200
export const PROVINCE_OPINION_MAX_BATCH_SIZE = 500
export const PROVINCE_OPINION_SERVING_INDEXES = Object.freeze([
  'canonical_province_opinion_hot_idx',
  'canonical_province_opinion_latest_idx',
])

export const PROVINCE_OPINION_INPUT = Object.freeze({
  role: 'results',
  sourceKey: PROVINCE_OPINION_SOURCE_KEY,
  ...PROVINCE_OPINION_SOURCE_LOCATOR,
  builtInMappingVersion: PROVINCE_OPINION_MAPPING_VERSION,
  builtInMappingId: 'e373f0f5-2042-4b34-bce9-bb4d668e5429',
})

export const PROVINCE_OPINION_WRITER_CONTRACT_SUMMARY = Object.freeze({
  watermark: 'Every insert and every relevant update advances a finite, non-null timestamp updated_at, including province, source, heat and LLM classification changes.',
  deletion: 'Hard deletes are not used; removals must remain observable through a source change record before Hub ingestion can support them.',
  ordering: 'A later commit cannot expose updated_at at or behind a checkpoint already consumed by the Hub; use an ordered change journal or CDC when this cannot be guaranteed.',
  input: Object.freeze({
    table: `${PROVINCE_OPINION_INPUT.schema}.${PROVINCE_OPINION_INPUT.table}`,
    cursor: [PROVINCE_OPINION_INPUT.cursorColumn, PROVINCE_OPINION_INPUT.idColumn],
    requiredIndex: `(${PROVINCE_OPINION_INPUT.cursorColumn}, ${PROVINCE_OPINION_INPUT.idColumn})`,
  }),
})

export const PROVINCE_OPINION_WRITER_CONTRACT_DIGEST = createHash('sha256')
  .update(JSON.stringify(PROVINCE_OPINION_WRITER_CONTRACT_SUMMARY))
  .digest('hex')

const SHARED_CONNECTION_FIELDS = new Set([
  'host', 'port', 'database', 'username', 'password', 'sslMode',
])
const ABANDONED_RUN_CYCLES = 10
const ABANDONED_RUN_FLOOR_MS = 15 * 60 * 1_000
const ENQUEUE_ERRORS = Object.freeze({
  unavailable: {
    code: 'atomic_enqueue_unavailable',
    message: 'Province opinion sync requires the PostgreSQL queue',
  },
  failed: {
    code: 'pipeline_sync_enqueue_failed',
    message: 'No province opinion task was scheduled; retry when the PostgreSQL queue is available',
  },
  outcomeUnknown: {
    code: 'pipeline_sync_enqueue_outcome_unknown',
    message: 'The province opinion sync transaction outcome is unknown; inspect the task queue before retrying',
  },
})

export function isProvinceOpinionSourceKey(sourceKey) {
  return sourceKey === PROVINCE_OPINION_SOURCE_KEY
}

export function provinceOpinionHanlpIssues(segmenterConfig) {
  const backend = typeof segmenterConfig?.backend === 'string'
    ? segmenterConfig.backend.trim().toLowerCase()
    : ''
  const hanlpUrl = typeof segmenterConfig?.hanlpUrl === 'string'
    ? segmenterConfig.hanlpUrl.trim()
    : ''
  const issues = []
  if (backend !== 'hanlp') {
    issues.push('Province opinion indexing requires MX_COMMON_SEGMENTER=hanlp')
  }
  if (!hanlpUrl) {
    issues.push('Province opinion indexing requires a configured MX_COMMON_HANLP_URL')
  }
  return issues
}

export function assertProvinceOpinionHanlpConfigured(segmenterConfig) {
  const issues = provinceOpinionHanlpIssues(segmenterConfig)
  if (issues.length > 0) {
    throw new AppError(
      409,
      'province_hanlp_required',
      'Configure strict HanLP indexing before activating or scheduling the province opinion pipeline',
      { issues },
    )
  }
}

function writerContract() {
  return {
    version: PROVINCE_OPINION_WRITER_CONTRACT_VERSION,
    digest: PROVINCE_OPINION_WRITER_CONTRACT_DIGEST,
    summary: PROVINCE_OPINION_WRITER_CONTRACT_SUMMARY,
  }
}

function assertWriterContractAttestation(attestation) {
  if (
    attestation?.confirmed !== true
    || attestation?.contractVersion !== PROVINCE_OPINION_WRITER_CONTRACT_VERSION
    || attestation?.contractDigest !== PROVINCE_OPINION_WRITER_CONTRACT_DIGEST
  ) {
    throw new AppError(
      409,
      'writer_contract_attestation_required',
      'Explicit confirmation of the province opinion source-writer contract is required before activation',
      { writerContract: writerContract() },
    )
  }
}

function isCurrentWriterContractAttestation(attestation) {
  return attestation?.contractVersion === PROVINCE_OPINION_WRITER_CONTRACT_VERSION
    && attestation?.contractDigest === PROVINCE_OPINION_WRITER_CONTRACT_DIGEST
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
  const size = value ?? PROVINCE_OPINION_SAFE_BATCH_SIZE
  if (!Number.isInteger(size) || size < 1 || size > PROVINCE_OPINION_MAX_BATCH_SIZE) {
    throw new AppError(
      400,
      'invalid_batch_size',
      `batchSize must be an integer between 1 and ${PROVINCE_OPINION_MAX_BATCH_SIZE}`,
    )
  }
  return size
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

export class ProvinceOpinionPipeline {
  constructor({ store, queue, databasePuller, agentPipelineStore = null, segmenterConfig = null }) {
    this.store = store
    this.queue = queue
    this.databasePuller = databasePuller
    this.agentPipelineStore = agentPipelineStore
    this.segmenterConfig = segmenterConfig
  }

  async #source() {
    const source = await this.store.getExternalSource(PROVINCE_OPINION_SOURCE_KEY)
    if (!source) {
      throw new AppError(404, 'pipeline_source_not_found', 'Province opinion source is not installed')
    }
    if (source.sourceKind !== 'database') {
      throw new AppError(409, 'pipeline_source_invalid', 'Province opinion source must be a PostgreSQL database source')
    }
    return source
  }

  async #cursor() {
    return this.queue?.getCursor?.(`external:${PROVINCE_OPINION_SOURCE_KEY}`) ?? null
  }

  async #withLock(operation) {
    if (typeof this.databasePuller?.withSourceLock !== 'function') {
      throw new AppError(503, 'source_lock_unavailable', 'Province opinion changes require source locking')
    }
    return this.databasePuller.withSourceLock(PROVINCE_OPINION_SOURCE_KEY, operation)
  }

  async #builtInMapping(source) {
    const mappings = await this.store.listSourceMappings(source.id)
    const mapping = mappings.find((candidate) => (
      candidate.id === PROVINCE_OPINION_INPUT.builtInMappingId
      && candidate.version === PROVINCE_OPINION_INPUT.builtInMappingVersion
    ))
    if (!mapping) {
      throw new AppError(409, 'builtin_mapping_conflict', 'Seeded province opinion mapping is missing or collides')
    }
    return mapping
  }

  async #servingIndexes() {
    if (typeof this.store.getPublicOpinionServingIndexStatus !== 'function') {
      return {
        ready: false,
        required: [...PROVINCE_OPINION_SERVING_INDEXES],
        indexes: [],
        missing: [...PROVINCE_OPINION_SERVING_INDEXES],
      }
    }
    return this.store.getPublicOpinionServingIndexStatus()
  }

  async get() {
    const source = await this.#source()
    const [
      activeMapping, mappings, cursor, runs, latestAttestation, servingIndexes,
      classification,
    ] = await Promise.all([
      this.store.getActiveMapping(source.id),
      this.store.listSourceMappings(source.id),
      this.#cursor(),
      this.store.listImportRuns(source.id, 1),
      this.store.getLatestPipelineWriterContractAttestation?.(PROVINCE_OPINION_PIPELINE_KEY) ?? null,
      this.#servingIndexes(),
      this.agentPipelineStore?.getPipeline?.(PROVINCE_GEOGRAPHY_PIPELINE_KEY) ?? null,
    ])
    const connection = sharedConnection(source.connection)
    const sourceContractIssues = provinceOpinionSourceContractIssues(source)
    const hanlpIssues = provinceOpinionHanlpIssues(this.segmenterConfig)
    const fixedContractValid = sourceContractIssues.length === 0
    return {
      pipelineKey: PROVINCE_OPINION_PIPELINE_KEY,
      displayName: '全国省份舆情',
      status: source.status,
      configured: isConfigured(connection) && fixedContractValid,
      connection,
      syncIntervalSeconds: source.syncIntervalSeconds,
      fixedInput: {
        schema: PROVINCE_OPINION_INPUT.schema,
        table: PROVINCE_OPINION_INPUT.table,
        cursorColumn: PROVINCE_OPINION_INPUT.cursorColumn,
        idColumn: PROVINCE_OPINION_INPUT.idColumn,
      },
      configurationIssues: [
        ...sourceContractIssues,
        ...hanlpIssues,
        ...(servingIndexes.ready
          ? []
          : [`Hub serving indexes are not ready: ${servingIndexes.missing.join(', ')}`]),
      ],
      servingIndexes,
      indexing: {
        requiredBackend: 'hanlp',
        configuredBackend: this.segmenterConfig?.backend || null,
        hanlpUrlConfigured: Boolean(this.segmenterConfig?.hanlpUrl),
        readyToSchedule: hanlpIssues.length === 0,
      },
      writerContract: { ...writerContract(), latestAttestation },
      classification,
      task: {
        ...PROVINCE_OPINION_INPUT,
        source,
        activeMapping,
        builtInMappingAvailable: mappings.some((mapping) => (
          mapping.id === PROVINCE_OPINION_INPUT.builtInMappingId
          && mapping.version === PROVINCE_OPINION_INPUT.builtInMappingVersion
        )),
        cursor,
        latestRun: runs[0] ?? null,
        nextDueAt: nextDueAt(source, cursor),
      },
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
        `Province opinion table and cursor fields are fixed; unsupported connection fields: ${unsupportedConnection.join(', ')}`,
      )
    }
    const interval = syncInterval(body.syncIntervalSeconds)
    return this.#withLock(async () => {
      const source = await this.#source()
      if (source.status !== 'paused') {
        throw new AppError(409, 'source_pause_required', 'Pause the province opinion pipeline before changing its connection')
      }
      const cursor = await this.#cursor()
      if (cursor?.status === 'running') {
        throw new AppError(409, 'source_draining', 'Wait for the province opinion task to reach a checkpoint')
      }
      let connection
      if (body.connection != null) {
        connection = {
          ...sharedConnection(source.connection),
          ...body.connection,
          schema: PROVINCE_OPINION_INPUT.schema,
          table: PROVINCE_OPINION_INPUT.table,
          cursorColumn: PROVINCE_OPINION_INPUT.cursorColumn,
          idColumn: PROVINCE_OPINION_INPUT.idColumn,
        }
        delete connection.dsnEnv
        validateDatabaseConnection(connection)
        await this.databasePuller.testConnection(connection)
      }
      await this.store.updateExternalSourcesBatch([{
        sourceKey: PROVINCE_OPINION_SOURCE_KEY,
        ...(connection ? { connection } : {}),
        ...(interval === undefined ? {} : { syncIntervalSeconds: interval }),
      }])
      return this.get()
    })
  }

  async setStatus(status, { approvedBy = 'admin-token', writerContractAttestation = null } = {}) {
    if (!['active', 'paused'].includes(status)) {
      throw new AppError(400, 'invalid_status', 'status must be active or paused')
    }
    if (status === 'paused') {
      await this.store.updateExternalSourcesBatch([{
        sourceKey: PROVINCE_OPINION_SOURCE_KEY,
        status: 'paused',
      }])
      return this.get()
    }
    return this.#withLock(async () => {
      assertProvinceOpinionHanlpConfigured(this.segmenterConfig)
      const source = await this.#source()
      const sourceContractIssues = provinceOpinionSourceContractIssues(source)
      if (sourceContractIssues.length > 0) {
        throw new AppError(
          409,
          'pipeline_source_contract_drift',
          'The fixed province opinion source contract has drifted',
          { issues: sourceContractIssues },
        )
      }
      const connection = sharedConnection(source.connection)
      if (!isConfigured(connection)) {
        throw new AppError(409, 'pipeline_not_configured', 'Configure the province opinion database connection before activation')
      }
      const cursor = await this.#cursor()
      if (cursor?.status === 'running') {
        throw new AppError(409, 'source_draining', 'Wait for the province opinion task to reach a checkpoint')
      }
      const servingIndexes = await this.#servingIndexes()
      if (!servingIndexes.ready) {
        throw new AppError(
          409,
          'serving_indexes_required',
          'Install the province opinion Hub serving indexes online before activation',
          { servingIndexes },
        )
      }
      const active = await this.store.getActiveMapping(source.id)
      const builtIn = await this.#builtInMapping(source)
      if (active && (active.id !== builtIn.id || active.version !== builtIn.version)) {
        throw new AppError(409, 'builtin_mapping_conflict', 'A non-built-in mapping is active for the province opinion source')
      }
      const description = await this.databasePuller.describe(PROVINCE_OPINION_SOURCE_KEY, {
        mappingOverride: builtIn,
      })
      const probeIssues = provinceOpinionProbeIssues(description)
      if (probeIssues.length > 0) {
        throw new AppError(
          409,
          'source_probe_failed',
          'Province opinion source schema is not safe for incremental sync',
          { sourceKey: PROVINCE_OPINION_SOURCE_KEY, issues: probeIssues, warnings: description.warnings },
        )
      }
      await this.databasePuller.assertCheckpointCompatible(PROVINCE_OPINION_SOURCE_KEY, {
        mappingOverride: builtIn,
      })
      assertWriterContractAttestation(writerContractAttestation)
      await this.store.activateExternalSourcesWithAttestation({
        sourceKeys: [PROVINCE_OPINION_SOURCE_KEY],
        pipelineKey: PROVINCE_OPINION_PIPELINE_KEY,
        contractVersion: PROVINCE_OPINION_WRITER_CONTRACT_VERSION,
        contractDigest: PROVINCE_OPINION_WRITER_CONTRACT_DIGEST,
        contractSummary: PROVINCE_OPINION_WRITER_CONTRACT_SUMMARY,
        attestedBy: approvedBy,
        approvals: active ? [] : [{
          mappingId: builtIn.id,
          sourceId: source.id,
          version: builtIn.version,
        }],
      })
      return this.get()
    })
  }

  async sync(body = {}) {
    const unsupported = unsupportedFields(body, new Set(['batchSize']))
    if (unsupported.length > 0) {
      throw new AppError(400, 'unsupported_fields', `Unsupported sync fields: ${unsupported.join(', ')}`)
    }
    const size = batchSize(body.batchSize)
    assertProvinceOpinionHanlpConfigured(this.segmenterConfig)
    const source = await this.#source()
    const sourceContractIssues = provinceOpinionSourceContractIssues(source)
    if (sourceContractIssues.length > 0) {
      throw new AppError(
        409,
        'pipeline_source_contract_drift',
        'The fixed province opinion source contract has drifted',
        { issues: sourceContractIssues },
      )
    }
    if (source.status !== 'active') {
      throw new AppError(409, 'pipeline_paused', 'Activate the province opinion pipeline before scheduling sync')
    }
    const attestation = await this.store.getLatestPipelineWriterContractAttestation?.(PROVINCE_OPINION_PIPELINE_KEY)
    if (!isCurrentWriterContractAttestation(attestation)) {
      throw new AppError(
        409,
        'writer_contract_attestation_required',
        'Activate the province opinion pipeline under the current writer contract before scheduling sync',
        { writerContract: writerContract() },
      )
    }
    const cursor = await this.#cursor()
    if (cursor?.status === 'running') {
      return {
        pipelineKey: PROVINCE_OPINION_PIPELINE_KEY,
        task: { sourceKey: PROVINCE_OPINION_SOURCE_KEY, jobId: null, alreadyScheduled: true },
      }
    }
    const description = await this.databasePuller.describe(PROVINCE_OPINION_SOURCE_KEY)
    const probeIssues = provinceOpinionProbeIssues(description)
    if (probeIssues.length > 0) {
      throw new AppError(409, 'source_probe_failed', 'Province opinion source schema is not safe for incremental sync', {
        sourceKey: PROVINCE_OPINION_SOURCE_KEY,
        issues: probeIssues,
      })
    }
    const [jobId] = await enqueueJobsAtomically(this.queue, [{
      queue: EXTERNAL_PULL_QUEUE,
      payload: { sourceKey: PROVINCE_OPINION_SOURCE_KEY, batchSize: size, trigger: 'manual', chunk: 0 },
      options: { dedupeKey: `external-pull:${PROVINCE_OPINION_SOURCE_KEY}:0`, priority: 220 },
    }], ENQUEUE_ERRORS)
    return {
      pipelineKey: PROVINCE_OPINION_PIPELINE_KEY,
      task: { sourceKey: PROVINCE_OPINION_SOURCE_KEY, jobId, alreadyScheduled: jobId === null },
    }
  }

  async progress() {
    const [progress, description] = await Promise.all([
      this.databasePuller.progress(PROVINCE_OPINION_SOURCE_KEY),
      this.databasePuller.describe(PROVINCE_OPINION_SOURCE_KEY),
    ])
    const issues = [...new Set([
      ...(progress.issues || []),
      ...provinceOpinionProbeIssues(description),
    ])]
    return {
      pipelineKey: PROVINCE_OPINION_PIPELINE_KEY,
      checkedAt: new Date().toISOString(),
      ...progress,
      blocker: issues.length > 0 ? progress.blocker || 'source_contract_unsafe' : null,
      issues,
    }
  }

  async resumeFailedTask() {
    return this.#withLock(async () => {
      const source = await this.#source()
      const cursor = await this.#cursor()
      const abandoned = cursor?.status === 'running' && abandonedRun(source, cursor)
      if (cursor?.status === 'running' && !abandoned) {
        throw new AppError(409, 'source_draining', 'Wait for the province opinion task to reach a checkpoint')
      }
      if (cursor?.status !== 'failed' && !abandoned) {
        return {
          pipelineKey: PROVINCE_OPINION_PIPELINE_KEY,
          task: { sourceKey: PROVINCE_OPINION_SOURCE_KEY, status: cursor?.status ?? 'idle', resumed: false },
        }
      }
      await this.queue.saveCursor(
        `external:${PROVINCE_OPINION_SOURCE_KEY}`,
        cursor.position ?? {},
        { status: 'idle', processedDelta: 0, error: null },
      )
      return {
        pipelineKey: PROVINCE_OPINION_PIPELINE_KEY,
        task: {
          sourceKey: PROVINCE_OPINION_SOURCE_KEY,
          status: 'idle',
          resumed: true,
          from: abandoned ? 'abandoned_run' : 'failed',
          silentForMs: abandoned ? cursorSilenceMs(cursor) : null,
          clearedError: cursor.error ?? null,
        },
      }
    })
  }

  async resetCheckpoint(confirmPipelineKey) {
    if (confirmPipelineKey !== PROVINCE_OPINION_PIPELINE_KEY) {
      throw new AppError(
        400,
        'checkpoint_reset_confirmation_required',
        `confirmPipelineKey must be ${PROVINCE_OPINION_PIPELINE_KEY}`,
      )
    }
    const source = await this.#source()
    if (source.status !== 'paused') {
      throw new AppError(409, 'source_pause_required', 'Pause the province opinion pipeline before resetting its checkpoint')
    }
    const builtIn = await this.#builtInMapping(source)
    const cursor = await this.databasePuller.resetCheckpoints(
      [PROVINCE_OPINION_SOURCE_KEY],
      { mappingOverrides: { [PROVINCE_OPINION_SOURCE_KEY]: builtIn } },
    )
    return { pipelineKey: PROVINCE_OPINION_PIPELINE_KEY, resets: cursor }
  }
}
