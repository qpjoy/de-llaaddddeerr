import { pathToFileURL } from 'node:url'

// Standalone Admin-Pod/stdin diagnostic: only the Hub DATABASE_URL is used.
// Never connect to the source, resolve a DSN, print credentials/body/error text,
// or change tasks, checkpoints, mappings, approvals or data.
const PREFIX = '^night-all-saved-records-[a-z][a-z0-9-]*$'
const LIMIT = 500
const SCOPES = `scopes(source_type, dataset_id, platform, object_type) AS (VALUES
  ('news', 'data-center.saved-records.news.v1', 'data_center_saved_records_news', 'saved_record'),
  ('web', 'data-center.saved-records.web.v1', 'data_center_saved_records_web', 'saved_record')),
  batches(tag) AS (VALUES ('tasiting'), ('maidanglao'))`
const RAW_JOIN = `LEFT JOIN ingest.source_objects o
  ON o.connector_id = 'external:night-all-saved-records-' || s.source_type
 AND o.stream_id = s.platform || '.external.v1' AND o.object_type = s.object_type
 AND o.raw_payload->>'tag' = b.tag
 LEFT JOIN core.canonical_records c ON c.dataset_id = s.dataset_id
 AND c.platform = s.platform AND c.object_type = o.object_type AND c.external_id = o.source_key`
const TOKEN = /^[A-Za-z0-9_.:-]{1,180}$/u
const token = value => typeof value === 'string' && TOKEN.test(value) ? value : null
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value) ? value : null
const count = value => /^(?:0|[1-9][0-9]{0,19})$/u.test(String(value)) ? String(value) : null
const choice = (value, values) => value == null ? null : values.includes(value) ? value : 'other'
const time = value => {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null
  // Preserve microseconds in source cursor strings instead of rounding via Date.
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/u.test(value) ? value : null
}
const code = error => typeof error?.code === 'string' && /^[0-9A-Z]{5}$/u.test(error.code) ? error.code : 'diagnostic_read_failed'
const position = value => value && typeof value === 'object' ? {
  cursor: time(value.cursor), lastId: count(value.lastId),
  contractHash: typeof value.contractHash === 'string' && /^[a-f0-9]{64}$/u.test(value.contractHash) ? value.contractHash : null,
  mappingVersion: count(value.mappingVersion), importRunId: uuid(value.importRunId),
} : null

export async function diagnoseNightAllABatches(pool) {
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '15s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'")
    await client.query('SET LOCAL search_path = pg_catalog, pg_temp')
    const section = async (sql, values, project, limit = LIMIT) => {
      await client.query('SAVEPOINT diagnostic_section')
      try {
        const { rows } = await client.query(sql, values)
        await client.query('RELEASE SAVEPOINT diagnostic_section')
        return { state: 'read', rows: rows.slice(0, limit).map(project), truncated: rows.length > limit }
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT diagnostic_section')
        await client.query('RELEASE SAVEPOINT diagnostic_section')
        return { state: 'unavailable', code: code(error), rows: null }
      }
    }
    const database = await section(`SELECT /* batch-audit:database */ current_database() AS database,
      (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS database_oid,
      inet_server_addr()::text AS server_address, inet_server_port() AS server_port,
      current_setting('server_version_num') AS server_version_number,
      current_setting('transaction_read_only') AS read_only,
      current_setting('transaction_isolation') AS isolation, transaction_timestamp() AS snapshot_at`, [], row => ({
      database: token(row.database), databaseOid: count(row.database_oid),
      serverAddress: typeof row.server_address === 'string' && /^[0-9a-f.:/]+$/iu.test(row.server_address) ? row.server_address : null,
      serverPort: count(row.server_port), serverVersionNumber: count(row.server_version_number),
      readOnly: row.read_only === 'on', isolation: choice(row.isolation, ['repeatable read']), snapshotAt: time(row.snapshot_at),
    }))
    const tasks = await section(`WITH selected AS (
      SELECT s.*, p.id AS profile_id, p.engine AS profile_engine,
        CASE WHEN s.database_connection_id IS NULL THEN s.connection ELSE p.connection END AS transport,
        s.database_connection_id IS NOT NULL AND s.connection ?| ARRAY[
          'host','port','database','username','password','sslMode','dsnEnv'] AS inline_transport_conflict,
        s.database_connection_id IS NOT NULL AND p.connection ?| ARRAY[
          'schema','table','cursorColumn','idColumn','sourceContractId'] AS profile_locator_conflict
      FROM catalog.external_sources s LEFT JOIN catalog.database_connections p ON p.id = s.database_connection_id
      WHERE s.source_key ~ $1 ORDER BY s.source_key LIMIT 501)
      SELECT /* batch-audit:tasks */ s.id, s.source_key, s.source_kind, s.status,
        s.dataset_id, s.platform, s.object_type, s.database_connection_id, s.profile_id, s.profile_engine,
        s.inline_transport_conflict, s.profile_locator_conflict,
        s.transport->>'host' AS host, s.transport->>'port' AS port,
        s.transport->>'database' AS database, s.transport->>'sslMode' AS ssl_mode,
        s.transport ? 'dsnEnv' AS dsn_reference,
        s.connection->>'schema' AS schema, s.connection->>'table' AS table,
        c.id IS NOT NULL AS cursor_present, c.status AS cursor_status, c.processed_count,
        c.position, c.updated_at AS cursor_updated_at, c.last_error IS NOT NULL AS has_saved_error
      FROM selected s LEFT JOIN mxq.cursors c ON c.id = 'external:' || s.source_key
      ORDER BY s.source_key`, [PREFIX], row => ({
      sourceId: uuid(row.id), sourceKey: token(row.source_key), sourceKind: choice(row.source_kind, ['database', 'file']),
      status: choice(row.status, ['active', 'paused']), datasetId: token(row.dataset_id), platform: token(row.platform), objectType: token(row.object_type),
      connection: {
        mode: row.database_connection_id ? 'profile' : row.dsn_reference ? 'dsn_reference_not_resolved' : 'inline',
        profileId: uuid(row.database_connection_id), profileFound: row.database_connection_id ? Boolean(row.profile_id) : null,
        profileEngine: choice(row.profile_engine, ['postgresql']), inlineTransportConflict: row.inline_transport_conflict === true,
        profileLocatorConflict: row.profile_locator_conflict === true, dsnReferenceUnresolved: row.dsn_reference === true,
        host: token(row.host),
        port: row.dsn_reference || (row.database_connection_id && !row.profile_id) ? null : count(row.port ?? 5432),
        database: token(row.database),
        sslMode: row.dsn_reference || (row.database_connection_id && !row.profile_id) ? null
          : choice(row.ssl_mode ?? 'require', ['disable', 'require', 'verify-ca', 'verify-full']),
        schema: token(row.schema ?? 'public'), table: token(row.table),
      },
      cursor: row.cursor_present ? { status: choice(row.cursor_status, ['idle', 'running', 'paused', 'failed', 'completed']),
        position: position(row.position), processedCount: count(row.processed_count), updatedAt: time(row.cursor_updated_at), hasSavedError: row.has_saved_error === true } : null,
    }))
    const imports = await section(`WITH ranked AS (
      SELECT s.source_key, r.id, r.status, r.mapping_version, r.row_count, r.ingested_count,
        r.changed_count, r.deleted_count, r.rejected_count, r.started_at, r.finished_at,
        r.last_error IS NOT NULL AS has_saved_error,
        row_number() OVER (PARTITION BY r.source_id ORDER BY r.started_at DESC, r.id DESC) AS rn
      FROM ingest.import_runs r JOIN catalog.external_sources s ON s.id = r.source_id WHERE s.source_key ~ $1)
      SELECT /* batch-audit:imports */ * FROM ranked WHERE rn <= 3 ORDER BY source_key, rn LIMIT 1501`, [PREFIX], row => ({
      sourceKey: token(row.source_key), importRunId: uuid(row.id), status: choice(row.status, ['running', 'succeeded', 'failed', 'skipped']),
      mappingVersion: count(row.mapping_version), rowCount: count(row.row_count), ingestedCount: count(row.ingested_count),
      changedCount: count(row.changed_count), deletedCount: count(row.deleted_count), rejectedCount: count(row.rejected_count),
      startedAt: time(row.started_at), finishedAt: time(row.finished_at), hasSavedError: row.has_saved_error === true,
    }), 1500)
    const batches = await section(`WITH ${SCOPES}
      SELECT /* batch-audit:counts */ s.source_type, b.tag,
        o.raw_payload->>'connector_id' AS raw_connector_id, o.raw_payload->>'source_type' AS raw_source_type,
        count(o.id)::text AS raw_count, count(c.id) FILTER (WHERE c.deleted_at IS NULL)::text AS matched_live,
        count(c.id) FILTER (WHERE c.deleted_at IS NOT NULL)::text AS matched_deleted,
        count(o.id) FILTER (WHERE c.id IS NULL)::text AS missing_canonical,
        count(o.id) FILTER (WHERE o.raw_payload->>'record_key' IS DISTINCT FROM o.source_key)::text AS raw_identity_mismatch
      FROM scopes s CROSS JOIN batches b ${RAW_JOIN}
      GROUP BY s.source_type, b.tag, o.raw_payload->>'connector_id', o.raw_payload->>'source_type'
      ORDER BY s.source_type, b.tag, raw_connector_id NULLS FIRST, raw_source_type NULLS FIRST LIMIT 501`, [], row => ({
      sourceType: choice(row.source_type, ['news', 'web']), tag: choice(row.tag, ['tasiting', 'maidanglao']),
      rawConnectorId: token(row.raw_connector_id), rawSourceType: token(row.raw_source_type), rawCount: count(row.raw_count),
      matchedLiveCanonical: count(row.matched_live), matchedDeletedCanonical: count(row.matched_deleted),
      missingCanonical: count(row.missing_canonical), rawIdentityMismatch: count(row.raw_identity_mismatch),
    }))
    const samples = await section(`WITH ${SCOPES}, ranked AS (
      SELECT s.source_type, b.tag, o.source_key, o.raw_payload->>'id' AS raw_row_id,
        o.raw_payload->>'connector_id' AS raw_connector_id, o.raw_payload->>'source_type' AS raw_source_type,
        o.raw_payload#>>'{attributes,site_id}' AS site_id, o.raw_payload->>'last_seen_at' AS raw_last_seen_at,
        c.id AS canonical_id, c.deleted_at IS NOT NULL AS canonical_deleted,
        c.stable_fields#>>'{crawler,identity,rowId}' AS canonical_row_id,
        c.stable_fields#>>'{crawler,lineage,lastSeenAt}' AS canonical_last_seen_at,
        row_number() OVER (PARTITION BY s.source_type, b.tag ORDER BY o.last_seen_at DESC, o.id DESC) AS rn
      FROM scopes s CROSS JOIN batches b ${RAW_JOIN} WHERE o.id IS NOT NULL)
      SELECT /* batch-audit:samples */ * FROM ranked WHERE rn <= 5 ORDER BY source_type, tag, rn LIMIT 21`, [], row => ({
      sourceType: choice(row.source_type, ['news', 'web']), tag: choice(row.tag, ['tasiting', 'maidanglao']),
      rawConnectorId: token(row.raw_connector_id), rawSourceType: token(row.raw_source_type),
      recordKey: token(row.source_key), rawRowId: count(row.raw_row_id), siteId: token(row.site_id), rawLastSeenAt: time(row.raw_last_seen_at),
      canonicalId: uuid(row.canonical_id), canonicalDeleted: row.canonical_id ? row.canonical_deleted === true : null,
      canonicalLineageRowId: count(row.canonical_row_id), canonicalLineageLastSeenAt: time(row.canonical_last_seen_at),
    }), 20)
    const status = [database, tasks, imports, batches, samples].every(result => result.state === 'read' && !result.truncated)
      ? 'observed' : 'incomplete'
    return { diagnosticRevision: 'night-all-a-batches.v1', checkedAt: new Date().toISOString(), status,
      database, tasks, imports, batches, samples,
      evidenceBoundary: {
        hubDatabaseOnly: true, sourceDatabaseContacted: false, mutations: false,
        status: 'observed means all diagnostic sections were read without truncation; it does not mean cleaning passed. incomplete retains all available evidence.',
        batchScopes: ['news', 'web'], batchTags: ['tasiting', 'maidanglao'], samplesPerScopeAndTag: 5,
        samplesOrder: 'latest Hub raw-object observation; not a full comparison',
        counts: 'Current source_objects only; exact connector/stream/object_type scope and canonical dataset/platform/object_type/external_id identity. Counts and identity matches do not prove equal content, complete source ingestion, indexing or writer ordering.',
        tags: 'Top-level raw tag is retained evidence, not canonical tags or complete historical/cross-batch membership. Replaced raw tags and historical revisions are not counted.',
        identifiers: 'Null identifier fields may be absent or withheld by bounded output validation; null does not prove absence. Samples retain raw connector/source_type so a shared tag is not assumed to mean organization-web.',
        transport: 'Profile transport is authoritative; conflicts are reported, never silently merged. DSN references are not resolved. Configured source host/database is not proof of the physical source database identity.',
        imports: 'Latest three runs per source; category totals are not per-tag totals. Read failures and truncation are incomplete evidence, not zero records.',
      } }
  } catch (error) {
    const failure = new Error('diagnostic_read_failed')
    failure.code = code(error)
    throw failure
  } finally {
    if (client) {
      let failure
      try { await client.query('ROLLBACK') } catch (error) { failure = error }
      client.release(failure)
      if (failure) throw new Error('diagnostic_read_failed')
    }
  }
}

// Both `node --input-type=module - < file` and stdin without '-' are supported.
if (!process.argv[1] || process.argv[1] === '-' || import.meta.url === pathToFileURL(process.argv[1]).href) {
  let pool
  try {
    if (process.argv.slice(2).length) throw new Error('invalid_arguments')
    if (!process.env.DATABASE_URL) throw new Error('database_url_required')
    const { default: pg } = await import('pg')
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000,
      query_timeout: 16000, options: '-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=1000' })
    const report = await diagnoseNightAllABatches(pool)
    console.log(JSON.stringify(report, null, 2))
    if (report.status === 'incomplete') process.exitCode = 1
  } catch (error) {
    console.error(JSON.stringify({ error: ['invalid_arguments', 'database_url_required'].includes(error.message) ? error.message : code(error) }))
    process.exitCode = 1
  } finally {
    await pool?.end().catch(() => { console.error('{"error":"diagnostic_read_failed"}'); process.exitCode = 1 })
  }
}
