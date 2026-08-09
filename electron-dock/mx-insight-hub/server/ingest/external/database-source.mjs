import { createHash } from 'node:crypto'
import pg from 'pg'
import { AppError } from '../../core/errors.mjs'
import { applyMapping, validateFieldMap, CHUNKER_VERSION } from './mapping.mjs'

// Incremental pull from a foreign PostgreSQL database.
//
// Scope is deliberately one engine. A generic "any database" connector means
// bundling a driver per engine and reimplementing cursor semantics for each
// dialect's ordering and type coercion rules. When a MySQL or SQL Server source
// actually appears, it gets its own module with its own tested cursor logic
// rather than a shared abstraction guessing at both.
//
// Read-only by construction: the connection runs with
// `default_transaction_read_only`, so a mapping mistake or an injected
// identifier cannot write to somebody else's database.

const MAX_BATCH = 5_000
const MAX_PREVIEW = 3
const CONNECTION_FIELDS = new Set(['dsnEnv', 'schema', 'table', 'cursorColumn', 'idColumn'])
const CURSOR_CASTS = new Map([
  ['timestamptz', 'timestamptz'],
  ['timestamp', 'timestamp'],
  ['date', 'date'],
])
const ID_CASTS = new Map([
  ['int2', 'smallint'],
  ['int4', 'integer'],
  ['int8', 'bigint'],
  ['uuid', 'uuid'],
  ['text', 'text'],
  ['varchar', 'text'],
  ['bpchar', 'text'],
])

/**
 * Identifiers cannot be parameterised in SQL, so they are validated instead.
 *
 * The allowlist is strict on purpose: a schema/table/column name in this system
 * comes from operator configuration, and anything outside plain identifiers is
 * far more likely to be a mistake or an injection attempt than a legitimate
 * name that needs quoting.
 */
function safeIdentifier(value, what) {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value)) {
    throw new AppError(400, 'invalid_identifier', `${what} must be a plain SQL identifier: ${value}`)
  }
  return value
}

function qualifiedTable(connection) {
  const schema = safeIdentifier(connection.schema || 'public', 'schema')
  const table = safeIdentifier(connection.table, 'table')
  return `"${schema}"."${table}"`
}

function quotedIdentifier(value, what) {
  return `"${safeIdentifier(value, what)}"`
}

export function validateDatabaseConnection(connection) {
  if (!connection || typeof connection !== 'object' || Array.isArray(connection)) {
    throw new AppError(400, 'invalid_connection', 'connection must be an object')
  }
  const unsupported = Object.keys(connection).filter((key) => !CONNECTION_FIELDS.has(key))
  if (unsupported.length > 0) {
    throw new AppError(400, 'unsupported_connection_fields', `Unsupported database connection fields: ${unsupported.join(', ')}`)
  }
  if (typeof connection.dsnEnv !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(connection.dsnEnv)) {
    throw new AppError(400, 'missing_dsn_env', 'connection.dsnEnv must name an uppercase environment variable')
  }
  safeIdentifier(connection.schema || 'public', 'schema')
  safeIdentifier(connection.table, 'table')
  if (connection.cursorColumn != null) safeIdentifier(connection.cursorColumn, 'cursorColumn')
  if (connection.idColumn != null) safeIdentifier(connection.idColumn, 'idColumn')
  return true
}

function safeSource(source) {
  const connection = source.connection || {}
  return {
    sourceKey: source.sourceKey,
    displayName: source.displayName,
    datasetId: source.datasetId,
    platform: source.platform,
    objectType: source.objectType,
    status: source.status,
    schema: connection.schema || 'public',
    table: connection.table,
  }
}

function valueShape(value) {
  if (value === null || value === undefined) return { jsonType: 'null', isNull: true, serializedLength: 4 }
  let jsonType = typeof value
  if (Buffer.isBuffer(value)) jsonType = 'binary'
  else if (value instanceof Date) jsonType = 'timestamp'
  else if (Array.isArray(value)) jsonType = 'array'
  else if (typeof value === 'object') jsonType = 'object'
  let serialized
  try {
    serialized = JSON.stringify(value)
  } catch {
    serialized = JSON.stringify(String(value))
  }
  return {
    jsonType,
    isNull: false,
    serializedLength: Buffer.byteLength(serialized ?? 'null'),
  }
}

function cursorTypes(columns, cursorName, idName) {
  const cursor = columns.find((column) => column.name === cursorName)
  const id = columns.find((column) => column.name === idName)
  if (!cursor || !id) {
    throw new AppError(409, 'source_schema_mismatch', 'Configured cursor or id column is absent; inspect the source schema')
  }
  const cursorCast = CURSOR_CASTS.get(cursor.databaseType)
  const idCast = ID_CASTS.get(id.databaseType)
  if (!cursorCast || !idCast) {
    throw new AppError(409, 'unsupported_cursor_type', 'Cursor requires a date/timestamp column and a scalar integer, UUID, or text id column', {
      cursor: { name: cursorName, type: cursor.databaseType },
      id: { name: idName, type: id.databaseType },
    })
  }
  return { cursorCast, idCast }
}

function safeFailureCode(error) {
  for (const candidate of [error?.code, error?.name]) {
    if (typeof candidate === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(candidate)) return candidate
  }
  return 'source_pull_failed'
}

function pullInputName(sourceKey, position) {
  const window = createHash('sha256').update(JSON.stringify(position || {})).digest('hex').slice(0, 16)
  return `database-pull:${sourceKey}:${window}`
}

function indexStartsWith(definition, cursorColumn, idColumn) {
  if (/\bwhere\b/i.test(String(definition))) return false
  const order = '(?:\\s+(?:asc|desc))?(?:\\s+nulls\\s+(?:first|last))?'
  return new RegExp(
    `\\(\\s*${cursorColumn}\\s*${order}\\s*,\\s*${idColumn}\\s*${order}(?:\\s*,|\\s*\\))`,
    'i',
  ).test(String(definition).replace(/"/g, ''))
}

function uniqueIndexProvesOrder(definition, cursorColumn, idColumn) {
  const sql = String(definition).replace(/"/g, '')
  if (/\bwhere\b/i.test(sql)) return false
  if (!/\bcreate\s+unique\s+index\b/i.test(sql)) return false
  const order = '(?:\\s+(?:asc|desc))?(?:\\s+nulls\\s+(?:first|last))?'
  const uniqueId = new RegExp(`\\(\\s*${idColumn}\\s*${order}\\s*\\)`, 'i')
  const uniquePair = new RegExp(
    `\\(\\s*${cursorColumn}\\s*${order}\\s*,\\s*${idColumn}\\s*${order}\\s*\\)`,
    'i',
  )
  return uniqueId.test(sql) || uniquePair.test(sql)
}

export class DatabaseSourcePuller {
  constructor({ store, queue, logger = console, poolFactory = (options) => new pg.Pool(options), env = process.env }) {
    this.store = store
    this.queue = queue
    this.logger = logger
    this.poolFactory = poolFactory
    this.env = env
  }

  /**
   * Resolve the DSN from the environment.
   *
   * `catalog.external_sources.connection` stores the NAME of an environment
   * variable, never the DSN itself. A password in a database row is a password
   * in every backup, every replica and every admin API response that forgets to
   * redact it.
   */
  #dsn(connection) {
    const variable = connection.dsnEnv
    if (!variable) {
      throw new AppError(400, 'missing_dsn_env', 'connection.dsnEnv must name an environment variable')
    }
    const dsn = this.env[variable]
    if (!dsn) {
      throw new AppError(503, 'dsn_not_configured', `${variable} is not set in this deployment`)
    }
    return dsn
  }

  #pool(connection, applicationName) {
    return this.poolFactory({
      connectionString: this.#dsn(connection),
      max: 2,
      application_name: applicationName,
      statement_timeout: 60_000,
      // Read-only for the whole session. Even a bug in identifier handling
      // cannot mutate the upstream database from here.
      options: '-c default_transaction_read_only=on',
    })
  }

  async #source(sourceKey, { requireMapping = false } = {}) {
    const source = await this.store.getExternalSource(sourceKey)
    if (!source) throw new AppError(404, 'source_not_found', `Unknown external source: ${sourceKey}`)
    if (source.sourceKind !== 'database') {
      throw new AppError(400, 'wrong_source_kind', 'This source is not a database source')
    }
    validateDatabaseConnection(source.connection || {})
    const mapping = await this.store.getActiveMapping(source.id)
    if (requireMapping && !mapping) {
      throw new AppError(409, 'no_approved_mapping', 'This source has no approved field mapping')
    }
    if (mapping) validateFieldMap(mapping.fieldMap)
    return { source, mapping, connection: source.connection || {} }
  }

  async #columns(pool, connection) {
    const schema = safeIdentifier(connection.schema || 'public', 'schema')
    const table = safeIdentifier(connection.table, 'table')
    const { rows } = await pool.query(
      `SELECT column_name, data_type, udt_name, is_nullable, ordinal_position
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position`,
      [schema, table],
    )
    if (rows.length === 0) {
      throw new AppError(404, 'source_table_not_found', `Configured source table ${schema}.${table} was not found`)
    }
    return rows.map((row) => ({
      name: row.column_name,
      dataType: row.data_type,
      databaseType: row.udt_name,
      nullable: row.is_nullable === 'YES',
      ordinal: Number(row.ordinal_position),
    }))
  }

  async #metadata(pool, connection) {
    const schema = safeIdentifier(connection.schema || 'public', 'schema')
    const table = safeIdentifier(connection.table, 'table')
    const [relationResult, indexResult, constraintResult, triggerResult] = await Promise.all([
      pool.query(
        `SELECT greatest(c.reltuples, 0)::bigint AS estimated_rows,
                pg_total_relation_size(c.oid)::bigint AS total_bytes
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2`,
        [schema, table],
      ),
      pool.query(
        `SELECT indexname AS name, indexdef AS definition
           FROM pg_indexes
          WHERE schemaname = $1 AND tablename = $2
          ORDER BY indexname`,
        [schema, table],
      ),
      pool.query(
        `SELECT con.conname AS name, con.contype AS type, pg_get_constraintdef(con.oid) AS definition
           FROM pg_constraint con
           JOIN pg_class c ON c.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2
          ORDER BY con.conname`,
        [schema, table],
      ),
      pool.query(
        `SELECT trigger_name AS name, event_manipulation AS event,
                action_timing AS timing, action_statement AS statement
           FROM information_schema.triggers
          WHERE event_object_schema = $1 AND event_object_table = $2
          ORDER BY trigger_name, event_manipulation`,
        [schema, table],
      ),
    ])
    const relation = relationResult.rows[0] || {}
    return {
      estimatedRows: relation.estimated_rows == null ? null : Number(relation.estimated_rows),
      totalBytes: relation.total_bytes == null ? null : Number(relation.total_bytes),
      indexes: indexResult.rows.map((row) => ({ name: row.name, definition: row.definition })),
      constraints: constraintResult.rows.map((row) => ({ name: row.name, type: row.type, definition: row.definition })),
      triggers: triggerResult.rows.map((row) => ({
        name: row.name, event: row.event, timing: row.timing, statement: row.statement,
      })),
    }
  }

  /** Inspect a registered source without returning its DSN or any row values. */
  async describe(sourceKey) {
    const { source, mapping, connection } = await this.#source(sourceKey)
    const pool = this.#pool(connection, 'mx-insight-hub-external-describe')
    try {
      const [columns, metadata] = await Promise.all([
        this.#columns(pool, connection),
        this.#metadata(pool, connection),
      ])
      const names = new Set(columns.map((column) => column.name))
      const cursorColumn = connection.cursorColumn == null
        ? null
        : safeIdentifier(connection.cursorColumn, 'cursorColumn')
      const idColumn = connection.idColumn == null
        ? null
        : safeIdentifier(connection.idColumn, 'idColumn')
      const missingMappings = mapping
        ? Object.entries(mapping.fieldMap).flatMap(([target, rule]) => {
          const candidates = Array.isArray(rule.from) ? rule.from : [rule.from]
          const matches = rule.type === 'composite'
            ? candidates.every((column) => names.has(column))
            : candidates.some((column) => names.has(column))
          return matches
            ? []
            : [{ target, message: `mapping ${target} has no matching source column (${candidates.join(', ')})` }]
          })
        : []
      const requiredMappingTargets = new Set([
        'externalId',
        ...(source.platform === 'telegram' ? ['eventTime'] : []),
      ])
      const undefinedRequiredMappings = mapping
        ? [...requiredMappingTargets].filter((target) => mapping.fieldMap[target] == null)
          .map((target) => `mapping ${target} is required for ${source.platform} records`)
        : []
      const hasCursorIndex = cursorColumn != null && idColumn != null && metadata.indexes.some((index) =>
        indexStartsWith(index.definition, cursorColumn, idColumn),
      )
      const hasUniqueOrder = cursorColumn != null && idColumn != null && metadata.indexes.some((index) =>
        uniqueIndexProvesOrder(index.definition, cursorColumn, idColumn),
      )
      return {
        source: safeSource(source),
        columns,
        ...metadata,
        cursor: { cursorColumn, idColumn },
        mappingVersion: mapping?.version ?? null,
        issues: [
          ...(cursorColumn == null ? ['cursorColumn is not configured'] : []),
          ...(idColumn == null ? ['idColumn is not configured'] : []),
          ...(cursorColumn != null && !names.has(cursorColumn) ? [`cursor column ${cursorColumn} is missing`] : []),
          ...(idColumn != null && !names.has(idColumn) ? [`id column ${idColumn} is missing`] : []),
          ...(cursorColumn != null && columns.find((column) => column.name === cursorColumn)?.nullable
            ? [`cursor column ${cursorColumn} must be non-null`]
            : []),
          ...(idColumn != null && columns.find((column) => column.name === idColumn)?.nullable
            ? [`id column ${idColumn} must be non-null`]
            : []),
          ...(cursorColumn != null && names.has(cursorColumn) && !CURSOR_CASTS.has(columns.find((column) => column.name === cursorColumn).databaseType)
            ? [`cursor column ${cursorColumn} has unsupported type`]
            : []),
          ...(idColumn != null && names.has(idColumn) && !ID_CASTS.has(columns.find((column) => column.name === idColumn).databaseType)
            ? [`id column ${idColumn} has unsupported type`]
            : []),
          ...(cursorColumn != null && idColumn != null && !hasCursorIndex
            ? [`no index begins with (${cursorColumn}, ${idColumn})`]
            : []),
          ...(cursorColumn != null && idColumn != null && !hasUniqueOrder
            ? [`no unique index proves (${cursorColumn}, ${idColumn}) is a total order`]
            : []),
          ...undefinedRequiredMappings,
          ...missingMappings.filter((entry) => requiredMappingTargets.has(entry.target)).map((entry) => entry.message),
        ],
        warnings: missingMappings.filter((entry) => !requiredMappingTargets.has(entry.target)).map((entry) => entry.message),
      }
    } finally {
      await pool.end()
    }
  }

  /** Return at most three value-free row shapes; this is not a raw-data API. */
  async preview(sourceKey, { limit = 3 } = {}) {
    const { source, mapping, connection } = await this.#source(sourceKey)
    const previewLimit = Number(limit)
    if (!Number.isInteger(previewLimit) || previewLimit < 1 || previewLimit > MAX_PREVIEW) {
      throw new AppError(400, 'invalid_preview_limit', `preview limit must be between 1 and ${MAX_PREVIEW}`)
    }
    const table = qualifiedTable(connection)
    const pool = this.#pool(connection, 'mx-insight-hub-external-preview')
    try {
      const columns = await this.#columns(pool, connection)
      const { rows } = await pool.query(
        `SELECT * FROM ${table} LIMIT $1`,
        [previewLimit],
      )
      return {
        source: safeSource(source),
        columns,
        mappingVersion: mapping?.version ?? null,
        sampleShapes: rows.map((row) => Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key, valueShape(value)]),
        )),
      }
    } finally {
      await pool.end()
    }
  }

  /**
   * Pull one batch, resuming from the durable cursor.
   *
   * The cursor is `(cursorColumn, idColumn)` for the same reason the Night-All
   * backfill uses `(last_seen_at, id)`: a timestamp alone is not a total order,
   * and rows sharing one would be skipped or repeated forever.
   */
  async pullBatch(sourceKey, { batchSize = 1_000 } = {}) {
    const { source, mapping, connection } = await this.#source(sourceKey, { requireMapping: true })
    if (source.status !== 'active') throw new AppError(409, 'source_paused', 'This source is paused')
    if (!this.queue) throw new AppError(503, 'queue_unavailable', 'Database pull requires a durable cursor store')

    const table = qualifiedTable(connection)
    if (!connection.cursorColumn || !connection.idColumn) {
      throw new AppError(409, 'source_cursor_unconfigured', 'Configure verified cursorColumn and idColumn values before sync')
    }
    const cursorName = safeIdentifier(connection.cursorColumn, 'cursorColumn')
    const idName = safeIdentifier(connection.idColumn, 'idColumn')
    const cursorColumn = quotedIdentifier(cursorName, 'cursorColumn')
    const idColumn = quotedIdentifier(idName, 'idColumn')
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new AppError(400, 'invalid_batch_size', 'batchSize must be a positive integer')
    }
    const limit = Math.min(batchSize, MAX_BATCH)

    // Resolve the DSN before touching the cursor. Every check above is pure
    // configuration validation; doing I/O first would mean a misconfigured
    // source reports its problem only after a round trip, and reports it as
    // whatever failed second.
    this.#dsn(connection)
    const cursorId = `external:${sourceKey}`
    const saved = await this.queue.getCursor(cursorId)
    const position = saved?.position ?? {}
    const pool = this.#pool(connection, 'mx-insight-hub-external-pull')
    let run = null
    let runFinished = false
    let pulledCount = 0
    let rejectionCount = 0

    try {
      run = await this.store.startImportRun({
        sourceId: source.id,
        mappingVersion: mapping.version,
        inputSha256: null,
        inputName: pullInputName(sourceKey, position),
        inputBytes: null,
      })
      const columns = await this.#columns(pool, connection)
      const { cursorCast, idCast } = cursorTypes(columns, cursorName, idName)
      const { rows } = await pool.query(
        `SELECT * FROM ${table}
          WHERE ${cursorColumn} IS NOT NULL
            AND ($1::${cursorCast} IS NULL OR (${cursorColumn}, ${idColumn}) > ($1::${cursorCast}, $2::${idCast}))
          ORDER BY ${cursorColumn}, ${idColumn}
          LIMIT $3`,
        [position.cursor ?? null, position.lastId ?? null, limit],
      )
      pulledCount = rows.length
      if (rows.length === 0) {
        await this.store.finishImportRun(run.id, {
          status: 'succeeded', rowCount: 0, rejectedCount: 0, error: null,
        })
        runFinished = true
        await this.queue.saveCursor(cursorId, position, { status: 'idle' })
        return { pulled: 0, ingested: 0, rejected: 0, importRunId: run.id, done: true }
      }

      const rejections = []
      const mapped = []
      for (const [index, raw] of rows.entries()) {
        const { record, rejected } = applyMapping(raw, mapping.fieldMap, {
          platform: source.platform,
          objectType: source.objectType,
        })
        if (rejected) {
          rejections.push({ rowIndex: index + 1, reason: rejected, raw })
          continue
        }
        if (source.platform === 'telegram' && !record.eventTime) {
          rejections.push({ rowIndex: index + 1, reason: 'eventTime is required for Telegram serving', raw })
          continue
        }
        record.parserVersion = `${CHUNKER_VERSION}:map${mapping.version}`
        mapped.push(record)
      }

      await this.store.recordRejectedRows(run.id, rejections)
      rejectionCount = rejections.length
      const rejectionRate = rejections.length / rows.length
      if (rejections.length > 0) {
        await this.store.finishImportRun(run.id, {
          status: 'failed',
          rowCount: rows.length,
          rejectedCount: rejections.length,
          error: 'row_rejections_detected',
        })
        runFinished = true
        throw new AppError(
          409,
          'row_rejections_detected',
          `Rejected ${rejections.length} of ${rows.length} rows; correct the mapping before resuming`,
        )
      }

      const result = await this.store.ingestExternalRecords({
        datasetId: source.datasetId,
        platform: source.platform,
        connectorId: `external:${source.sourceKey}`,
        records: mapped,
        importRunId: run.id,
      })

      await this.store.finishImportRun(run.id, {
        status: 'succeeded',
        rowCount: rows.length,
        rejectedCount: rejections.length,
        error: null,
      })
      runFinished = true

      // Cursor advances only after the batch is written, so a crash replays it
      // and the uniqueness constraint absorbs the repeat.
      const last = rows[rows.length - 1]
      const done = rows.length < limit
      await this.queue.saveCursor(
        cursorId,
        { cursor: last[cursorName], lastId: String(last[idName]) },
        { status: done ? 'idle' : 'running', processedDelta: result.ingested },
      )

      if (rejections.length > 0) {
        this.logger?.warn?.(
          `[external] ${sourceKey}: ${rejections.length}/${rows.length} rows rejected in this batch`,
        )
      }
      return {
        pulled: rows.length,
        ingested: result.ingested,
        changed: result.changed,
        rejected: rejections.length,
        rejectionRate: Math.round(rejectionRate * 1_000) / 1_000,
        importRunId: run.id,
        done,
      }
    } catch (error) {
      if (run && !runFinished) {
        await this.store.finishImportRun(run.id, {
          status: 'failed', rowCount: pulledCount, rejectedCount: rejectionCount, error: safeFailureCode(error),
        }).catch(() => {})
      }
      await this.queue.saveCursor(cursorId, position, {
        status: 'failed',
        // Cursor status is returned through an admin API. Preserve a useful
        // machine code without copying a DSN/host-bearing driver message into it.
        error: safeFailureCode(error),
      }).catch(() => {})
      throw error
    } finally {
      await pool.end()
    }
  }
}
