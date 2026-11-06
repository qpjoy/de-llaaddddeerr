// PostgreSQL state of one file dataset (schema account_dictionary).
//
// Each version owns two hash-partitioned tables named from its integer id
// (ids come from one sequence, so names never collide across datasets):
//   stage_v<N>     raw accepted records while importing (dropped per
//                  partition as soon as that partition is deduplicated)
//   mappings_v<N>  deduplicated, indexed, read-only rows that searches use
// Publishing only moves datasets.active_version_id; no table is rewritten.
import { AppError } from '../../core/errors.mjs'

export const SCHEMA = 'account_dictionary'
// Session advisory lock held by the single active dictionary worker process.
export const WORKER_LOCK = Object.freeze([0x4d580178, 1])
// Session advisory lock (class, dataset hash) held while one dataset's
// version is processed or its tables are dropped.
export const DATASET_LOCK_CLASS = 0x4d58017a
// Transaction advisory locks (class, slot) bounding concurrent slow queries.
export const SLOW_LANE_LOCK_CLASS = 0x4d580179
export const OPEN_STAGES = Object.freeze(['pending', 'verifying', 'importing', 'building', 'validating', 'ready'])

// FNV-1a: a stable 31-bit lock key per dataset.
export function datasetLock(datasetKey) {
  let hash = 0x811c9dc5
  for (const char of Buffer.from(datasetKey)) hash = Math.imul(hash ^ char, 0x01000193) >>> 0
  return Object.freeze([DATASET_LOCK_CLASS, hash & 0x7fffffff])
}

export function versionTables(versionId, partitions = 16) {
  if (!Number.isSafeInteger(versionId) || versionId <= 0) throw new Error('Invalid dictionary version id')
  if (!Number.isSafeInteger(partitions) || partitions < 1 || partitions > 64) throw new Error('Invalid dictionary partition count')
  const base = `v${versionId}`
  return {
    partitions,
    stage: `${SCHEMA}.stage_${base}`,
    stageLeaf: k => `${SCHEMA}.stage_${base}_p${k}`,
    mappings: `${SCHEMA}.mappings_${base}`,
    leaf: k => `${SCHEMA}.mappings_${base}_p${k}`,
    leafName: k => `mappings_${base}_p${k}`,
  }
}

const iso = value => value ? new Date(value).toISOString() : null
const count = value => value === null || value === undefined ? null : Number(value)

export function versionView(row) {
  if (!row) return null
  return {
    id: row.id,
    datasetKey: row.dataset_key,
    stage: row.stage,
    desiredState: row.desired_state,
    runState: row.run_state,
    source: {
      rootId: row.source_root_id,
      relativePath: row.source_relative_path,
      filename: row.source_filename,
      bytes: count(row.source_bytes),
      // Set when the content is one file inside a .zip archive.
      entry: row.source_entry ?? null,
      entryBytes: count(row.source_entry_bytes ?? null),
      expectedSha256: row.expected_sha256,
      sha256: row.source_sha256,
      shaBytes: count(row.sha_bytes),
    },
    parserVersion: row.parser_version,
    partitionCount: row.partition_count,
    byteOffset: count(row.byte_offset),
    parserState: row.parser_state,
    pairsRead: count(row.pairs_read),
    pairsLoaded: count(row.pairs_loaded),
    pairsQuarantined: count(row.pairs_quarantined),
    quarantineReasons: Object.fromEntries(Object.entries(row.quarantine_reasons || {}).map(([key, value]) => [key, Number(value)])),
    uniqueMappings: count(row.unique_mappings),
    duplicatePairs: count(row.duplicate_pairs),
    sampleRows: count(row.sample_rows),
    tableBytes: count(row.table_bytes),
    indexBytes: count(row.index_bytes),
    rowsPerSecond: row.recent_rows_per_second === null ? null : Number(row.recent_rows_per_second),
    error: row.error_code ? { code: row.error_code, message: row.error_message } : null,
    heartbeatAt: iso(row.heartbeat_at),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    startedAt: iso(row.started_at),
    importedAt: iso(row.imported_at),
    readyAt: iso(row.ready_at),
    publishedAt: iso(row.published_at),
    retiredAt: iso(row.retired_at),
    dataDroppedAt: iso(row.data_dropped_at),
    updatedAt: iso(row.updated_at),
  }
}

export function datasetView(row) {
  if (!row) return null
  return {
    key: row.dataset_key,
    name: row.display_name,
    owner: row.owner,
    purpose: row.purpose,
    legalBasis: row.legal_basis,
    source: row.source_root_id ? { rootId: row.source_root_id, relativePath: row.source_relative_path, entry: row.source_entry ?? null } : null,
    expectedSha256: row.expected_sha256,
    activeVersionId: row.active_version_id,
    previousVersionId: row.previous_version_id,
    revision: row.revision,
    updatedBy: row.updated_by,
    updatedAt: iso(row.updated_at),
  }
}

export class FileDatasetStore {
  constructor(pool, { datasetKey, kind, partitions = kind?.partitions } = {}) {
    if (!pool) throw new Error('FileDatasetStore requires a PostgreSQL pool')
    if (!datasetKey || !kind) throw new Error('FileDatasetStore requires a dataset key and storage kind')
    this.pool = pool
    this.datasetKey = datasetKey
    this.kind = kind
    this.partitions = partitions
    this.lock = datasetLock(datasetKey)
  }

  async dataset(client = this.pool) {
    const { rows } = await client.query(`SELECT * FROM ${SCHEMA}.datasets WHERE dataset_key = $1`, [this.datasetKey])
    if (!rows[0]) throw new AppError(503, 'file_dataset_unavailable', `File dataset ${this.datasetKey} is not migrated`)
    return rows[0]
  }

  async configureSource({ rootId, relativePath, entry = null, expectedSha256, owner, purpose, legalBasis, updatedBy }) {
    const { rows } = await this.pool.query(
      `UPDATE ${SCHEMA}.datasets SET source_root_id = $2, source_relative_path = $3, expected_sha256 = $4,
         owner = coalesce($5, owner), purpose = coalesce($6, purpose), legal_basis = coalesce($7, legal_basis),
         updated_by = $8, source_entry = $9, revision = revision + 1, updated_at = now()
       WHERE dataset_key = $1 RETURNING *`,
      [this.datasetKey, rootId, relativePath, expectedSha256, owner ?? null, purpose ?? null, legalBasis ?? null, updatedBy, entry],
    )
    return rows[0]
  }

  async openVersion(client = this.pool) {
    const { rows } = await client.query(
      `SELECT * FROM ${SCHEMA}.versions WHERE dataset_key = $1 AND stage = ANY($2::text[])`,
      [this.datasetKey, OPEN_STAGES],
    )
    return rows[0] || null
  }

  async version(id, client = this.pool) {
    const { rows } = await client.query(`SELECT * FROM ${SCHEMA}.versions WHERE id = $1 AND dataset_key = $2`, [id, this.datasetKey])
    return rows[0] || null
  }

  async recentVersions(limit = 10) {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${SCHEMA}.versions WHERE dataset_key = $1 ORDER BY id DESC LIMIT $2`,
      [this.datasetKey, limit],
    )
    return rows
  }

  async partitionRows(versionId, client = this.pool) {
    const { rows } = await client.query(
      `SELECT * FROM ${SCHEMA}.version_partitions WHERE version_id = $1 ORDER BY partition_no`,
      [versionId],
    )
    return rows
  }

  async createVersion({ file, entry = null, expectedSha256, createdBy }) {
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO ${SCHEMA}.versions (
           dataset_key, source_root_id, source_relative_path, source_filename, source_bytes,
           source_identity, source_mtime_ns, expected_sha256, parser_version, partition_count, created_by,
           source_entry, source_entry_bytes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
        [this.datasetKey, file.rootId, file.relativePath, file.filename, file.bytes,
          file.identity, file.mtimeNs, expectedSha256, this.kind.parserVersion, this.partitions, createdBy,
          entry?.name ?? null, entry?.size ?? null],
      )
      return rows[0]
    } catch (error) {
      if (error.code === '23505') {
        throw new AppError(409, 'dictionary_version_open', 'A dictionary version is already in progress or awaiting publish')
      }
      throw error
    }
  }

  async requestPause(versionId) {
    const { rows } = await this.pool.query(
      `UPDATE ${SCHEMA}.versions SET desired_state = 'paused',
         run_state = CASE WHEN run_state = 'waiting' THEN 'paused' ELSE run_state END, updated_at = now()
       WHERE id = $1 AND dataset_key = $2 AND stage = ANY($3::text[]) AND stage <> 'ready'
         AND desired_state = 'running' AND run_state IN ('waiting', 'running')
       RETURNING *`,
      [versionId, this.datasetKey, OPEN_STAGES],
    )
    if (!rows[0]) throw new AppError(409, 'dictionary_not_running', 'This version is not running')
    return rows[0]
  }

  async requestResume(versionId) {
    const { rows } = await this.pool.query(
      `UPDATE ${SCHEMA}.versions SET desired_state = 'running', run_state = 'waiting',
         error_code = NULL, error_message = NULL, updated_at = now()
       WHERE id = $1 AND dataset_key = $2 AND stage = ANY($3::text[]) AND stage <> 'ready'
         AND desired_state <> 'discard'
         AND (desired_state = 'paused' OR run_state IN ('paused', 'failed'))
       RETURNING *`,
      [versionId, this.datasetKey, OPEN_STAGES],
    )
    if (!rows[0]) throw new AppError(409, 'dictionary_not_resumable', 'This version is neither paused nor failed')
    return rows[0]
  }

  /**
   * Discard an unpublished version. When no worker is processing this
   * dataset the tables are dropped immediately; otherwise the running worker
   * drops them after its current batch or partition step.
   */
  async requestDiscard(versionId) {
    const { rows } = await this.pool.query(
      `UPDATE ${SCHEMA}.versions SET desired_state = 'discard', updated_at = now()
       WHERE id = $1 AND dataset_key = $2 AND stage = ANY($3::text[]) RETURNING *`,
      [versionId, this.datasetKey, OPEN_STAGES],
    )
    if (!rows[0]) throw new AppError(409, 'dictionary_not_discardable', 'Only an unpublished version can be discarded')
    const dropped = await this.withDatasetLock(client => this.discardVersion(client, rows[0]))
    return dropped.acquired ? await this.version(versionId) : rows[0]
  }

  async withDatasetLock(fn) {
    const client = await this.pool.connect()
    try {
      const { rows } = await client.query('SELECT pg_try_advisory_lock($1, $2) AS acquired', this.lock)
      if (!rows[0]?.acquired) return { acquired: false }
      try {
        return { acquired: true, value: await fn(client) }
      } finally {
        await client.query('SELECT pg_advisory_unlock($1, $2)', this.lock).catch(() => {})
      }
    } finally {
      client.release()
    }
  }

  async dropVersionTables(client, versionId, partitions = this.partitions) {
    const tables = versionTables(versionId, partitions)
    await client.query(`SET lock_timeout = '30s'`)
    try {
      await client.query(`DROP TABLE IF EXISTS ${tables.stage} CASCADE`)
      await client.query(`DROP TABLE IF EXISTS ${tables.mappings} CASCADE`)
      // Leaves not yet attached to mappings_v<N> are independent tables.
      for (let k = 0; k < partitions; k += 1) await client.query(`DROP TABLE IF EXISTS ${tables.leaf(k)}`)
      await client.query(`DELETE FROM ${SCHEMA}.trigram_stats WHERE version_id = $1`, [versionId])
      await client.query(`DELETE FROM ${SCHEMA}.quarantine WHERE version_id = $1`, [versionId])
    } finally {
      await client.query('RESET lock_timeout').catch(() => {})
    }
  }

  async discardVersion(client, version) {
    await this.dropVersionTables(client, version.id, version.partition_count)
    await client.query(
      `UPDATE ${SCHEMA}.versions SET stage = 'discarded', run_state = 'done', data_dropped_at = now(), updated_at = now()
       WHERE id = $1`,
      [version.id],
    )
  }

  async publish(versionId, { publishedBy }) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const dataset = (await client.query(`SELECT * FROM ${SCHEMA}.datasets WHERE dataset_key = $1 FOR UPDATE`, [this.datasetKey])).rows[0]
      const { rows } = await client.query(
        `UPDATE ${SCHEMA}.versions SET stage = 'published', published_at = now(), updated_at = now()
         WHERE id = $1 AND dataset_key = $2 AND stage = 'ready' RETURNING *`,
        [versionId, this.datasetKey],
      )
      if (!rows[0]) throw new AppError(409, 'dictionary_not_ready', 'Only a validated version can be published')
      if (dataset.active_version_id) {
        await client.query(
          `UPDATE ${SCHEMA}.versions SET stage = 'retired', retired_at = now(), updated_at = now() WHERE id = $1`,
          [dataset.active_version_id],
        )
      }
      await client.query(
        `UPDATE ${SCHEMA}.datasets SET active_version_id = $2, previous_version_id = $3,
           updated_by = $4, revision = revision + 1, updated_at = now()
         WHERE dataset_key = $1`,
        [this.datasetKey, versionId, dataset.active_version_id, publishedBy],
      )
      await client.query('COMMIT')
      return rows[0]
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  /** Swap the active and previous versions (the previous data is kept). */
  async rollback({ rolledBackBy }) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const dataset = (await client.query(`SELECT * FROM ${SCHEMA}.datasets WHERE dataset_key = $1 FOR UPDATE`, [this.datasetKey])).rows[0]
      if (!dataset.previous_version_id) throw new AppError(409, 'dictionary_no_previous_version', 'There is no previous version to roll back to')
      const previous = (await client.query(`SELECT * FROM ${SCHEMA}.versions WHERE id = $1`, [dataset.previous_version_id])).rows[0]
      if (!previous || previous.data_dropped_at) throw new AppError(409, 'dictionary_previous_dropped', 'The previous version data is no longer available')
      await client.query(
        `UPDATE ${SCHEMA}.versions SET stage = 'published', retired_at = NULL, updated_at = now() WHERE id = $1`,
        [previous.id],
      )
      if (dataset.active_version_id) {
        await client.query(
          `UPDATE ${SCHEMA}.versions SET stage = 'retired', retired_at = now(), updated_at = now() WHERE id = $1`,
          [dataset.active_version_id],
        )
      }
      await client.query(
        `UPDATE ${SCHEMA}.datasets SET active_version_id = $2, previous_version_id = $3,
           updated_by = $4, revision = revision + 1, updated_at = now()
         WHERE dataset_key = $1`,
        [this.datasetKey, previous.id, dataset.active_version_id, rolledBackBy],
      )
      await client.query('COMMIT')
      return previous
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  /** Retired versions that are neither active nor the rollback target. */
  async droppableVersions(client = this.pool) {
    const { rows } = await client.query(
      `SELECT v.* FROM ${SCHEMA}.versions v JOIN ${SCHEMA}.datasets d ON d.dataset_key = v.dataset_key
       WHERE v.dataset_key = $1 AND v.data_dropped_at IS NULL
         AND (v.stage = 'discarded' OR (v.stage = 'retired'
           AND v.id IS DISTINCT FROM d.active_version_id AND v.id IS DISTINCT FROM d.previous_version_id))
       ORDER BY v.id`,
      [this.datasetKey],
    )
    return rows
  }

  async activeVersion() {
    const { rows } = await this.pool.query(
      `SELECT v.id, v.partition_count, v.unique_mappings, v.sample_rows, v.published_at, v.source_sha256
       FROM ${SCHEMA}.datasets d JOIN ${SCHEMA}.versions v ON v.id = d.active_version_id
       WHERE d.dataset_key = $1`,
      [this.datasetKey],
    )
    const row = rows[0]
    return row ? {
      id: row.id,
      partitionCount: row.partition_count,
      uniqueMappings: Number(row.unique_mappings || 0),
      sampleRows: Number(row.sample_rows || 0),
      publishedAt: iso(row.published_at),
      sourceSha256: row.source_sha256,
    } : null
  }

  async recentAccess(limit = 20) {
    const { rows } = await this.pool.query(
      `SELECT mode, field, outcome, result_count, revealed_count, took_ms, consumer_id, api_key_id, version_id, created_at
       FROM ${SCHEMA}.access_events WHERE dataset_key = $1 ORDER BY created_at DESC LIMIT $2`,
      [this.datasetKey, limit],
    )
    return rows.map(row => ({
      mode: row.mode, field: row.field, outcome: row.outcome, resultCount: row.result_count,
      revealedCount: row.revealed_count, tookMs: row.took_ms, consumerId: row.consumer_id,
      apiKeyId: row.api_key_id, versionId: row.version_id, createdAt: iso(row.created_at),
    }))
  }
}
