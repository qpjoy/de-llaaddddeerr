import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { lookupRequestDiagnostics } from '../../server/acquisitions/diagnostics.mjs'

const identifier = 'ab00ef17-1e2e-4085-8254-eb6a13729966'
const eventId = '58434459-3cdd-4a89-895d-d7a124583c71'
const ownerId = '29ea667d-24c2-421a-adcb-d7481132eca3'
const rejection = { event_id: eventId, request_id: identifier, request_id_source: 'server',
  tenant_id: ownerId, consumer_id: ownerId, api_key_id: ownerId, platform: 'tieba', route_path: '/api/v1/search', scope_mode: 'snapshot',
  error_code: 'platform_not_granted', http_status: 403, occurred_at: '2026-11-17T11:15:00.000Z' }

function fixture({ available = true, rows = [rejection], fail = false } = {}) {
  const queries = []
  let released = false
  const pool = { async connect() { return { async query(sql, params) {
    queries.push({ sql, params })
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/u)
    if (sql.includes('request-diagnostics:admission-schema')) return { rows: [{ available }] }
    if (sql.includes('request-diagnostics:admissions')) {
      if (fail) throw Object.assign(new Error('private database details'), { code: '42501' })
      return { rows }
    }
    return { rows: [] }
  }, release() { released = true } } } }
  return { pool, queries, released: () => released }
}

test('authorization refusals remain distinct from usage, calls and billing in a read-only exact lookup', async () => {
  const f = fixture({ rows: [{ ...rejection, message: 'private message', request_body: 'private query', api_key: 'private key' }] })
  const result = await lookupRequestDiagnostics(f.pool, identifier)
  assert.deepEqual(result.runs, [])
  assert.equal(result.admissionEvidenceAvailable, true)
  assert.equal(result.admissionFailuresTruncated, false)
  assert.deepEqual(result.admissionFailures, [{ eventId, requestId: identifier, requestIdSource: 'server',
    tenantId: ownerId, consumerId: ownerId, apiKeyId: ownerId, platform: 'tieba', routePath: '/api/v1/search', scopeMode: 'snapshot',
    errorCode: 'platform_not_granted', httpStatus: 403, occurredAt: rejection.occurred_at }])
  const query = f.queries.find(row => row.sql.includes('request-diagnostics:admissions'))
  assert.deepEqual(query.params, [identifier])
  assert.match(query.sql, /WHERE request_id = \$1/u)
  assert.match(query.sql, /LIMIT 21/u)
  assert.doesNotMatch(query.sql, /\bILIKE\b|SELECT \*/u)
  assert.doesNotMatch(JSON.stringify(result), /private |providerCalls|customerCharge|response_body|api_key"/u)
  assert.equal(f.queries[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(f.queries.at(-1).sql, 'COMMIT')
  assert.ok(f.released())
})

test('old schemas report unavailable authorization evidence without querying the missing table', async () => {
  const f = fixture({ available: false })
  const result = await lookupRequestDiagnostics(f.pool, identifier)
  assert.equal(result.admissionEvidenceAvailable, false)
  assert.deepEqual(result.admissionFailures, [])
  assert.equal(result.admissionFailuresTruncated, false)
  assert.ok(!f.queries.some(row => row.sql.includes('request-diagnostics:admissions */')))
})

test('same client request IDs retain separate bounded events and unreviewed properties cannot cross projection', async () => {
  const rows = Array.from({ length: 21 }, (_, index) => ({ ...rejection,
    event_id: `58434459-3cdd-4a89-895d-${String(index).padStart(12, '0')}`, request_id_source: 'client' }))
  const result = await lookupRequestDiagnostics(fixture({ rows }).pool, identifier)
  assert.equal(result.admissionFailures.length, 20)
  assert.equal(result.admissionFailuresTruncated, true)
  assert.equal(new Set(result.admissionFailures.map(row => row.eventId)).size, 20)
  assert.ok(result.admissionFailures.every(row => row.requestIdSource === 'client'))
  const hostile = { ...rejection, event_id: 'private uuid', request_id: 'private other request',
    request_id_source: 'private source', tenant_id: 'private tenant', consumer_id: 'private consumer', api_key_id: 'private key',
    platform: 'private platform', route_path: '/api/v1/search?private=query', scope_mode: 'private scope',
    error_code: 'private code', http_status: 200, occurred_at: 'private timestamp' }
  const invalid = await lookupRequestDiagnostics(fixture({ rows: [hostile] }).pool, identifier)
  assert.ok(Object.values(invalid.admissionFailures[0]).every(value => value === null))
  assert.doesNotMatch(JSON.stringify(invalid), /private /u)
})

test('unreadable authorization evidence fails explicitly and never exposes database text', async () => {
  const f = fixture({ fail: true })
  await assert.rejects(lookupRequestDiagnostics(f.pool, identifier), error => error.status === 503
    && error.code === 'request_diagnostics_unavailable' && !error.message.includes('private'))
  assert.equal(f.queries.at(-1).sql, 'ROLLBACK')
  assert.ok(f.released())
})

test('actual PostgreSQL supports pre-usage evidence and preserves multiple owners sharing a client ID', {
  skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE,
}, async t => {
  const { PGlite } = await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(`CREATE SCHEMA control; CREATE SCHEMA external_platform; CREATE SCHEMA serving;
    CREATE TABLE public.usage_requests(id uuid PRIMARY KEY);
    CREATE TABLE external_platform.provider_calls(upstream_request_id text,usage_request_id uuid);
    CREATE TABLE serving.connector_calls(upstream_request_id text,usage_request_id uuid);`)
  const pool = { async connect() { return { query: (sql, params) => db.query(sql, params), release() {} } } }
  assert.equal((await lookupRequestDiagnostics(pool, identifier)).admissionEvidenceAvailable, false)
  await db.exec(await readFile(new URL('../../migrations/193_request_authorization_rejections.sql', import.meta.url), 'utf8'))
  for (const owner of [ownerId, eventId]) {
    await db.query(`INSERT INTO control.request_authorization_rejections
      (event_id,request_id,request_id_source,tenant_id,consumer_id,api_key_id,platform,scope_mode,error_code,http_status)
      VALUES(gen_random_uuid(),$1,'client',$2,$2,$2,'tieba','snapshot','platform_not_granted',403)`, [identifier, owner])
  }
  const result = await lookupRequestDiagnostics(pool, identifier)
  assert.equal(result.admissionEvidenceAvailable, true)
  assert.deepEqual(result.runs, [])
  assert.equal(result.admissionFailures.length, 2)
  assert.equal(new Set(result.admissionFailures.map(row => row.eventId)).size, 2)
  assert.ok(result.admissionFailures.every(row => row.routePath === null), 'unknown historical route is not reconstructed')
  assert.deepEqual(new Set(result.admissionFailures.map(row => row.consumerId)), new Set([ownerId, eventId]))
  assert.equal((await lookupRequestDiagnostics(pool, ownerId)).admissionFailures.length, 0)
  assert.equal((await db.query('SELECT count(*)::int AS count FROM public.usage_requests')).rows[0].count, 0)
})

const require = createRequire(import.meta.url)
const view = build({
  stdin: { contents: "export { default as RequestDiagnostics } from './request-diagnostics.jsx'", loader: 'js',
    resolveDir: fileURLToPath(new URL('../../src/', import.meta.url)) },
  bundle: true, define: { 'import.meta.env': '{}' }, format: 'esm', jsx: 'automatic', platform: 'node', write: false,
  loader: { '.css': 'empty' }, plugins: [{ name: 'shared-react', setup(builder) {
    builder.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }))
  } }],
}).then(({ outputFiles }) => import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`))
async function render(data) {
  const { RequestDiagnostics } = await view
  return renderToStaticMarkup(createElement(RequestDiagnostics, {
    token: 'fixture', session: { token: 'fixture', identifier, data }, setSession() {},
  }))
}

test('authorization evidence UI does not become an upstream failure or offer purchase, recovery or grant mutation', async () => {
  const data = await lookupRequestDiagnostics(fixture().pool, identifier)
  const html = await render(data)
  assert.match(html, /Hub 权限校验拒绝/u)
  assert.match(html, /tieba/u)
  assert.match(html, /platform_not_granted/u)
  assert.match(html, /\/api\/v1\/search/u)
  assert.match(html, /Key 独立权限范围（snapshot）/u)
  assert.match(html, /先确认调用接口支持该平台/u)
  assert.match(html, /无法区分应用授权与 Key 范围缺项，也不能证明该接口已经接入目标平台/u)
  assert.doesNotMatch(html, /未找到关联记录|上游拒绝|<h4>客户结算|准备按原参数|查看当前限制|href=/u)
})

test('empty and older deployments state that missing records do not establish successful authorization', async () => {
  const old = await render(await lookupRequestDiagnostics(fixture({ available: false }).pool, identifier))
  assert.match(old, /权限拒绝证据当前不可用/u)
  assert.match(old, /旧版本未保存其证据/u)
  assert.match(old, /未匹配不代表请求成功/u)
  const ready = await render(await lookupRequestDiagnostics(fixture({ rows: [] }).pool, identifier))
  assert.doesNotMatch(ready, /权限拒绝证据当前不可用/u)
  assert.match(ready, /未找到关联记录/u)
  const capped = await render({ identifier, runs: [], admissionFailures: [], admissionEvidenceAvailable: true,
    admissionFailuresTruncated: true, checkedAt: rejection.occurred_at })
  assert.match(capped, /调用方提供的相同 ID 可能关联多次请求/u)
})
