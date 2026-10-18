import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { diagnoseTelegramIngestion, telegramRuntimeEvidence } from '../../server/ops/diagnose-telegram-ingestion.mjs'

const scriptUrl = new URL('../../server/ops/diagnose-telegram-ingestion.mjs', import.meta.url)
const script = readFileSync(scriptUrl, 'utf8')
const pgliteModule = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const postgres = { skip: pgliteModule ? false : 'Set MX_INSIGHT_TEST_PGLITE_MODULE to a local PGlite module' }
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const sources = ['telegram-monitor-chats', 'telegram-monitor-messages', 'telegram-sqlite-api-chats', 'telegram-sqlite-api-messages']
const secret = 'NEVER_PRINT_PASSWORD_TOKEN_BODY_OR_SQL'

async function fixture(t) {
  const { PGlite } = await import(pathToFileURL(pgliteModule).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`CREATE SCHEMA catalog; CREATE SCHEMA ingest; CREATE SCHEMA mxq;
    CREATE TABLE catalog.external_sources(id uuid PRIMARY KEY, source_key text UNIQUE, source_kind text,
      status text, sync_interval_seconds int, updated_at timestamptz, database_connection_id uuid, connection jsonb);
    CREATE TABLE catalog.source_mappings(source_id uuid, version int, approved_at timestamptz);
    CREATE TABLE catalog.pipeline_writer_contract_attestations(pipeline_key text, contract_version text, contract_digest text,
      attested_at timestamptz, attested_by text, contract_summary jsonb);
    CREATE TABLE mxq.cursors(id text PRIMARY KEY, position jsonb, status text, processed_count bigint, updated_at timestamptz, last_error text);
    CREATE TABLE ingest.import_runs(id uuid PRIMARY KEY, source_id uuid, status text, trigger text, mapping_version int,
      row_count int, ingested_count int, changed_count int, deleted_count int, rejected_count int,
      started_at timestamptz, finished_at timestamptz, last_error text, input_name text);
    CREATE TABLE mxq.jobs(id bigint PRIMARY KEY, queue text, payload jsonb, status text, attempts int, max_attempts int,
      run_at timestamptz, lease_expires_at timestamptz, created_at timestamptz, updated_at timestamptz, last_error text, locked_by text);`)
  for (const [n, key] of sources.entries()) {
    await db.query('INSERT INTO catalog.external_sources VALUES($1,$2,$3,$4,300,now(),NULL,$5)', [
      id(n + 1), key, n < 2 ? 'database' : 'sqlite_api', 'active', {
        sourceContractId: '0123456789abcdef0123456789abcdef', table: n === 0 ? 'tg_monitor_chats' : n === 1 ? 'tg_monitor_messages' : undefined,
        resource: n === 2 ? 'chats' : n === 3 ? 'messages' : undefined,
        host: secret, username: secret, password: secret, token: secret, baseUrl: `https://${secret}.invalid/`,
      },
    ])
    await db.query('INSERT INTO catalog.source_mappings VALUES($1,2,now())', [id(n + 1)])
    await db.query("INSERT INTO mxq.cursors VALUES($1,$2,'failed',123,now() - interval '4 days',$3)", [
      `external:${key}`, { cursor: '2026-10-13T01:38:00.123456Z', lastId: '-100123', importRunId: id(20 + n),
        contractHash: 'a'.repeat(64), mappingVersion: 2, secret,
        cycle: { mode: 'incremental', page: 7, pageSize: 500, processedRows: 3000, totalRows: 4000, secret },
      }, n < 2 ? 'source_contract_mismatch' : 'sqlite_api_request_failed',
    ])
    for (let r = 0; r < 5; r++) await db.query(`INSERT INTO ingest.import_runs VALUES($1,$2,'failed','schedule',2,500,499,499,0,1,
      now() - make_interval(secs => $3), now(),$4,$4)`, [id(100 + n * 10 + r), id(n + 1), r, secret])
  }
  await db.query('INSERT INTO catalog.pipeline_writer_contract_attestations VALUES($1,$2,$3,now(),$4,$5)', [
    'telegram-monitor', 'telegram-monitor.writer.v1', 'b'.repeat(64), secret, { secret },
  ])
  const statements = []
  let released = false
  const pool = { connect: async () => ({ query: async (sql, values) => {
    statements.push(sql)
    if (sql.includes('telegram-audit:')) {
      assert.equal((await db.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on')
      assert.equal((await db.query('SHOW transaction_isolation')).rows[0].transaction_isolation, 'repeatable read')
      assert.equal((await db.query('SHOW statement_timeout')).rows[0].statement_timeout, '10s')
      assert.equal((await db.query('SHOW lock_timeout')).rows[0].lock_timeout, '1s')
    }
    return db.query(sql, values)
  }, release: () => { released = true } }) }
  const addJob = (n, key, status, { queue = 'mx-insight-hub:external-pull', delayed = false, expired = false } = {}) => db.query(`
    INSERT INTO mxq.jobs VALUES($1,$2,$3,$4,4,5,now() + make_interval(secs => $5),
      now() + make_interval(secs => $6),now(),now(),$7,$7)`, [
    n, queue, { sourceKey: key, importRunId: id(20), chunk: 3, body: secret, token: secret }, status,
    delayed ? 300 : -300, expired ? -60 : 60, secret,
  ])
  return { db, pool, statements, addJob, wasReleased: () => released }
}

test('standalone stdin/file entrypoints reject missing connection without application imports or credentials', () => {
  assert.doesNotMatch(script, /(?:from|import\()\s*['"]\.\.?\//u)
  assert.doesNotMatch(script, /\bfetch\s*\(/u)
  const env = { ...process.env }; delete env.DATABASE_URL
  for (const args of [['--input-type=module', '-'], [scriptUrl.pathname]]) {
    const result = spawnSync(process.execPath, args, { input: script, env, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.deepEqual(JSON.parse(result.stderr), { error: 'database_url_required' })
  }
})

test('section failures remain incomplete and do not expose error messages; transaction always rolls back', async () => {
  const commands = []; let released = false
  const report = await diagnoseTelegramIngestion({ connect: async () => ({
    query: async sql => {
      commands.push(sql)
      if (sql.includes('telegram-audit:')) throw Object.assign(new Error(secret), { code: '57014', detail: secret })
      return { rows: [] }
    }, release: () => { released = true },
  }) })
  for (const name of ['database', 'tasks', 'writerAttestation', 'imports', 'telegramJobs', 'runningExternalJobs', 'queues']) {
    assert.deepEqual(report[name], { state: 'unavailable', code: '57014', rows: null })
  }
  assert.equal(report.status, 'incomplete')
  assert.equal(commands[0], 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(commands.at(-1), 'ROLLBACK'); assert.equal(released, true)
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret, 'u'))
  await assert.rejects(diagnoseTelegramIngestion({ connect: async () => { throw Object.assign(new Error(secret), { code: '28P01' }) } }),
    error => error.message === 'diagnostic_read_failed' && error.code === '28P01')
})

test('actual read-only SQL captures TG failure and starvation metadata without raw rows, credentials or unbounded errors', postgres, async t => {
  const { db, pool, statements, addJob, wasReleased } = await fixture(t)
  await addJob(1, sources[0], 'dead')
  await addJob(2, sources[3], 'pending', { delayed: true })
  await addJob(3, 'night-all-saved-records-news', 'running', { expired: true })
  await addJob(4, 'other-source', 'pending', { queue: 'mx-insight-hub:ingest' })
  const before = await db.query('SELECT * FROM mxq.cursors ORDER BY id')
  const report = await diagnoseTelegramIngestion(pool)
  assert.equal(report.status, 'observed')
  assert.equal(report.database.rows[0].readOnly, true)
  assert.equal(report.tasks.rows.length, 4)
  const task = report.tasks.rows.find(row => row.sourceKey === sources[0])
  assert.equal(task.cursor.error.code, 'source_contract_mismatch')
  assert.equal(task.cursor.position.cursor, '2026-10-13T01:38:00.123456Z')
  assert.equal(task.cursor.position.lastId, '-100123')
  assert.equal(task.approvedMappingVersion, '2')
  assert.equal(task.sourceContractId, '0123456789abcdef0123456789abcdef')
  assert.equal(report.writerAttestation.rows[0].contractDigest, 'b'.repeat(64))
  assert.equal(report.imports.rows.length, 12)
  assert.equal(report.imports.rows[0].error.code, 'withheld_unrecognized_error')
  assert.equal(report.telegramJobs.rows.length, 2)
  assert.equal(report.telegramJobs.rows.find(row => row.id === '2').delayed, true)
  assert.equal(report.runningExternalJobs.rows[0].sourceKey, 'night-all-saved-records-news')
  assert.equal(report.runningExternalJobs.rows[0].relevantTelegram, false)
  assert.equal(report.runningExternalJobs.rows[0].leaseExpired, true)
  assert.equal(report.queues.rows.find(row => row.queue.endsWith(':ingest')).count, '1')
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret, 'u'))
  assert.deepEqual(await db.query('SELECT * FROM mxq.cursors ORDER BY id'), before)
  assert.equal(wasReleased(), true)
  assert.ok(statements.every(sql => /^(?:BEGIN|SET LOCAL|SAVEPOINT|SELECT|RELEASE SAVEPOINT|ROLLBACK)/u.test(sql)))
})

test('missing schema and bounded queue output do not masquerade as zero jobs or complete evidence', postgres, async t => {
  const { db, pool, addJob } = await fixture(t)
  for (let n = 1; n <= 42; n++) await addJob(n, sources[0], 'running')
  await db.exec('DROP TABLE catalog.pipeline_writer_contract_attestations')
  const report = await diagnoseTelegramIngestion(pool)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.writerAttestation.state, 'unavailable')
  assert.equal(report.writerAttestation.code, '42P01')
  assert.equal(report.writerAttestation.rows, null)
  assert.equal(report.telegramJobs.rows.length, 40); assert.equal(report.telegramJobs.truncated, true)
  assert.equal(report.runningExternalJobs.rows.length, 20); assert.equal(report.runningExternalJobs.truncated, true)
  assert.equal(report.queues.rows[0].count, '42')
})

test('runtime evidence hashes fixed source files only and marks missing files explicitly', async () => {
  const report = await telegramRuntimeEvidence(new URL('../../', import.meta.url).pathname.replace(/\/$/u, ''))
  assert.equal(report.node, process.version)
  assert.equal(report.files.length, 9)
  assert.ok(report.files.every(file => /^[a-f0-9]{64}$/u.test(file.sha256)))
  const missing = await telegramRuntimeEvidence('/path-that-does-not-exist-telegram-diagnostic')
  assert.ok(missing.files.every(file => file.sha256 === null && file.state === 'unavailable'))
})
