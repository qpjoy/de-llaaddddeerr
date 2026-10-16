import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { diagnoseNightAllABatches } from '../../server/ops/diagnose-night-all-a-batches.mjs'

const scriptUrl = new URL('../../server/ops/diagnose-night-all-a-batches.mjs', import.meta.url)
const script = readFileSync(scriptUrl, 'utf8')
const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const postgres = { skip: modulePath ? false : 'Set MX_INSIGHT_TEST_PGLITE_MODULE to a local PGlite module' }
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const secret = 'NEVER_PRINT_BODY_PASSWORD_OR_DSN'

async function fixture(t) {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`CREATE SCHEMA catalog; CREATE SCHEMA ingest; CREATE SCHEMA core; CREATE SCHEMA mxq;
    CREATE TABLE catalog.database_connections(id uuid PRIMARY KEY, engine text, connection jsonb);
    CREATE TABLE catalog.external_sources(id uuid PRIMARY KEY, source_key text UNIQUE, source_kind text,
      status text, dataset_id text, platform text, object_type text, database_connection_id uuid, connection jsonb);
    CREATE TABLE mxq.cursors(id text PRIMARY KEY, position jsonb, status text, processed_count bigint, updated_at timestamptz, last_error text);
    CREATE TABLE ingest.import_runs(id uuid PRIMARY KEY, source_id uuid, status text, mapping_version int,
      row_count int, ingested_count int, changed_count int, deleted_count int, rejected_count int,
      started_at timestamptz, finished_at timestamptz, last_error text);
    CREATE TABLE ingest.source_objects(id uuid PRIMARY KEY, connector_id text, stream_id text, object_type text,
      source_key text, raw_payload jsonb, last_seen_at timestamptz,
      UNIQUE(connector_id,stream_id,object_type,source_key));
    CREATE TABLE core.canonical_records(id uuid PRIMARY KEY, dataset_id text, platform text, object_type text,
      external_id text, stable_fields jsonb, deleted_at timestamptz,
      UNIQUE(dataset_id,platform,object_type,external_id));`)
  const statements = []
  const pool = { connect: async () => ({
    query: async (sql, values) => {
      statements.push(sql)
      if (sql.includes('batch-audit:')) {
        assert.equal((await db.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on')
        assert.equal((await db.query('SHOW statement_timeout')).rows[0].statement_timeout, '15s')
        assert.equal((await db.query('SHOW lock_timeout')).rows[0].lock_timeout, '1s')
      }
      return db.query(sql, values)
    }, release: () => {},
  }) }
  return { db, pool, statements }
}

async function source(db, type, { sourceId = 1, profileId = null, connection = {}, status = 'active' } = {}) {
  await db.query(`INSERT INTO catalog.external_sources VALUES($1,$2,'database',$3,$4,$5,'saved_record',$6,$7)`, [
    id(sourceId), `night-all-saved-records-${type}`, status, `data-center.saved-records.${type}.v1`,
    `data_center_saved_records_${type}`, profileId, { schema: 'public', table: `saved_records_${type}`, ...connection },
  ])
}

async function raw(db, n, type, tag, { recordKey = `record-${n}`, connectorId, stream, objectType = 'saved_record', rawType = type } = {}) {
  const payload = { id: n, record_key: recordKey, tag, connector_id: 'organization-web', source_type: rawType,
    attributes: { site_id: 'example.org', body: secret }, last_seen_at: '2026-10-17T01:02:03.123456Z', body: secret, password: secret }
  await db.query('INSERT INTO ingest.source_objects VALUES($1,$2,$3,$4,$5,$6,$7)', [id(100 + n),
    connectorId ?? `external:night-all-saved-records-${type}`, stream ?? `data_center_saved_records_${type}.external.v1`,
    objectType, recordKey, payload, `2026-10-17T01:02:${String(n).padStart(2, '0')}Z`])
}

async function canonical(db, n, type, { dataset = `data-center.saved-records.${type}.v1`, deleted = false, recordKey = `record-${n}` } = {}) {
  await db.query('INSERT INTO core.canonical_records VALUES($1,$2,$3,$4,$5,$6,$7)', [id(200 + n), dataset,
    `data_center_saved_records_${type}`, 'saved_record', recordKey,
    { crawler: { identity: { rowId: n }, lineage: { lastSeenAt: '2026-10-17T01:02:03.123456Z' } }, secret },
    deleted ? '2026-10-17T03:00:00Z' : null])
}

test('standalone stdin and file entrypoints fail safely without DATABASE_URL, with no local application imports', () => {
  assert.doesNotMatch(script, /(?:from|import\()\s*['"]\.\.?\//u)
  assert.match(script, /await import\('pg'\)/u)
  const env = { ...process.env }
  delete env.DATABASE_URL
  for (const args of [['--input-type=module'], ['--input-type=module', '-'], [scriptUrl.pathname]]) {
    const result = spawnSync(process.execPath, args, { input: script, env, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.deepEqual(JSON.parse(result.stderr), { error: 'database_url_required' })
  }
})

test('connection and section failures expose codes only and always roll back', async () => {
  await assert.rejects(diagnoseNightAllABatches({ connect: async () => {
    throw Object.assign(new Error(secret), { code: '28P01', detail: secret })
  } }), error => error.message === 'diagnostic_read_failed' && error.code === '28P01' && !JSON.stringify(error).includes(secret))
  const commands = []
  let released = false
  const report = await diagnoseNightAllABatches({ connect: async () => ({
    query: async sql => {
      commands.push(sql)
      if (sql.includes('batch-audit:')) throw Object.assign(new Error(secret), { code: '57014', detail: secret })
      return { rows: [] }
    }, release: () => { released = true },
  }) })
  for (const name of ['database', 'tasks', 'imports', 'batches', 'samples']) {
    assert.deepEqual(report[name], { state: 'unavailable', code: '57014', rows: null })
  }
  assert.equal(report.status, 'incomplete')
  assert.equal(commands.filter(sql => sql === 'ROLLBACK TO SAVEPOINT diagnostic_section').length, 5)
  assert.equal(commands[0], 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(commands.at(-1), 'ROLLBACK')
  assert.equal(released, true)
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret, 'u'))
})

test('stdin CLI prints available sections and exits nonzero when one section times out', t => {
  // A local fake pg module tests the actual standalone CLI without any network.
  const dir = mkdtempSync(join(tmpdir(), 'night-all-batch-cli-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const packageDir = join(dir, 'node_modules', 'pg')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ type: 'module', exports: './index.mjs' }))
  writeFileSync(join(packageDir, 'index.mjs'), `export default { Pool: class {
    async connect() { return { async query(sql) {
      if (sql.includes('batch-audit:imports')) throw Object.assign(new Error('${secret}'), {code:'57014'});
      return {rows:[]};
    }, release() {} }; }
    async end() {}
  }};`)
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
    cwd: dir, input: script, encoding: 'utf8', env: { ...process.env, DATABASE_URL: `postgresql://${secret}@unused.invalid/example` },
  })
  assert.equal(result.status, 1)
  assert.equal(result.stderr, '')
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(report.imports, { state: 'unavailable', code: '57014', rows: null })
  assert.equal(report.tasks.state, 'read')
  assert.equal(report.batches.state, 'read')
  assert.equal(report.samples.state, 'read')
  assert.doesNotMatch(result.stdout, new RegExp(secret, 'u'))
})

test('actual SQL resolves profile transport, flags conflicts, filters checkpoint fields and reports recent imports without secrets', postgres, async t => {
  const { db, pool, statements } = await fixture(t)
  await db.query('INSERT INTO catalog.database_connections VALUES($1,$2,$3)', [id(50), 'postgresql', {
    host: '100.127.0.6', port: 5432, database: 'agent_data_crawler_platform', username: secret, password: secret,
    sslMode: 'verify-ca', sourceContractId: secret,
  }])
  await source(db, 'news', { profileId: id(50), status: 'paused', connection: { host: 'stale.invalid', password: secret } })
  await source(db, 'web', { sourceId: 2, connection: { host: '127.0.0.1', database: 'agent_data_crawler_platform', password: secret } })
  await source(db, 'tender', { sourceId: 3, profileId: id(51) })
  await source(db, 'finance', { sourceId: 4, connection: { dsnEnv: secret } })
  await db.query('INSERT INTO mxq.cursors VALUES($1,$2,$3,$4,$5,$6)', ['external:night-all-saved-records-news', {
    cursor: '2026-10-17T01:02:03.123456Z', lastId: 325, contractHash: 'a'.repeat(64), mappingVersion: 1,
    importRunId: id(80), secret, connection: { password: secret },
  }, 'failed', '9007199254740993', '2026-10-17T02:00:00Z', secret])
  for (let n = 0; n < 4; n += 1) await db.query('INSERT INTO ingest.import_runs VALUES($1,$2,$3,1,10,8,7,1,2,$4,$4,$5)', [
    id(80 + n), id(1), n === 3 ? 'failed' : 'succeeded', `2026-10-17T0${n}:00:00Z`, secret,
  ])
  const before = await db.query('SELECT row_to_json(c) AS value FROM mxq.cursors c')
  const report = await diagnoseNightAllABatches(pool)
  assert.equal(report.status, 'observed')
  const news = report.tasks.rows.find(row => row.sourceKey.endsWith('-news'))
  assert.equal(report.database.rows[0].readOnly, true)
  assert.equal(news.status, 'paused')
  assert.equal(news.connection.host, '100.127.0.6')
  assert.equal(news.connection.database, 'agent_data_crawler_platform')
  assert.equal(news.connection.table, 'saved_records_news')
  assert.equal(news.connection.sslMode, 'verify-ca')
  assert.equal(news.connection.inlineTransportConflict, true)
  assert.equal(news.connection.profileLocatorConflict, true)
  assert.equal(news.cursor.status, 'failed')
  assert.equal(news.cursor.processedCount, '9007199254740993')
  assert.deepEqual(news.cursor.position, { cursor: '2026-10-17T01:02:03.123456Z', lastId: '325', contractHash: 'a'.repeat(64), mappingVersion: '1', importRunId: id(80) })
  assert.equal(news.cursor.hasSavedError, true)
  const missingProfile = report.tasks.rows.find(row => row.sourceKey.endsWith('-tender')).connection
  assert.equal(missingProfile.profileFound, false)
  assert.equal(missingProfile.port, null)
  assert.equal(missingProfile.sslMode, null)
  assert.equal(report.tasks.rows.find(row => row.sourceKey.endsWith('-finance')).connection.dsnReferenceUnresolved, true)
  assert.equal(report.imports.rows.length, 3)
  assert.equal(report.imports.rows[0].importRunId, id(83))
  assert.equal(report.imports.rows[0].status, 'failed')
  assert.equal(report.imports.rows[0].ingestedCount, '8')
  assert.equal(report.imports.rows[0].hasSavedError, true)
  assert.deepEqual((await db.query('SELECT row_to_json(c) AS value FROM mxq.cursors c')).rows, before.rows)
  assert.equal((await db.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'off')
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.doesNotMatch(JSON.stringify(report), new RegExp(`${secret}|stale.invalid|profile_should_not_override_locator`, 'u'))
  assert.ok(statements.every(sql => /^(?:BEGIN|SET LOCAL|SAVEPOINT|SELECT|WITH|RELEASE SAVEPOINT|ROLLBACK)/u.test(sql)))
})

test('actual batch SQL matches full identities, separates missing/deleted rows, scopes both batches and bounds samples', postgres, async t => {
  const { db, pool } = await fixture(t)
  await source(db, 'news')
  await source(db, 'web', { sourceId: 2 })
  for (let n = 1; n <= 7; n += 1) {
    await raw(db, n, 'news', 'maidanglao')
    if (n !== 2) await canonical(db, n, 'news', { deleted: n === 3, dataset: n === 4 ? 'wrong.dataset' : undefined })
  }
  await raw(db, 8, 'news', 'tasiting')
  await canonical(db, 8, 'news')
  await raw(db, 9, 'web', 'maidanglao')
  await canonical(db, 9, 'web')
  // Same record key elsewhere cannot contaminate fixed source identity or match a wrong dataset.
  await raw(db, 10, 'news', 'maidanglao', { recordKey: 'record-1', stream: 'other.external.v1' })
  await raw(db, 11, 'news', 'maidanglao', { objectType: 'other' })
  await raw(db, 12, 'news', 'maidanglao', { connectorId: 'external:other' })
  await raw(db, 13, 'news', 'not-this-batch')
  const before = await db.query('SELECT row_to_json(o) AS value FROM ingest.source_objects o ORDER BY id')
  const report = await diagnoseNightAllABatches(pool)
  const rows = report.batches.rows
  assert.equal(rows.length, 4)
  assert.deepEqual(rows.find(row => row.sourceType === 'news' && row.tag === 'maidanglao'), {
    sourceType: 'news', tag: 'maidanglao', rawConnectorId: 'organization-web', rawSourceType: 'news', rawCount: '7',
    matchedLiveCanonical: '4', matchedDeletedCanonical: '1', missingCanonical: '2', rawIdentityMismatch: '0',
  })
  assert.equal(rows.find(row => row.sourceType === 'web' && row.tag === 'tasiting').rawCount, '0')
  assert.equal(rows.find(row => row.sourceType === 'news' && row.tag === 'tasiting').rawCount, '1')
  const sample = report.samples.rows.filter(row => row.sourceType === 'news' && row.tag === 'maidanglao')
  assert.equal(sample.length, 5)
  assert.deepEqual(sample.map(row => row.recordKey), ['record-7', 'record-6', 'record-5', 'record-4', 'record-3'])
  assert.equal(sample[0].canonicalId, id(207))
  assert.equal(sample[0].rawConnectorId, 'organization-web')
  assert.equal(sample[0].rawSourceType, 'news')
  assert.equal(sample[0].canonicalLineageRowId, '7')
  assert.equal(sample[0].rawLastSeenAt, '2026-10-17T01:02:03.123456Z')
  assert.equal(sample[0].canonicalLineageLastSeenAt, '2026-10-17T01:02:03.123456Z')
  assert.equal(sample[3].canonicalId, null)
  assert.equal(sample[4].canonicalDeleted, true)
  assert.match(report.evidenceBoundary.counts, /do not prove equal content/u)
  assert.equal(report.evidenceBoundary.sourceDatabaseContacted, false)
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret, 'u'))
  assert.deepEqual((await db.query('SELECT row_to_json(o) AS value FROM ingest.source_objects o ORDER BY id')).rows, before.rows)
})

test('actual SAVEPOINT recovery keeps batch evidence when old deployment lacks task/import schema', postgres, async t => {
  const { db, pool } = await fixture(t)
  await raw(db, 1, 'web', 'maidanglao')
  await canonical(db, 1, 'web')
  await db.exec('DROP TABLE mxq.cursors; ALTER TABLE ingest.import_runs DROP COLUMN changed_count;')
  const report = await diagnoseNightAllABatches(pool)
  assert.deepEqual(report.tasks, { state: 'unavailable', code: '42P01', rows: null })
  assert.deepEqual(report.imports, { state: 'unavailable', code: '42703', rows: null })
  assert.equal(report.status, 'incomplete')
  assert.equal(report.batches.state, 'read')
  assert.equal(report.batches.rows.find(row => row.sourceType === 'web' && row.tag === 'maidanglao').matchedLiveCanonical, '1')
  assert.equal(report.samples.rows.length, 1)
})
