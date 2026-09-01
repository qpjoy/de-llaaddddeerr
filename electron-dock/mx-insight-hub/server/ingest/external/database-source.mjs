import { createHash } from 'node:crypto'
import pg from 'pg'
import { AppError } from '../../core/errors.mjs'
import {
  applyMapping,
  validateFieldMap,
  CHUNKER_VERSION,
  refreshMappedPayloadSha256,
} from './mapping.mjs'
import { isTelegramSourceFunctionDefinition } from '../telegram/source-preparer.mjs'
import {
  PROVINCE_OPINION_SOURCE_KEY,
  provinceOpinionColumnIssues,
  provinceOpinionCursorIsFinite,
  provinceOpinionSourceContractIssues,
} from '../province/source-contract.mjs'
import {
  createMobileMarketplaceClassifier,
  enrichMobileCommerceRecord,
} from '../mobile-commerce/record.mjs'
import {
  MOBILE_COMMERCE_SOURCE_KEY,
  MOBILE_COMMERCE_SOURCE_LOCATOR,
  mobileCommerceColumnIssues,
  mobileCommerceCursorIsFinite,
  mobileCommerceSourceContractIssues,
} from '../mobile-commerce/source-contract.mjs'

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
const SOURCE_CONNECTION_TIMEOUT_MS = 10_000
const DATABASE_TRANSPORT_FIELDS = new Set([
  'dsnEnv',
  'host',
  'port',
  'database',
  'username',
  'password',
  'sslMode',
])
const DATABASE_LOCATOR_FIELDS = new Set([
  'schema',
  'table',
  'cursorColumn',
  'idColumn',
  'sourceContractId',
])
const CONNECTION_FIELDS = new Set([...DATABASE_TRANSPORT_FIELDS, ...DATABASE_LOCATOR_FIELDS])
const REQUIRED_DIRECT_CONNECTION_FIELDS = ['host', 'database', 'username', 'password']
const DIRECT_CONNECTION_FIELDS = [...REQUIRED_DIRECT_CONNECTION_FIELDS, 'port', 'sslMode']
const SSL_MODES = new Set(['disable', 'require', 'verify-ca', 'verify-full'])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
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

function validateConnectionObject(connection) {
  if (!connection || typeof connection !== 'object' || Array.isArray(connection)) {
    throw new AppError(400, 'invalid_connection', 'connection must be an object')
  }
}

function pickConnectionFields(connection, allowed) {
  return Object.fromEntries(Object.entries(connection).filter(([key]) => allowed.has(key)))
}

/** Validate a shared profile's PostgreSQL transport without requiring a table. */
export function validateDatabaseTransport(connection) {
  validateConnectionObject(connection)
  const unsupported = Object.keys(connection).filter((key) => !DATABASE_TRANSPORT_FIELDS.has(key))
  if (unsupported.length > 0) {
    throw new AppError(400, 'unsupported_database_transport_fields', `Unsupported database transport fields: ${unsupported.join(', ')}`)
  }
  const usesDsnEnv = connection.dsnEnv != null
  const directFields = DIRECT_CONNECTION_FIELDS.filter((field) => connection[field] != null)
  if (usesDsnEnv && directFields.length > 0) {
    throw new AppError(400, 'ambiguous_database_connection', 'Use either connection.dsnEnv or direct PostgreSQL credentials, not both')
  }
  if (usesDsnEnv) {
    if (typeof connection.dsnEnv !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(connection.dsnEnv)) {
      throw new AppError(400, 'invalid_dsn_env', 'connection.dsnEnv must name an uppercase environment variable')
    }
  } else {
    const missing = REQUIRED_DIRECT_CONNECTION_FIELDS.filter((field) => (
      typeof connection[field] !== 'string' || connection[field].trim().length === 0
    ))
    if (missing.length > 0) {
      throw new AppError(400, 'missing_database_credentials', `Direct PostgreSQL connection requires: ${missing.join(', ')}`)
    }
    if (
      connection.host !== connection.host.trim()
      || connection.database !== connection.database.trim()
      || connection.username !== connection.username.trim()
      || connection.host.length > 253
      || connection.database.length > 128
      || connection.username.length > 128
      || /[\u0000-\u001f\u007f]/.test(`${connection.host}${connection.database}${connection.username}`)
    ) {
      throw new AppError(400, 'invalid_database_credentials', 'PostgreSQL host, database, and username must be trimmed strings within their allowed lengths')
    }
    if (/\s|\/|@|:\/\//.test(connection.host)) {
      throw new AppError(400, 'invalid_database_host', 'connection.host must not contain a URL scheme, path, credentials, or whitespace')
    }
    if (Buffer.byteLength(connection.password, 'utf8') > 4_096) {
      throw new AppError(400, 'invalid_database_password', 'connection.password must be at most 4096 bytes')
    }
    const port = connection.port ?? 5432
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new AppError(400, 'invalid_database_port', 'connection.port must be an integer between 1 and 65535')
    }
    const sslMode = connection.sslMode ?? 'require'
    if (!SSL_MODES.has(sslMode)) {
      throw new AppError(400, 'invalid_database_ssl_mode', 'connection.sslMode must be disable, require, verify-ca, or verify-full')
    }
  }
  return true
}

/** Validate the per-source physical table and checkpoint locator. */
export function validateDatabaseLocator(connection) {
  validateConnectionObject(connection)
  const unsupported = Object.keys(connection).filter((key) => !DATABASE_LOCATOR_FIELDS.has(key))
  if (unsupported.length > 0) {
    throw new AppError(400, 'unsupported_database_locator_fields', `Unsupported database source locator fields: ${unsupported.join(', ')}`)
  }
  safeIdentifier(connection.schema || 'public', 'schema')
  safeIdentifier(connection.table, 'table')
  if (connection.cursorColumn != null) safeIdentifier(connection.cursorColumn, 'cursorColumn')
  if (connection.idColumn != null) safeIdentifier(connection.idColumn, 'idColumn')
  if (
    connection.sourceContractId != null
    && (typeof connection.sourceContractId !== 'string' || !/^[a-f0-9]{32}$/.test(connection.sourceContractId))
  ) {
    throw new AppError(400, 'invalid_source_contract_id', 'sourceContractId must be a 32-character lowercase hex identifier')
  }
  return true
}

export function validateDatabaseConnection(connection) {
  validateConnectionObject(connection)
  const unsupported = Object.keys(connection).filter((key) => !CONNECTION_FIELDS.has(key))
  if (unsupported.length > 0) {
    throw new AppError(400, 'unsupported_connection_fields', `Unsupported database connection fields: ${unsupported.join(', ')}`)
  }
  validateDatabaseTransport(pickConnectionFields(connection, DATABASE_TRANSPORT_FIELDS))
  validateDatabaseLocator(pickConnectionFields(connection, DATABASE_LOCATOR_FIELDS))
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

function safePullError(error) {
  // AppError instances originate at explicit Hub trust boundaries and already
  // carry operator-safe messages. Driver/store errors do not: PostgreSQL often
  // embeds connection coordinates (and sometimes a full DSN) in Error.message.
  // The queue worker logs that message and persists it as jobs.last_error, so
  // discard the raw object here while retaining the stable code used for
  // retry/operator-action/unknown-commit classification.
  if (error instanceof AppError) return error
  const wrapped = new AppError(
    503,
    safeFailureCode(error),
    'External source pull failed; retry from the last durable checkpoint',
  )
  if (error?.externalFinalizationAttempted === true) {
    wrapped.externalFinalizationAttempted = true
  }
  return wrapped
}

function safeSourceOperationError(error, code, message) {
  if (error instanceof AppError) return error
  return new AppError(503, code, message)
}

function pullInputName(sourceKey, position) {
  const window = createHash('sha256').update(JSON.stringify(position || {})).digest('hex').slice(0, 16)
  return `database-pull:${sourceKey}:${window}`
}

function sourceContractHash(source, mapping) {
  const connection = source.connection || {}
  const contract = {
    connection: connection.dsnEnv
      ? { dsnEnv: connection.dsnEnv }
      : {
          host: connection.host,
          port: connection.port ?? 5432,
          database: connection.database,
          username: connection.username,
          sslMode: connection.sslMode ?? 'require',
        },
    schema: connection.schema || 'public',
    table: connection.table,
    cursorColumn: connection.cursorColumn || null,
    idColumn: connection.idColumn || null,
    datasetId: source.datasetId,
    platform: source.platform,
    objectType: source.objectType,
    mappingVersion: mapping.version,
    ...(connection.sourceContractId ? { sourceContractId: connection.sourceContractId } : {}),
  }
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex')
}

function importBatchKey({ contractHash, position, limit }) {
  return createHash('sha256').update(JSON.stringify({
    contractHash,
    cursor: position.cursor ?? null,
    lastId: position.lastId ?? null,
    limit,
  })).digest('hex')
}

function sourcePageFingerprint(rows, exactCursors, idColumn) {
  const orderKeys = rows.map((row, index) => [exactCursors[index], String(row[idColumn])])
  return createHash('sha256').update(JSON.stringify(orderKeys)).digest('hex')
}

function internalCursorAlias(columns) {
  const names = new Set(columns.map((column) => column.name))
  for (let index = 0; ; index += 1) {
    const candidate = `__mx_insight_cursor_${index}`
    if (!names.has(candidate)) return candidate
  }
}

function takeExactCursors(rows, alias, cursorColumn, { replaceCursorValue = false } = {}) {
  return rows.map((row) => {
    // PostgreSQL guarantees this alias for a real pull. The fallback keeps
    // injected pool test doubles and non-pg adapters source-compatible.
    const hasExactCursor = Object.prototype.hasOwnProperty.call(row, alias)
    const cursor = hasExactCursor ? row[alias] : row[cursorColumn]
    if (hasExactCursor) delete row[alias]
    if (hasExactCursor && replaceCursorValue) row[cursorColumn] = cursor
    return cursor
  })
}

function importRunKey({ sourceId, contractHash, mappingVersion, position }) {
  return createHash('sha256').update(JSON.stringify({
    sourceId,
    contractHash,
    mappingVersion,
    cursor: position.cursor ?? null,
    lastId: position.lastId ?? null,
    // A deliberate checkpoint reset starts a new logical import even when it
    // returns to the same source boundary.
    resetAt: position.resetAt ?? null,
  })).digest('hex')
}

function withoutImportRun(position) {
  const { importRunId: _importRunId, ...rest } = position || {}
  return rest
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

function uniqueIndexProvesIdentity(definition, idColumn) {
  const sql = String(definition).replace(/"/g, '')
  if (/\bwhere\b/i.test(sql) || !/\bcreate\s+unique\s+index\b/i.test(sql)) return false
  const order = '(?:\\s+(?:asc|desc))?(?:\\s+nulls\\s+(?:first|last))?'
  return new RegExp(`\\(\\s*${idColumn}\\s*${order}\\s*\\)`, 'i').test(sql)
}

export class DatabaseSourcePuller {
  constructor({
    store,
    queue,
    logger = console,
    poolFactory = (options) => new pg.Pool(options),
    env = process.env,
  }) {
    this.store = store
    this.queue = queue
    this.logger = logger
    this.poolFactory = poolFactory
    this.env = env
    this.sourceLocks = new Set()
  }

  async #databaseConnectionProfile(id) {
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
      throw new AppError(400, 'invalid_database_connection_id', 'databaseConnectionId must be a UUID')
    }
    if (typeof this.store?.getDatabaseConnection !== 'function') {
      throw new AppError(503, 'database_connection_store_unavailable', 'Shared database connections require a compatible store')
    }
    const profile = await this.store.getDatabaseConnection(id)
    if (!profile) {
      throw new AppError(404, 'database_connection_not_found', `Unknown database connection: ${id}`)
    }
    if (profile.engine !== 'postgresql') {
      throw new AppError(400, 'unsupported_database_engine', 'Only PostgreSQL database connections are supported')
    }
    validateDatabaseTransport(profile.connection || {})
    return profile
  }

  /**
   * Resolve an inline or shared-profile source candidate into one complete
   * connection. Callers must never persist the returned merged credentials
   * back into the source locator.
   */
  async resolveConnectionCandidate({ databaseConnectionId = null, connection = {} } = {}) {
    if (databaseConnectionId == null) {
      validateDatabaseConnection(connection)
      return {
        databaseConnectionId: null,
        databaseConnectionKey: null,
        databaseConnectionRevision: null,
        connection: { ...connection },
      }
    }

    // A profile is authoritative for transport. Reject even an identical
    // inline transport instead of silently choosing one copy over the other.
    validateDatabaseLocator(connection)
    const profile = await this.#databaseConnectionProfile(databaseConnectionId)
    const resolved = { ...profile.connection, ...connection }
    validateDatabaseConnection(resolved)
    return {
      databaseConnectionId: profile.id,
      databaseConnectionKey: profile.key,
      databaseConnectionRevision: profile.revision,
      connection: resolved,
    }
  }

  /**
   * Resolve a legacy DSN reference from the environment.
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

  #directConnectionOptions(connection) {
    const sslMode = connection.sslMode ?? 'require'
    let ssl = false
    if (sslMode === 'require') ssl = { rejectUnauthorized: false }
    if (sslMode === 'verify-ca') {
      // Verify the certificate chain while deliberately skipping hostname
      // matching, which is PostgreSQL's verify-ca (not verify-full) contract.
      ssl = { rejectUnauthorized: true, checkServerIdentity: () => undefined }
    }
    if (sslMode === 'verify-full') ssl = { rejectUnauthorized: true }
    return {
      host: connection.host,
      port: connection.port ?? 5432,
      database: connection.database,
      user: connection.username,
      password: connection.password,
      ssl,
    }
  }

  async #poolOptions(connection, applicationName, { requireLocator = true } = {}) {
    if (requireLocator) validateDatabaseConnection(connection)
    else validateDatabaseTransport(connection)
    const connectionOptions = connection.dsnEnv
      ? { connectionString: this.#dsn(connection) }
      : this.#directConnectionOptions(connection)
    return {
      ...connectionOptions,
      max: 2,
      application_name: applicationName,
      // statement_timeout starts only after PostgreSQL accepts the session.
      // Bound DNS/TCP/TLS startup separately so an unreachable source cannot
      // hold an admin request or source advisory lock until the kernel gives up.
      connectionTimeoutMillis: SOURCE_CONNECTION_TIMEOUT_MS,
      statement_timeout: 60_000,
      // Read-only for the whole session. Even a bug in identifier handling
      // cannot mutate the upstream database from here.
      options: '-c default_transaction_read_only=on',
    }
  }

  async #pool(connection, applicationName) {
    return this.poolFactory(await this.#poolOptions(connection, applicationName))
  }

  async #source(sourceKey, { requireMapping = false, mappingOverride = undefined } = {}) {
    const persistedSource = await this.store.getExternalSource(sourceKey)
    if (!persistedSource) throw new AppError(404, 'source_not_found', `Unknown external source: ${sourceKey}`)
    if (persistedSource.sourceKind !== 'database') {
      throw new AppError(400, 'wrong_source_kind', 'This source is not a database source')
    }
    const resolved = await this.resolveConnectionCandidate(persistedSource)
    const source = { ...persistedSource, connection: resolved.connection }
    const mapping = mappingOverride === undefined
      ? await this.store.getActiveMapping(source.id)
      : mappingOverride
    if (mapping && mapping.sourceId && mapping.sourceId !== source.id) {
      throw new AppError(409, 'mapping_source_mismatch', 'The field mapping belongs to another source')
    }
    if (requireMapping && !mapping) {
      throw new AppError(409, 'no_approved_mapping', 'This source has no approved field mapping')
    }
    if (mapping) validateFieldMap(mapping.fieldMap)
    return {
      source,
      mapping,
      connection: resolved.connection,
      databaseConnection: resolved.databaseConnectionId == null ? null : {
        id: resolved.databaseConnectionId,
        key: resolved.databaseConnectionKey,
        revision: resolved.databaseConnectionRevision,
      },
    }
  }

  async #assertManagedSourceContract(pool, connection) {
    if (!connection.sourceContractId) return
    let marker
    let triggers
    let indexes
    let infrastructure
    let constraints
    try {
      ;[marker, triggers, indexes, infrastructure, constraints] = await Promise.all([
        pool.query(
          `SELECT version, generation,
                  chats_table_oid = to_regclass('public.tg_monitor_chats')::oid AS chats_match,
                  messages_table_oid = to_regclass('public.tg_monitor_messages')::oid AS messages_match,
                  EXISTS (
                    SELECT 1 FROM pg_class c
                    WHERE c.oid = to_regclass('public.tg_monitor_chats')
                      AND c.relkind = 'r' AND NOT c.relispartition
                      AND NOT EXISTS (
                        SELECT 1 FROM pg_inherits i
                         WHERE i.inhrelid = c.oid OR i.inhparent = c.oid
                      )
                  ) AS chats_ordinary,
                  EXISTS (
                    SELECT 1 FROM pg_class c
                    WHERE c.oid = to_regclass('public.tg_monitor_messages')
                      AND c.relkind = 'r' AND NOT c.relispartition
                      AND NOT EXISTS (
                        SELECT 1 FROM pg_inherits i
                         WHERE i.inhrelid = c.oid OR i.inhparent = c.oid
                      )
                  ) AS messages_ordinary
             FROM mx_insight_hub_source.telegram_monitor_contract
            WHERE contract_key = 'telegram-monitor'`,
        ),
        pool.query(
          `SELECT c.relname AS table_name, t.tgname AS name, t.tgenabled AS enabled,
                  t.tgtype AS trigger_type, pn.nspname AS function_schema,
                  p.proname AS function_name, p.prosecdef AS security_definer,
                  p.prosrc AS function_source, p.proconfig AS function_config,
                  l.lanname AS function_language,
                  p.proowner = wm.relowner AS owner_matches_watermark,
                  t.tgqual IS NULL AS no_when_clause,
                  t.tgattr = ''::int2vector AS no_column_filter,
                  t.tgnargs = 0 AS no_arguments
             FROM pg_trigger t
             JOIN pg_class c ON c.oid = t.tgrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_proc p ON p.oid = t.tgfoid
             JOIN pg_namespace pn ON pn.oid = p.pronamespace
             JOIN pg_language l ON l.oid = p.prolang
             LEFT JOIN pg_class wm
               ON wm.oid = to_regclass('mx_insight_hub_source.telegram_monitor_watermark')
            WHERE n.nspname = 'public'
              AND c.relname IN ('tg_monitor_chats', 'tg_monitor_messages')
              AND NOT t.tgisinternal`,
        ),
        pool.query(
          `SELECT c.relname AS table_name, i.indisvalid AS valid, i.indisready AS ready,
                  am.amname AS access_method,
                  i.indexprs IS NULL AS no_expressions,
                  i.indpred IS NULL AS no_predicate,
                  pg_get_indexdef(i.indexrelid, 1, true) AS first_key,
                  pg_get_indexdef(i.indexrelid, 2, true) AS second_key
             FROM pg_index i
             JOIN pg_class c ON c.oid = i.indrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_class ci ON ci.oid = i.indexrelid
             JOIN pg_am am ON am.oid = ci.relam
            WHERE n.nspname = 'public'
              AND c.relname IN ('tg_monitor_chats', 'tg_monitor_messages')`,
        ),
        pool.query(
          `SELECT
             EXISTS (
               SELECT 1
                 FROM pg_class c
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'mx_insight_hub_source'
                  AND c.relname = 'telegram_monitor_watermark'
                  AND c.relkind = 'r'
                  AND NOT c.relrowsecurity
                  AND NOT c.relforcerowsecurity
                  AND (SELECT count(*) FROM pg_attribute a
                        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) = 2
                  AND EXISTS (
                    SELECT 1 FROM pg_attribute a
                     WHERE a.attrelid = c.oid AND a.attname = 'singleton'
                       AND a.atttypid = 'boolean'::regtype AND a.attnotnull
                  )
                  AND EXISTS (
                    SELECT 1 FROM pg_attribute a
                     WHERE a.attrelid = c.oid AND a.attname = 'last_updated_at'
                       AND a.atttypid = 'timestamp with time zone'::regtype AND a.attnotnull
                  )
                  AND EXISTS (
                    SELECT 1 FROM pg_constraint con
                     WHERE con.conrelid = c.oid AND con.contype = 'p'
                       AND pg_get_constraintdef(con.oid) = 'PRIMARY KEY (singleton)'
                  )
                  AND EXISTS (
                    SELECT 1 FROM pg_constraint con
                     WHERE con.conrelid = c.oid AND con.contype = 'c' AND con.convalidated
                       AND pg_get_expr(con.conbin, con.conrelid) = 'singleton'
                  )
                  AND EXISTS (
                    SELECT 1 FROM pg_constraint con
                     WHERE con.conrelid = c.oid AND con.contype = 'c' AND con.convalidated
                       AND pg_get_expr(con.conbin, con.conrelid) = 'isfinite(last_updated_at)'
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal
                  )
             ) AS structure_ready,
             (SELECT count(*) FROM mx_insight_hub_source.telegram_monitor_watermark) = 1
               AS one_row,
             (SELECT count(*) FROM mx_insight_hub_source.telegram_monitor_watermark
               WHERE singleton IS TRUE AND isfinite(last_updated_at)) = 1
               AS finite_singleton`,
        ),
        pool.query(
          `SELECT c.relname AS table_name, con.convalidated AS validated,
                  pg_get_expr(con.conbin, con.conrelid) AS expression
             FROM pg_constraint con
             JOIN pg_class c ON c.oid = con.conrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relname IN ('tg_monitor_chats', 'tg_monitor_messages')
              AND con.contype = 'c'`,
        ),
      ])
    } catch {
      throw new AppError(409, 'source_contract_mismatch', 'Telegram source contract evidence is missing or unreadable')
    }
    const contract = marker.rows[0]
    const markerReady = Number(contract?.version) === 1
      && contract?.generation === connection.sourceContractId
      && contract?.chats_match === true
      && contract?.messages_match === true
      && contract?.chats_ordinary === true
      && contract?.messages_ordinary === true
    const infrastructureReady = infrastructure.rows[0]?.structure_ready === true
      && infrastructure.rows[0]?.one_row === true
      && infrastructure.rows[0]?.finite_singleton === true
    const triggerReady = (tableName) => {
      const rows = triggers.rows.filter((row) => row.table_name === tableName)
      const expected = [
        ['mx_insight_hub_advance_watermark', 22, 'telegram_monitor_advance_watermark', 'pg_catalog,mx_insight_hub_source'],
        ['zzzzzzzz_mx_insight_hub_touch_updated_at', 23, 'telegram_monitor_touch_updated_at', 'pg_catalog,mx_insight_hub_source'],
        ['mx_insight_hub_deny_hard_delete', 42, 'telegram_monitor_deny_hard_delete', 'pg_catalog'],
      ]
      const exact = expected.every(([name, type, functionName, searchPath]) => rows.some((row) => {
        const config = Array.isArray(row.function_config)
          ? row.function_config.join(',').replace(/\s+/g, '')
          : ''
        return row.name === name
          && row.enabled === 'A'
          && Number(row.trigger_type) === type
          && row.function_schema === 'mx_insight_hub_source'
          && row.function_name === functionName
          && row.security_definer === true
          && row.function_language === 'plpgsql'
          && row.owner_matches_watermark === true
          && row.no_when_clause === true
          && row.no_column_filter === true
          && row.no_arguments === true
          && config.includes(`search_path=${searchPath}`.replace(/\s+/g, ''))
          && isTelegramSourceFunctionDefinition(functionName, row.function_source)
      }))
      const laterCompeting = rows.some((row) => (
        row.name > 'zzzzzzzz_mx_insight_hub_touch_updated_at'
        && (Number(row.trigger_type) & 1) === 1
        && (Number(row.trigger_type) & 2) === 2
        && ((Number(row.trigger_type) & 4) === 4 || (Number(row.trigger_type) & 16) === 16)
      ))
      return exact && !laterCompeting
    }
    const indexReady = (tableName, idColumn) => indexes.rows.some((row) => (
      row.table_name === tableName
      && row.valid === true
      && row.ready === true
      && row.access_method === 'btree'
      && row.no_expressions === true
      && row.no_predicate === true
      && String(row.first_key).replace(/"/g, '').trim() === 'updated_at'
      && String(row.second_key).replace(/"/g, '').trim() === idColumn
    ))
    const finiteUpdatedAt = (tableName) => constraints.rows.some((row) => (
      row.table_name === tableName
      && row.validated === true
      && row.expression === 'isfinite(updated_at)'
    ))
    if (
      !markerReady
      || !infrastructureReady
      || !triggerReady('tg_monitor_chats')
      || !triggerReady('tg_monitor_messages')
      || !finiteUpdatedAt('tg_monitor_chats')
      || !finiteUpdatedAt('tg_monitor_messages')
      || !indexReady('tg_monitor_chats', 'chat_id')
      || !indexReady('tg_monitor_messages', 'id')
    ) {
      throw new AppError(
        409,
        'source_contract_mismatch',
        'Telegram source contract changed; pause, prepare, and reset checkpoints when instructed',
      )
    }
  }

  async withSourceLock(sourceKey, operation) {
    if (typeof this.store.withExternalSourceLock === 'function') {
      return this.store.withExternalSourceLock(
        sourceKey,
        (assertOwned = async () => {}, sessionClient = null) => operation(assertOwned, sessionClient),
      )
    }
    // MemoryStore and focused unit-test doubles do not own a PostgreSQL
    // session. Keep the same non-overlap contract within this process.
    if (this.sourceLocks.has(sourceKey)) {
      throw new AppError(409, 'source_busy', `External source is currently being synchronized: ${sourceKey}`)
    }
    this.sourceLocks.add(sourceKey)
    try {
      return await operation(async () => {}, null)
    } finally {
      this.sourceLocks.delete(sourceKey)
    }
  }

  async withSourceLocks(sourceKeys, operation) {
    const keys = [...new Set(sourceKeys)].sort()
    const acquire = (index, guards, sessionClients) => index >= keys.length
      ? operation(async () => {
          for (const assertOwned of guards) await assertOwned()
        }, sessionClients)
      : this.withSourceLock(
          keys[index],
          (assertOwned, sessionClient) => acquire(
            index + 1,
            [...guards, assertOwned],
            [...sessionClients, sessionClient],
          ),
        )
    return acquire(0, [], [])
  }

  #assertCheckpoint(position, { contractHash, mappingVersion, sourceContractId = null }) {
    if (!position?.contractHash) {
      const meaningfulLegacyCheckpoint = position?.cursor != null
        || position?.lastId != null
        || position?.importRunId != null
      if (sourceContractId && meaningfulLegacyCheckpoint) {
        throw new AppError(
          409,
          'checkpoint_contract_mismatch',
          'The saved checkpoint predates the managed source contract; pause and reset it explicitly',
        )
      }
      return
    }
    if (position.contractHash !== contractHash || Number(position.mappingVersion) !== Number(mappingVersion)) {
      throw new AppError(
        409,
        'checkpoint_contract_mismatch',
        'The saved checkpoint belongs to a different connection, table, cursor, dataset, or mapping; pause and reset it explicitly',
      )
    }
  }

  async assertCheckpointCompatible(sourceKey, { mappingOverride = undefined } = {}) {
    if (!this.queue) throw new AppError(503, 'queue_unavailable', 'Database pull requires a durable cursor store')
    const { source, mapping } = await this.#source(sourceKey, { requireMapping: true, mappingOverride })
    const contractHash = sourceContractHash(source, mapping)
    const cursor = await this.queue.getCursor(`external:${sourceKey}`)
    this.#assertCheckpoint(cursor?.position ?? {}, {
      contractHash,
      mappingVersion: mapping.version,
      sourceContractId: source.connection?.sourceContractId ?? null,
    })
    return { compatible: true, contractHash, mappingVersion: mapping.version, cursor: cursor ?? null }
  }

  async resetCheckpoint(sourceKey) {
    return this.withSourceLock(sourceKey, async (assertOwned) => {
      if (!this.queue) throw new AppError(503, 'queue_unavailable', 'Database pull requires a durable cursor store')
      const { source, mapping } = await this.#source(sourceKey, { requireMapping: true })
      if (source.status !== 'paused') {
        throw new AppError(409, 'source_pause_required', 'Pause this source before resetting its checkpoint')
      }
      const cursorId = `external:${sourceKey}`
      const saved = await this.queue.getCursor(cursorId)
      const previousPosition = saved?.position ?? {}
      const contractHash = sourceContractHash(source, mapping)
      const resetPosition = {
        contractHash,
        mappingVersion: mapping.version,
        resetAt: new Date().toISOString(),
      }
      if (typeof this.store.resetExternalImportCheckpoint === 'function') {
        await assertOwned()
        const result = await this.store.resetExternalImportCheckpoint({
          sourceId: source.id,
          cursorId,
          position: resetPosition,
        })
        return result.cursor
      }
      if (previousPosition.importRunId) {
        await assertOwned()
        await this.store.finishImportRun(previousPosition.importRunId, {
          status: 'failed', rowCount: null, rejectedCount: null,
          cursorEnd: resetPosition, error: 'checkpoint_reset',
        })
      }
      await assertOwned()
      return this.queue.saveCursor(
        cursorId,
        resetPosition,
        { status: 'idle', error: null },
      )
    })
  }

  async resetCheckpoints(sourceKeys, { mappingOverrides = {} } = {}) {
    return this.withSourceLocks(sourceKeys, async (assertOwned) => {
      if (!this.queue) throw new AppError(503, 'queue_unavailable', 'Database pull requires a durable cursor store')
      if (typeof this.store.resetExternalImportCheckpointsBatch !== 'function') {
        throw new AppError(503, 'atomic_checkpoint_reset_unavailable', 'Pipeline checkpoint reset requires the PostgreSQL store')
      }
      const resetAt = new Date().toISOString()
      const resets = []
      for (const sourceKey of sourceKeys) {
        const mappingOverride = mappingOverrides instanceof Map
          ? mappingOverrides.get(sourceKey)
          : mappingOverrides[sourceKey]
        const { source, mapping } = await this.#source(sourceKey, {
          requireMapping: true,
          mappingOverride,
        })
        if (source.status !== 'paused') {
          throw new AppError(409, 'source_pause_required', 'Pause every pipeline source before resetting checkpoints')
        }
        resets.push({
          sourceKey,
          sourceId: source.id,
          cursorId: `external:${sourceKey}`,
          position: {
            contractHash: sourceContractHash(source, mapping),
            mappingVersion: mapping.version,
            resetAt,
          },
        })
      }
      await assertOwned()
      return this.store.resetExternalImportCheckpointsBatch(resets)
    })
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

  async #mobileCommerceIndexIssues(pool, connection) {
    const schema = safeIdentifier(connection.schema || 'public', 'schema')
    const table = safeIdentifier(connection.table, 'table')
    const { rows } = await pool.query(
      `SELECT p.indexdef AS definition, i.indisvalid AS valid, i.indisready AS ready
         FROM pg_indexes p
         JOIN pg_namespace n ON n.nspname = p.schemaname
         JOIN pg_class t ON t.relnamespace = n.oid AND t.relname = p.tablename
         JOIN pg_class ci ON ci.relnamespace = n.oid AND ci.relname = p.indexname
         JOIN pg_index i ON i.indrelid = t.oid AND i.indexrelid = ci.oid
        WHERE p.schemaname = $1 AND p.tablename = $2`,
      [schema, table],
    )
    const definitions = rows
      .filter((row) => row.valid !== false && row.ready !== false)
      .map((row) => row.definition)
    return [
      ...(!definitions.some((definition) => indexStartsWith(
        definition,
        MOBILE_COMMERCE_SOURCE_LOCATOR.cursorColumn,
        MOBILE_COMMERCE_SOURCE_LOCATOR.idColumn,
      )) ? ['mobile-commerce pull index is missing or invalid'] : []),
      ...(!definitions.some((definition) => uniqueIndexProvesIdentity(
        definition,
        MOBILE_COMMERCE_SOURCE_LOCATOR.idColumn,
      )) ? ['mobile-commerce unique capture-id index is missing or invalid'] : []),
    ]
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
        `SELECT p.indexname AS name, p.indexdef AS definition,
                i.indisvalid AS valid, i.indisready AS ready
           FROM pg_indexes p
           JOIN pg_namespace n ON n.nspname = p.schemaname
           JOIN pg_class t ON t.relnamespace = n.oid AND t.relname = p.tablename
           JOIN pg_class ci ON ci.relnamespace = n.oid AND ci.relname = p.indexname
           JOIN pg_index i ON i.indrelid = t.oid AND i.indexrelid = ci.oid
          WHERE p.schemaname = $1 AND p.tablename = $2
          ORDER BY p.indexname`,
        [schema, table],
      ),
      pool.query(
        `SELECT con.conname AS name, con.contype AS type, con.convalidated AS validated,
                pg_get_expr(con.conbin, con.conrelid) AS expression,
                pg_get_constraintdef(con.oid) AS definition
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
      indexes: indexResult.rows.map((row) => ({
        name: row.name,
        definition: row.definition,
        valid: row.valid !== false,
        ready: row.ready !== false,
      })),
      constraints: constraintResult.rows.map((row) => ({
        name: row.name,
        type: row.type,
        validated: row.validated !== false,
        expression: row.expression,
        definition: row.definition,
      })),
      triggers: triggerResult.rows.map((row) => ({
        name: row.name, event: row.event, timing: row.timing, statement: row.statement,
      })),
    }
  }

  /** Inspect a registered source without returning its DSN or any row values. */
  async describe(sourceKey, { mappingOverride = undefined } = {}) {
    const { source, mapping, connection } = await this.#source(sourceKey, { mappingOverride })
    let pool = null
    try {
      pool = await this.#pool(connection, 'mx-insight-hub-external-describe')
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
        index.valid && index.ready && indexStartsWith(index.definition, cursorColumn, idColumn),
      )
      const hasUniqueOrder = cursorColumn != null && idColumn != null && metadata.indexes.some((index) =>
        index.valid && index.ready && uniqueIndexProvesOrder(index.definition, cursorColumn, idColumn),
      )
      const hasUniqueIdentity = idColumn != null && metadata.indexes.some((index) =>
        index.valid && index.ready && uniqueIndexProvesIdentity(index.definition, idColumn),
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
          ...(source.sourceKey === MOBILE_COMMERCE_SOURCE_KEY && idColumn != null && !hasUniqueIdentity
            ? [`no unique index proves ${idColumn} is a stable capture identity`]
            : []),
          ...undefinedRequiredMappings,
          ...missingMappings.filter((entry) => requiredMappingTargets.has(entry.target)).map((entry) => entry.message),
        ],
        warnings: missingMappings.filter((entry) => !requiredMappingTargets.has(entry.target)).map((entry) => entry.message),
      }
    } catch (error) {
      throw safeSourceOperationError(
        error,
        'source_schema_probe_failed',
        'PostgreSQL source schema probe failed',
      )
    } finally {
      if (pool) await pool.end().catch(() => {})
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
    let pool = null
    try {
      pool = await this.#pool(connection, 'mx-insight-hub-external-preview')
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
    } catch (error) {
      throw safeSourceOperationError(
        error,
        'source_preview_failed',
        'PostgreSQL source preview failed',
      )
    } finally {
      if (pool) await pool.end().catch(() => {})
    }
  }

  async #testConnection(connection, { requireLocator, applicationName }) {
    let pool = null
    try {
      pool = this.poolFactory(await this.#poolOptions(connection, applicationName, { requireLocator }))
      const { rows } = await pool.query(
        `SELECT current_database() AS database_name,
                current_user AS database_user,
                current_setting('server_version') AS server_version,
                current_setting('transaction_read_only') AS read_only`,
      )
      const row = rows[0]
      if (row?.read_only !== 'on') {
        throw new AppError(503, 'source_not_read_only', 'Source test session is not read-only')
      }
      return {
        database: row.database_name,
        user: row.database_user,
        serverVersion: row.server_version,
        readOnly: true,
      }
    } catch (error) {
      if (error instanceof AppError && error.code === 'source_not_read_only') throw error
      if (error instanceof AppError && error.status < 500) throw error
      throw new AppError(503, 'source_connection_failed', 'PostgreSQL source connection test failed')
    } finally {
      if (pool) await pool.end().catch(() => {})
    }
  }

  /** Test a complete inline source connection before it is persisted. */
  async testConnection(connection) {
    return this.#testConnection(connection, {
      requireLocator: true,
      applicationName: 'mx-insight-hub-source-connection-test',
    })
  }

  /** Test a transport-only candidate for the shared database profile CRUD. */
  async testDatabaseConnectionTransport(connection) {
    return this.#testConnection(connection, {
      requireLocator: false,
      applicationName: 'mx-insight-hub-database-profile-test',
    })
  }

  /** Resolve and test one persisted shared database profile. */
  async testDatabaseConnectionProfile(databaseConnectionId) {
    const profile = await this.#databaseConnectionProfile(databaseConnectionId)
    return this.testDatabaseConnectionTransport(profile.connection)
  }

  /** Resolve and test a source candidate without persisting the merged secret. */
  async testSourceCandidate(candidate) {
    const { connection } = await this.resolveConnectionCandidate(candidate)
    return this.testConnection(connection)
  }

  /** Verify the currently persisted connection for one source. */
  async testSource(sourceKey) {
    const { connection } = await this.#source(sourceKey)
    return this.testConnection(connection)
  }

  /**
   * Count an upstream source only when an operator explicitly opens progress.
   *
   * This deliberately does not run in the scheduler: exact COUNT queries can
   * be expensive on a large foreign table. A saved composite checkpoint makes
   * completed/remaining exact; before the first checkpoint only the total is
   * knowable without inventing progress.
   */
  async progress(sourceKey) {
    const { connection } = await this.#source(sourceKey)
    const table = qualifiedTable(connection)
    const cursorId = `external:${sourceKey}`
    const saved = await this.queue?.getCursor?.(cursorId) ?? null
    const position = saved?.position ?? {}
    const hasConfiguredCursor = Boolean(connection.cursorColumn && connection.idColumn)
    let pool = null
    try {
      pool = await this.#pool(connection, 'mx-insight-hub-external-progress')
      const totalOnly = async (blocker, issues) => {
        const { rows } = await pool.query(`SELECT count(*)::bigint AS total_rows FROM ${table}`)
        return {
          totalRows: Number(rows[0]?.total_rows ?? 0),
          completedRows: null,
          remainingRows: null,
          percent: null,
          cursor: saved,
          blocker,
          issues,
        }
      }
      if (!hasConfiguredCursor) {
        return await totalOnly('source_cursor_unconfigured', ['cursorColumn and idColumn are not configured'])
      }

      const cursorName = safeIdentifier(connection.cursorColumn, 'cursorColumn')
      const idName = safeIdentifier(connection.idColumn, 'idColumn')
      const cursorColumn = quotedIdentifier(cursorName, 'cursorColumn')
      const idColumn = quotedIdentifier(idName, 'idColumn')
      const columns = await this.#columns(pool, connection)
      const cursorDefinition = columns.find((column) => column.name === cursorName)
      const idDefinition = columns.find((column) => column.name === idName)
      const issues = [
        ...(!cursorDefinition ? [`cursor column ${cursorName} is missing`] : []),
        ...(!idDefinition ? [`id column ${idName} is missing`] : []),
        ...(cursorDefinition?.nullable ? [`cursor column ${cursorName} must be non-null`] : []),
        ...(idDefinition?.nullable ? [`id column ${idName} must be non-null`] : []),
        ...(cursorDefinition && !CURSOR_CASTS.has(cursorDefinition.databaseType)
          ? [`cursor column ${cursorName} has unsupported type`]
          : []),
        ...(idDefinition && !ID_CASTS.has(idDefinition.databaseType)
          ? [`id column ${idName} has unsupported type`]
          : []),
      ]
      if (issues.length > 0) return await totalOnly('source_cursor_unsafe', issues)

      const schema = safeIdentifier(connection.schema || 'public', 'schema')
      const sourceTable = safeIdentifier(connection.table, 'table')
      const indexResult = await pool.query(
        `SELECT p.indexdef AS definition, i.indisvalid AS valid, i.indisready AS ready
           FROM pg_indexes p
           JOIN pg_namespace n ON n.nspname = p.schemaname
           JOIN pg_class t ON t.relnamespace = n.oid AND t.relname = p.tablename
           JOIN pg_class ci ON ci.relnamespace = n.oid AND ci.relname = p.indexname
           JOIN pg_index i ON i.indrelid = t.oid AND i.indexrelid = ci.oid
          WHERE p.schemaname = $1 AND p.tablename = $2`,
        [schema, sourceTable],
      )
      const definitions = indexResult.rows
        .filter((row) => row.valid !== false && row.ready !== false)
        .map((row) => row.definition)
      if (!definitions.some((definition) => indexStartsWith(definition, cursorName, idName))) {
        issues.push(`no index begins with (${cursorName}, ${idName})`)
      }
      if (!definitions.some((definition) => uniqueIndexProvesOrder(definition, cursorName, idName))) {
        issues.push(`no unique index proves (${cursorName}, ${idName}) is a total order`)
      }
      if (issues.length > 0) return await totalOnly('source_cursor_unsafe', issues)

      const { cursorCast, idCast } = cursorTypes(columns, cursorName, idName)
      if (position.cursor == null || position.lastId == null) {
        const { rows } = await pool.query(
          `SELECT count(*)::bigint AS total_rows
             FROM ${table}
            WHERE ${cursorColumn} IS NOT NULL`,
        )
        return {
          totalRows: Number(rows[0]?.total_rows ?? 0),
          completedRows: null,
          remainingRows: null,
          percent: null,
          cursor: saved,
          blocker: null,
          issues: [],
        }
      }

      const { rows } = await pool.query(
        `SELECT count(*) FILTER (WHERE ${cursorColumn} IS NOT NULL)::bigint AS total_rows,
                count(*) FILTER (
                  WHERE ${cursorColumn} IS NOT NULL
                    AND (${cursorColumn}, ${idColumn}) > ($1::${cursorCast}, $2::${idCast})
                )::bigint AS remaining_rows
           FROM ${table}`,
        [position.cursor, position.lastId],
      )
      const totalRows = Number(rows[0]?.total_rows ?? 0)
      const remainingRows = Number(rows[0]?.remaining_rows ?? 0)
      const completedRows = Math.max(0, totalRows - remainingRows)
      return {
        totalRows,
        completedRows,
        remainingRows,
        percent: totalRows === 0 ? 100 : Math.round((completedRows / totalRows) * 10_000) / 100,
        cursor: saved,
        blocker: null,
        issues: [],
      }
    } catch (error) {
      throw safeSourceOperationError(
        error,
        'source_progress_failed',
        'PostgreSQL source progress query failed',
      )
    } finally {
      if (pool) await pool.end().catch(() => {})
    }
  }

  /**
   * Pull one batch, resuming from the durable cursor.
   *
   * The cursor is `(cursorColumn, idColumn)` for the same reason the Night-All
   * backfill uses `(last_seen_at, id)`: a timestamp alone is not a total order,
   * and rows sharing one would be skipped or repeated forever.
   */
  async pullBatch(sourceKey, options = {}) {
    try {
      return await this.withSourceLock(
        sourceKey,
        (assertOwned) => this.#pullBatchUnlocked(sourceKey, options, assertOwned),
      )
    } catch (error) {
      throw safePullError(error)
    }
  }

  async #assertImportRun(source, importRunId) {
    if (!importRunId || typeof this.store.getImportRunState !== 'function') return
    const run = await this.store.getImportRunState(importRunId)
    if (!run || run.sourceId !== source.id || run.status !== 'running') {
      throw new AppError(
        409,
        'import_run_checkpoint_invalid',
        'The checkpoint import run is missing, terminal, or belongs to another source; reset the checkpoint',
      )
    }
  }

  async #finalizeRun({
    source,
    cursorId,
    importRunId,
    position,
    status,
    cursorStatus,
    processedDelta = 0,
    error = null,
    assertOwned = async () => {},
  }) {
    const cursorPosition = withoutImportRun(position)
    if (typeof this.store.finalizeExternalImportRun === 'function') {
      try {
        await assertOwned()
        const result = await this.store.finalizeExternalImportRun({
          importRunId,
          sourceId: source.id,
          cursorId,
          position: cursorPosition,
          status,
          cursorStatus,
          processedDelta,
          error,
        })
        return result.cursor
      } catch (finalizeError) {
        finalizeError.externalFinalizationAttempted = true
        throw finalizeError
      }
    }

    // Focused unit-test doubles and MemoryStore do not own mxq.cursors. Keep
    // their legacy ordering while PostgreSQL uses the atomic path above.
    let remainingDelta = processedDelta
    if (status === 'succeeded' && cursorStatus === 'idle' && processedDelta > 0) {
      await assertOwned()
      await this.queue.saveCursor(
        cursorId,
        { ...withoutImportRun(position), importRunId },
        { status: 'running', processedDelta, error: null },
      )
      remainingDelta = 0
    }
    await assertOwned()
    await this.store.finishImportRun(importRunId, {
      status,
      rowCount: null,
      rejectedCount: null,
      cursorEnd: withoutImportRun(position),
      error,
    })
    await assertOwned()
    return this.queue.saveCursor(cursorId, cursorPosition, {
      status: cursorStatus,
      processedDelta: remainingDelta,
      error,
    })
  }

  async #acknowledgeBatch({
    source,
    sourceKey,
    cursorId,
    importRunId,
    cursorEnd,
    rowCount,
    limit,
    ingested,
    assertOwned = async () => {},
  }) {
    if (!cursorEnd || typeof cursorEnd !== 'object') {
      throw new AppError(500, 'import_batch_cursor_missing', 'A committed import batch has no cursor end')
    }
    const latestSource = await this.store.getExternalSource(sourceKey)
    const paused = latestSource?.status === 'paused'
    const done = paused || rowCount < limit
    if (done) {
      await this.#finalizeRun({
        source,
        cursorId,
        importRunId,
        position: cursorEnd,
        status: 'succeeded',
        cursorStatus: 'idle',
        processedDelta: ingested,
        error: null,
        assertOwned,
      })
    } else {
      await assertOwned()
      await this.queue.saveCursor(
        cursorId,
        { ...withoutImportRun(cursorEnd), importRunId },
        { status: 'running', processedDelta: ingested, error: null },
      )
    }
    return { done, paused, cursorEnd: withoutImportRun(cursorEnd) }
  }

  async markContinuationFailed(sourceKey, importRunId, error = 'continuation_enqueue_failed') {
    return this.withSourceLock(sourceKey, async (assertOwned) => {
      if (!this.queue) throw new AppError(503, 'queue_unavailable', 'Database pull requires a durable cursor store')
      const source = await this.store.getExternalSource(sourceKey)
      if (!source) throw new AppError(404, 'source_not_found', `Unknown external source: ${sourceKey}`)
      const cursorId = `external:${sourceKey}`
      const saved = await this.queue.getCursor(cursorId)
      const position = saved?.position ?? {}
      const checkpointRunId = position.importRunId ?? null
      if (!checkpointRunId || (importRunId && checkpointRunId !== importRunId)) {
        throw new AppError(409, 'import_run_checkpoint_mismatch', 'The failed continuation no longer owns this checkpoint')
      }
      await this.#assertImportRun(source, checkpointRunId)
      const failedPosition = { ...withoutImportRun(position), importRunId: checkpointRunId }
      if (typeof this.store.markExternalImportCursorFailed === 'function') {
        const input = {
          importRunId: checkpointRunId,
          sourceId: source.id,
          cursorId,
          position: failedPosition,
          error,
        }
        await assertOwned()
        try {
          return (await this.store.markExternalImportCursorFailed(input)).cursor
        } catch (markError) {
          if (markError?.code !== 'external_cursor_failure_outcome_unknown') throw markError
          // The operation is idempotent and leaves the run running. Retrying
          // resolves both possibilities of an ambiguous first COMMIT.
          await assertOwned()
          return (await this.store.markExternalImportCursorFailed(input)).cursor
        }
      }
      await assertOwned()
      return this.queue.saveCursor(cursorId, failedPosition, { status: 'failed', error })
    })
  }

  async markSourceContractFailed(sourceKey, error = 'source_contract_mismatch') {
    return this.withSourceLock(sourceKey, async (assertOwned) => {
      if (!this.queue) throw new AppError(503, 'queue_unavailable', 'Database pull requires a durable cursor store')
      const source = await this.store.getExternalSource(sourceKey)
      if (!source) throw new AppError(404, 'source_not_found', `Unknown external source: ${sourceKey}`)
      const cursorId = `external:${sourceKey}`
      const saved = await this.queue.getCursor(cursorId)
      const position = saved?.position ?? {}
      const importRunId = position.importRunId ?? null
      if (importRunId && typeof this.store.markExternalImportCursorFailed === 'function') {
        await this.#assertImportRun(source, importRunId)
        const input = {
          importRunId,
          sourceId: source.id,
          cursorId,
          position: { ...withoutImportRun(position), importRunId },
          error,
        }
        await assertOwned()
        try {
          return (await this.store.markExternalImportCursorFailed(input)).cursor
        } catch (markError) {
          if (markError?.code !== 'external_cursor_failure_outcome_unknown') throw markError
          await assertOwned()
          return (await this.store.markExternalImportCursorFailed(input)).cursor
        }
      }
      await assertOwned()
      return this.queue.saveCursor(cursorId, position, { status: 'failed', error })
    })
  }

  async #pullBatchUnlocked(
    sourceKey,
    { batchSize = 1_000, importRunId = null, trigger = 'manual' } = {},
    assertOwned = async () => {},
  ) {
    const { source, mapping, connection } = await this.#source(sourceKey, { requireMapping: true })
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
    if (connection.dsnEnv) this.#dsn(connection)

    const cursorId = `external:${sourceKey}`
    const saved = await this.queue.getCursor(cursorId)
    const position = saved?.position ?? {}
    if (
      sourceKey === PROVINCE_OPINION_SOURCE_KEY
      && position.cursor != null
      && !provinceOpinionCursorIsFinite(position.cursor)
    ) {
      throw new AppError(409, 'source_contract_mismatch', 'Province opinion checkpoint contains a non-finite watermark')
    }
    if (
      sourceKey === MOBILE_COMMERCE_SOURCE_KEY
      && position.cursor != null
      && !mobileCommerceCursorIsFinite(position.cursor)
    ) {
      throw new AppError(409, 'source_contract_mismatch', 'Mobile-commerce checkpoint contains a non-finite watermark')
    }
    const contractHash = sourceContractHash(source, mapping)
    this.#assertCheckpoint(position, {
      contractHash,
      mappingVersion: mapping.version,
      sourceContractId: connection.sourceContractId ?? null,
    })
    const checkpointRunId = position.importRunId ?? null
    if (importRunId && !checkpointRunId) {
      // The predecessor was retried after its atomic finalize/reset committed.
      // It no longer owns work and must not open a fresh run.
      return {
        pulled: 0, ingested: 0, changed: 0, deleted: 0, rejected: 0,
        importRunId, done: true, stale: true,
      }
    }
    if (importRunId && importRunId !== checkpointRunId) {
      throw new AppError(
        409,
        'import_run_checkpoint_mismatch',
        'The queued import run no longer owns this source checkpoint; discard the stale continuation',
      )
    }
    await this.#assertImportRun(source, checkpointRunId)

    let run = checkpointRunId ? { id: checkpointRunId, duplicateOf: null } : null
    const completedPosition = withoutImportRun({
      ...position,
      contractHash,
      mappingVersion: mapping.version,
    })
    if (source.status !== 'active') {
      if (run) {
        await this.#finalizeRun({
          source,
          cursorId,
          importRunId: run.id,
          position: completedPosition,
          status: 'succeeded',
          cursorStatus: 'idle',
          error: null,
          assertOwned,
        })
      } else if (saved?.status === 'running' || saved?.status === 'paused') {
        await assertOwned()
        await this.queue.saveCursor(cursorId, completedPosition, { status: 'idle', error: null })
      }
      return {
        pulled: 0, ingested: 0, changed: 0, deleted: 0, rejected: 0,
        importRunId: run?.id ?? null, done: true, paused: true,
      }
    }

    const batchKey = importBatchKey({ contractHash, position, limit })
    if (run && typeof this.store.getImportBatch === 'function') {
      const committedBatch = await this.store.getImportBatch(run.id, batchKey)
      if (committedBatch) {
        if (committedBatch.status !== 'succeeded') {
          await this.#finalizeRun({
            source,
            cursorId,
            importRunId: run.id,
            position: committedBatch.cursorStart ?? completedPosition,
            status: 'failed',
            cursorStatus: 'failed',
            error: committedBatch.errorCode ?? 'import_batch_failed',
          })
          throw new AppError(409, 'import_batch_failed', 'This import batch previously failed and must be reset')
        }
        const acknowledgement = await this.#acknowledgeBatch({
          source,
          sourceKey,
          cursorId,
          importRunId: run.id,
          cursorEnd: committedBatch.cursorEnd,
          rowCount: committedBatch.rowCount,
          limit,
          ingested: committedBatch.ingested,
          assertOwned,
        })
        return {
          pulled: committedBatch.rowCount,
          ingested: committedBatch.ingested,
          changed: committedBatch.changed,
          deleted: committedBatch.deleted,
          replayed: true,
          rejected: committedBatch.rejected,
          rejectionRate: committedBatch.rowCount > 0
            ? Math.round((committedBatch.rejected / committedBatch.rowCount) * 1_000) / 1_000
            : 0,
          importRunId: run.id,
          done: acknowledgement.done,
          paused: acknowledgement.paused,
        }
      }
    }

    // Credentials and the upstream pool are deliberately opened only after a
    // committed replay has been ruled out; replay can advance from stored
    // cursor evidence even if the source page has since drifted or vanished.
    const poolOptions = await this.#poolOptions(connection, 'mx-insight-hub-external-pull')
    const pool = this.poolFactory(poolOptions)
    let runFinished = false
    let batchCommitted = false
    let checkpointWriteInFlight = false

    try {
      await this.#assertManagedSourceContract(pool, connection)
      const columns = await this.#columns(pool, connection)
      if (sourceKey === PROVINCE_OPINION_SOURCE_KEY) {
        const contractIssues = [
          ...provinceOpinionSourceContractIssues(source),
          ...provinceOpinionColumnIssues(columns),
        ]
        if (contractIssues.length > 0) {
          throw new AppError(
            409,
            'source_contract_mismatch',
            'Province opinion source contract changed; pause and re-probe before resuming',
          )
        }
      }
      if (sourceKey === MOBILE_COMMERCE_SOURCE_KEY) {
        const contractIssues = [
          ...mobileCommerceSourceContractIssues(source),
          ...mobileCommerceColumnIssues(columns),
        ]
        if (contractIssues.length > 0) {
          throw new AppError(
            409,
            'source_contract_mismatch',
            'Mobile-commerce source contract changed; pause and re-probe before resuming',
          )
        }
        const indexIssues = await this.#mobileCommerceIndexIssues(pool, connection)
        if (indexIssues.length > 0) {
          throw new AppError(
            409,
            'source_contract_mismatch',
            'Mobile-commerce source indexes changed; pause and re-probe before resuming',
            { issues: indexIssues },
          )
        }
      }
      const { cursorCast, idCast } = cursorTypes(columns, cursorName, idName)
      const cursorAliasName = internalCursorAlias(columns)
      const cursorAlias = quotedIdentifier(cursorAliasName, 'internal cursor alias')
      const { rows } = await pool.query(
        `SELECT *, ${cursorColumn}::text AS ${cursorAlias} FROM ${table}
          WHERE ${cursorColumn} IS NOT NULL
            AND ($1::${cursorCast} IS NULL OR (${cursorColumn}, ${idColumn}) > ($1::${cursorCast}, $2::${idCast}))
          ORDER BY ${cursorColumn}, ${idColumn}
          LIMIT $3`,
        [position.cursor ?? null, position.lastId ?? null, limit],
      )
      const cursorDefinition = columns.find((column) => column.name === cursorName)
      const exactCursors = takeExactCursors(rows, cursorAliasName, cursorName, {
        // node-postgres converts `timestamp without time zone` to a Date before
        // mapping. Restore PostgreSQL's exact source-local text so the fixed
        // +08:00 rule is independent of the Hub process timezone.
        replaceCursorValue: sourceKey === MOBILE_COMMERCE_SOURCE_KEY
          && cursorDefinition?.databaseType === 'timestamp',
      })
      if (
        sourceKey === PROVINCE_OPINION_SOURCE_KEY
        && exactCursors.some((cursor) => !provinceOpinionCursorIsFinite(cursor))
      ) {
        throw new AppError(
          409,
          'source_contract_mismatch',
          'Province opinion source returned a non-finite updated_at watermark',
        )
      }
      if (
        sourceKey === MOBILE_COMMERCE_SOURCE_KEY
        && exactCursors.some((cursor) => !mobileCommerceCursorIsFinite(cursor))
      ) {
        throw new AppError(
          409,
          'source_contract_mismatch',
          'Mobile-commerce source returned a non-finite collected_at watermark',
        )
      }
      await assertOwned()
      if (rows.length === 0) {
        if (run) {
          await this.#finalizeRun({
            source,
            cursorId,
            importRunId: run.id,
            position: completedPosition,
            status: 'succeeded',
            cursorStatus: 'idle',
            error: null,
            assertOwned,
          })
          runFinished = true
        } else {
          await assertOwned()
          await this.queue.saveCursor(cursorId, completedPosition, { status: 'idle', error: null })
        }
        return { pulled: 0, ingested: 0, rejected: 0, importRunId: run?.id ?? null, done: true }
      }

      let classifyMobileMarketplace = null
      if (sourceKey === MOBILE_COMMERCE_SOURCE_KEY) {
        if (typeof this.store.listSourceCatalogEntries !== 'function') {
          throw new AppError(
            503,
            'source_catalog_unavailable',
            'Mobile-commerce classification requires the governed source catalog',
          )
        }
        // One authoritative catalog snapshot per page keeps every row in the
        // batch consistent even if an administrator edits the catalog later.
        const catalogEntries = await this.store.listSourceCatalogEntries({ includeArchived: false })
        classifyMobileMarketplace = createMobileMarketplaceClassifier(catalogEntries)
      }

      if (!run) {
        const runKey = importRunKey({
          sourceId: source.id,
          contractHash,
          mappingVersion: mapping.version,
          position,
        })
        await assertOwned()
        run = await this.store.startImportRun({
          sourceId: source.id,
          mappingVersion: mapping.version,
          inputSha256: null,
          inputName: pullInputName(sourceKey, position),
          inputBytes: null,
          cursorStart: withoutImportRun({ ...position, contractHash, mappingVersion: mapping.version }),
          trigger,
          runKey,
        })
        // Persist the logical run before canonical ingest. If the worker dies
        // after COMMIT but before enqueueing a continuation, the reclaimed job
        // resumes this run and the batch key absorbs the replay.
        checkpointWriteInFlight = true
        await assertOwned()
        await this.queue.saveCursor(cursorId, {
          ...position,
          contractHash,
          mappingVersion: mapping.version,
          importRunId: run.id,
        }, { status: 'running', error: null })
        checkpointWriteInFlight = false
      }
      const pageFingerprint = sourcePageFingerprint(rows, exactCursors, idName)

      const rejections = []
      const mapped = []
      for (const [index, raw] of rows.entries()) {
        const { record, rejected } = applyMapping(raw, mapping.fieldMap, {
          platform: source.platform,
          objectType: source.objectType,
          source: { origin: 'database', sourceKey: source.sourceKey },
        })
        if (rejected) {
          rejections.push({ rowIndex: index + 1, reason: rejected, raw })
          continue
        }
        if (source.platform === 'telegram' && !record.eventTime) {
          rejections.push({ rowIndex: index + 1, reason: 'eventTime is required for Telegram serving', raw })
          continue
        }
        enrichMobileCommerceRecord(record, raw, source, { classifyMarketplace: classifyMobileMarketplace })
        refreshMappedPayloadSha256(record)
        record.parserVersion = `${CHUNKER_VERSION}:map${mapping.version}`
        mapped.push(record)
      }

      const rejectionRate = rejections.length / rows.length
      if (rejections.length > 0) {
        if (this.store.recordRejectedImportBatch) {
          await assertOwned()
          await this.store.recordRejectedImportBatch(run.id, {
            sourceId: source.id,
            batchKey,
            cursorStart: { ...position, contractHash, mappingVersion: mapping.version },
            rowCount: rows.length,
            rejections,
            pageFingerprint,
          })
        } else {
          await this.store.recordRejectedRows(run.id, rejections)
        }
        await this.#finalizeRun({
          source,
          cursorId,
          importRunId: run.id,
          position: { ...position, contractHash, mappingVersion: mapping.version },
          status: 'failed',
          cursorStatus: 'failed',
          error: 'row_rejections_detected',
          assertOwned,
        })
        runFinished = true
        throw new AppError(
          409,
          'row_rejections_detected',
          `Rejected ${rejections.length} of ${rows.length} rows; correct the mapping before resuming`,
        )
      }

      const last = rows[rows.length - 1]
      const nextPosition = {
        contractHash,
        mappingVersion: mapping.version,
        cursor: exactCursors[exactCursors.length - 1],
        lastId: String(last[idName]),
      }
      await assertOwned()
      const result = await this.store.ingestExternalRecords({
        datasetId: source.datasetId,
        platform: source.platform,
        connectorId: `external:${source.sourceKey}`,
        records: mapped,
        importRunId: run.id,
        sourceId: source.id,
        batch: {
          key: batchKey,
          cursorStart: withoutImportRun({ ...position, contractHash, mappingVersion: mapping.version }),
          cursorEnd: nextPosition,
          rowCount: rows.length,
          pageFingerprint,
        },
      })
      batchCommitted = true

      const acknowledgedPosition = result.cursorEnd ?? nextPosition
      const acknowledgedRows = result.rowCount ?? rows.length
      const acknowledgement = await this.#acknowledgeBatch({
        source,
        sourceKey,
        cursorId,
        importRunId: run.id,
        cursorEnd: acknowledgedPosition,
        rowCount: acknowledgedRows,
        limit,
        ingested: result.ingested,
        assertOwned,
      })
      runFinished = acknowledgement.done

      if (rejections.length > 0) {
        this.logger?.warn?.(
          `[external] ${sourceKey}: ${rejections.length}/${rows.length} rows rejected in this batch`,
        )
      }
      return {
        pulled: rows.length,
        ingested: result.ingested,
        changed: result.changed,
        deleted: result.deleted ?? 0,
        replayed: result.replayed === true,
        rejected: rejections.length,
        rejectionRate: Math.round(rejectionRate * 1_000) / 1_000,
        importRunId: run.id,
        done: acknowledgement.done,
        paused: acknowledgement.paused,
      }
    } catch (error) {
      const preserveForRetry = batchCommitted
        || checkpointWriteInFlight
        || error?.externalFinalizationAttempted === true
        || ['external_commit_outcome_unknown', 'external_finalize_outcome_unknown'].includes(error?.code)
      if (!preserveForRetry && run && !runFinished) {
        await this.#finalizeRun({
          source,
          cursorId,
          importRunId: run.id,
          position: { ...position, contractHash, mappingVersion: mapping.version },
          status: 'failed',
          cursorStatus: 'failed',
          error: safeFailureCode(error),
          assertOwned,
        }).catch(() => {})
      } else if (!preserveForRetry && !run) {
        await assertOwned().then(() => this.queue.saveCursor(
          cursorId,
          withoutImportRun(position),
          { status: 'failed', error: safeFailureCode(error) },
        )).catch(() => {})
      }
      throw error
    } finally {
      await pool.end().catch(() => {})
    }
  }
}
