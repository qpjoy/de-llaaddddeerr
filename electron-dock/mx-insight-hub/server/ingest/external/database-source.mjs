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

export class DatabaseSourcePuller {
  constructor({ store, queue, logger = console }) {
    this.store = store
    this.queue = queue
    this.logger = logger
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
    const dsn = process.env[variable]
    if (!dsn) {
      throw new AppError(503, 'dsn_not_configured', `${variable} is not set in this deployment`)
    }
    return dsn
  }

  /**
   * Pull one batch, resuming from the durable cursor.
   *
   * The cursor is `(cursorColumn, idColumn)` for the same reason the Night-All
   * backfill uses `(last_seen_at, id)`: a timestamp alone is not a total order,
   * and rows sharing one would be skipped or repeated forever.
   */
  async pullBatch(sourceKey, { batchSize = 1_000 } = {}) {
    const source = await this.store.getExternalSource(sourceKey)
    if (!source) throw new AppError(404, 'source_not_found', `Unknown external source: ${sourceKey}`)
    if (source.sourceKind !== 'database') {
      throw new AppError(400, 'wrong_source_kind', 'This source is not a database source')
    }

    const mapping = await this.store.getActiveMapping(source.id)
    if (!mapping) {
      throw new AppError(409, 'no_approved_mapping', 'This source has no approved field mapping')
    }
    validateFieldMap(mapping.fieldMap)

    const connection = source.connection || {}
    const table = qualifiedTable(connection)
    const cursorColumn = safeIdentifier(connection.cursorColumn || 'updated_at', 'cursorColumn')
    const idColumn = safeIdentifier(connection.idColumn || 'id', 'idColumn')
    const limit = Math.min(batchSize, MAX_BATCH)

    // Resolve the DSN before touching the cursor. Every check above is pure
    // configuration validation; doing I/O first would mean a misconfigured
    // source reports its problem only after a round trip, and reports it as
    // whatever failed second.
    const dsn = this.#dsn(connection)

    const cursorId = `external:${sourceKey}`
    const saved = await this.queue.getCursor(cursorId)
    const position = saved?.position ?? {}

    const pool = new pg.Pool({
      connectionString: dsn,
      max: 2,
      application_name: 'mx-insight-hub-external-pull',
      statement_timeout: 60_000,
      // Read-only for the whole session. Even a bug in identifier handling
      // cannot mutate the upstream database from here.
      options: '-c default_transaction_read_only=on',
    })

    try {
      const { rows } = await pool.query(
        `SELECT * FROM ${table}
          WHERE ($1::text IS NULL OR (${cursorColumn}, ${idColumn}::text) > ($1::timestamptz, $2::text))
          ORDER BY ${cursorColumn}, ${idColumn}
          LIMIT $3`,
        [position.cursor ?? null, position.lastId ?? null, limit],
      )
      if (rows.length === 0) {
        await this.queue.saveCursor(cursorId, position, { status: 'idle' })
        return { pulled: 0, ingested: 0, done: true }
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
        record.parserVersion = `${CHUNKER_VERSION}:map${mapping.version}`
        mapped.push(record)
      }

      const result = await this.store.ingestExternalRecords({
        datasetId: source.datasetId,
        platform: source.platform,
        connectorId: `external:${source.sourceKey}`,
        records: mapped,
        importRunId: null,
      })

      // Cursor advances only after the batch is written, so a crash replays it
      // and the uniqueness constraint absorbs the repeat.
      const last = rows[rows.length - 1]
      await this.queue.saveCursor(
        cursorId,
        { cursor: last[cursorColumn], lastId: String(last[idColumn]) },
        { status: 'running', processedDelta: result.ingested },
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
        done: rows.length < limit,
      }
    } finally {
      await pool.end()
    }
  }
}
