import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { REQUEST_IDS, diagnoseTelegramSearch, elasticReader, summarizeSearch, telegramSearchDatabase, telegramSearchProjection } from '../../server/ops/diagnose-telegram-search.mjs'

const scriptUrl = new URL('../../server/ops/diagnose-telegram-search.mjs', import.meta.url)
const script = readFileSync(scriptUrl, 'utf8')
const secret = 'NEVER_PRINT_BUSINESS_BODY_CREDENTIAL_OR_ERROR'
const env = { MX_COMMON_ELASTICSEARCH_URL: 'https://search.invalid', MX_COMMON_ELASTICSEARCH_USERNAME: secret, MX_COMMON_ELASTICSEARCH_PASSWORD: secret }
const datasets = ['telegram.monitor.messages.v1', 'telegram.sqlite.messages.v1']
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const pgliteModule = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const actualSql = { skip: pgliteModule ? false : 'Set MX_INSIGHT_TEST_PGLITE_MODULE to a local PGlite module' }
const root = new URL('../../', import.meta.url).pathname.replace(/\/$/u, '')
const result = (hits = []) => ({ state: 'observed', data: { timed_out: false, _shards: { total: 1, successful: 1, skipped: 0, failed: 0 }, hits: { hits } } })

test('stdin and file entrypoints reject absent database and extra arguments without leaking environment or importing application modules', () => {
  assert.doesNotMatch(script, /(?:from|import\()\s*['"]\.\.?\//u)
  const environment = { ...process.env, MX_COMMON_ELASTICSEARCH_PASSWORD: secret }; delete environment.DATABASE_URL
  for (const args of [['--input-type=module', '-'], [scriptUrl.pathname]]) {
    const run = spawnSync(process.execPath, args, { input: script, env: environment, encoding: 'utf8' })
    assert.equal(run.status, 1); assert.equal(run.stdout, '')
    assert.deepEqual(JSON.parse(run.stderr), { error: 'database_url_required' })
  }
  const args = spawnSync(process.execPath, [scriptUrl.pathname, secret], { env: environment, encoding: 'utf8' })
  assert.deepEqual(JSON.parse(args.stderr), { error: 'invalid_arguments' })
})

test('SQL timeout or absent schema remains incomplete, releases read-only transaction, and never becomes zero matches', async () => {
  const sql = []; let released = false
  const report = await telegramSearchDatabase({ connect: async () => ({ query: async text => {
    sql.push(text)
    if (text.startsWith('SELECT')) throw Object.assign(new Error(secret), { code: '57014', detail: secret })
    return { rows: [] }
  }, release: () => { released = true } }) })
  assert.equal(report.state, 'incomplete'); assert.equal(report.requests.rows, null)
  assert.equal(report.datasets[0].windowLiteral.rows, null)
  assert.equal(report.datasets[0].windowLiteral.code, '57014')
  assert.equal(sql[0], 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.ok(sql.includes("SET LOCAL statement_timeout = '3s'")); assert.ok(sql.includes("SET LOCAL lock_timeout = '1s'"))
  assert.equal(sql.at(-1), 'ROLLBACK'); assert.equal(released, true)
  assert.ok(sql.every(value => /^(?:BEGIN|SET LOCAL|SAVEPOINT|SELECT|RELEASE SAVEPOINT|ROLLBACK)/u.test(value)))
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret, 'u'))
  assert.deepEqual(await telegramSearchDatabase({ connect: async () => { throw new Error(secret) } }), { state: 'incomplete', code: 'diagnostic_read_failed' })
})

test('actual PostgreSQL SQL returns bounded existence and field matches with no raw body or sensitive errors', actualSql, async t => {
  const { PGlite } = await import(pathToFileURL(pgliteModule).href)
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(`CREATE SCHEMA core; CREATE TABLE core.canonical_records(id uuid PRIMARY KEY,dataset_id text,
    platform text,object_type text,event_time timestamptz,title text,body text,deleted_at timestamptz,current_revision int DEFAULT 2);
    CREATE TABLE core.record_chunks(id uuid PRIMARY KEY,record_id uuid,source_revision int,embedding_model text,
    vector real[],embedded_at timestamptz,projected_at timestamptz,content text,chunk_index int DEFAULT 0,chunker_version text DEFAULT 'v1');
    CREATE TABLE public.usage_requests(id uuid PRIMARY KEY,status text,response_status int,reserved_at timestamptz,
    completed_at timestamptz,platform text,acquisition_request jsonb,response_body jsonb,error_code text);`)
  const body = { query: '领导人', sourceScope: 'all', scope: 'messages', matchMode: 'full_text', pageSize: 20,
    from: '2026-10-13T19:51:18.939036Z', to: '2026-10-18T19:51:18.939036Z' }
  for (const requestId of REQUEST_IDS) await db.query(`INSERT INTO public.usage_requests VALUES($1,'committed',200,now(),now(),'telegram',$2,$3,$4)`, [requestId,
    { method: 'POST', path: '/api/v1/data/telegram/search', body }, { data: { status: 'ok', items: [], warnings: [], pageInfo: { hasMore: false }, private: secret } }, secret])
  for (const [n, dataset] of datasets.entries()) {
    await db.query(`INSERT INTO core.canonical_records VALUES($1,$2,'telegram','message','2026-10-14T00:00:00Z',$3,$4,NULL,2)`, [id(n + 1), dataset, secret, `领导人 ${secret}`])
    await db.query(`INSERT INTO core.canonical_records VALUES($1,$2,'telegram','message','2026-10-14T00:00:00Z','领导人',$3,now(),2)`, [id(n + 3), dataset, secret])
    await db.query(`INSERT INTO core.record_chunks VALUES($1,$2,1,'provider:synthetic-stale',ARRAY[99]::real[],now(),now(),$3,0,'v1')`, [id(20 + n), id(n + 1), secret])
    await db.query(`INSERT INTO core.record_chunks VALUES($1,$2,2,'provider:synthetic-current',ARRAY[1,2]::real[],now(),now(),$3,0,'v1')`, [id(30 + n), id(n + 1), secret])
  }
  const before = await db.query('SELECT * FROM core.canonical_records ORDER BY id')
  let released = false
  const pool = { connect: async () => ({ query: async (sql, values) => {
    if (sql.startsWith('SELECT')) {
      assert.equal((await db.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on')
      assert.equal((await db.query('SHOW statement_timeout')).rows[0].statement_timeout, '3s')
      assert.equal((await db.query('SHOW lock_timeout')).rows[0].lock_timeout, '1s')
      assert.match(sql, /LIMIT [12]$/u); assert.doesNotMatch(sql, /count\(\*\)/iu)
    }
    return db.query(sql, values)
  }, release: () => { released = true } }) }
  const report = await telegramSearchDatabase(pool)
  assert.equal(report.state, 'observed'); assert.equal(released, true)
  assert.equal(report.requests.rows.length, 2)
  assert.ok(Object.values(report.requests.rows[0].expectedFieldsMatch).every(value => value === true))
  assert.equal(report.requests.rows[0].returnedCount, 0)
  for (const [n, dataset] of report.datasets.entries()) {
    assert.equal(dataset.windowLiteral.rows.length, 1); assert.equal(dataset.windowLiteral.rows[0].id, id(n + 1))
    assert.equal(dataset.currentVector.rows.length, 1); assert.equal(dataset.currentVector.rows[0].chunkId, id(30 + n))
    assert.equal(dataset.currentVector.rows[0].sourceRevision, 2); assert.equal(dataset.currentVector.rows[0].dimensions, 2)
    assert.equal(dataset.currentVector.rows[0].model, 'provider:synthetic-current')
    assert.equal(dataset.currentVector.rows[0].documentId, `${id(n + 1)}:0:v1`)
    assert.equal(Object.hasOwn(dataset.currentVector.rows[0], 'vector'), false)
  }
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret, 'u'))
  assert.deepEqual(await db.query('SELECT * FROM core.canonical_records ORDER BY id'), before)
  await db.exec('DROP TABLE core.canonical_records')
  const missing = await telegramSearchDatabase(pool)
  assert.equal(missing.state, 'incomplete'); assert.equal(missing.datasets[0].any.code, '42P01')
})

test('ES requests are GET-only with configured credentials, no redirects, body size limit, and K8s fallback', async () => {
  const seen = []
  const read = elasticReader(env, async (url, options) => {
    seen.push({ url, options }); return new Response(JSON.stringify({ secret, ok: true }))
  })
  const response = await read('/mx-insight-hub-content/_search', { size: 1 })
  assert.equal(response.state, 'observed'); assert.equal(seen[0].options.method, 'GET')
  assert.equal(seen[0].options.redirect, 'error'); assert.equal(seen[0].url.searchParams.get('source'), '{"size":1}')
  assert.equal(seen[0].options.headers.authorization, `Basic ${Buffer.from(`${secret}:${secret}`).toString('base64')}`)
  assert.equal(elasticReader({}, () => { throw new Error('must not fetch') }), null)
  assert.throws(() => elasticReader({ MX_COMMON_ELASTICSEARCH_URL: `http://${secret}@search.invalid` }), /invalid_search_config/u)
  let hostname
  await elasticReader({ KUBERNETES_SERVICE_HOST: 'cluster' }, async url => { hostname = url.hostname; return new Response('{}') })('/_alias/example')
  assert.equal(hostname, 'mx-common-elasticsearch.mx-common.svc.cluster.local')
  const oversized = await elasticReader(env, async () => new Response('x'.repeat(1024 * 1024 + 1)))('/_alias/example')
  assert.deepEqual(oversized, { state: 'incomplete', code: 'search_read_failed' })
  assert.deepEqual(await elasticReader(env, async () => new Response(secret, { status: 403 }))('/_alias/example'), { state: 'incomplete', httpStatus: 403 })
})

test('ES full-body deadline covers a body that never finishes; errors remain sanitized', async () => {
  let aborted = false
  const read = elasticReader(env, async (_url, options) => {
    options.signal.addEventListener('abort', () => { aborted = true })
    return new Response(new ReadableStream({ start() {} }))
  }, 20)
  assert.deepEqual(await read('/_alias/example'), { state: 'incomplete', code: 'search_read_failed' })
  assert.equal(aborted, true)
  assert.deepEqual(await elasticReader(env, async () => { throw new Error(secret) })('/_alias/example'), { state: 'incomplete', code: 'search_read_failed' })
})

test('timed-out, partial-shard, early-terminated and malformed ES responses do not claim absence', () => {
  for (const data of [
    { ...result().data, timed_out: true },
    { ...result().data, _shards: { total: 2, successful: 1, failed: 1, failures: [secret] } },
    { ...result().data, terminated_early: true }, {},
  ]) {
    const summary = summarizeSearch({ state: 'observed', data })
    assert.equal(summary.state, 'incomplete'); assert.equal(summary.found, null)
    assert.doesNotMatch(JSON.stringify(summary), new RegExp(secret, 'u'))
  }
  const sample = summarizeSearch(result([{ _id: id(1), _source: { id: id(1), datasetId: datasets[0], eventTime: '2026-10-14T00:00:00Z', body: secret, credentials: secret } }]))
  assert.equal(sample.found, true); assert.doesNotMatch(JSON.stringify(sample), new RegExp(secret, 'u'))
  assert.equal(summarizeSearch(result()).found, false)
})

test('projection probes add scope, time, phrase sequentially and compare only bounded canonical sample IDs', async () => {
  const calls = []
  const read = async (path, query) => {
    calls.push({ path, query })
    if (path.includes('_search')) return result()
    const alias = path.includes('chunk') ? 'mx-insight-hub-chunk' : path.includes('v6') ? 'mx-insight-hub-content-v6' : 'mx-insight-hub-content'
    return { state: 'observed', data: { 'mx-insight-hub-content-v6-current': path.includes('_mapping')
      ? { mappings: { properties: { body: { type: 'text', secret }, token: { type: secret } } } }
      : { aliases: { [alias]: { is_write_index: true, secret } } } } }
  }
  const report = await telegramSearchProjection(read, { datasets: [{ windowLiteral: { rows: [{ id: id(1) }] } }] })
  assert.equal(report.state, 'observed'); assert.equal(calls.length, 10)
  const searches = calls.filter(call => call.query)
  assert.deepEqual(searches.map(call => call.query.query.bool?.filter.length ?? 'ids'), [3, 4, 5, 'ids'])
  for (const call of searches) {
    assert.equal(call.query.track_total_hits, false); assert.equal(call.query.size, 1); assert.equal(call.query.timeout, '3s')
    assert.deepEqual(call.query._source, ['id', 'datasetId', 'eventTime'])
  }
  assert.deepEqual(searches[3].query.query.ids.values, [id(1)])
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret, 'u'))
})

test('vector projection evidence compares exact current sample revision and space without vectors, credentials or model calls', async () => {
  const calls = []
  const sample = { id: id(1), chunkId: id(30), documentId: `${id(1)}:0:v1`, currentRevision: 2, model: 'provider:synthetic-current', dimensions: 2 }
  const read = async (path, query) => {
    calls.push({ path, query })
    if (path === '/mx-insight-hub-chunk/_search') return result([{ _id: sample.documentId,
      _source: { recordId: sample.id, sourceRevision: 1, embeddingSpace: `${secret}:1024`, embedding: [12345], content: secret } }])
    if (path.includes('_search')) return result()
    const alias = path.includes('chunk') ? 'mx-insight-hub-chunk' : path.includes('v6') ? 'mx-insight-hub-content-v6' : 'mx-insight-hub-content'
    return { state: 'observed', data: { 'mx-insight-hub-chunk-v2-current': path.includes('_mapping')
      ? { mappings: { properties: { embedding: { type: 'dense_vector', dims: 2 }, sourceRevision: { type: 'long' } } } }
      : { aliases: { [alias]: {} } } } }
  }
  const report = await telegramSearchProjection(read, { datasets: [{ currentVector: { rows: [sample] } }] })
  assert.equal(report.vectorSamples[0].found, true)
  assert.equal(report.vectorSamples[0].samples[0].documentMatches, true)
  assert.equal(report.vectorSamples[0].samples[0].recordMatches, true)
  assert.equal(report.vectorSamples[0].samples[0].revisionMatches, false)
  assert.equal(report.vectorSamples[0].samples[0].embeddingSpaceMatches, false)
  assert.deepEqual(calls.at(-1).query._source, ['recordId', 'sourceRevision', 'embeddingSpace'])
  assert.deepEqual(calls.at(-1).query.query, { ids: { values: [`${id(1)}:0:v1`] } })
  assert.equal(report.mappings.at(-1).indices[0].dimensions, 2)
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret, 'u'))
  assert.doesNotMatch(JSON.stringify(report), /12345/u)
  const matched = await telegramSearchProjection(async (path, query) => path === '/mx-insight-hub-chunk/_search'
    ? result([{ _id: sample.documentId, _source: { recordId: sample.id, sourceRevision: 2, embeddingSpace: 'synthetic-current:2' } }])
    : read(path, query), { datasets: [{ currentVector: { rows: [sample] } }] })
  assert.equal(matched.vectorSamples[0].samples[0].revisionMatches, true)
  assert.equal(matched.vectorSamples[0].samples[0].embeddingSpaceMatches, true)
})

test('report hashes fixed runtime sources and marks missing configuration/files incomplete', async () => {
  const pool = { connect: async () => { throw new Error(secret) } }
  const report = await diagnoseTelegramSearch(pool, { environment: {}, root, fetchImpl: () => { throw new Error('no network expected') } })
  assert.equal(report.status, 'incomplete'); assert.equal(report.projection.code, 'search_not_configured')
  assert.equal(report.runtime.files.length, 4); assert.ok(report.runtime.files.every(file => /^[a-f0-9]{64}$/u.test(file.sha256)))
  assert.equal(report.effectiveWindow.from, '2026-10-13T19:51:18.939Z')
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret, 'u'))
  const missing = await diagnoseTelegramSearch(pool, { environment: {}, root: '/nonexistent-telegram-search-diagnostic' })
  assert.ok(missing.runtime.files.every(file => file.sha256 === null))
})
