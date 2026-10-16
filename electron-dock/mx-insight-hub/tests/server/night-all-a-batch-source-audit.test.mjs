import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const sql = readFileSync(new URL('../../scripts/night-all-a-batch-source-audit.sql', import.meta.url), 'utf8')
const section = name => sql.split(`-- BEGIN ${name}\n`)[1].split(`-- END ${name}`)[0].trim().replace(/;?$/u, ';')
const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const postgres = { skip: modulePath ? false : 'Set MX_INSIGHT_TEST_PGLITE_MODULE to an installed local PGlite module' }

async function database(t) {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite()
  t.after(() => db.close())
  return db
}
async function table(db, tag = 'varchar(128)') {
  await db.exec(`CREATE TABLE public.saved_records (
    id integer NOT NULL, tag ${tag}, source_type varchar(64), connector_id varchar(128),
    record_key varchar(64), attributes jsonb, created_at timestamptz, last_seen_at timestamptz,
    text text, source_url text
  )`)
}
async function record(db, { id, tag = 'maidanglao', type = 'news', connector = 'organization-web', site = 'example.org', status = 'complete', seen = `2026-10-16T00:00:${String(id % 60).padStart(2, '0')}Z` }) {
  await db.query(`INSERT INTO public.saved_records VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9)`, [
    id, tag, type, connector, `key-${id}`, JSON.stringify({ site_id: site, body_status: status, secret: 'ATTR_SECRET' }),
    seen, 'BODY_SECRET', 'https://URL_SECRET.invalid/',
  ])
}
async function report(db, name) {
  const result = await db.query(section(name))
  assert.equal(result.rows.length, 1)
  return JSON.parse(Object.values(result.rows[0])[0])
}
async function schema(db) {
  const row = (await db.query(section('SCHEMA PREFLIGHT'))).rows[0]
  return { ready: row.audit_schema_ready, report: JSON.parse(row.audit_schema_report) }
}

test('psql audit is a bounded read-only snapshot with explicit failure and privilege branches', () => {
  assert.match(sql, /^\\set ON_ERROR_STOP on/mu)
  assert.match(sql, /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;/u)
  assert.match(sql, /SET LOCAL statement_timeout = '15s';/u)
  assert.match(sql, /SET LOCAL lock_timeout = '1s';/u)
  assert.match(sql, /SET LOCAL idle_in_transaction_session_timeout = '30s';/u)
  assert.match(sql, /SET LOCAL search_path = pg_catalog;/u)
  assert.match(sql, /\\if :audit_system_id_readable[\s\S]*-- BEGIN SYSTEM IDENTIFIER[\s\S]*\\else[\s\S]*'status', 'unavailable'/u)
  assert.match(sql, /-- END SCHEMA PREFLIGHT\s*\\gset\s*\\echo :audit_schema_report\s*\\if :audit_schema_ready/u)
  assert.match(sql, /-- END LATEST SAMPLES\s*\\else[\s\S]*RAISE EXCEPTION 'batch audit schema unsupported; no business rows read; see batch_schema report';[\s\S]*\\endif\s*ROLLBACK;\s*$/u)
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|COMMIT)\b/u)
  assert.doesNotMatch(sql, /to_jsonb\s*\(|\bsource_url\b|\bcontent\b|\braw_payload\b/iu)
  assert.match(section('BATCH COUNTS'), /LIMIT 100/u)
  assert.match(section('LATEST SAMPLES'), /LIMIT 5/u)
  assert.match(section('BATCH COUNTS'), /tag IN \('tasiting', 'maidanglao'\)/u)
})

test('identity reports actual connection metadata and does not infer application routing', postgres, async t => {
  const db = await database(t)
  await db.exec('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const identity = await report(db, 'CONNECTION IDENTITY')
  assert.equal(identity.transactionReadOnly, 'on')
  assert.equal(identity.transactionIsolation, 'repeatable read')
  for (const name of ['database', 'serverAddress', 'serverPort', 'postmasterStartedAt', 'snapshotAt']) assert.ok(Object.hasOwn(identity, name))
  assert.match(identity.scope, /not proof of application engine or Hub routing/u)
  const permission = (await db.query(section('SYSTEM IDENTIFIER PERMISSION'))).rows[0].audit_system_id_readable
  if (permission) {
    const cluster = await report(db, 'SYSTEM IDENTIFIER')
    assert.equal(cluster.status, 'observed')
    assert.match(cluster.systemIdentifier, /^\d+$/u)
  }
  await db.exec('ROLLBACK')
})

test('schema preflight identifies absent table/tag or incompatible types without reading business columns', postgres, async t => {
  const db = await database(t)
  const missingTable = await schema(db)
  assert.equal(missingTable.ready, false)
  assert.equal(missingTable.report.status, 'unsupported_schema')
  assert.equal(missingTable.report.counts, null)
  assert.equal(missingTable.report.businessRowsRead, false)
  await table(db)
  assert.equal((await schema(db)).ready, true)
  await db.exec('ALTER TABLE public.saved_records DROP COLUMN tag')
  assert.deepEqual((await schema(db)).report.problems, [{ column: 'tag', actualType: null }])
  await db.exec('ALTER TABLE public.saved_records ADD COLUMN tag integer')
  assert.deepEqual((await schema(db)).report.problems, [{ column: 'tag', actualType: 'integer' }])
  assert.equal((await schema(db)).ready, false)
})

test('batch counts separate tags, source types and connectors and count distinct nonempty sites', postgres, async t => {
  const db = await database(t)
  await table(db)
  for (const row of [
    { id: 1 }, { id: 2 }, { id: 3, site: 'second.example' },
    { id: 4, site: null }, { id: 5, site: '' },
    { id: 6, tag: 'tasiting' }, { id: 7, type: 'web' },
    { id: 8, connector: 'another-connector' }, { id: 9, tag: 'excluded-tag' },
  ]) await record(db, row)
  const result = await report(db, 'BATCH COUNTS')
  assert.equal(result.totalGroups, 4)
  assert.equal(result.groupsComplete, true)
  const group = result.groups.find(row => row.tag === 'maidanglao' && row.sourceType === 'news' && row.connectorId === 'organization-web')
  assert.equal(group.rowCount, 5)
  assert.equal(group.siteCount, 2)
  assert.equal(group.missingSiteIdRows, 2)
  assert.equal(new Date(group.minLastSeenAt).toISOString(), '2026-10-16T00:00:01.000Z')
  assert.equal(new Date(group.maxLastSeenAt).toISOString(), '2026-10-16T00:00:05.000Z')
  assert.doesNotMatch(JSON.stringify(result), /SECRET|excluded-tag/u)
})

test('latest samples return five news and five web rows from only the new organization-web batch', postgres, async t => {
  const db = await database(t)
  await table(db)
  for (const type of ['news', 'web']) {
    for (let n = 1; n <= 7; n += 1) await record(db, { id: (type === 'news' ? 100 : 200) + n, type, seen: `2026-10-16T00:00:0${n}Z` })
  }
  for (const row of [
    { id: 301, tag: 'tasiting' }, { id: 302, connector: 'other' }, { id: 303, type: 'tender' },
  ]) await record(db, { ...row, seen: '2026-10-17T00:00:00Z' })
  const result = await report(db, 'LATEST SAMPLES')
  assert.equal(result.sampleOnly, true)
  assert.deepEqual(result.rows.map(row => row.id), [107, 106, 105, 104, 103, 207, 206, 205, 204, 203])
  assert.deepEqual(Object.keys(result.rows[0]).sort(), ['bodyStatus', 'createdAt', 'id', 'lastSeenAt', 'recordKey', 'siteId', 'sourceType'])
  assert.equal(result.rows[0].recordKey, 'key-107')
  assert.equal(result.rows[0].siteId, 'example.org')
  assert.equal(result.rows[0].bodyStatus, 'complete')
  assert.doesNotMatch(JSON.stringify(result), /SECRET|https:\/\//u)
})

test('aggregate output is bounded with an explicit truncation indicator', postgres, async t => {
  const db = await database(t)
  await table(db)
  await db.exec(`INSERT INTO public.saved_records(id,tag,source_type,connector_id,attributes,last_seen_at)
    SELECT n, 'maidanglao', 'news', 'connector-'||n, '{"site_id":"example.org"}', now()
    FROM generate_series(1,101) n`)
  const result = await report(db, 'BATCH COUNTS')
  assert.equal(result.totalGroups, 101)
  assert.equal(result.groupsComplete, false)
  assert.equal(result.groups.length, 100)
})

test('empty success is distinguishable from permissions or read-only failures', postgres, async t => {
  const db = await database(t)
  await table(db)
  await db.exec('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const result = await report(db, 'BATCH COUNTS')
  assert.equal(result.status, 'observed')
  assert.deepEqual(result.groups, [])
  assert.equal(result.totalGroups, 0)
  assert.deepEqual((await report(db, 'LATEST SAMPLES')).rows, [])
  await assert.rejects(() => record(db, { id: 1 }), /read-only transaction/u)
  await db.exec('ROLLBACK')
  // PGlite initially grants this function to PUBLIC; model restricted execution
  // only in this disposable database, without making any production grants.
  await db.exec('REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system() FROM PUBLIC; CREATE ROLE batch_audit_no_data_access; SET ROLE batch_audit_no_data_access')
  assert.equal((await schema(db)).ready, true)
  assert.equal((await db.query(section('SYSTEM IDENTIFIER PERMISSION'))).rows[0].audit_system_id_readable, false)
  await assert.rejects(() => report(db, 'BATCH COUNTS'), /permission denied/u)
  await db.exec('RESET ROLE')
})
