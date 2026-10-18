import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

// Standalone ESM, including `cd /app && node --input-type=module - < file`.
// Only Hub DATABASE_URL is opened. No source connections, application imports,
// HTTP, business rows, arbitrary error text, mutations, or recovery actions.
const SOURCES = ['telegram-monitor-chats', 'telegram-monitor-messages', 'telegram-sqlite-api-chats', 'telegram-sqlite-api-messages']
const QUEUES = ['mx-insight-hub:external-pull', 'mx-insight-hub:ingest']
const CODE_FILES = ['server/ingest/telegram/monitor-pipeline.mjs', 'server/ingest/telegram/sqlite-pipeline.mjs',
  'server/ingest/telegram/source-preparer.mjs', 'server/ingest/telegram/sql/prepare-source-v1.sql',
  'server/ingest/external/database-source.mjs', 'server/ingest/external/sqlite-api-source.mjs',
  'server/ingest/external/sync-job.mjs', 'server/workers/ingest.mjs', '../mx-common/src/queue/postgres-queue.mjs']
const ERRORS = new Set(['source_contract_mismatch', 'checkpoint_contract_mismatch', 'source_busy', 'source_lock_lost',
  'source_recovery_pending', 'source_draining', 'source_pause_required', 'source_probe_failed', 'no_approved_mapping',
  'builtin_mapping_conflict', 'writer_contract_attestation_required', 'row_rejections_detected', 'import_batch_failed',
  'import_run_checkpoint_invalid', 'import_run_checkpoint_mismatch', 'import_contract_mismatch', 'continuation_enqueue_failed',
  'external_commit_outcome_unknown', 'external_finalize_outcome_unknown', 'external_reset_outcome_unknown',
  'sqlite_api_unavailable', 'sqlite_api_response_read_failed', 'sqlite_api_invalid_json', 'sqlite_api_request_failed',
  'sqlite_api_unauthorized', 'sqlite_api_contract_rejected', 'sqlite_api_unhealthy', 'sqlite_api_contract_mismatch',
  'sqlite_api_page_mismatch', 'sqlite_api_lossless_json_unsupported', 'sqlite_api_numeric_token_too_large',
  'sqlite_api_unsupported_numeric_token', 'sqlite_api_pull_failed', 'source_pull_failed', 'checkpoint_reset',
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'AbortError', 'TimeoutError'])
const choice = (value, allowed) => value == null ? null : allowed.includes(value) ? value : 'other'
const number = value => value != null && /^-?\d{1,20}$/u.test(String(value)) ? String(value) : null
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value) ? value : null
const sourceContractId = value => typeof value === 'string' && /^[a-f0-9]{32}$/u.test(value) ? value : null
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value) ? value : null
const time = value => value instanceof Date ? (Number.isFinite(value.getTime()) ? value.toISOString() : null)
  : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/u.test(value) ? value : null
const sourceKey = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,119}$/u.test(value) ? value : null
const sqlCode = error => typeof error?.code === 'string' && /^[0-9A-Z]{5}$/u.test(error.code) ? error.code : 'diagnostic_read_failed'
const errorSummary = value => ({ present: value != null, code: ERRORS.has(value) ? value : value == null ? null : 'withheld_unrecognized_error' })
const position = value => !value || typeof value !== 'object' ? null : {
  cursor: time(value.cursor), lastId: number(value.lastId), contractHash: hash(value.contractHash),
  mappingVersion: number(value.mappingVersion), importRunId: uuid(value.importRunId),
  resetAt: time(value.resetAt), lastCompletedAt: time(value.lastCompletedAt), lastMessageAt: time(value.lastMessageAt),
  lastReconciledAt: time(value.lastReconciledAt), lastSweepRows: number(value.lastSweepRows), lastSweepTotal: number(value.lastSweepTotal),
  cycle: !value.cycle || typeof value.cycle !== 'object' ? null : {
    mode: choice(value.cycle.mode, ['incremental', 'reconciliation', 'daily_window']),
    page: number(value.cycle.page), pageSize: number(value.cycle.pageSize), processedRows: number(value.cycle.processedRows),
    totalRows: number(value.cycle.totalRows), startedAt: time(value.cycle.startedAt), startAt: time(value.cycle.startAt), endAt: time(value.cycle.endAt),
  },
}
const job = row => ({
  id: number(row.id), queue: choice(row.queue, QUEUES), sourceKey: sourceKey(row.source_key), relevantTelegram: SOURCES.includes(row.source_key),
  status: choice(row.status, ['pending', 'running', 'dead']), attempts: number(row.attempts), maxAttempts: number(row.max_attempts),
  runAt: time(row.run_at), leaseExpiresAt: time(row.lease_expires_at), createdAt: time(row.created_at), updatedAt: time(row.updated_at),
  delayed: row.delayed === true, leaseExpired: row.lease_expired === true, ownerPresent: row.owner_present === true,
  importRunId: uuid(row.import_run_id), chunk: number(row.chunk), error: errorSummary(row.last_error),
})
const JOB_COLUMNS = `j.id, j.queue, j.payload->>'sourceKey' AS source_key, j.status, j.attempts, j.max_attempts,
  j.run_at, j.lease_expires_at, j.created_at, j.updated_at, j.last_error,
  j.status = 'pending' AND j.run_at > transaction_timestamp() AS delayed,
  j.status = 'running' AND j.lease_expires_at < transaction_timestamp() AS lease_expired,
  j.locked_by IS NOT NULL AS owner_present, j.payload->>'importRunId' AS import_run_id, j.payload->>'chunk' AS chunk`

export async function telegramRuntimeEvidence(root = process.cwd()) {
  const files = await Promise.all(CODE_FILES.map(async file => {
    try { return { file, sha256: createHash('sha256').update(await readFile(new URL(file, pathToFileURL(`${root}/`)))).digest('hex') } }
    catch { return { file, sha256: null, state: 'unavailable' } }
  }))
  return { node: process.version, files, scope: 'This process filesystem only; Admin hashes do not establish the running ingest worker version.' }
}

export async function diagnoseTelegramIngestion(pool) {
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '10s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'")
    await client.query('SET LOCAL search_path = pg_catalog, pg_temp')
    const section = async (sql, values, project, limit) => {
      await client.query('SAVEPOINT diagnostic_section')
      try {
        const { rows } = await client.query(sql, values)
        await client.query('RELEASE SAVEPOINT diagnostic_section')
        return { state: 'read', rows: rows.slice(0, limit).map(project), truncated: rows.length > limit }
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT diagnostic_section')
        await client.query('RELEASE SAVEPOINT diagnostic_section')
        return { state: 'unavailable', code: sqlCode(error), rows: null }
      }
    }
    const database = await section(`SELECT /* telegram-audit:database */
      current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation,
      current_setting('server_version_num') AS server_version, transaction_timestamp() AS snapshot_at`, [], row => ({
      readOnly: row.read_only === 'on', isolation: choice(row.isolation, ['repeatable read']),
      serverVersion: number(row.server_version), snapshotAt: time(row.snapshot_at),
    }), 1)
    const tasks = await section(`SELECT /* telegram-audit:tasks */ s.id, s.source_key, s.source_kind, s.status,
      s.sync_interval_seconds, s.updated_at, s.database_connection_id,
      s.connection->>'sourceContractId' AS source_contract_id,
      s.connection->>'table' AS table_name, s.connection->>'resource' AS resource,
      c.id IS NOT NULL AS cursor_present, c.position, c.status AS cursor_status, c.processed_count,
      c.updated_at AS cursor_updated_at, c.last_error,
      EXTRACT(EPOCH FROM transaction_timestamp() - c.updated_at)::bigint AS silence_seconds,
      m.version AS mapping_version, m.approved_at AS mapping_approved_at
      FROM catalog.external_sources s LEFT JOIN mxq.cursors c ON c.id = 'external:' || s.source_key
      LEFT JOIN LATERAL (SELECT version, approved_at FROM catalog.source_mappings
        WHERE source_id = s.id AND approved_at IS NOT NULL ORDER BY version DESC LIMIT 1) m ON true
      WHERE s.source_key = ANY($1::text[]) ORDER BY s.source_key LIMIT 5`, [SOURCES], row => ({
      sourceId: uuid(row.id), sourceKey: choice(row.source_key, SOURCES),
      sourceKind: choice(row.source_kind, ['database', 'sqlite_api']), status: choice(row.status, ['active', 'paused']),
      syncIntervalSeconds: number(row.sync_interval_seconds), updatedAt: time(row.updated_at),
      databaseConnectionId: uuid(row.database_connection_id), sourceContractId: sourceContractId(row.source_contract_id),
      table: choice(row.table_name, ['tg_monitor_chats', 'tg_monitor_messages']), resource: choice(row.resource, ['chats', 'messages']),
      approvedMappingVersion: number(row.mapping_version), mappingApprovedAt: time(row.mapping_approved_at),
      cursor: row.cursor_present ? { status: choice(row.cursor_status, ['idle', 'running', 'paused', 'failed']),
        processedCount: number(row.processed_count), updatedAt: time(row.cursor_updated_at), silenceSeconds: number(row.silence_seconds),
        error: errorSummary(row.last_error), position: position(row.position) } : null,
    }), 4)
    const writerAttestation = await section(`SELECT /* telegram-audit:writer */ contract_version, contract_digest, attested_at
      FROM catalog.pipeline_writer_contract_attestations WHERE pipeline_key = 'telegram-monitor'
      ORDER BY attested_at DESC LIMIT 1`, [], row => ({
      contractVersion: choice(row.contract_version, ['telegram-monitor.writer.v1']), contractDigest: hash(row.contract_digest), attestedAt: time(row.attested_at),
    }), 1)
    const imports = await section(`SELECT /* telegram-audit:imports */ s.source_key, r.* FROM catalog.external_sources s
      CROSS JOIN LATERAL (SELECT id, status, trigger, mapping_version, row_count, ingested_count, rejected_count,
        changed_count, deleted_count, started_at, finished_at, last_error FROM ingest.import_runs
        WHERE source_id = s.id ORDER BY started_at DESC, id DESC LIMIT 3) r
      WHERE s.source_key = ANY($1::text[]) ORDER BY s.source_key, r.started_at DESC LIMIT 13`, [SOURCES], row => ({
      sourceKey: choice(row.source_key, SOURCES), importRunId: uuid(row.id), status: choice(row.status, ['running', 'succeeded', 'failed', 'skipped']),
      trigger: choice(row.trigger, ['manual', 'schedule', 'file', 'daily_window']), mappingVersion: number(row.mapping_version),
      rowCount: number(row.row_count), ingestedCount: number(row.ingested_count), changedCount: number(row.changed_count),
      deletedCount: number(row.deleted_count), rejectedCount: number(row.rejected_count), startedAt: time(row.started_at),
      finishedAt: time(row.finished_at), error: errorSummary(row.last_error),
    }), 12)
    const telegramJobs = await section(`SELECT /* telegram-audit:telegram-jobs */ ${JOB_COLUMNS} FROM mxq.jobs j
      WHERE j.queue = $1 AND j.payload->>'sourceKey' = ANY($2::text[]) AND j.status IN ('pending','running','dead')
      ORDER BY CASE j.status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, j.updated_at DESC, j.id DESC LIMIT 41`,
    [QUEUES[0], SOURCES], job, 40)
    const runningExternalJobs = await section(`SELECT /* telegram-audit:running-external */ ${JOB_COLUMNS} FROM mxq.jobs j
      WHERE j.queue = $1 AND j.status = 'running' ORDER BY j.updated_at, j.id LIMIT 21`, [QUEUES[0]], job, 20)
    const queues = await section(`SELECT /* telegram-audit:queues */ queue, status, count(*)::text AS count,
      min(created_at) AS oldest_created_at, min(run_at) AS earliest_run_at, max(updated_at) AS latest_updated_at,
      count(*) FILTER (WHERE status = 'pending' AND run_at > transaction_timestamp())::text AS delayed_count,
      count(*) FILTER (WHERE status = 'running' AND lease_expires_at < transaction_timestamp())::text AS expired_lease_count
      FROM mxq.jobs WHERE queue = ANY($1::text[]) AND status IN ('pending','running','dead')
      GROUP BY queue, status ORDER BY queue, status LIMIT 7`, [QUEUES], row => ({
      queue: choice(row.queue, QUEUES), status: choice(row.status, ['pending', 'running', 'dead']), count: number(row.count),
      oldestCreatedAt: time(row.oldest_created_at), earliestRunAt: time(row.earliest_run_at), latestUpdatedAt: time(row.latest_updated_at),
      delayedCount: number(row.delayed_count), expiredLeaseCount: number(row.expired_lease_count),
    }), 6)
    const sections = { database, tasks, writerAttestation, imports, telegramJobs, runningExternalJobs, queues }
    return { diagnosticRevision: 'telegram-ingestion.v1', checkedAt: new Date().toISOString(),
      status: Object.values(sections).every(value => value.state === 'read' && !value.truncated) && tasks.rows.length === 4 ? 'observed' : 'incomplete',
      ...sections,
      evidenceBoundary: {
        hubDatabaseOnly: true, sourceDatabaseContacted: false, externalHttp: false, mutations: false,
        expectedSources: SOURCES, errors: 'Only exact allowlisted error codes; all other text is withheld, not absent.',
        status: 'Observed means metadata was read, not that cleaning is healthy. Missing/failed/truncated sections are incomplete evidence.',
        jobs: 'Latest 40 Telegram pending/running/dead jobs; oldest 20 running external-pull jobs from all sources to inspect worker starvation. Queue counts cover all sources. No job payloads or worker-owner identifiers.',
        sourceContract: 'Saved generation, approval and checkpoint metadata only; no source trigger/index/schema or writer-order verification.',
        recovery: 'Silence, a failed cursor or an expired lease alone does not authorize recovery or establish that work has stopped.',
      },
    }
  } catch (error) {
    const failure = new Error('diagnostic_read_failed'); failure.code = sqlCode(error); throw failure
  } finally {
    if (client) {
      let failure
      try { await client.query('ROLLBACK') } catch (error) { failure = error }
      client.release(failure)
      if (failure) throw new Error('diagnostic_read_failed')
    }
  }
}

if (!process.argv[1] || process.argv[1] === '-' || import.meta.url === pathToFileURL(process.argv[1]).href) {
  let pool
  try {
    if (process.argv.slice(2).length) throw new Error('invalid_arguments')
    if (!process.env.DATABASE_URL) throw new Error('database_url_required')
    const { default: pg } = await import('pg')
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000,
      query_timeout: 11000, options: '-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=1000' })
    const report = await diagnoseTelegramIngestion(pool)
    report.runtime = await telegramRuntimeEvidence()
    console.log(JSON.stringify(report, null, 2))
    if (report.status === 'incomplete') process.exitCode = 1
  } catch (error) {
    console.error(JSON.stringify({ error: ['invalid_arguments', 'database_url_required'].includes(error.message) ? error.message : sqlCode(error) }))
    process.exitCode = 1
  } finally {
    await pool?.end().catch(() => { console.error('{"error":"diagnostic_read_failed"}'); process.exitCode = 1 })
  }
}
